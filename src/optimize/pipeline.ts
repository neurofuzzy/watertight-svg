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
 */
export function optimize(svgString: string, options: OptimizeOptions): OptimizeResult {
    // Parse the SVG
    const original = parseSVG(svgString);
    const beforeStats = calculateStats(original.paths);

    // Run optimization steps
    let paths = [...original.paths];

    // Step 1: Merge connected segments (uses tight geometric tolerance)
    if (options.mergePaths) {
        paths = mergePaths(paths); // Uses default 0.001 tolerance
    }

    // Step 2: Remove overdraw (uses tight geometric tolerance)
    if (options.removeOverdraw) {
        paths = removeOverdraw(paths); // Uses default 0.01 tolerance
    }

    // Step 3: Find enclosed regions (Flash-style fills)
    if (options.findRegions) {
        const regions = findRegions(paths, { tolerance: options.gapTolerance });
        // Add detected regions to the path list
        paths = [...paths, ...regions];
    }

    // Step 4: Close nearly-closed paths
    if (options.closePaths) {
        paths = autoClosePaths(paths, options.gapTolerance);
    }

    // Step 5: Fix winding for nested shapes
    if (options.fixWinding) {
        paths = fixWinding(paths, options.fillRule);
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
