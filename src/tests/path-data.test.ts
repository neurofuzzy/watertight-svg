import { describe, it, expect } from 'vitest';
import {
    parsePathData,
    flattenPath,
    flattenPathData,
    rectSubpath,
    ellipseSubpath,
    PathDataError,
    type PathCommand,
} from '../geometry/path-data';
import type { Point } from '../geometry/types';

/** Does this polyline pass through the given point? */
function hasVertex(points: Point[], x: number, y: number, tolerance = 1e-9): boolean {
    return points.some(p => Math.abs(p.x - x) < tolerance && Math.abs(p.y - y) < tolerance);
}

/** How deeply a corner was cut: distance from the vertex to the nearest segment. */
function cutDepth(vertex: Point, points: Point[]): number {
    let best = Infinity;
    for (let i = 0; i < points.length - 1; i++) {
        const a = points[i], b = points[i + 1];
        const dx = b.x - a.x, dy = b.y - a.y;
        const lengthSq = dx * dx + dy * dy;
        const t = lengthSq > 0
            ? Math.max(0, Math.min(1, ((vertex.x - a.x) * dx + (vertex.y - a.y) * dy) / lengthSq))
            : 0;
        best = Math.min(best, Math.hypot(vertex.x - (a.x + t * dx), vertex.y - (a.y + t * dy)));
    }
    return best;
}

describe('parsePathData', () => {
    it('parses absolute linetos', () => {
        expect(parsePathData('M 0 0 L 10 0 L 5 10 Z')).toEqual([
            { type: 'M', x: 0, y: 0 },
            { type: 'L', x: 10, y: 0 },
            { type: 'L', x: 5, y: 10 },
            { type: 'Z' },
        ]);
    });

    it('resolves relative commands against the current point', () => {
        expect(parsePathData('m 5 5 l 10 0 l 0 10')).toEqual([
            { type: 'M', x: 5, y: 5 },
            { type: 'L', x: 15, y: 5 },
            { type: 'L', x: 15, y: 15 },
        ]);
    });

    it('treats extra parameters after a moveto as implicit linetos', () => {
        expect(parsePathData('M0,0 10,0 5,10z')).toEqual([
            { type: 'M', x: 0, y: 0 },
            { type: 'L', x: 10, y: 0 },
            { type: 'L', x: 5, y: 10 },
            { type: 'Z' },
        ]);
    });

    it('keeps a relative moveto\'s implicit linetos relative', () => {
        expect(parsePathData('m10,10 5,0 0,5')).toEqual([
            { type: 'M', x: 10, y: 10 },
            { type: 'L', x: 15, y: 10 },
            { type: 'L', x: 15, y: 15 },
        ]);
    });

    it('expands H and V into linetos', () => {
        expect(parsePathData('M2,3 H10 V20 h-4 v-5')).toEqual([
            { type: 'M', x: 2, y: 3 },
            { type: 'L', x: 10, y: 3 },
            { type: 'L', x: 10, y: 20 },
            { type: 'L', x: 6, y: 20 },
            { type: 'L', x: 6, y: 15 },
        ]);
    });

    it('reads numbers with omitted separators', () => {
        // "1.5.3" is two numbers, and "10-5" is two numbers: the grammar allows
        // a separator to be dropped wherever the result stays unambiguous.
        expect(parsePathData('M1.5.3L10-5')).toEqual([
            { type: 'M', x: 1.5, y: 0.3 },
            { type: 'L', x: 10, y: -5 },
        ]);
    });

    it('reads exponent notation', () => {
        expect(parsePathData('M1e2,2E-1 L+3,.5')).toEqual([
            { type: 'M', x: 100, y: 0.2 },
            { type: 'L', x: 3, y: 0.5 },
        ]);
    });

    it('reflects the control point for S', () => {
        const commands = parsePathData('M0,0 C1,1 2,2 3,3 S5,5 6,6');
        // The reflection of (2,2) about the current point (3,3) is (4,4).
        expect(commands[2]).toEqual({ type: 'C', x1: 4, y1: 4, x2: 5, y2: 5, x: 6, y: 6 });
    });

    it('uses the current point when S has no preceding cubic', () => {
        const commands = parsePathData('M1,1 S5,5 6,6');
        expect(commands[1]).toEqual({ type: 'C', x1: 1, y1: 1, x2: 5, y2: 5, x: 6, y: 6 });
    });

    it('reflects the control point for T', () => {
        const commands = parsePathData('M0,0 Q1,2 3,3 T6,6');
        expect(commands[2]).toEqual({ type: 'Q', x1: 5, y1: 4, x: 6, y: 6 });
    });

    it('reads arc flags as single characters', () => {
        // The classic mis-parse: "0 011 1" is largeArc=0, sweep=1, endpoint 1,1.
        // Reading the flags as numbers would consume "011" as one value.
        expect(parsePathData('M0,0 a1 1 0 011 1')).toEqual([
            { type: 'M', x: 0, y: 0 },
            { type: 'A', rx: 1, ry: 1, rotation: 0, largeArc: false, sweep: true, x: 1, y: 1 },
        ]);
    });

    it('rejects malformed data so the caller can fall back', () => {
        expect(() => parsePathData('M0,0 L10')).toThrow(PathDataError);
        expect(() => parsePathData('L 10 10')).toThrow(PathDataError);
        expect(() => parsePathData('M0,0 Z 5')).toThrow(PathDataError);
        expect(() => parsePathData('M0,0 A1 1 0 5 1 2 2')).toThrow(PathDataError);
        expect(() => parsePathData('M0,0 X9')).toThrow(PathDataError);
    });
});

