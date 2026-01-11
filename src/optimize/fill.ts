/**
 * Closed Path Detection and Gap-Tolerant Filling
 * Detects nearly-closed paths and optionally closes them
 */

import type { Path, Point } from '../geometry/types';
import { distance, pathStart, pathEnd, pointsEqual } from '../geometry/math';

/**
 * Close paths that are nearly closed (gap within tolerance).
 * This enables proper filling for hand-drawn or imprecise paths.
 */
export function closePaths(paths: Path[], gapTolerance: number = 2): Path[] {
    return paths.map(path => {
        if (path.closed) return path;
        if (path.points.length < 3) return path;

        const start = pathStart(path);
        const end = pathEnd(path);
        const gap = distance(start, end);

        if (gap <= gapTolerance) {
            // Close the path by connecting end to start
            return {
                ...path,
                closed: true,
            };
        }

        return path;
    });
}

/**
 * Find paths that could potentially be closed by connecting
 * their endpoints to nearby path endpoints.
 */
export function findPotentialClosures(
    paths: Path[],
    gapTolerance: number = 2
): ClosureCandidate[] {
    const candidates: ClosureCandidate[] = [];

    for (let i = 0; i < paths.length; i++) {
        const pathA = paths[i];
        if (pathA.closed || pathA.points.length < 2) continue;

        const startA = pathStart(pathA);
        const endA = pathEnd(pathA);

        // Check self-closure first
        const selfGap = distance(startA, endA);
        if (selfGap <= gapTolerance && selfGap > 0) {
            candidates.push({
                type: 'self',
                pathIndex: i,
                gap: selfGap,
            });
        }

        // Check connections to other paths
        for (let j = i + 1; j < paths.length; j++) {
            const pathB = paths[j];
            if (pathB.closed || pathB.points.length < 2) continue;

            const startB = pathStart(pathB);
            const endB = pathEnd(pathB);

            // Check all four possible connections
            checkConnection(candidates, i, j, endA, startB, 'end-start', gapTolerance);
            checkConnection(candidates, i, j, endA, endB, 'end-end', gapTolerance);
            checkConnection(candidates, i, j, startA, startB, 'start-start', gapTolerance);
            checkConnection(candidates, i, j, startA, endB, 'start-end', gapTolerance);
        }
    }

    // Sort by gap size (smallest first)
    candidates.sort((a, b) => a.gap - b.gap);

    return candidates;
}

interface ClosureCandidate {
    type: 'self' | 'connection';
    pathIndex: number;
    otherPathIndex?: number;
    connectionType?: 'end-start' | 'end-end' | 'start-start' | 'start-end';
    gap: number;
}

function checkConnection(
    candidates: ClosureCandidate[],
    i: number,
    j: number,
    pointA: Point,
    pointB: Point,
    connectionType: 'end-start' | 'end-end' | 'start-start' | 'start-end',
    gapTolerance: number
): void {
    const gap = distance(pointA, pointB);
    if (gap <= gapTolerance && gap > 0) {
        candidates.push({
            type: 'connection',
            pathIndex: i,
            otherPathIndex: j,
            connectionType,
            gap,
        });
    }
}

/**
 * Apply closures from candidates, merging paths where needed.
 */
export function applyClosures(
    paths: Path[],
    candidates: ClosureCandidate[]
): Path[] {
    const result = paths.map(p => ({ ...p, points: [...p.points] }));
    const merged = new Set<number>();

    for (const candidate of candidates) {
        if (merged.has(candidate.pathIndex)) continue;
        if (candidate.otherPathIndex !== undefined && merged.has(candidate.otherPathIndex)) {
            continue;
        }

        if (candidate.type === 'self') {
            result[candidate.pathIndex].closed = true;
        } else if (candidate.type === 'connection' && candidate.otherPathIndex !== undefined) {
            // Merge the two paths
            const pathA = result[candidate.pathIndex];
            const pathB = result[candidate.otherPathIndex];

            let mergedPoints: Point[];

            switch (candidate.connectionType) {
                case 'end-start':
                    mergedPoints = [...pathA.points, ...pathB.points];
                    break;
                case 'end-end':
                    mergedPoints = [...pathA.points, ...pathB.points.slice().reverse()];
                    break;
                case 'start-start':
                    mergedPoints = [...pathA.points.slice().reverse(), ...pathB.points];
                    break;
                case 'start-end':
                    mergedPoints = [...pathB.points, ...pathA.points];
                    break;
                default:
                    continue;
            }

            // Check if merged path is now closed
            const start = mergedPoints[0];
            const end = mergedPoints[mergedPoints.length - 1];
            const isClosed = pointsEqual(start, end, candidate.gap);

            result[candidate.pathIndex] = {
                points: mergedPoints,
                closed: isClosed,
                meta: pathA.meta || pathB.meta,
            };

            merged.add(candidate.otherPathIndex);
        }
    }

    // Remove merged paths
    return result.filter((_, i) => !merged.has(i));
}

/**
 * Automatically close and merge paths within tolerance.
 * This is the main entry point for gap-tolerant closure.
 */
export function autoClosePaths(paths: Path[], gapTolerance: number = 2): Path[] {
    // First, close self-closing paths
    let result = closePaths(paths, gapTolerance);

    // Then, find and apply potential merges that result in closed paths
    const candidates = findPotentialClosures(result, gapTolerance);

    // Only apply candidates that would result in closed paths
    // (We're being conservative here to avoid unexpected merges)
    const selfClosures = candidates.filter(c => c.type === 'self');
    result = applyClosures(result, selfClosures);

    return result;
}
