
import {
    type Path,
    type BoundingBox,
    type Point
} from '../geometry/types';
import {
    pathBounds,
    findInteriorPoint,
    pointInPolygonEvenOdd
} from '../geometry/math';

/**
 * Compute nesting depth analytically using Point-in-Polygon (Ray Casting).
 * Returns an array of depths corresponding to the input paths.
 * 
 * Depth 0: Open paths (or ignored)
 * Depth 1: Outermost closed paths (not inside any other)
 * Depth 2: Inside one path
 * ...
 */
export function computeAnalyticalNestingDepths(paths: Path[]): number[] {
    const n = paths.length;
    const depths = new Array(n).fill(0);

    // 1. Identify closed paths and pre-calculate bounds/test points
    const closedIndices: number[] = [];
    const bounds: BoundingBox[] = new Array(n);
    const testPoints: (Point | null)[] = new Array(n).fill(null);

    for (let i = 0; i < n; i++) {
        const path = paths[i];

        // Open paths are always depth 0 (or treated as "cuts" on top layer usually, but logic here says depth 0 is special)
        // If we want them processed, we'd need a different strategy, but usually nesting implies closed regions.
        if (!path.closed || path.points.length < 3) {
            depths[i] = 0;
            continue;
        }

        closedIndices.push(i);
        bounds[i] = pathBounds(path);

        // Find a point guaranteed to be strictly inside
        // Using findInteriorPoint from math.ts which handles complex shapes better than centroid
        testPoints[i] = findInteriorPoint(path.points);
    }

    // 2. Compare every closed path against every other closed path
    // O(N^2) complexity, but N is usually small (< 10,000) for this tool.
    // Bounding box checks make it fast.
    for (const i of closedIndices) {
        let nestingCount = 0;
        const boxA = bounds[i];
        const pointA = testPoints[i];

        if (!pointA) {
            // Should not happen for valid polygons > 3 points
            continue;
        }

        for (const j of closedIndices) {
            if (i === j) continue;

            const boxB = bounds[j];

            // Fast Pre-check: Is Box A inside Box B?
            // If Box A is NOT strictly inside Box B, Path A cannot be inside Path B.
            // (Equality is tricky, assume strictly smaller or equal? Nesting usually implies geometric strictness)
            // But bounding boxes can match even if shapes are different.
            // Let's check if Box A is *within* Box B.
            // A.min >= B.min && A.max <= B.max
            if (boxA.minX >= boxB.minX && boxA.maxX <= boxB.maxX &&
                boxA.minY >= boxB.minY && boxA.maxY <= boxB.maxY) {

                // Detailed Check: Is Point A inside Polygon B?
                if (pointInPolygonEvenOdd(pointA, paths[j].points)) {
                    nestingCount++;
                }
            }
        }

        // Depth 1-based for closed paths
        depths[i] = nestingCount + 1;
    }

    return depths;
}