describe('flattenPath', () => {
    it('emits polygon vertices exactly, at any step', () => {
        // The bug this module exists to prevent: arc-length sampling lands on a
        // vertex only by luck, so corners get chamfered by up to one step.
        const triangle = 'M0,0 L100,0 L50,86.6 Z';
        for (const step of [0.5, 3, 7, 33, 1000]) {
            const [subpath] = flattenPath(triangle, step);
            expect(subpath.points).toEqual([
                { x: 0, y: 0 },
                { x: 100, y: 0 },
                { x: 50, y: 86.6 },
            ]);
            expect(subpath.closed).toBe(true);
        }
    });

    it('keeps corners of a tiny shape against a document-sized step', () => {
        // wood_plot.svg's smallest hatch triangles are ~1.5mm on an 11in page,
        // where the old sampler cut a quarter off each corner.
        const [subpath] = flattenPath('M348.438,143.436 L351.562,143.436 L350.000,146.141 Z', 2.35);
        for (const corner of [
            { x: 348.438, y: 143.436 },
            { x: 351.562, y: 143.436 },
            { x: 350.0, y: 146.141 },
        ]) {
            expect(hasVertex(subpath.points, corner.x, corner.y)).toBe(true);
            expect(cutDepth(corner, subpath.points)).toBeLessThan(1e-9);
        }
    });

    it('does not repeat the start point of a closed path', () => {
        // "closed" already implies the segment home; spelling the return out as
        // well would push a zero-length segment into the pipeline.
        const [subpath] = flattenPath('M0,0 L10,0 L10,10 L0,0 Z', 5);
        expect(subpath.points).toHaveLength(3);
        expect(subpath.closed).toBe(true);
    });

    it('leaves an unclosed path\'s repeated endpoint alone', () => {
        // Same geometry without Z: the repeat is the only thing joining the ends.
        const [subpath] = flattenPath('M0,0 L10,0 L10,10 L0,0', 5);
        expect(subpath.points).toHaveLength(4);
        expect(subpath.closed).toBe(false);
    });

    it('splits subpaths at each moveto', () => {
        const subpaths = flattenPath('M0,0 L1,0 M5,5 L6,5 L6,6 Z', 1);
        expect(subpaths).toHaveLength(2);
        expect(subpaths[0].closed).toBe(false);
        expect(subpaths[1].closed).toBe(true);
        expect(subpaths[1].points).toHaveLength(3);
    });

    it('starts a new subpath at the closed start when drawing continues after Z', () => {
        const subpaths = flattenPath('M0,0 L10,0 L10,10 Z L20,20', 5);
        expect(subpaths).toHaveLength(2);
        expect(subpaths[1].points[0]).toEqual({ x: 0, y: 0 });
        expect(subpaths[1].points[1]).toEqual({ x: 20, y: 20 });
    });

    it('drops a moveto that draws nothing', () => {
        expect(flattenPath('M5,5', 1)).toHaveLength(0);
    });

    it('samples a cubic without moving its endpoints', () => {
        const [subpath] = flattenPath('M0,0 C0,50 100,50 100,0', 5);
        expect(subpath.points[0]).toEqual({ x: 0, y: 0 });
        expect(subpath.points[subpath.points.length - 1]).toEqual({ x: 100, y: 0 });
        expect(subpath.points.length).toBeGreaterThan(10);

        // t=0.5 of this symmetric curve is (50, 37.5).
        expect(hasVertex(subpath.points, 50, 37.5, 1e-9)).toBe(true);
    });

    it('samples a quadratic on the curve', () => {
        const [subpath] = flattenPath('M0,0 Q50,100 100,0', 5);
        expect(subpath.points[subpath.points.length - 1]).toEqual({ x: 100, y: 0 });
        // This curve is the parabola y = 2x - x^2/50; every sample must be on it.
        for (const p of subpath.points) {
            expect(p.y).toBeCloseTo(2 * p.x - (p.x * p.x) / 50, 9);
        }
        expect(Math.max(...subpath.points.map(p => p.y))).toBeCloseTo(50, 1);
    });

    it('scales curve density with the step', () => {
        const coarse = flattenPath('M0,0 C0,50 100,50 100,0', 20)[0].points.length;
        const fine = flattenPath('M0,0 C0,50 100,50 100,0', 2)[0].points.length;
        expect(fine).toBeGreaterThan(coarse * 5);
    });

    it('walks an arc along its true radius', () => {
        // Quarter circle of radius 100, centred on the origin.
        const [subpath] = flattenPath('M100,0 A100,100 0 0 1 0,100', 5);
        expect(subpath.points[subpath.points.length - 1].x).toBeCloseTo(0, 9);
        expect(subpath.points[subpath.points.length - 1].y).toBeCloseTo(100, 9);
        for (const p of subpath.points) {
            expect(Math.hypot(p.x, p.y)).toBeCloseTo(100, 6);
        }
    });

    it('honours the arc sweep flag', () => {
        // Same endpoints and radius, so the two flags pick the two different
        // centres a radius-100 circle through (100,0) and (0,100) can have.
        const sweep = flattenPath('M100,0 A100,100 0 0 1 0,100', 5)[0].points;
        const antiSweep = flattenPath('M100,0 A100,100 0 0 0 0,100', 5)[0].points;
        for (const p of sweep) expect(Math.hypot(p.x, p.y)).toBeCloseTo(100, 6);
        for (const p of antiSweep) expect(Math.hypot(p.x - 100, p.y - 100)).toBeCloseTo(100, 6);
    });

    it('honours the large-arc flag', () => {
        // largeArc flips the centre as well, so the long way round from (100,0)
        // to (0,100) at sweep=1 is the 270° arc about (100,100).
        const short = flattenPath('M100,0 A100,100 0 0 1 0,100', 5)[0].points;
        const long = flattenPath('M100,0 A100,100 0 1 1 0,100', 5)[0].points;
        expect(long.length).toBeGreaterThan(short.length * 2);
        for (const p of long) expect(Math.hypot(p.x - 100, p.y - 100)).toBeCloseTo(100, 6);
        // The long arc reaches the far side of that circle; the short one cannot.
        expect(Math.max(...long.map(p => p.y))).toBeCloseTo(200, 1);
    });

    it('scales up radii too small to span the chord', () => {
        // Per spec these are enlarged until they just reach, rather than failing.
        const [subpath] = flattenPath('M0,0 A1,1 0 0 1 100,0', 5);
        const last = subpath.points[subpath.points.length - 1];
        expect(last.x).toBeCloseTo(100, 9);
        expect(last.y).toBeCloseTo(0, 9);
        // Radius is enlarged to 50, so the arc bulges exactly that far.
        const extreme = Math.max(...subpath.points.map(p => Math.abs(p.y)));
        expect(extreme).toBeCloseTo(50, 6);
    });

    it('treats a zero-radius arc as a line', () => {
        const [subpath] = flattenPath('M0,0 A0,0 0 0 1 10,10', 1);
        expect(subpath.points).toEqual([{ x: 0, y: 0 }, { x: 10, y: 10 }]);
    });

    it('applies the arc x-axis rotation', () => {
        // A flat ellipse rotated 90° bulges along x instead of y.
        const [subpath] = flattenPath('M0,0 A50,10 90 0 1 0,100', 5);
        const extreme = Math.max(...subpath.points.map(p => Math.abs(p.x)));
        expect(extreme).toBeCloseTo(10, 6);
    });
});

