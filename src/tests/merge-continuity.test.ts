/**
 * Merge continuity tests
 *
 * At a junction where several chains meet, the merge should follow the smallest
 * heading change so curves flow through crossings instead of turning onto the
 * crossing curve.
 */

import { describe, it, expect } from 'vitest';
import { mergePaths } from '../optimize/merge';
import type { Path, Point } from '../geometry/types';

function line(...points: [number, number][]): Path {
    return { points: points.map(([x, y]) => ({ x, y })), closed: false };
}

/** Largest turn angle (degrees) anywhere along a path */
function maxTurn(path: Path): number {
    let worst = 0;

    for (let i = 1; i < path.points.length - 1; i++) {
        const prev = path.points[i - 1];
        const curr = path.points[i];
        const next = path.points[i + 1];

        const inAngle = Math.atan2(curr.y - prev.y, curr.x - prev.x);
        const outAngle = Math.atan2(next.y - curr.y, next.x - curr.x);

        let delta = Math.abs(outAngle - inAngle);
        if (delta > Math.PI) delta = 2 * Math.PI - delta;

        worst = Math.max(worst, (delta * 180) / Math.PI);
    }

    return worst;
}

function spans(path: Path, from: Point, to: Point): boolean {
    const first = path.points[0];
    const last = path.points[path.points.length - 1];
    const hits = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-6;
    return (hits(first, from) && hits(last, to)) || (hits(first, to) && hits(last, from));
}

describe('merge continuity at junctions', () => {
    it('carries straight through a four-way crossing', () => {
        // Horizontal and vertical lines, each split at the shared origin -
        // the shape splitPathsAtIntersections produces at a crossing.
        const merged = mergePaths([
            line([-10, 0], [0, 0]),
            line([0, 0], [10, 0]),
            line([0, -10], [0, 0]),
            line([0, 0], [0, 10]),
        ], 0.1);

        expect(merged).toHaveLength(2);

        // Neither chain may contain a corner: an L-shaped merge turns 90 degrees
        for (const path of merged) {
            expect(maxTurn(path)).toBeLessThan(1);
        }

        const horizontal = merged.find(p => p.points.every(pt => Math.abs(pt.y) < 1e-6));
        const vertical = merged.find(p => p.points.every(pt => Math.abs(pt.x) < 1e-6));

        expect(horizontal).toBeDefined();
        expect(vertical).toBeDefined();
        expect(spans(horizontal!, { x: -10, y: 0 }, { x: 10, y: 0 })).toBe(true);
        expect(spans(vertical!, { x: 0, y: -10 }, { x: 0, y: 10 })).toBe(true);
    });

    it('picks the straighter branch at a Y junction', () => {
        // A shallow 15-degree branch and a hard 60-degree branch leave the same point
        const shallowEnd = { x: 10 + 10 * Math.cos(Math.PI / 12), y: 10 * Math.sin(Math.PI / 12) };
        const steepEnd = { x: 10 + 10 * Math.cos(Math.PI / 3), y: 10 * Math.sin(Math.PI / 3) };

        const merged = mergePaths([
            line([0, 0], [10, 0]),
            line([10, 0], [shallowEnd.x, shallowEnd.y]),
            line([10, 0], [steepEnd.x, steepEnd.y]),
        ], 0.1);

        // The trunk joins the shallow branch; the steep branch is left on its own
        const trunk = merged.find(p => p.points.length === 3);
        expect(trunk).toBeDefined();
        expect(spans(trunk!, { x: 0, y: 0 }, shallowEnd)).toBe(true);
        expect(maxTurn(trunk!)).toBeLessThan(16);
    });

    it('still merges when only one candidate is available', () => {
        const merged = mergePaths([
            line([0, 0], [10, 0]),
            line([10, 0], [10, 10]),
        ], 0.1);

        expect(merged).toHaveLength(1);
        expect(merged[0].points).toHaveLength(3);
    });

    it('prefers a straight continuation over a marginally closer sharp turn', () => {
        // The sharp branch sits exactly on the junction; the straight one is
        // slightly off but still within tolerance. Straightness should win.
        const merged = mergePaths([
            line([0, 0], [10, 0]),
            line([10.04, 0], [20, 0]),
            line([10, 0], [10, 10]),
        ], 0.1);

        const straight = merged.find(p => p.points.every(pt => Math.abs(pt.y) < 1e-6));
        expect(straight).toBeDefined();
        expect(maxTurn(straight!)).toBeLessThan(1);
    });
});
