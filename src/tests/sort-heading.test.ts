/**
 * Sorting should prefer strokes that continue the previous stroke's heading,
 * without letting that override a materially shorter travel move.
 */

import { describe, it, expect } from 'vitest';
import { sortPaths, calculateTravelDistance, calculateTravelCost } from '../optimize/sort';
import type { Path } from '../geometry/types';

function line(...points: [number, number][]): Path {
    return { points: points.map(([x, y]) => ({ x, y })), closed: false };
}

/** Heading changes (degrees) at each pen-up transition, in order */
function transitionTurns(paths: Path[]): number[] {
    const turns: number[] = [];

    for (let i = 1; i < paths.length; i++) {
        const prev = paths[i - 1].points;
        const curr = paths[i].points;

        const exit = Math.atan2(
            prev[prev.length - 1].y - prev[prev.length - 2].y,
            prev[prev.length - 1].x - prev[prev.length - 2].x
        );
        const entry = Math.atan2(curr[1].y - curr[0].y, curr[1].x - curr[0].x);

        let delta = Math.abs(entry - exit);
        if (delta > Math.PI) delta = 2 * Math.PI - delta;
        turns.push((delta * 180) / Math.PI);
    }

    return turns;
}

describe('heading-aware sorting', () => {
    it('continues the current heading when two candidates are equidistant', () => {
        // Both candidates start exactly 10 away from where the first stroke ends.
        // One carries on rightwards, the other doubles back leftwards.
        const sorted = sortPaths([
            line([0, 0], [100, 0]),           // ends heading +x at (100, 0)
            line([110, 40], [10, 40]),        // 10 away (vertically), heads -x
            line([110, 0], [210, 0]),         // 10 away, heads +x - the smooth choice
        ], { x: 0, y: 0 });

        expect(sorted[0].points[0]).toEqual({ x: 0, y: 0 });
        // The straight continuation must be taken before the doubling-back stroke
        expect(sorted[1].points[0]).toEqual({ x: 110, y: 0 });
        expect(transitionTurns(sorted)[0]).toBeLessThan(1);
    });

    it('still takes a much shorter travel over a smoother heading', () => {
        // The aligned candidate is far away; the perpendicular one is adjacent.
        // Travel must stay the dominant term.
        const sorted = sortPaths([
            line([0, 0], [100, 0]),
            line([101, 0], [101, 100]),       // 1 away, turns 90 degrees
            line([900, 0], [1000, 0]),        // 800 away, perfectly aligned
        ], { x: 0, y: 0 });

        expect(sorted[1].points[0]).toEqual({ x: 101, y: 0 });
    });

    it('reverses a stroke when that gives the smoother entry', () => {
        // Drawing the second stroke backwards enters heading +x, matching the
        // first stroke's exit; drawing it forwards would enter heading -x.
        const sorted = sortPaths([
            line([0, 0], [100, 0]),
            line([210, 0], [110, 0]),
        ], { x: 0, y: 0 });

        expect(sorted[1].points[0]).toEqual({ x: 110, y: 0 });
        expect(transitionTurns(sorted)[0]).toBeLessThan(1);
    });

    it('reports pure travel distance separately from the sort objective', () => {
        const paths = [line([0, 0], [10, 0]), line([20, 20], [30, 20])];

        const travel = calculateTravelDistance(paths);
        const cost = calculateTravelCost(paths);

        // Same geometry, but the cost carries an extra heading term
        expect(cost).toBeGreaterThanOrEqual(travel);
        expect(travel).toBeCloseTo(Math.hypot(0, 0) + Math.hypot(10, 20), 6);
    });

    it('leaves single-path and empty inputs alone', () => {
        expect(sortPaths([])).toEqual([]);
        const one = [line([0, 0], [1, 1])];
        expect(sortPaths(one)).toEqual(one);
    });
});
