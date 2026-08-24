/**
 * SVG path data and shape geometry -> polylines.
 *
 * This exists because sampling by arc length loses corners. `getPointAtLength()`
 * walks a uniform step and only lands on a vertex by luck, so every corner of a
 * polygonal path gets chamfered by up to one step — on an 8.5x11in document that
 * is ~1.1mm of geometry, which is a quarter of the edge on a small triangle.
 *
 * So vertices are emitted exactly and only genuine curves are sampled. Curve
 * density still follows the document-relative step, which is what keeps a bezier
 * looking the same whether the viewBox is in pixels or inches.
 *
 * **Deliberately DOM-free**, unlike its only caller. Everything here is exact
 * arithmetic on the path data, which makes it testable under Node — the parser
 * itself is not, which is why `src/tests/simple-parser.ts` had to exist.
 */

import type { Point } from './types';

/**
 * One flattened subpath. `closed` implies the segment back to the first point;
 * it is not repeated in `points`.
 */
export interface Subpath {
    points: Point[];
    closed: boolean;
}

/**
 * A path command in absolute coordinates.
 *
 * The shorthands are resolved during parsing rather than being carried through:
 * H/V become L, S becomes C and T becomes Q, since the reflected control point
 * they imply is only knowable in command sequence.
 */
export type PathCommand =
    | { type: 'M' | 'L'; x: number; y: number }
    | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
    | { type: 'Q'; x1: number; y1: number; x: number; y: number }
    | {
        type: 'A';
        rx: number; ry: number; rotation: number;
        largeArc: boolean; sweep: boolean;
        x: number; y: number;
    }
    | { type: 'Z' };

/** Thrown on path data this parser cannot read, so callers can fall back. */
export class PathDataError extends Error { }

/** Ceiling on points per curve, so a degenerate step can't produce a huge array. */
const MAX_SAMPLES_PER_CURVE = 4096;

/** Points closer than this are the same point, for dropping a redundant closing vertex. */
const CLOSE_EPSILON = 1e-9;

// ─── Tokenizer ───────────────────────────────────────────────────────────────

const COMMAND_LETTERS = 'MmLlHhVvCcSsQqTtAaZz';

/**
 * Number scanner for the path data grammar.
 *
 * The grammar allows separators to be omitted wherever the result is still
 * unambiguous — `1.5.3` is two numbers, `10-5` is two numbers — so this cannot
 * be a split on whitespace.
 */