describe('flattenPathData', () => {
    it('accepts commands built directly, without a d string', () => {
        const commands: PathCommand[] = [
            { type: 'M', x: 0, y: 0 },
            { type: 'L', x: 10, y: 0 },
            { type: 'Z' },
        ];
        expect(flattenPathData(commands, 1)).toEqual([
            { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], closed: true },
        ]);
    });
});

describe('rectSubpath', () => {
    it('emits four exact corners', () => {
        expect(rectSubpath(10, 20, 100, 50, 0, 0, 3)).toEqual({
            points: [
                { x: 10, y: 20 },
                { x: 110, y: 20 },
                { x: 110, y: 70 },
                { x: 10, y: 70 },
            ],
            closed: true,
        });
    });

    it('rounds corners with arcs when given radii', () => {
        const subpath = rectSubpath(0, 0, 100, 100, 10, 10, 2)!;
        expect(subpath.closed).toBe(true);
        // Every point stays inside the rectangle, and the sharp corner is gone.
        for (const p of subpath.points) {
            expect(p.x).toBeGreaterThanOrEqual(-1e-9);
            expect(p.y).toBeGreaterThanOrEqual(-1e-9);
            expect(p.x).toBeLessThanOrEqual(100 + 1e-9);
            expect(p.y).toBeLessThanOrEqual(100 + 1e-9);
        }
        expect(hasVertex(subpath.points, 0, 0)).toBe(false);
        expect(cutDepth({ x: 0, y: 0 }, subpath.points)).toBeGreaterThan(1);
    });

    it('clamps radii to half the side', () => {
        // rx=500 on a 100-wide rect is clamped to 50, giving a stadium shape.
        const subpath = rectSubpath(0, 0, 100, 100, 500, 500, 2)!;
        for (const p of subpath.points) {
            expect(Math.hypot(p.x - 50, p.y - 50)).toBeLessThanOrEqual(50 + 1e-6);
        }
    });

    it('rejects a rectangle with no area', () => {
        expect(rectSubpath(0, 0, 0, 50, 0, 0, 1)).toBeNull();
        expect(rectSubpath(0, 0, 50, -1, 0, 0, 1)).toBeNull();
    });
});

describe('ellipseSubpath', () => {
    it('samples points on the ellipse', () => {
        const subpath = ellipseSubpath(10, 20, 30, 15, 2)!;
        expect(subpath.closed).toBe(true);
        for (const p of subpath.points) {
            const normalized = ((p.x - 10) / 30) ** 2 + ((p.y - 20) / 15) ** 2;
            expect(normalized).toBeCloseTo(1, 9);
        }
    });

    it('never degenerates below a recognisable polygon', () => {
        expect(ellipseSubpath(0, 0, 5, 5, 10_000)!.points.length).toBeGreaterThanOrEqual(8);
    });

    it('rejects a zero radius', () => {
        expect(ellipseSubpath(0, 0, 0, 10, 1)).toBeNull();
    });
});
