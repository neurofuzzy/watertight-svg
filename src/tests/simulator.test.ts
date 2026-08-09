import { describe, it, expect } from 'vitest';
import type { Path } from '../geometry/types';
import { buildDistanceTable } from '../ui/simulator';

/**
 * `buildDistanceTable` defines the simulator's progress axis, which is measured
 * in distance rather than time. It is also what the follow-along indexes into
 * to track a live plot, so the start/end figures have to line up with the
 * plotter's per-stroke events exactly.
 */

const line = (pts: [number, number][], closed = false): Path => ({
    points: pts.map(([x, y]) => ({ x, y })),
    closed,
});

describe('buildDistanceTable', () => {
    it('accumulates a single open path', () => {
        // 3-4-5 triangle legs: 30 then 40.
        const t = buildDistanceTable([line([[0, 0], [30, 0], [30, 40]])]);
        expect(t.startDist).toEqual([0]);
        expect(t.endDist).toEqual([70]);
        expect(t.totalDistance).toBe(70);
    });

    it('includes the closing segment of a closed path', () => {
        // 10x10 square drawn open would be 30; closed adds the 4th side.
        const t = buildDistanceTable([line([[0, 0], [10, 0], [10, 10], [0, 10]], true)]);
        expect(t.endDist).toEqual([40]);
    });

    it('counts pen-up travel between paths', () => {
        const t = buildDistanceTable([
            line([[0, 0], [10, 0]]),    // draws 10
            line([[30, 0], [40, 0]]),   // travels 20, draws 10
        ]);
        expect(t.startDist).toEqual([0, 30]);
        expect(t.endDist).toEqual([10, 40]);
        expect(t.totalDistance).toBe(40);
    });

    it('returns to the first point of a closed path before travelling on', () => {
        const t = buildDistanceTable([
            line([[0, 0], [10, 0], [10, 10], [0, 10]], true),  // ends back at 0,0
            line([[0, 50], [0, 60]]),                          // travel is 50, not 40
        ]);
        expect(t.startDist[1] - t.endDist[0]).toBe(50);
    });

    it('skips paths that cannot be drawn, keeping indices contiguous', () => {
        const t = buildDistanceTable([
            line([[0, 0], [10, 0]]),
            line([[99, 99]]),           // single point — never drawn
            line([[10, 0], [20, 0]]),
        ]);
        expect(t.startDist).toHaveLength(2);
        expect(t.endDist).toEqual([10, 20]);
    });

    it('keeps start strictly before end for every drawn path', () => {
        const t = buildDistanceTable([
            line([[0, 0], [5, 0]]),
            line([[20, 0], [25, 5]]),
            line([[0, 40], [8, 40], [8, 48]], true),
        ]);
        for (let i = 0; i < t.endDist.length; i++) {
            expect(t.startDist[i]).toBeLessThan(t.endDist[i]);
        }
    });

    it('produces monotonically increasing distances', () => {
        const t = buildDistanceTable([
            line([[0, 0], [10, 10]]),
            line([[40, 0], [50, 10]]),
            line([[80, 0], [90, 10]]),
        ]);
        const flat = t.startDist.flatMap((s, i) => [s, t.endDist[i]]);
        for (let i = 1; i < flat.length; i++) {
            expect(flat[i]).toBeGreaterThanOrEqual(flat[i - 1]);
        }
        expect(t.totalDistance).toBe(flat[flat.length - 1]);
    });

    it('handles an empty list without dividing by zero downstream', () => {
        const t = buildDistanceTable([]);
        expect(t).toEqual({ startDist: [], endDist: [], totalDistance: 0 });
    });
});
