/**
 * Bridge between the optimizer's output and the vendored nib EBB backend.
 *
 * Like `src/ui/export.ts` and the simulator, this consumes paths that have
 * already been through the post-pipeline transforms in `main.ts` (rotation,
 * scale-to-fit, layering) — it does not apply them itself.
 *
 * Runs on the main thread only: WebSerial lives on `navigator`, so nothing
 * here may be imported from `src/worker.ts` or anything under `src/optimize/`.
 */

import type { Path } from '../geometry/types';
import { EBBBackend } from './vendor/ebb.ts';
import { PlotEmitter } from './vendor/events.ts';
import { WebSerialTransport, requestEbbPort } from './vendor/web-serial.ts';
import type { EbbTransport } from './vendor/transport.ts';
import type { Stroke } from './vendor/stroke.ts';
import type { Profile, ResolvedProfile } from './vendor/job.ts';
import { MACHINE_ENVELOPES, type Envelope } from './vendor/envelope.ts';

export type { Profile, EbbTransport, Envelope, Stroke };
export { WebSerialTransport, requestEbbPort, MACHINE_ENVELOPES };

/** WebSerial is Chromium-only; the Plot UI stays hidden without it. */
export function isPlottingSupported(): boolean {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
}

/**
 * Scale factor from a document's user units into millimetres.
 *
 * The inverse of `mmToDocUnits` in main.ts. nib works exclusively in absolute
 * mm, so this is the boundary where the project's "user units are not pixels"
 * rule has to be cashed out — a `pt` document plotted as if it were mm would
 * come out 2.8x too small.
 */
export function docUnitsToMM(units?: string): number {
    switch (units) {
        case 'in': return 25.4;
        case 'cm': return 10;
        case 'pt': return 25.4 / 72;
        case 'pc': return 25.4 / 6;
        case 'q': return 0.25;
        default: return 1; // mm, or unitless documents which we treat as mm
    }
}

export interface ToStrokesOptions {
    /** Document unit from `SVGDocument.units`; undefined is treated as mm. */
    units?: string;
    /**
     * Depth map from `groupPathsByDepth`. Depth becomes `Stroke.layer`, which
     * nib treats as nib/axicli multi-pen layer metadata. Omit for a single-pen
     * plot — every stroke then lands on layer 0.
     */
    layers?: Map<number, Path[]>;
}

/** Page rectangle in mm. */
export interface Page {
    widthMM: number;
    heightMM: number;
}

/**
 * Rotate a placed stroke list 90° counter-clockwise, carrying the page with it.
 *
 * `(x, y) -> (y, pageWidth - x)`. A true rotation, not a mirror. The page's
 * original **top-right** corner lands on the new origin, which is what makes
 * this the right direction: the machine homes at the origin, and turning a
 * portrait sheet counter-clockwise onto the bed puts its top-right corner
 * under the parked pen.
 */
export function rotateStrokesCCW(strokes: Stroke[], page: Page): { strokes: Stroke[]; page: Page } {
    const w = page.widthMM;
    return {
        strokes: strokes.map(s => ({
            ...s,
            points: s.points.map(p => ({ x: p.y, y: w - p.x })),
        })),
        page: { widthMM: page.heightMM, heightMM: page.widthMM },
    };
}

/**
 * Lay the page landscape, always.
 *
 * An AxiDraw's X travel is the gantry and is the longer axis — the A4 model is
 * 280x218, sized for US Letter *landscape*. Rather than deciding per-document
 * whether a rotation is needed, portrait pages are simply turned 90°
 * counter-clockwise every time. One rule, one orientation, nothing to
 * configure and nothing to get wrong: the paper always goes on the bed the
 * same way round.
 */
export function orientLandscape(
    strokes: Stroke[],
    page: Page,
): { strokes: Stroke[]; page: Page; rotated: boolean } {
    if (page.widthMM >= page.heightMM) return { strokes, page, rotated: false };
    return { ...rotateStrokesCCW(strokes, page), rotated: true };
}

/**
 * Convert optimizer paths into nib strokes.
 *
 * Two things change: a closed path gets its first point repeated so the pen
 * actually draws the final edge back to the start (nib strokes are open
 * polylines — `closed` has no representation), and coordinates are scaled into
 * absolute mm.
 */
export function pathsToStrokes(paths: Path[], options: ToStrokesOptions = {}): Stroke[] {
    const k = docUnitsToMM(options.units);

    // Invert the depth map once so lookup per path is O(1).
    const layerOf = new Map<Path, number>();
    if (options.layers) {
        for (const [depth, group] of options.layers) {
            for (const p of group) layerOf.set(p, depth);
        }
    }

    const strokes: Stroke[] = [];
    for (const path of paths) {
        if (path.points.length < 2) continue;

        const points = path.points.map(p => ({ x: p.x * k, y: p.y * k }));
        if (path.closed) {
            const first = path.points[0];
            points.push({ x: first.x * k, y: first.y * k });
        }

        strokes.push({ points, layer: layerOf.get(path) ?? 0 });
    }
    return strokes;
}

