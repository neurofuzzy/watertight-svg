/**
 * Segment Merging - Join connected path segments into continuous paths
 */

import type { Path } from '../geometry/types';
import { pointsEqual, pathStart, pathEnd, reversePath } from '../geometry/math';

/**
 * Merge paths that share endpoints into longer continuous paths.
 * Uses a tight tolerance for endpoint matching only - does NOT simplify curves.
 */
export function mergePaths(paths: Path[], tolerance: number = 0.001): Path[] {
    if (paths.length === 0) return [];

    // Make a working copy
    let remaining = paths.map(p => ({ ...p, points: [...p.points] }));
    const result: Path[] = [];

    while (remaining.length > 0) {
        // Start with the first remaining path
        let current = remaining.shift()!;
        let merged = true;

        // Keep trying to merge until no more matches
        while (merged && !current.closed) {
            merged = false;

            for (let i = 0; i < remaining.length; i++) {
                const candidate = remaining[i];
                if (candidate.closed) continue;

                const currentStart = pathStart(current);
                const currentEnd = pathEnd(current);
                const candidateStart = pathStart(candidate);
                const candidateEnd = pathEnd(candidate);

                // Try all four possible connections
                if (pointsEqual(currentEnd, candidateStart, tolerance)) {
                    // current -> candidate
                    current = joinPaths(current, candidate);
                    remaining.splice(i, 1);
                    merged = true;
                    break;
                }

                if (pointsEqual(currentEnd, candidateEnd, tolerance)) {
                    // current -> reversed candidate
                    current = joinPaths(current, reversePath(candidate));
                    remaining.splice(i, 1);
                    merged = true;
                    break;
                }

                if (pointsEqual(currentStart, candidateEnd, tolerance)) {
                    // candidate -> current
                    current = joinPaths(candidate, current);
                    remaining.splice(i, 1);
                    merged = true;
                    break;
                }

                if (pointsEqual(currentStart, candidateStart, tolerance)) {
                    // reversed candidate -> current
                    current = joinPaths(reversePath(candidate), current);
                    remaining.splice(i, 1);
                    merged = true;
                    break;
                }
            }
        }

        // NOTE: We intentionally do NOT simplify paths here as that destroys curves
        result.push(current);
    }

    return result;
}

/** Join two paths into one */
function joinPaths(a: Path, b: Path): Path {
    // Remove the duplicate point at the junction
    const points = [...a.points, ...b.points.slice(1)];

    return {
        points,
        closed: false,
        meta: a.meta || b.meta,
    };
}
