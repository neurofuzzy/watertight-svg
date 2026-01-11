/**
 * Shape-within-Shape Detection and Path Winding Correction
 * Fixes winding direction for proper fills with nested shapes
 */

import type { Path } from '../geometry/types';
import {
    centroid,
    pointInPolygonEvenOdd,

    signedArea,
    isCounterClockwise,
    pathBounds
} from '../geometry/math';

type FillRule = 'evenodd' | 'nonzero';

/**
 * Detect nested shapes and correct their winding direction
 * based on the specified fill rule.
 */
export function fixWinding(paths: Path[], fillRule: FillRule = 'evenodd'): Path[] {
    // Only process closed paths
    const closedPaths = paths.filter(p => p.closed && p.points.length >= 3);
    const openPaths = paths.filter(p => !p.closed || p.points.length < 3);

    if (closedPaths.length === 0) {
        return paths;
    }

    // Build containment hierarchy
    const hierarchy = buildContainmentHierarchy(closedPaths);

    // Fix winding based on depth and fill rule
    const fixedClosed = closedPaths.map((path, index) => {
        const depth = hierarchy.depths[index];
        const shouldBeCCW = getCorrectWinding(depth, fillRule);
        const isCCW = isCounterClockwise(path.points);

        if (shouldBeCCW !== isCCW) {
            // Reverse the path
            return {
                ...path,
                points: [...path.points].reverse(),
            };
        }

        return path;
    });

    return [...fixedClosed, ...openPaths];
}

interface ContainmentHierarchy {
    /** Parent index for each path (-1 if no parent) */
    parents: number[];
    /** Depth in hierarchy (0 = outermost) */
    depths: number[];
    /** Children indices for each path */
    children: number[][];
}

/**
 * Build a hierarchy of which paths contain which other paths.
 */
function buildContainmentHierarchy(paths: Path[]): ContainmentHierarchy {
    const n = paths.length;
    const parents: number[] = new Array(n).fill(-1);
    const children: number[][] = paths.map(() => []);

    // For each path, find which other paths contain it
    for (let i = 0; i < n; i++) {
        const pathI = paths[i];
        const centerI = centroid(pathI.points);

        let bestParent = -1;
        let bestParentArea = Infinity;

        for (let j = 0; j < n; j++) {
            if (i === j) continue;

            const pathJ = paths[j];

            // Quick bounding box check
            if (!boundsContain(pathBounds(pathJ), pathBounds(pathI))) {
                continue;
            }

            // Check if center of pathI is inside pathJ
            if (pointInPolygonEvenOdd(centerI, pathJ.points)) {
                // pathJ contains pathI
                // We want the smallest containing path (immediate parent)
                const areaJ = Math.abs(signedArea(pathJ.points));
                if (areaJ < bestParentArea) {
                    bestParent = j;
                    bestParentArea = areaJ;
                }
            }
        }

        parents[i] = bestParent;
        if (bestParent !== -1) {
            children[bestParent].push(i);
        }
    }

    // Calculate depths from parent relationships
    const depths: number[] = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
        let depth = 0;
        let current = parents[i];
        while (current !== -1) {
            depth++;
            current = parents[current];
        }
        depths[i] = depth;
    }

    return { parents, depths, children };
}

/**
 * Check if bounds A contains bounds B
 */
function boundsContain(
    a: { minX: number; minY: number; maxX: number; maxY: number },
    b: { minX: number; minY: number; maxX: number; maxY: number }
): boolean {
    return a.minX <= b.minX && a.minY <= b.minY &&
        a.maxX >= b.maxX && a.maxY >= b.maxY;
}

/**
 * Determine correct winding direction based on depth and fill rule.
 * 
 * For even-odd rule:
 * - All shapes should be in the same direction (typically CCW)
 * 
 * For non-zero rule:
 * - Even depths (0, 2, 4, ...): Counter-clockwise (fills)
 * - Odd depths (1, 3, 5, ...): Clockwise (holes)
 */
function getCorrectWinding(depth: number, fillRule: FillRule): boolean {
    if (fillRule === 'evenodd') {
        // For even-odd, winding doesn't matter for correctness,
        // but we'll use CCW for consistency
        return true;
    } else {
        // For non-zero, alternate winding to create holes
        return depth % 2 === 0;
    }
}

/**
 * Analyze paths to report their containment relationships.
 * Useful for debugging and visualization.
 */
export function analyzeNesting(paths: Path[]): NestingAnalysis {
    const closedPaths = paths.filter(p => p.closed && p.points.length >= 3);
    const hierarchy = buildContainmentHierarchy(closedPaths);

    return {
        pathCount: closedPaths.length,
        maxDepth: Math.max(...hierarchy.depths, 0),
        hierarchy: closedPaths.map((path, i) => ({
            index: i,
            depth: hierarchy.depths[i],
            parentIndex: hierarchy.parents[i],
            childCount: hierarchy.children[i].length,
            isCCW: isCounterClockwise(path.points),
            area: Math.abs(signedArea(path.points)),
        })),
    };
}

export interface NestingAnalysis {
    pathCount: number;
    maxDepth: number;
    hierarchy: PathInfo[];
}

interface PathInfo {
    index: number;
    depth: number;
    parentIndex: number;
    childCount: number;
    isCCW: boolean;
    area: number;
}