class Scanner {
    private pos = 0;
    /** Sticky so a match is anchored at the cursor rather than found downstream. */
    private static readonly NUMBER = /[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/y;

    constructor(private readonly text: string) { }

    private isSeparator(ch: string): boolean {
        return ch === ',' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
    }

    skipSeparators(): void {
        while (this.pos < this.text.length && this.isSeparator(this.text[this.pos])) this.pos++;
    }

    atEnd(): boolean {
        this.skipSeparators();
        return this.pos >= this.text.length;
    }

    /** The command letter at the cursor, consumed; null if a parameter is next. */
    readCommand(): string | null {
        this.skipSeparators();
        const ch = this.text[this.pos];
        if (ch && COMMAND_LETTERS.includes(ch)) {
            this.pos++;
            return ch;
        }
        return null;
    }

    hasNumber(): boolean {
        this.skipSeparators();
        Scanner.NUMBER.lastIndex = this.pos;
        return Scanner.NUMBER.test(this.text);
    }

    readNumber(): number {
        this.skipSeparators();
        Scanner.NUMBER.lastIndex = this.pos;
        const match = Scanner.NUMBER.exec(this.text);
        if (!match || match.index !== this.pos) {
            throw new PathDataError(`Expected a number at offset ${this.pos} of path data`);
        }
        this.pos = Scanner.NUMBER.lastIndex;
        const value = parseFloat(match[0]);
        if (!Number.isFinite(value)) {
            throw new PathDataError(`Non-finite number "${match[0]}" in path data`);
        }
        return value;
    }

    /**
     * An arc flag is a single character, not a number: in `a1 1 0 011 1` the
     * flags are `0` and `1` and the endpoint is `1,1`. Reading these as numbers
     * is the classic way to mis-parse an arc.
     */
    readFlag(): boolean {
        this.skipSeparators();
        const ch = this.text[this.pos];
        if (ch !== '0' && ch !== '1') {
            throw new PathDataError(`Expected an arc flag (0 or 1) at offset ${this.pos} of path data`);
        }
        this.pos++;
        return ch === '1';
    }
}

/**
 * Parse a `d` attribute into absolute commands.
 *
 * Throws `PathDataError` rather than guessing at malformed data — the caller has
 * the DOM and can fall back to sampling what the browser thinks the path is.
 */
export function parsePathData(d: string): PathCommand[] {
    const scanner = new Scanner(d);
    const commands: PathCommand[] = [];

    // Current point, and the start of the current subpath (where Z returns to).
    let cx = 0, cy = 0;
    let startX = 0, startY = 0;
    // Reflected-control-point state for the S and T shorthands.
    let lastCubicCtrl: Point | null = null;
    let lastQuadCtrl: Point | null = null;
    let command: string | null = null;

    while (!scanner.atEnd()) {
        const next = scanner.readCommand();
        if (next !== null) {
            command = next;
        } else if (command === null) {
            throw new PathDataError('Path data does not start with a command');
        }
        // Otherwise the previous command repeats implicitly with new parameters.

        const relative: boolean = command === command!.toLowerCase();
        const type = command!.toUpperCase();

        // Path data has to open with a moveto. Anything else is in error, and
        // the current point it would draw from is undefined.
        if (commands.length === 0 && type !== 'M') {
            throw new PathDataError(`Path data starts with "${command}" rather than a moveto`);
        }
        // Relative offsets are against the current point, which every branch
        // below updates, so read it once per parameter group.
        const ox = relative ? cx : 0;
        const oy = relative ? cy : 0;

        switch (type) {
            case 'M': {
                const x = scanner.readNumber() + ox;
                const y = scanner.readNumber() + oy;
                commands.push({ type: 'M', x, y });
                cx = startX = x;
                cy = startY = y;
                lastCubicCtrl = lastQuadCtrl = null;
                // Further parameters after a moveto are implicit linetos.
                command = relative ? 'l' : 'L';
                break;
            }
            case 'L': {
                const x = scanner.readNumber() + ox;
                const y = scanner.readNumber() + oy;
                commands.push({ type: 'L', x, y });
                cx = x; cy = y;
                lastCubicCtrl = lastQuadCtrl = null;
                break;
            }
            case 'H': {
                const x = scanner.readNumber() + ox;
                commands.push({ type: 'L', x, y: cy });
                cx = x;
                lastCubicCtrl = lastQuadCtrl = null;
                break;
            }
            case 'V': {
                const y = scanner.readNumber() + oy;
                commands.push({ type: 'L', x: cx, y });
                cy = y;
                lastCubicCtrl = lastQuadCtrl = null;
                break;
            }
            case 'C': {
                const x1 = scanner.readNumber() + ox;
                const y1 = scanner.readNumber() + oy;
                const x2 = scanner.readNumber() + ox;
                const y2 = scanner.readNumber() + oy;
                const x = scanner.readNumber() + ox;
                const y = scanner.readNumber() + oy;
                commands.push({ type: 'C', x1, y1, x2, y2, x, y });
                cx = x; cy = y;
                lastCubicCtrl = { x: x2, y: y2 };
                lastQuadCtrl = null;
                break;
            }
            case 'S': {
                // The first control point mirrors the previous one about the
                // current point; with no previous cubic it coincides with it.
                const x1: number = lastCubicCtrl ? 2 * cx - lastCubicCtrl.x : cx;
                const y1: number = lastCubicCtrl ? 2 * cy - lastCubicCtrl.y : cy;
                const x2 = scanner.readNumber() + ox;
                const y2 = scanner.readNumber() + oy;
                const x = scanner.readNumber() + ox;
                const y = scanner.readNumber() + oy;
                commands.push({ type: 'C', x1, y1, x2, y2, x, y });
                cx = x; cy = y;
                lastCubicCtrl = { x: x2, y: y2 };
                lastQuadCtrl = null;
                break;
            }
            case 'Q': {
                const x1 = scanner.readNumber() + ox;
                const y1 = scanner.readNumber() + oy;
                const x = scanner.readNumber() + ox;
                const y = scanner.readNumber() + oy;
                commands.push({ type: 'Q', x1, y1, x, y });
                cx = x; cy = y;
                lastQuadCtrl = { x: x1, y: y1 };
                lastCubicCtrl = null;
                break;
            }
            case 'T': {
                const x1: number = lastQuadCtrl ? 2 * cx - lastQuadCtrl.x : cx;
                const y1: number = lastQuadCtrl ? 2 * cy - lastQuadCtrl.y : cy;
                const x = scanner.readNumber() + ox;
                const y = scanner.readNumber() + oy;
                commands.push({ type: 'Q', x1, y1, x, y });
                cx = x; cy = y;
                lastQuadCtrl = { x: x1, y: y1 };
                lastCubicCtrl = null;
                break;
            }
            case 'A': {
                const rx = scanner.readNumber();
                const ry = scanner.readNumber();
                const rotation = scanner.readNumber();
                const largeArc = scanner.readFlag();
                const sweep = scanner.readFlag();
                const x = scanner.readNumber() + ox;
                const y = scanner.readNumber() + oy;
                commands.push({ type: 'A', rx, ry, rotation, largeArc, sweep, x, y });
                cx = x; cy = y;
                lastCubicCtrl = lastQuadCtrl = null;
                break;
            }
            case 'Z': {
                commands.push({ type: 'Z' });
                cx = startX; cy = startY;
                lastCubicCtrl = lastQuadCtrl = null;
                // Z takes no parameters, so anything else here is malformed.
                if (scanner.hasNumber()) {
                    throw new PathDataError('closepath (Z) does not take parameters');
                }
                break;
            }
            default:
                throw new PathDataError(`Unsupported path command "${command}"`);
        }
    }

    return commands;
}

// ─── Flattening ──────────────────────────────────────────────────────────────

/** Sample count for a curve of roughly this length, at this step. */
function sampleCount(estimatedLength: number, step: number): number {
    if (!(step > 0) || !Number.isFinite(step) || !Number.isFinite(estimatedLength)) return 1;
    return Math.max(1, Math.min(MAX_SAMPLES_PER_CURVE, Math.ceil(estimatedLength / step)));
}

const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(bx - ax, by - ay);

/**
 * Convert commands into polylines, one per subpath.
 *
 * `step` is the target spacing between sampled points on curves, in the same
 * units as the command coordinates. Line vertices are emitted exactly and are
 * unaffected by it.
 */
export function flattenPathData(commands: PathCommand[], step: number): Subpath[] {
    const subpaths: Subpath[] = [];
    let current: Subpath | null = null;
    let cx = 0, cy = 0;
    let startX = 0, startY = 0;

    /**
     * A drawing command with no open subpath — either path data that starts
     * without a moveto, or a command after Z, which per spec begins a new
     * subpath at the closed one's start point.
     */
    const open = (): Subpath => {
        if (current) return current;
        const started: Subpath = { points: [{ x: cx, y: cy }], closed: false };
        current = started;
        subpaths.push(started);
        return started;
    };

    for (const command of commands) {
        switch (command.type) {
            case 'M':
                current = { points: [{ x: command.x, y: command.y }], closed: false };
                subpaths.push(current);
                cx = startX = command.x;
                cy = startY = command.y;
                break;

            case 'L':
                open().points.push({ x: command.x, y: command.y });
                cx = command.x; cy = command.y;
                break;

            case 'C': {
                const points = open().points;
                // Average of the chord and the control polygon: the two bound
                // the true arc length from below and above.
                const chord = dist(cx, cy, command.x, command.y);
                const polygon = dist(cx, cy, command.x1, command.y1)
                    + dist(command.x1, command.y1, command.x2, command.y2)
                    + dist(command.x2, command.y2, command.x, command.y);
                const n = sampleCount((chord + polygon) / 2, step);
                for (let i = 1; i <= n; i++) {
                    const t = i / n;
                    const u = 1 - t;
                    points.push({
                        x: u * u * u * cx + 3 * u * u * t * command.x1 + 3 * u * t * t * command.x2 + t * t * t * command.x,
                        y: u * u * u * cy + 3 * u * u * t * command.y1 + 3 * u * t * t * command.y2 + t * t * t * command.y,
                    });
                }
                cx = command.x; cy = command.y;
                break;
            }

            case 'Q': {
                const points = open().points;
                const chord = dist(cx, cy, command.x, command.y);
                const polygon = dist(cx, cy, command.x1, command.y1)
                    + dist(command.x1, command.y1, command.x, command.y);
                const n = sampleCount((chord + polygon) / 2, step);
                for (let i = 1; i <= n; i++) {
                    const t = i / n;
                    const u = 1 - t;
                    points.push({
                        x: u * u * cx + 2 * u * t * command.x1 + t * t * command.x,
                        y: u * u * cy + 2 * u * t * command.y1 + t * t * command.y,
                    });
                }
                cx = command.x; cy = command.y;
                break;
            }

            case 'A': {
                const points = open().points;
                appendArc(points, cx, cy, command, step);
                cx = command.x; cy = command.y;
                break;
            }

            case 'Z':
                if (current) {
                    // `closed` already implies the segment home, so a path that
                    // spells the return out would otherwise carry a zero-length
                    // segment into the pipeline.
                    const points = current.points;
                    if (points.length > 2) {
                        const last = points[points.length - 1];
                        if (Math.abs(last.x - startX) < CLOSE_EPSILON
                            && Math.abs(last.y - startY) < CLOSE_EPSILON) {
                            points.pop();
                        }
                    }
                    current.closed = true;
                    current = null;
                }
                cx = startX; cy = startY;
                break;
        }
    }

    // A lone moveto draws nothing.
    return subpaths.filter(subpath => subpath.points.length >= 2);
}

/** Parse and flatten in one step. Throws `PathDataError` on malformed data. */
export function flattenPath(d: string, step: number): Subpath[] {
    return flattenPathData(parsePathData(d), step);
}

/**
 * Append an elliptical arc, converting the endpoint parameterization SVG uses
 * into the centre parameterization needed to walk it (SVG 1.1 appendix F.6.5).
 */
function appendArc(
    points: Point[],
    x1: number, y1: number,
    command: Extract<PathCommand, { type: 'A' }>,
    step: number,
): void {
    const { x: x2, y: y2, largeArc, sweep } = command;
    let rx = Math.abs(command.rx);
    let ry = Math.abs(command.ry);

    // Per spec, a zero radius or a zero-length arc degenerates to a line.
    if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) {
        points.push({ x: x2, y: y2 });
        return;
    }

