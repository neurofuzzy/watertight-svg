/**
 * Optimal Path Sorting - Minimize travel distance between paths
 * Uses a greedy nearest-neighbor algorithm (TSP heuristic)
 *
 * Ordering also favours strokes that continue the previous stroke's heading, so
 * the machine flows from one stroke into the next instead of whipping around.
 * Travel distance stays the dominant term - see HEADING_WEIGHT.
 */

import type { Path, Point } from '../geometry/types';
import { distance, pathStart, pathEnd, reversePath, pathsBounds, outwardTangent, angleBetween } from '../geometry/math';

/**
 * Cost of a full 180-degree heading reversal between consecutive strokes,
 * as a fraction of the drawing's diagonal.
 *
 * Deliberately small: pen-up travel is the real cost to minimise, and heading
 * should only decide between otherwise comparable candidates. Raising this
 * trades longer travel for smoother machine motion.
 */
const HEADING_WEIGHT = 0.02;

/** Direction of travel entering a path at its start (i.e. drawn forwards) */
function entryHeading(path: Path): Point | null {
    return outwardTangent(path, true);
}

/** Direction of travel leaving a path at its end (i.e. drawn forwards) */
function exitHeading(path: Path): Point | null {
    const tangent = outwardTangent(path, false);
    // outwardTangent points back into the path, so motion is the opposite way
    return tangent ? { x: -tangent.x, y: -tangent.y } : null;
}

/** Distance-equivalent cost of turning from one heading to another */
function headingCost(from: Point | null, to: Point | null, penalty: number): number {
    if (!from || !to || penalty <= 0) return 0;
    return penalty * (angleBetween(from, to) / Math.PI);
}

/** Penalty scale for this drawing: a full reversal costs HEADING_WEIGHT of its diagonal */
export function headingPenaltyFor(paths: Path[]): number {
    const bounds = pathsBounds(paths);
    const diagonal = Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
    return diagonal * HEADING_WEIGHT;
}

/**
 * Sort paths to minimize total travel distance (pen-up moves).
 * Uses greedy nearest-neighbor with path reversal optimization, preferring
 * continuations that keep the machine's heading where distances are comparable.
 */
export function sortPaths(
    paths: Path[],
    startPoint: Point = { x: 0, y: 0 },
    headingPenalty: number = headingPenaltyFor(paths)
): Path[] {
    if (paths.length <= 1) return paths;

    // Make working copies
    const remaining = paths.map((path, index) => ({ path, index }));
    const result: Path[] = [];

    let currentPosition = startPoint;
    // Unknown until the first stroke is placed, so the first pick is distance-only
    let currentHeading: Point | null = null;

    while (remaining.length > 0) {
        // Find the cheapest next stroke: travel distance plus heading change
        let bestIndex = 0;
        let bestCost = Infinity;
        let shouldReverse = false;

        for (let i = 0; i < remaining.length; i++) {
            const { path } = remaining[i];

            // Draw forwards: enter at the path's start
            const costToStart = distance(currentPosition, pathStart(path))
                + headingCost(currentHeading, entryHeading(path), headingPenalty);

            if (costToStart < bestCost) {
                bestCost = costToStart;
                bestIndex = i;
                shouldReverse = false;
            }

            // Draw backwards: enter at the path's end, so motion heads back
            // into the path - which is exactly the outward tangent there
            if (!path.closed) {
                const costToEnd = distance(currentPosition, pathEnd(path))
                    + headingCost(currentHeading, outwardTangent(path, false), headingPenalty);

                if (costToEnd < bestCost) {
                    bestCost = costToEnd;
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
        currentHeading = exitHeading(bestPath);
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
 * Travel distance plus heading-change penalties - the objective the sorter
 * actually minimises. Kept separate from calculateTravelDistance(), which
 * reports pure pen-up distance for the stats display.
 */
export function calculateTravelCost(
    paths: Path[],
    startPoint: Point = { x: 0, y: 0 },
    headingPenalty: number = headingPenaltyFor(paths)
): number {
    if (paths.length === 0) return 0;

    let total = 0;
    let currentPosition = startPoint;
    let currentHeading: Point | null = null;

    for (const path of paths) {
        total += distance(currentPosition, pathStart(path));
        total += headingCost(currentHeading, entryHeading(path), headingPenalty);

        currentPosition = pathEnd(path);
        currentHeading = exitHeading(path);
    }

    return total;
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
    // One penalty scale for the whole run, so greedy and 2-opt agree on cost
    // (and it can't drift as 2-opt reverses paths)
    const headingPenalty = headingPenaltyFor(paths);

    // Start with greedy solution
    let current = sortPaths(paths, startPoint, headingPenalty);
    let currentCost = calculateTravelCost(current, startPoint, headingPenalty);

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
                const newCost = calculateTravelCost(newPaths, startPoint, headingPenalty);

                if (newCost < currentCost - 0.001) {
                    current = newPaths;
                    currentCost = newCost;
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
        // Deep Reversal: Reverse the path geometry too so the flow is continuous
        // old: A -> B -> C
        // new: reverse(C) -> reverse(B) -> reverse(A)
        // This ensures C.end connects to B.start (now reversed B.end), etc.
        result.push(reversePath(paths[k]));
    }

    // Add paths after j
    for (let k = j + 1; k < paths.length; k++) {
        result.push(paths[k]);
    }

    return result;
}
