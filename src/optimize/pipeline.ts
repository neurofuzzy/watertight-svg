/**
 * Optimization Pipeline - Orchestrates all optimization steps
 */

import type { Path, OptimizeOptions, PathStats, SVGDocument } from '../geometry/types';
import { parseSVG } from '../geometry/parser';
import { pathLength } from '../geometry/math';
import { mergePaths } from './merge';
import { removeOverdraw } from './overdraw';
import { sortPathsWithTwoOpt, calculateTravelDistance } from './sort';
import { autoClosePaths } from './fill';
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

    // Run optimization steps
    let paths = [...original.paths];

    // Step 0: Break apart paths (stress test)
    if (options.breakApart) {
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
        paths = brokenPaths;
    }

    // Step 1: Remove overdraw (uses tight geometric tolerance)
    if (options.removeOverdraw) {
        paths = removeOverdraw(paths); // Uses default 0.01 tolerance
    }

    // Step 2: Merge connected segments (uses tight geometric tolerance)
    if (options.mergePaths) {
        paths = mergePaths(paths); // Uses default 0.001 tolerance
    }

    // Step 3: Fill Strategy & Step 4: Fix Winding
    // We handle these together to optimize performance (only fixing winding on regions)
    if (options.findRegions) {
        // Determine progress range for regions phase
        // If winding is enabled, regions gets 70% of the bar, winding gets 30%
        const regionsRange = options.fixWinding ? 0.7 : 1.0;

        // Find enclosed regions
        let regions = findRegions(paths, {
            tolerance: options.gapTolerance,
            onProgress: onProgress ? (p) => onProgress(p * regionsRange) : undefined
        });

        // Step 4: Fix winding for regions
        // OPTIMIZATION: Only run winding correction on the newly found regions
        // This avoids O(N^2) checks against the thousands of original stroke segments
        if (options.fixWinding) {
            const rangeStart = 0.7;
            const rangeWidth = 0.3;

            regions = fixWinding(regions, options.fillRule, onProgress ? (p) => {
                onProgress(rangeStart + (p * rangeWidth));
            } : undefined);
        }

        // Add detected regions to the path list
        // REPLACE original paths with regions to avoid duplicates
        paths = [...regions];

    } else if (options.closePaths) {
        // Close nearly-closed paths (Simple)
        paths = autoClosePaths(paths, options.gapTolerance);

        // Step 4: Fix winding for closed paths
        // In the "Close Paths" strategy, we operate on the original paths
        if (options.fixWinding) {
            paths = fixWinding(paths, options.fillRule, onProgress);
        }
    }

    // Step 5: Sort paths to minimize travel
    if (options.sortPaths) {
        paths = sortPathsWithTwoOpt(paths);
    }

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
