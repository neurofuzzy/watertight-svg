/**
 * Optimization Pipeline - Orchestrates all optimization steps
 */

import type { Path, OptimizeOptions, PathStats, SVGDocument } from '../geometry/types';
import { parseSVG } from '../geometry/parser';
import { pathLength, scalePath, pruneDuplicatePoints } from '../geometry/math';
import { mergePaths } from './merge';
import { removeOverdraw } from './overdraw';
import { sortPathsWithTwoOpt, calculateTravelDistance } from './sort';
import { autoClosePaths, bridgeGaps } from './fill';
import { fixWinding } from './winding';
import { findRegions } from './regions';

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

    // Step 0: Break apart paths (stress test)
    if (scaledOptions.breakApart) {
        const brokenPaths: Path[] = [];
        for (const path of paths) {
            for (let i = 0; i < path.points.length - 1; i++) {
                brokenPaths.push({
                    points: [path.points[i], path.points[i + 1]],
                    closed: false,
                    meta: path.meta
                });
            }
            // If closed, add closing segment
            if (path.closed && path.points.length > 1) {
                brokenPaths.push({
                    points: [path.points[path.points.length - 1], path.points[0]],
                    closed: false,
                    meta: path.meta
                });
            }
        }

        // Shuffle segments to stress-test sorting/merging (Fisher-Yates)
        for (let i = brokenPaths.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [brokenPaths[i], brokenPaths[j]] = [brokenPaths[j], brokenPaths[i]];
        }

        paths = brokenPaths;
    }

    // Step 1: Remove overdraw (uses tight geometric tolerance)
    if (scaledOptions.removeOverdraw) {
        paths = removeOverdraw(paths); // Uses default tolerance
        // Cleanup: Remove duplicate points that might have been created
        paths = pruneDuplicatePoints(paths);
    }

    // Step 2: Merge connected segments (uses tight geometric tolerance)
    if (scaledOptions.mergePaths) {
        paths = mergePaths(paths); // Uses default tolerance
    }

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
            onProgress: onProgress ? (p) => onProgress(p * regionsRange) : undefined
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
