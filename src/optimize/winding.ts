
/**
 * Winding Correction using Analytical Nesting
 * Uses geometric analysis to determine nesting depth and correct winding.
 */

import type { Path } from '../geometry/types';
import { isCounterClockwise } from '../geometry/math';
import { computeAnalyticalNestingDepths } from './nesting-analytical';

type FillRule = 'evenodd' | 'nonzero';

/**
 * Detect nested shapes and correct their winding direction.
 * Ensures consistent winding based on nesting depth (Odd=CCW, Even=CW).
 */
export function fixWinding(
    paths: Path[],
    _fillRule: FillRule = 'evenodd',
    onProgress?: (percent: number) => void
): Path[] {
    // Only process closed paths (open paths don't have winding)
    // We keep open paths in the list but don't modify them

    // NOTE: computeAnalyticalNestingDepths expects the full list and returns depths for all.
    // Open paths will get depth 0.

    if (paths.length === 0) {
        if (onProgress) onProgress(1);
        return paths;
    }

    try {
        // Run analytical analysis to get depths
        const depths = computeAnalyticalNestingDepths(paths);

        const fixedPaths = paths.map((path, index) => {
            if (!path.closed || path.points.length < 3) {
                return path;
            }

            // Odd depth (1, 3, 5) -> Solid -> CCW
            // Even depth (2, 4, 6) -> Hole -> CW
            // Depth 0 -> Should not happen for closed paths with our logic, but treat as Solid if it does.
            const depth = depths[index];
            const shouldBeCCW = (depth % 2 !== 0);

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

        if (onProgress) onProgress(1);
        return fixedPaths;

    } catch (error) {
        console.error('Winding correction failed, falling back to original paths:', error);
        return paths;
    }
}

// Re-export for compatibility if needed, though nesting.ts now imports directly from source
export { computeAnalyticalNestingDepths } from './nesting-analytical';
