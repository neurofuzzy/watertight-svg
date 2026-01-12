import { Path, Point } from '../geometry/types';

/**
 * Scales and centers paths to fit within a target paper size.
 * Returns new paths in millimeter units.
 */
export function fitToPaper(
    paths: Path[],
    paperWidth: number,
    paperHeight: number,
    margin: number
): { paths: Path[], scale: number, translateX: number, translateY: number } {
    if (paths.length === 0) return { paths: [], scale: 1, translateX: 0, translateY: 0 };

    // 1. Calculate Bounding Box of all paths
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    for (const path of paths) {
        for (const p of path.points) {
            minX = Math.min(minX, p.x);
            minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x);
            maxY = Math.max(maxY, p.y);
        }
    }

    const contentWidth = maxX - minX;
    const contentHeight = maxY - minY;

    // 2. Calculate Target Area
    const targetWidth = paperWidth - (margin * 2);
    const targetHeight = paperHeight - (margin * 2);

    if (targetWidth <= 0 || targetHeight <= 0) {
        // Margin too big? Return original.
        return { paths, scale: 1, translateX: 0, translateY: 0 };
    }

    // 3. Compute Scale to fit
    const scaleX = targetWidth / contentWidth;
    const scaleY = targetHeight / contentHeight;
    const scale = Math.min(scaleX, scaleY);

    // 4. Compute Translation to center
    // Center of scaled content relative to (minX, minY) * scale
    const scaledWidth = contentWidth * scale;
    const scaledHeight = contentHeight * scale;

    const offsetX = (targetWidth - scaledWidth) / 2;
    const offsetY = (targetHeight - scaledHeight) / 2;

    // Final transform:
    // x' = (x - minX) * scale + margin + offsetX
    // y' = (y - minY) * scale + margin + offsetY

    const translateX = margin + offsetX - (minX * scale);
    const translateY = margin + offsetY - (minY * scale);

    const newPaths: Path[] = paths.map(path => ({
        ...path,
        points: path.points.map(p => ({
            x: p.x * scale + translateX,
            y: p.y * scale + translateY
        }))
    }));

    return { paths: newPaths, scale, translateX, translateY };
}