export interface PlacementOptions {
    units?: string;
    layers?: Map<number, Path[]>;
    /** Page size in document units, as reported by `prepareOutput`. */
    page: { width: number; height: number };
}

export interface Placement {
    strokes: Stroke[];
    /** Oriented page, in mm. Always landscape. */
    page: Page;
    /** True when a portrait page was turned to get there. */
    rotated: boolean;
}

/**
 * Turn optimizer paths into machine-ready strokes: convert to mm, then lay the
 * page landscape.
 *
 * The page corner always lands on the machine origin, so there is nothing to
 * configure — no home-corner setting, no orientation toggle. Load the paper
 * landscape with its corner under the parked pen and it is correct.
 */
export function placeForMachine(paths: Path[], options: PlacementOptions): Placement {
    const k = docUnitsToMM(options.units);
    const base = pathsToStrokes(paths, { units: options.units, layers: options.layers });
    const page: Page = {
        widthMM: options.page.width * k,
        heightMM: options.page.height * k,
    };

    return orientLandscape(base, page);
}

/** Extent of a stroke list in mm, measured from the origin. */
export function strokeBounds(strokes: Stroke[]): {
    minX: number; minY: number; maxX: number; maxY: number;
} {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of strokes) {
        for (const p of s.points) {
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }
    }
    return { minX, minY, maxX, maxY };
}

/**
 * Pre-flight bounds check on the actual geometry, not the page.
 *
 * nib checks the envelope per-move and aborts on violation, but by then the
 * carriage is already at the boundary. Checking up front means an oversize job
 * is refused before the pen ever moves. Returns null when the job is safe, or a
 * human-readable reason when it is not.
 */
export function envelopeViolation(
    strokes: Stroke[],
    envelope: Envelope,
): string | null {
    if (strokes.length === 0) return null;
    const b = strokeBounds(strokes);
    const over: string[] = [];
    if (b.minX < -0.1) over.push(`${(-b.minX).toFixed(0)}mm left of the origin`);
    if (b.minY < -0.1) over.push(`${(-b.minY).toFixed(0)}mm above the origin`);
    if (b.maxX > envelope.widthMm + 0.1) {
        over.push(`${(b.maxX - envelope.widthMm).toFixed(0)}mm past the ${envelope.widthMm}mm X travel`);
    }
    if (b.maxY > envelope.heightMm + 0.1) {
        over.push(`${(b.maxY - envelope.heightMm).toFixed(0)}mm past the ${envelope.heightMm}mm Y travel`);
    }
    if (over.length === 0) return null;
    return `Drawing is ${b.maxX.toFixed(0)}×${b.maxY.toFixed(0)}mm — ${over.join(', ')}.`;
}

/**
 * Speeds are percentages of nib's LM caps, not absolute rates — 50% pen-down is
 * 25mm/s, 100% pen-up is 100mm/s. Percentages are not comparable to axicli's,
 * which scale against different internal maxima, so `speedToMms` exists to show
 * the real figure in the UI.
 */
export const LM_PENDOWN_MAX_MMS = 50;
export const LM_PENUP_MAX_MMS = 100;

/** Resolve a profile speed percentage to mm/s on the LM path. */
export function speedToMms(percent: number, penDown: boolean): number {
    return (percent / 100) * (penDown ? LM_PENDOWN_MAX_MMS : LM_PENUP_MAX_MMS);
}

/**
 * Starting point for a fineliner; the UI lets these be edited.
 *
 * 25mm/s pen-down is the usual comfortable rate for a fineliner on smooth
 * paper. Pen-up runs at the cap — there is no reason to travel slowly with the
 * pen off the page, and it dominates plot time on sparse drawings.
 */
export const DEFAULT_PROFILE: Profile = {
    speedPendown: 50,   // 25 mm/s
    speedPenup: 100,    // 100 mm/s
    penPosDown: 30,
    penPosUp: 60,
    accel: 75,
};

export interface PlotRunOptions {
    profile: Profile;
    envelope?: Envelope;
    /** Plot only this nesting depth. Omit to plot every layer in one pass. */
    layer?: number;
    /**
     * Douglas-Peucker tolerance in mm applied to the move list. The parser
     * samples curves into dense polylines, so a small non-zero value here cuts
     * the number of LM commands streamed to the board considerably.
     */
    simplifyMm?: number;
    onProgress?: (fraction: number, etaSeconds: number) => void;
    /** Fires as the pen lands on stroke N, before it is drawn. */
    onPenDown?: (strokeIndex: number) => void;
    /** Fires as the pen lifts off stroke N, before the travel to N+1. */
    onPenUp?: (strokeIndex: number) => void;
    signal?: AbortSignal;
}

export interface PlotResult {
    aborted: boolean;
    /** Fraction of the plot completed, 0-1. */
    stoppedAt: number;
}

