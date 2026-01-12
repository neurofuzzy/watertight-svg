/**
 * Optimization Pipeline - Orchestrates all optimization steps
 */

import type { Path, OptimizeOptions, PathStats, SVGDocument } from '../geometry/types';
import { parseSVG } from '../geometry/parser';
import { pathLength, scalePath, pruneDuplicatePoints, removeTinyPaths, mergeColinearPoints } from '../geometry/math';
import { mergePaths } from './merge';
import { removeOverdraw } from './overdraw';
import { sortPathsWithTwoOpt, calculateTravelDistance } from './sort';
import { autoClosePaths, bridgeGaps } from './fill';
import { fixWinding } from './winding';
import { findRegions } from './regions';
import { splitPathsAtIntersections } from '../geometry/intersection';

export interface OptimizeResult {
    /** Original parsed document */
    original: SVGDocument;
    /** Optimized paths */
    optimized: SVGDocument;
    /** Statistics before optimization */
    beforeStats: PathStats;
    /** Statistics after optimization */
    afterStats: PathStats;
}

/**
 * Run the full optimization pipeline on an SVG string.
 * NOTE: This parses the SVG on the main thread (using DOM).
 */
export function optimize(svgString: string, options: OptimizeOptions): OptimizeResult {
    // Parse the SVG
    const original = parseSVG(svgString);
    return optimizeDocument(original, options);
}

/**
 * Run optimization on an already parsed SVG document.
 * This can be run in a worker since it doesn't use the DOM parser.
 */
