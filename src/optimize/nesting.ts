
import { Path } from '../geometry/types';
import { computeAnalyticalNestingDepths } from './nesting-analytical';

/**
 * Group paths by their nesting depth.
 * 
 * @param paths List of paths to group
 * @returns Map<depth, Path[]> where depth 0 is open/failed, 1 is outermost, etc.
 */
export function groupPathsByDepth(paths: Path[]): Map<number, Path[]> {
    const layers = new Map<number, Path[]>();

    // Initialize depth 0 for open paths or those that fail processing
    layers.set(0, []);

    try {
        // Use analytical approach (AABB + Ray Casting)
        const depths = computeAnalyticalNestingDepths(paths);

        paths.forEach((path, index) => {
            const depth = depths[index];

            // Validate depth (should be >= 0)
            const safeDepth = Math.max(0, Math.floor(depth));

            if (!layers.has(safeDepth)) {
                layers.set(safeDepth, []);
            }
            layers.get(safeDepth)!.push(path);
        });

    } catch (err) {
        console.error('Nesting calculation failed:', err);
        // Fallback: all paths to depth 0
        paths.forEach(p => layers.get(0)!.push(p));
    }

    // Sort map keys for consistent iteration order (not strictly guaranteed by Map but good practice for export)
    // (The Map itself preserves insertion order usually, but let's leave it as is, the exporter handles iteration)

    return layers;
}