    const phi = (command.rotation * Math.PI) / 180;
    const cosPhi = Math.cos(phi);
    const sinPhi = Math.sin(phi);

    // Midpoint of the chord, in the ellipse's own frame.
    const dx = (x1 - x2) / 2;
    const dy = (y1 - y2) / 2;
    const x1p = cosPhi * dx + sinPhi * dy;
    const y1p = -sinPhi * dx + cosPhi * dy;

    // Radii too small to span the chord are scaled up until they just fit.
    const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lambda > 1) {
        const scale = Math.sqrt(lambda);
        rx *= scale;
        ry *= scale;
    }

    const rxSq = rx * rx;
    const rySq = ry * ry;
    const numerator = rxSq * rySq - rxSq * y1p * y1p - rySq * x1p * x1p;
    const denominator = rxSq * y1p * y1p + rySq * x1p * x1p;
    const factor = (largeArc === sweep ? -1 : 1)
        * Math.sqrt(Math.max(0, numerator / denominator));

    const cxp = (factor * rx * y1p) / ry;
    const cyp = (-factor * ry * x1p) / rx;
    const centreX = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
    const centreY = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;

    const startVecX = (x1p - cxp) / rx;
    const startVecY = (y1p - cyp) / ry;
    const endVecX = (-x1p - cxp) / rx;
    const endVecY = (-y1p - cyp) / ry;

    const theta1 = angleBetweenVectors(1, 0, startVecX, startVecY);
    let sweepAngle = angleBetweenVectors(startVecX, startVecY, endVecX, endVecY);
    if (!sweep && sweepAngle > 0) sweepAngle -= 2 * Math.PI;
    else if (sweep && sweepAngle < 0) sweepAngle += 2 * Math.PI;

    // Upper bound on the arc length: the larger radius swept through the angle.
    const n = sampleCount(Math.max(rx, ry) * Math.abs(sweepAngle), step);
    for (let i = 1; i <= n; i++) {
        const theta = theta1 + (i / n) * sweepAngle;
        const cosTheta = Math.cos(theta);
        const sinTheta = Math.sin(theta);
        points.push({
            x: cosPhi * rx * cosTheta - sinPhi * ry * sinTheta + centreX,
            y: sinPhi * rx * cosTheta + cosPhi * ry * sinTheta + centreY,
        });
    }
}