export function optimizeDocument(
    original: SVGDocument,
    options: OptimizeOptions,
    onProgress?: (percent: number) => void
): OptimizeResult {
    const beforeStats = calculateStats(original.paths);

    // Scaling Factor to improve precision (10x)
    const SCALE = 10;

    // Scale UP geometry to avoid floating point issues with small details
    let paths = original.paths.map(p => scalePath(p, SCALE));

    // Scale UP relevant tolerance options
    // We clone options to avoid mutating the original object
    const scaledOptions = { ...options };
    scaledOptions.gapTolerance *= SCALE;



    // Step 1: Remove overdraw (uses tight geometric tolerance)
    // We do this BEFORE splitting intersections so we can identify duplicate paths 
    // while their topology is still intact.
    if (scaledOptions.removeOverdraw) {
        paths = removeOverdraw(paths, 0.01 * SCALE); // Scaled tolerance
        // Cleanup: Remove duplicate points that might have been created
        paths = pruneDuplicatePoints(paths);
    }

    // Step 0.5: Split segments at all intersection points (NEW)
    // This ensures no crossing segments - all intersections become proper vertices
    if (scaledOptions.splitIntersections) {
        // Only run this if we have paths left
        if (paths.length > 0) {
            const SPLIT_TOLERANCE = 1.0 * SCALE; // 1 pixel tolerance for intersection snapping
            paths = splitPathsAtIntersections(paths, SPLIT_TOLERANCE) as Path[];
        }
    }

    // Step 2: Merge connected segments (uses tight geometric tolerance)
    if (scaledOptions.mergePaths) {
        // Use scaled tolerance for merging (e.g. 0.1 scaled pixels)
        // This ensures we don't fail to merge slightly drifted points
        const MERGE_TOLERANCE = 0.1 * SCALE;
        paths = mergePaths(paths, MERGE_TOLERANCE);
    }

    // Step 2.5: Cleanup after merge
    // Remove tiny paths and merge colinear segments for cleaner geometry
    const MIN_PATH_LENGTH = 0.1 * SCALE; // 0.1 pixel minimum
    paths = removeTinyPaths(paths, MIN_PATH_LENGTH);
    paths = mergeColinearPoints(paths, 0.01 * SCALE);

    // Step 3: Fill Strategy & Step 4: Fix Winding
    // We handle these together to optimize performance (only fixing winding on regions)
    if (scaledOptions.findRegions) {
        // Determine progress range for regions phase
        // If winding is enabled, regions gets 70% of the bar, winding gets 30%
        const regionsRange = scaledOptions.fixWinding ? 0.7 : 1.0;

        // Pre-process: Bridge gaps using the user's gap tolerance (now scaled)
        // 1. Close endpoint-to-endpoint gaps
        let bridgedPaths = autoClosePaths(paths, scaledOptions.gapTolerance);

        // 2. Bridge T-junction gaps (point-to-segment)
        bridgedPaths = bridgeGaps(bridgedPaths, scaledOptions.gapTolerance);

        // Find enclosed regions (Flash-style fills)
        // Use STRICT tolerance to preserve geometry detail.
        // We rely on autoClosePaths + bridgeGaps above to bridge all gaps explicitly.
        // 0.1 unscaled pixels -> 0.1 * SCALE in scaled space
        const STRICT_TOLERANCE = 0.1 * SCALE;

        let regions = findRegions(bridgedPaths, {
            tolerance: STRICT_TOLERANCE,
            onProgress: onProgress ? (p: number) => onProgress(p * regionsRange) : undefined
        });

        // Step 4: Fix winding for regions
        // OPTIMIZATION: Only run winding correction on the newly found regions
        // This avoids O(N^2) checks against the thousands of original stroke segments
        if (scaledOptions.fixWinding) {
            const rangeStart = 0.7;
            const rangeWidth = 0.3;

            regions = fixWinding(regions, scaledOptions.fillRule, onProgress ? (p) => {
                onProgress(rangeStart + (p * rangeWidth));
            } : undefined);
        }

        // Add detected regions to the path list
        // REPLACE original paths with regions to avoid duplicates
        if (regions.length > 0) {
            paths = [...regions];
        } else {
            // Fallback: If no regions found (e.g. open paths), return the bridged paths
            // so the user effectively sees the "Close Paths" result instead of nothing.
            paths = bridgedPaths;
        }

    } else if (scaledOptions.closePaths) {
        // Close nearly-closed paths (Simple)
        paths = autoClosePaths(paths, scaledOptions.gapTolerance);

        // Step 4: Fix winding for closed paths
        // In the "Close Paths" strategy, we operate on the original paths
        if (scaledOptions.fixWinding) {
            paths = fixWinding(paths, scaledOptions.fillRule, onProgress);
        }
    }

    // Step 5: Sort paths to minimize travel
    if (scaledOptions.sortPaths) {
        paths = sortPathsWithTwoOpt(paths);
    }

    // Scale DOWN geometry before returning
    paths = paths.map(p => scalePath(p, 1 / SCALE));

    const optimized: SVGDocument = {
        ...original,
        paths,
    };

    const afterStats = calculateStats(paths);

    return {
        original,
        optimized,
        beforeStats,
        afterStats,
    };
}

/**
 * Calculate statistics for a set of paths.
 */
export function calculateStats(paths: Path[]): PathStats {
    let segmentCount = 0;
    let totalLength = 0;
    let closedPaths = 0;

    for (const path of paths) {
        totalLength += pathLength(path);
        segmentCount += path.points.length - 1;
        if (path.closed) {
            segmentCount += 1; // closing segment
            closedPaths++;
        }
    }

    const travelDistance = calculateTravelDistance(paths);

    return {
        pathCount: paths.length,
        segmentCount,
        totalLength,
        travelDistance,
        closedPaths,
    };
}

/**
 * Format statistics for display.
 */
export function formatStats(stats: PathStats): string {
    return [
        `Paths: ${stats.pathCount}`,
        `Segments: ${stats.segmentCount}`,
        `Draw: ${stats.totalLength.toFixed(1)}`,
        `Travel: ${stats.travelDistance.toFixed(1)}`,
        `Closed: ${stats.closedPaths}`,
    ].join(' | ');
}
