/**
 * SVG Export - Convert optimized paths back to SVG
 */

import type { Path, SVGDocument } from '../geometry/types';

/**
 * Export an SVGDocument back to an SVG string.
 */
export function exportSVG(doc: SVGDocument): string {
    const paths = doc.paths.map(pathToSVGPath).join('\n  ');

    const viewBox = doc.viewBox || `0 0 ${doc.width} ${doc.height}`;

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" 
     viewBox="${viewBox}" 
     width="${doc.width}" 
     height="${doc.height}">
  ${paths}
</svg>`;
}

/**
 * Convert a Path to an SVG path element string.
 */
function pathToSVGPath(path: Path): string {
    if (path.points.length < 2) return '';

    // Build path data
    const d = pointsToPathData(path.points, path.closed);

    // Build attributes
    const attrs: string[] = [`d="${d}"`];

    if (path.meta?.stroke) {
        attrs.push(`stroke="${path.meta.stroke}"`);
    } else {
        attrs.push('stroke="black"');
    }

    if (path.meta?.strokeWidth) {
        attrs.push(`stroke-width="${path.meta.strokeWidth}"`);
    } else {
        attrs.push('stroke-width="1"');
    }

    if (path.closed && path.meta?.fill && path.meta.fill !== 'none') {
        attrs.push(`fill="${path.meta.fill}"`);
    } else {
        attrs.push('fill="none"');
    }

    if (path.meta?.id) {
        attrs.push(`id="${path.meta.id}"`);
    }

    attrs.push('stroke-linecap="round"');
    attrs.push('stroke-linejoin="round"');

    return `<path ${attrs.join(' ')} />`;
}

/**
 * Convert points to SVG path data string.
 */
function pointsToPathData(points: Point[], closed: boolean): string {
    if (points.length === 0) return '';

    const commands: string[] = [];

    // Move to first point
    commands.push(`M ${formatNum(points[0].x)} ${formatNum(points[0].y)}`);

    // Line to remaining points
    for (let i = 1; i < points.length; i++) {
        commands.push(`L ${formatNum(points[i].x)} ${formatNum(points[i].y)}`);
    }

    // Close path
    if (closed) {
        commands.push('Z');
    }

    return commands.join(' ');
}

/** Format a number with reasonable precision */
function formatNum(n: number): string {
    // Round to 3 decimal places
    return Number(n.toFixed(3)).toString();
}

interface Point {
    x: number;
    y: number;
}

/**
 * Trigger a download of the SVG file.
 */
export function downloadSVG(doc: SVGDocument, filename: string = 'optimized.svg'): void {
    const svgString = exportSVG(doc);
    const blob = new Blob([svgString], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    URL.revokeObjectURL(url);
}
