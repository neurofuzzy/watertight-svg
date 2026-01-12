/**
 * Segment Merging - Join connected path segments into continuous paths
 * 
 * Enhanced version with:
 * - Multiple passes until no more merges possible
 * - Distance-based matching for close endpoints
 * - Automatic path reversal when needed
 */

import type { Path, Point } from '../geometry/types';
import { pointsEqual, pathStart, pathEnd, reversePath, distance } from '../geometry/math';

/**
 * Merge paths that share endpoints into longer continuous paths.
 * Uses a tight tolerance for endpoint matching only - does NOT simplify curves.
 * 
 * Enhanced algorithm:
 * 1. Build spatial index of all endpoints
 * 2. For each path, find best matching endpoint (closest within tolerance)
 * 3. Reverse paths as needed to connect end-to-start
 * 4. Repeat until no more merges possible
 */
export function mergePaths(paths: Path[], tolerance: number = 0.1): Path[] {
    if (paths.length === 0) return [];

    // Make a working copy - each path becomes a "chain" that can grow
    let chains: Path[] = paths.map(p => ({ ...p, points: [...p.points] }));

    let totalMerges = 0;
    let passCount = 0;
    const MAX_PASSES = 100; // Safety limit

    // Keep merging until no more progress
    while (passCount < MAX_PASSES) {
        passCount++;
        const mergesThisPass = mergePass(chains, tolerance);
        totalMerges += mergesThisPass;

        if (mergesThisPass === 0) break;
    }

    // Filter out empty/degenerate paths
    chains = chains.filter(p => p.points.length >= 2);

    console.log(`[mergePaths] ${paths.length} paths -> ${chains.length} chains (${totalMerges} merges, ${passCount} passes)`);

    return chains;
}

/**
 * Single merge pass - try to merge each path with its best neighbor
 * Returns number of merges performed
 */
function mergePass(chains: Path[], tolerance: number): number {
    let merges = 0;
    const toRemove = new Set<number>();

    // Build endpoint index for fast lookup
    const endpointIndex = buildEndpointIndex(chains);

    for (let i = 0; i < chains.length; i++) {
        if (toRemove.has(i)) continue;

        const chain = chains[i];
        if (chain.closed || chain.points.length < 2) continue;

        const chainStart = pathStart(chain);
        const chainEnd = pathEnd(chain);

        // Find best match for chain's end point (looking for a start to connect to)
        let bestMatch = findBestEndpointMatch(
            chainEnd,
            endpointIndex,
            i,
            toRemove,
            tolerance,
            chains
        );

        if (bestMatch) {
            // Merge: chain -> bestMatch (possibly reversed)
            const other = chains[bestMatch.chainIndex];
            const merged = connectChains(chain, other, bestMatch.connectType);
            chains[i] = merged;
            toRemove.add(bestMatch.chainIndex);
            merges++;
            continue;
        }

        // Try matching chain's start point (looking for an end to connect to)
        bestMatch = findBestEndpointMatch(
            chainStart,
            endpointIndex,
            i,
            toRemove,
            tolerance,
            chains,
            true // looking for ends
        );

        if (bestMatch) {
            // Merge: bestMatch -> chain (possibly reversed)
            const other = chains[bestMatch.chainIndex];
            const merged = connectChains(other, chain, bestMatch.connectType);
            chains[i] = merged;
            toRemove.add(bestMatch.chainIndex);
            merges++;
        }
    }

    // Remove merged chains (in reverse order to maintain indices)
    const removeIndices = Array.from(toRemove).sort((a, b) => b - a);
    for (const idx of removeIndices) {
        chains.splice(idx, 1);
    }

    return merges;
}

interface EndpointInfo {
    chainIndex: number;
    isStart: boolean;
    point: Point;
}

interface MatchResult {
    chainIndex: number;
    connectType: 'end-to-start' | 'end-to-end' | 'start-to-start' | 'start-to-end';
    distance: number;
}

/**
 * Build an index of all endpoints for fast spatial queries
 */
function buildEndpointIndex(chains: Path[]): EndpointInfo[] {
    const index: EndpointInfo[] = [];

    for (let i = 0; i < chains.length; i++) {
        const chain = chains[i];
        if (chain.closed || chain.points.length < 2) continue;

        index.push({
            chainIndex: i,
            isStart: true,
            point: pathStart(chain),
        });

        index.push({
            chainIndex: i,
            isStart: false,
            point: pathEnd(chain),
        });
    }

    return index;
}

/**
 * Find the best endpoint match for a given point
 */
function findBestEndpointMatch(
    point: Point,
    index: EndpointInfo[],
    excludeChain: number,
    excluded: Set<number>,
    tolerance: number,
    chains: Path[],
    lookingForEnds: boolean = false
): MatchResult | null {
    let best: MatchResult | null = null;

    for (const ep of index) {
        if (ep.chainIndex === excludeChain) continue;
        if (excluded.has(ep.chainIndex)) continue;
        if (chains[ep.chainIndex].closed) continue;

        const dist = distance(point, ep.point);
        if (dist > tolerance) continue;

        // Determine connection type based on which endpoints are meeting
        let connectType: MatchResult['connectType'];

        if (lookingForEnds) {
            // We have a start point, looking for an end to connect
            if (!ep.isStart) {
                // Their end -> our start = end-to-start (ideal)
                connectType = 'end-to-start';
            } else {
                // Their start <-> our start = need to reverse one
                connectType = 'start-to-start';
            }
        } else {
            // We have an end point, looking for a start to connect  
            if (ep.isStart) {
                // Our end -> their start = end-to-start (ideal)
                connectType = 'end-to-start';
            } else {
                // Our end <-> their end = need to reverse one
                connectType = 'end-to-end';
            }
        }

        if (!best || dist < best.distance) {
            best = {
                chainIndex: ep.chainIndex,
                connectType,
                distance: dist,
            };
        }
    }

    return best;
}

/**
 * Connect two chains based on the connection type
 * Handles reversing as needed
 */
function connectChains(
    first: Path,
    second: Path,
    connectType: MatchResult['connectType']
): Path {
    let a = first;
    let b = second;

    switch (connectType) {
        case 'end-to-start':
            // Ideal case: a.end -> b.start
            // No reversal needed
            break;

        case 'end-to-end':
            // a.end <-> b.end
            // Reverse b so b.end becomes b.start
            b = reversePath(b);
            break;

        case 'start-to-start':
            // a.start <-> b.start
            // Reverse a so a.start becomes a.end
            a = reversePath(a);
            break;

        case 'start-to-end':
            // a.start -> b.end
            // Reverse both
            a = reversePath(a);
            b = reversePath(b);
            break;
    }

    // Join: remove duplicate point at junction
    const points = [...a.points, ...b.points.slice(1)];

    // Check if this creates a closed path
    const closed = points.length > 2 &&
        pointsEqual(points[0], points[points.length - 1], 0.001);

    if (closed) {
        points.pop(); // Remove duplicate closing point
    }

    return {
        points,
        closed,
        meta: a.meta || b.meta,
    };
}

/** Join two paths into one (legacy, for compatibility) */
function joinPaths(a: Path, b: Path): Path {
    const points = [...a.points, ...b.points.slice(1)];
    return {
        points,
        closed: false,
        meta: a.meta || b.meta,
    };
}