/**
 * One connected plotter, alive across multiple plots.
 *
 * The session owns a single `EBBBackend` on purpose. The backend tracks arm
 * position in software — there is no "where are you?" query that survives, and
 * the firmware's own HM homes to *mechanical* home rather than the origin the
 * user parked. So position only exists for as long as the instance that
 * accumulated it. Creating a backend per plot would silently reset that to
 * (0,0) and make `home()` a no-op that strands the arm mid-page.
 *
 * Motors therefore stay energised between plots, and are only released by
 * `releaseMotors()` or `close()`.
 */
export class PlotSession {
    private backend: EBBBackend;
    private connected = false;

    constructor(transport: EbbTransport) {
        this.backend = new EBBBackend(transport);
    }

    private async ensureConnected(): Promise<void> {
        if (!this.connected) {
            await this.backend.connect();
            this.connected = true;
        }
    }

    /** Arm position in mm relative to the origin, as tracked in software. */
    get position(): { x: number; y: number } {
        return this.backend.currentPosition;
    }

    /**
     * Firmware capabilities, populated by `connect()`.
     *
     * `lm` is the one that matters for speed: without it every move falls back
     * to the SM command, which has no acceleration ramp and is therefore capped
     * at 10mm/s pen-down and 13mm/s pen-up regardless of the profile. LM needs
     * firmware >= 2.7.0. Note that `connect()` swallows a failed version query
     * and leaves every flag false, so "no LM" can also mean "the board did not
     * answer" rather than "old firmware".
     */
    get capabilities() {
        return this.backend.caps;
    }

    /**
     * Raw response to the EBB `V` command, e.g.
     * `EBBv13_and_above EB Firmware Version 2.8.1`.
     *
     * Use this rather than `capabilities.firmware` when diagnosing: a board
     * that answers with an unparseable string and a board that does not answer
     * at all both surface as version 0.0.0 with every capability disabled.
     */
    async firmwareString(): Promise<string> {
        await this.ensureConnected();
        return this.backend.commands.version();
    }

    /**
     * Plot a stroke list.
     *
     * `optimize` is pinned to 0: the pipeline's 2-opt sort has already
     * minimised pen-up travel, and nib's nearest-neighbour reorder would only
     * undo it.
     *
     * A plot that runs to completion homes itself, as does one aborted by an
     * envelope violation. A plot stopped via `signal` does *not* — see
     * `returnHome: false` in nib's `safeAbort`, which leaves the arm parked for
     * a possible resume. Call `home()` after an aborted plot.
     */
    async plot(strokes: Stroke[], options: PlotRunOptions): Promise<PlotResult> {
        const profile: ResolvedProfile = { name: 'watertight', ...options.profile };
        const emitter = new PlotEmitter();

        if (options.onProgress) {
            emitter.on('progress', options.onProgress);
        }
        // The events carry no index, so they are counted here. nib emits one of
        // each per stroke, and pen:up only fires when the pen was actually
        // down, so the two counters stay aligned with the stroke list.
        if (options.onPenDown) {
            let i = 0;
            emitter.on('pen:down', () => options.onPenDown!(i++));
        }
        if (options.onPenUp) {
            let i = 0;
            emitter.on('pen:up', () => options.onPenUp!(i++));
        }

        await this.ensureConnected();
        try {
            const result = await this.backend.runStrokes(profile, strokes, emitter, options.signal, {
                optimize: 0,
                envelope: options.envelope,
                layer: options.layer,
                simplifyMm: options.simplifyMm,
            });
            return { aborted: result.aborted, stoppedAt: result.stoppedAt };
        } finally {
            emitter.removeAllListeners();
            // Deliberately not shutdown() here — that disables the motors, and
            // the arm has to stay energised for home() to mean anything.
            await this.backend.liftPen().catch(() => undefined);
        }
    }

    /**
     * Seek the machine's own home corner via the firmware's HM command.
     *
     * Absolute rather than relative, so unlike `home()` this is correct even
     * after an emergency stop has invalidated software tracking — it is the
     * recovery path. The cost is that HM homes to the *machine's* corner, not
     * the paper origin the user set, and it redefines the origin to that
     * corner: re-park before plotting again.
     *
     * Requires EBB firmware >= 2.6.2; throws a descriptive error otherwise.
     */
    async homeMachine(): Promise<void> {
        await this.ensureConnected();
        await this.backend.homeMachine();
    }

    /** De-energise the steppers so the arm can be positioned by hand. */
    async releaseMotors(): Promise<void> {
        await this.ensureConnected();
        await this.backend.releaseMotors();
    }

    /** Re-energise the steppers, making the current position the new origin. */
    async reenableMotors(): Promise<void> {
        await this.ensureConnected();
        await this.backend.reenableMotors();
    }

    /** Park the pen up, release the motors, and close the serial port. */
    async close(): Promise<void> {
        try {
            await this.backend.disconnect();
        } finally {
            this.connected = false;
        }
    }
}