/** Signed angle from one vector to another, in (-pi, pi]. */
function angleBetweenVectors(ux: number, uy: number, vx: number, vy: number): number {
    const lengths = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    if (lengths === 0) return 0;
    const cosine = Math.min(1, Math.max(-1, (ux * vx + uy * vy) / lengths));
    const sign = ux * vy - uy * vx < 0 ? -1 : 1;
    return sign * Math.acos(cosine);
}

// ─── Shape elements ──────────────────────────────────────────────────────────

/**
 * Parse a `points` attribute (`<polygon>`, `<polyline>`).
 *
 * The attribute is a plain list of numbers — no units, no percentages — so this
 * is read directly rather than through `SVGPointList`. An odd trailing number is
 * dropped, matching how browsers render such a list.
 */
export function parsePointsList(text: string): Point[] {
    const numbers = text
        .split(/[\s,]+/)
        .filter(token => token.length > 0)
        .map(parseFloat);

    const points: Point[] = [];
    for (let i = 0; i + 1 < numbers.length; i += 2) {
        if (!Number.isFinite(numbers[i]) || !Number.isFinite(numbers[i + 1])) break;
        points.push({ x: numbers[i], y: numbers[i + 1] });
    }
    return points;
}

/**
 * A rectangle as a polyline. Corners are exact; rounded corners go through the
 * same arc sampler as path data.
 */
