/**
 * Segment Merging - Join connected path segments into continuous paths
 * 
 * Enhanced version with:
 * - Multiple passes until no more merges possible
 * - Distance-based matching for close endpoints
 * - Automatic path reversal when needed
 */

import type { Path, Point } from '../geometry/types';
import { pointsEqual, pathStart, pathEnd, reversePath, distance, outwardTangent, angleBetween } from '../geometry/math';
import { SpatialHash } from '../geometry/spatial-hash';

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
/**
 * Single merge pass - try to merge each path with its best neighbor
 * Returns number of merges performed
 */
function mergePass(chains: Path[], tolerance: number): number {
    let merges = 0;
    const toRemove = new Set<number>();

    // Chains already grown during this pass. The spatial index still holds their
    // pre-merge endpoints, so joining to one now would splice at a point it no
    // longer has. They become available again next pass, once the index is rebuilt.
    const mutated = new Set<number>();

    // Build endpoint index for fast lookup
    // Use heuristic cell size ~5x tolerance or min 10
    const cellSize = Math.max(tolerance * 10, 10);
    const spatialIndex = new SpatialHash<EndpointInfo>(cellSize);

    // Populate index
    for (let i = 0; i < chains.length; i++) {
        const chain = chains[i];
        if (chain.closed || chain.points.length < 2) continue;

        const start = pathStart(chain);
        const end = pathEnd(chain);

        spatialIndex.insert(start.x, start.y, {
            chainIndex: i,
            isStart: true,
            point: start
        });

        spatialIndex.insert(end.x, end.y, {
            chainIndex: i,
            isStart: false,
            point: end
        });
    }

    for (let i = 0; i < chains.length; i++) {
        if (toRemove.has(i)) continue;

        const chain = chains[i];
        if (chain.closed || chain.points.length < 2) continue;

        const chainStart = pathStart(chain);
        const chainEnd = pathEnd(chain);

        // Find best match for chain's end point (looking for a start to connect to)
        let bestMatch = findBestEndpointMatch(
            chainEnd,
            spatialIndex,
            i,
            toRemove,
            tolerance,
            chains,
            false,
            mutated
        );

        if (bestMatch) {
            // Merge: chain -> bestMatch (possibly reversed)
            const other = chains[bestMatch.chainIndex];
            const merged = connectChains(chain, other, bestMatch.connectType, tolerance);
            chains[i] = merged;
            toRemove.add(bestMatch.chainIndex);
            mutated.add(i);
            merges++;
            continue;
        }

        // Try matching chain's start point (looking for an end to connect to)
        bestMatch = findBestEndpointMatch(
            chainStart,
            spatialIndex,
            i,
            toRemove,
            tolerance,
            chains,
            true, // looking for ends
            mutated
        );

        if (bestMatch) {
            // Merge: bestMatch -> chain (possibly reversed)
            const other = chains[bestMatch.chainIndex];
            const merged = connectChains(other, chain, bestMatch.connectType, tolerance);
            chains[i] = merged;
            toRemove.add(bestMatch.chainIndex);
            mutated.add(i);
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
    /** Ranking cost - lower is better. Dominated by the turn angle at the junction. */
    cost: number;
}

/**
 * Weight of endpoint distance relative to turn angle (radians) in the match cost.
 * Small on purpose: distance only breaks ties between near-equally straight
 * continuations, since every candidate is already within tolerance.
 */
const DISTANCE_WEIGHT = 0.1;

/**
 * Turn angle (radians) a pen would make passing through a junction, where both
 * tangents point away from the junction into their own path.
 *
 * Travelling straight through means the two tangents are anti-parallel, so the
 * turn is the angle between one tangent and the *negation* of the other: 0 for a
 * perfectly straight continuation, pi for doubling back. Symmetric, so traversal
 * direction doesn't matter.
 */
function turnAngle(a: Point | null, b: Point | null): number {
    if (!a || !b) return 0; // Unknown heading - fall back to distance ranking
    return angleBetween(a, b ? { x: -b.x, y: -b.y } : null);
}

/**
 * Find the best endpoint match for a given point using Spatial Hash.
 *
 * Where several chains meet - the usual case at an intersection, once segments
 * have been split there - the candidate needing the smallest heading change wins,
 * so curves flow through crossings instead of turning onto the crossing curve.
 */
function findBestEndpointMatch(
    point: Point,
    index: SpatialHash<EndpointInfo>,
    excludeChain: number,
    excluded: Set<number>,
    tolerance: number,
    chains: Path[],
    lookingForEnds: boolean = false,
    mutated: Set<number> = new Set()
): MatchResult | null {
    let best: MatchResult | null = null;

    // Heading of the chain we are extending, measured at the junction end.
    // lookingForEnds means our junction is at our own start.
    const ourChain = chains[excludeChain];
    const ourTangent = outwardTangent(ourChain, lookingForEnds, tolerance);

    // Query neighbors
    // Query a region around the point + tolerance
    const candidates = index.queryRegion(
        point.x - tolerance,
        point.y - tolerance,
        point.x + tolerance,
        point.y + tolerance
    );

    for (const ep of candidates) {
        if (ep.chainIndex === excludeChain) continue;
        if (excluded.has(ep.chainIndex)) continue;
        // Its indexed endpoints are stale - see `mutated` in mergePass
        if (mutated.has(ep.chainIndex)) continue;
        // Check actual distance
        const dist = distance(point, ep.point);
        if (dist > tolerance) continue;

        // Double check closed (shouldn't be in index, but safe)
        if (chains[ep.chainIndex].closed) continue;

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

        // Prefer the continuation that bends the least, using distance only to
        // separate candidates of near-equal straightness.
        const theirTangent = outwardTangent(chains[ep.chainIndex], ep.isStart, tolerance);
        const turn = turnAngle(ourTangent, theirTangent);
        const cost = turn + (dist / tolerance) * DISTANCE_WEIGHT;

        if (!best || cost < best.cost) {
            best = {
                chainIndex: ep.chainIndex,
                connectType,
                distance: dist,
                cost,
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
    a: Path,
    b: Path,
    type: 'end-to-start' | 'end-to-end' | 'start-to-start' | 'start-to-end',
    tolerance: number = 0.001
): Path {
    let currentA = a;
    let currentB = b;
    let points: Point[];

    switch (type) {
        case 'end-to-start':
            // Ideal case: a.end -> b.start
            // No reversal needed
            break;

        case 'end-to-end':
            // a.end <-> b.end
            // Reverse b so b.end becomes b.start
            currentB = reversePath(currentB);
            break;

        case 'start-to-start':
            // a.start <-> b.start
            // Reverse a so a.start becomes a.end
            currentA = reversePath(currentA);
            break;

        case 'start-to-end':
            // a.start -> b.end
            // Reverse both
            currentA = reversePath(currentA);
            currentB = reversePath(currentB);
            break;
    }

    // Join: remove duplicate point at junction
    points = [...currentA.points, ...currentB.points.slice(1)];

    // Check if this creates a closed path
    const closed = points.length > 2 &&
        pointsEqual(points[0], points[points.length - 1], tolerance); // Use tolerance!

    if (closed) {
        points.pop(); // Remove duplicate closing point
    }

    return {
        points,
        closed,
        meta: a.meta || b.meta, // Preserve metadata
    };
}


