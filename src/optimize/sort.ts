/**
 * Optimal Path Sorting - Minimize travel distance between paths
 * Uses a greedy nearest-neighbor algorithm (TSP heuristic)
 */

import type { Path, Point } from '../geometry/types';
import { distance, pathStart, pathEnd, reversePath } from '../geometry/math';

/**
 * Sort paths to minimize total travel distance (pen-up moves).
 * Uses greedy nearest-neighbor with path reversal optimization.
 */
export function sortPaths(paths: Path[], startPoint: Point = { x: 0, y: 0 }): Path[] {
    if (paths.length <= 1) return paths;

    // Make working copies
    const remaining = paths.map((path, index) => ({ path, index }));
    const result: Path[] = [];

    let currentPosition = startPoint;

    while (remaining.length > 0) {
        // Find the nearest path endpoint to current position
        let bestIndex = 0;
        let bestDistance = Infinity;
        let shouldReverse = false;

        for (let i = 0; i < remaining.length; i++) {
            const { path } = remaining[i];

            // Check distance to path start
            const distToStart = distance(currentPosition, pathStart(path));
            if (distToStart < bestDistance) {
                bestDistance = distToStart;
                bestIndex = i;
                shouldReverse = false;
            }

            // Check distance to path end (we could reverse the path)
            if (!path.closed) {
                const distToEnd = distance(currentPosition, pathEnd(path));
                if (distToEnd < bestDistance) {
                    bestDistance = distToEnd;
                    bestIndex = i;
                    shouldReverse = true;
                }
            }
        }

        // Add the best path to result
        let bestPath = remaining[bestIndex].path;
        if (shouldReverse) {
            bestPath = reversePath(bestPath);
        }

        result.push(bestPath);
        currentPosition = pathEnd(bestPath);
        remaining.splice(bestIndex, 1);
    }

    return result;
}

/**
 * Calculate total travel distance (pen-up moves) for a sequence of paths.
 */
export function calculateTravelDistance(paths: Path[], startPoint: Point = { x: 0, y: 0 }): number {
    if (paths.length === 0) return 0;

    let totalTravel = 0;
    let currentPosition = startPoint;

    for (const path of paths) {
        // Travel to path start
        totalTravel += distance(currentPosition, pathStart(path));
        // Move to path end
        currentPosition = pathEnd(path);
    }

    return totalTravel;
}

/**
 * Sort paths with 2-opt improvement pass.
 * Tries swapping pairs of paths to find local improvements.
 */
export function sortPathsWithTwoOpt(
    paths: Path[],
    startPoint: Point = { x: 0, y: 0 },
    maxIterations: number = 100
): Path[] {
    // Start with greedy solution
    let current = sortPaths(paths, startPoint);
    let currentDistance = calculateTravelDistance(current, startPoint);

    let improved = true;
    let iterations = 0;

    while (improved && iterations < maxIterations) {
        improved = false;
        iterations++;

        // Try all possible 2-opt swaps
        for (let i = 0; i < current.length - 1; i++) {
            for (let j = i + 1; j < current.length; j++) {
                // Create new path order by reversing the segment between i and j
                const newPaths = twoOptSwap(current, i, j);
                const newDistance = calculateTravelDistance(newPaths, startPoint);

                if (newDistance < currentDistance - 0.001) {
                    current = newPaths;
                    currentDistance = newDistance;
                    improved = true;
                }
            }
        }
    }

    return current;
}

/** Perform a 2-opt swap: reverse the segment between i and j */
function twoOptSwap(paths: Path[], i: number, j: number): Path[] {
    const result: Path[] = [];

    // Add paths before i
    for (let k = 0; k < i; k++) {
        result.push(paths[k]);
    }

    // Add reversed segment from i to j
    for (let k = j; k >= i; k--) {
        result.push(paths[k]);
    }

    // Add paths after j
    for (let k = j + 1; k < paths.length; k++) {
        result.push(paths[k]);
    }

    return result;
}