export function rectSubpath(
    x: number, y: number, width: number, height: number,
    rx: number, ry: number, step: number,
): Subpath | null {
    if (!(width > 0) || !(height > 0)) return null;

    // Radii larger than half the side are clamped, not honoured.
    const rIsX = Math.min(Math.abs(rx), width / 2);
    const rIsY = Math.min(Math.abs(ry), height / 2);

    if (rIsX === 0 || rIsY === 0) {
        return {
            points: [
                { x, y },
                { x: x + width, y },
                { x: x + width, y: y + height },
                { x, y: y + height },
            ],
            closed: true,
        };
    }

    const commands: PathCommand[] = [
        { type: 'M', x: x + rIsX, y },
        { type: 'L', x: x + width - rIsX, y },
        arc(rIsX, rIsY, x + width, y + rIsY),
        { type: 'L', x: x + width, y: y + height - rIsY },
        arc(rIsX, rIsY, x + width - rIsX, y + height),
        { type: 'L', x: x + rIsX, y: y + height },
        arc(rIsX, rIsY, x, y + height - rIsY),
        { type: 'L', x, y: y + rIsY },
        arc(rIsX, rIsY, x + rIsX, y),
        { type: 'Z' },
    ];
    return flattenPathData(commands, step)[0] ?? null;
}

/** A quarter-turn corner arc: always the short way round, clockwise on screen. */
function arc(rx: number, ry: number, x: number, y: number): PathCommand {
    return { type: 'A', rx, ry, rotation: 0, largeArc: false, sweep: true, x, y };
}

/**
 * An ellipse as a closed polyline, sampled at the given step.
 *
 * Unlike the shapes above there are no vertices to preserve, but generating the
 * points here keeps every element on one density rule and off the DOM.
 */
export function ellipseSubpath(
    cx: number, cy: number, rx: number, ry: number, step: number,
): Subpath | null {
    rx = Math.abs(rx);
    ry = Math.abs(ry);
    if (rx === 0 || ry === 0) return null;

    // Ramanujan's approximation — good to a few parts per million at any
    // eccentricity these documents will contain.
    const perimeter = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)));
    const n = Math.max(8, sampleCount(perimeter, step));

    const points: Point[] = [];
    for (let i = 0; i < n; i++) {
        const theta = (i / n) * 2 * Math.PI;
        points.push({ x: cx + rx * Math.cos(theta), y: cy + ry * Math.sin(theta) });
    }
    return { points, closed: true };
}
