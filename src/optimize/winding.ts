/**
 * Raster-based Winding Correction
 * Uses OffscreenCanvas and additive blending to robustly detect nesting depth.
 */

import type { Path } from '../geometry/types';
import {
    isCounterClockwise,
    pathsBounds,
    findInteriorPoint
} from '../geometry/math';

type FillRule = 'evenodd' | 'nonzero';

/**
 * Detect nested shapes and correct their winding direction using raster analysis.
 */
export function fixWinding(
    paths: Path[],
    _fillRule: FillRule = 'evenodd',
    onProgress?: (percent: number) => void
): Path[] {
    // Only process closed paths (open paths don't have winding)
    const closedPaths = paths.filter(p => p.closed && p.points.length >= 3);
    const openPaths = paths.filter(p => !p.closed || p.points.length < 3);

    if (closedPaths.length === 0) {
        if (onProgress) onProgress(1);
        return paths;
    }

    try {
        // Run raster analysis
        const directions = analyzeWindingRaster(closedPaths, onProgress);

        // Apply corrections
        const fixedClosed = closedPaths.map((path, index) => {
            const shouldBeCCW = directions[index];
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
        return [...fixedClosed, ...openPaths];

    } catch (error) {
        console.error('Raster winding failed, falling back to original paths:', error);
        return paths;
    }
}

/**
 * Use OffscreenCanvas to determine proper winding direction for each path.
 */
function analyzeWindingRaster(
    paths: Path[],
    onProgress?: (percent: number) => void
): boolean[] {
    // 1. Setup Canvas
    const MAX_SIZE = 1024;
    const bounds = pathsBounds(paths);
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;

    // Avoid zero-size canvas
    if (width <= 0 || height <= 0) {
        return paths.map(() => true); // Default to CCW
    }

    const scale = Math.min(
        MAX_SIZE / width,
        MAX_SIZE / height
    );

    const canvasWidth = Math.ceil(width * scale) + 2; // +2 padding
    const canvasHeight = Math.ceil(height * scale) + 2;

    const canvas = new OffscreenCanvas(canvasWidth, canvasHeight);
    const ctx = canvas.getContext('2d')!;

    if (!ctx) {
        throw new Error('Could not get OffscreenCanvas context');
    }

    // 2. Render all paths with additive blending
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    ctx.globalCompositeOperation = 'lighter';
    // Use #111111 (decimal 17) for each layer
    ctx.fillStyle = '#111111';

    // Batch draw all paths? Or one by one?
    // We strictly need to "fill" each polygon.
    // Drawing all at once implies a union if self-intersecting?
    // No, standard canvas fill logic is non-zero or even-odd.
    // We want to accumulate density. So we must draw each path individually on top of each other.

    // Optimizing loop
    const total = paths.length;
    for (let i = 0; i < total; i++) {
        const path = paths[i];

        ctx.beginPath();
        const start = path.points[0];
        // Map to canvas coords (pad by 1px)
        ctx.moveTo((start.x - bounds.minX) * scale + 1, (start.y - bounds.minY) * scale + 1);

        for (let j = 1; j < path.points.length; j++) {
            const p = path.points[j];
            ctx.lineTo((p.x - bounds.minX) * scale + 1, (p.y - bounds.minY) * scale + 1);
        }
        ctx.closePath();
        ctx.fill(); // Default is non-zero, but we are just filling simple polygons

        // Report progress for drawing phase (first 50%)
        if (onProgress && i % 50 === 0) {
            onProgress(0.5 * (i / total));
        }
    }

    // 3. Sample depth
    const imageData = ctx.getImageData(0, 0, canvasWidth, canvasHeight);
    const data = imageData.data;
    const directions: boolean[] = [];

    for (let i = 0; i < total; i++) {
        const path = paths[i];

        // Find a representative interior point
        const point = findInteriorPoint(path.points);

        // Map to canvas coords
        const cx = Math.floor((point.x - bounds.minX) * scale + 1);
        const cy = Math.floor((point.y - bounds.minY) * scale + 1);

        // Clamp to bounds
        const x = Math.max(0, Math.min(canvasWidth - 1, cx));
        const y = Math.max(0, Math.min(canvasHeight - 1, cy));

        const index = (y * canvasWidth + x) * 4;
        const red = data[index]; // 0-255

        // Determine depth (each layer adds 17)
        // Round to nearest multiple of 17 to handle potential anti-aliasing noise
        // though finding interior point usually avoids edges.
        const depth = Math.round(red / 17);

        // Odd depth (1, 3, 5) -> Solid -> CCW
        // Even depth (2, 4, 6) -> Hole -> CW
        // Depth 0 -> Error? Assume Solid.
        const isSolid = (depth % 2 !== 0);

        directions.push(isSolid);

        // Report progress for sampling phase (last 50%)
        if (onProgress && i % 50 === 0) {
            onProgress(0.5 + 0.5 * (i / total));
        }
    }

    return directions;
}
