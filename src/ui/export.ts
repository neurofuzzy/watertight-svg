/**
 * SVG Export - Convert optimized paths back to SVG
 */

import type { Path, SVGDocument } from '../geometry/types';

/**
 * Export an SVGDocument back to an SVG string.
 * Combines all closed paths into a single path element with evenodd fill-rule
 * to correctly render holes (matching the preview renderer).
 */
export function exportSVG(
    doc: SVGDocument,
    layers?: Map<number, Path[]>
): string {
    const viewBox = doc.viewBox || `0 0 ${doc.width} ${doc.height}`;
    let content = '';

    if (layers && layers.size > 0) {
        // --- Layered Export ---
        const sortedDepths = Array.from(layers.keys()).sort((a, b) => a - b);

        const groups: string[] = [];
        for (const depth of sortedDepths) {
            const paths = layers.get(depth)!;
            const pathElements = pathsToSVGElements(paths);

            // Create Inkscape Layer Group
            // Depth 0 is usually "Open Paths" or "Background"
            // Depth 1+ are nested levels
            const label = depth === 0 ? "Open Paths" : `Depth ${depth}`;

            groups.push(`  <g inkscape:groupmode="layer" inkscape:label="${label}" id="depth-${depth}">
    ${pathElements.join('\n    ')}
  </g>`);
        }
        content = groups.join('\n');

    } else {
        // --- Standard Flat Export (Original Logic) ---
        content = pathsToSVGElements(doc.paths).join('\n  ');
    }

    // Preserve the source document's physical units. Falling back to mm keeps the
    // long-standing behaviour for unitless/pixel documents.
    const units = doc.units || 'mm';

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     viewBox="${viewBox}"
     width="${doc.width}${units}"
     height="${doc.height}${units}">
${content}
</svg>`;
}

/**
 * Helper to convert a list of paths to SVG string elements
 * (Extracted from original exportSVG)
 */
function pathsToSVGElements(paths: Path[]): string[] {
    // Separate closed and open paths
    const closedPaths = paths.filter(p => p.closed && p.points.length >= 3);
    const openPaths = paths.filter(p => !p.closed || p.points.length < 3);

    const elements: string[] = [];

    // Combine all closed paths into one element with evenodd fill
    if (closedPaths.length > 0) {
        const d = closedPaths.map(path => {
            const start = path.points[0];
            const lines = path.points.slice(1).map(p => `L${formatNum(p.x)} ${formatNum(p.y)}`).join(' ');
            return `M${formatNum(start.x)} ${formatNum(start.y)} ${lines} Z`;
        }).join(' ');

        // Use stroke width from first path (should be uniform for export)
        const strokeWidth = closedPaths[0]?.meta?.strokeWidth || 1;

        // Note: For layered export, we might want individual paths if the user plans to edit them?
        // But for cutting, a combined path is usually fine.
        // Let's stick to the combined path for consistency with preview/original logic.
        elements.push(`<path d="${d}" fill="none" stroke="black" stroke-width="${strokeWidth}" fill-rule="evenodd" stroke-linecap="round" stroke-linejoin="round" />`);
    }

    // Export open paths individually
    elements.push(...openPaths.map(pathToSVGPath));

    return elements;
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

    // Handle fills
    if (path.closed) {
        if (path.meta?.isRegion) {
            // Detected regions get a semi-transparent fill
            attrs.push('fill="rgba(100, 150, 255, 0.3)"');
        } else if (path.meta?.fill && path.meta.fill !== 'none') {
            attrs.push(`fill="${path.meta.fill}"`);
        } else {
            // Default semi-transparent fill for closed paths
            attrs.push('fill="rgba(150, 150, 150, 0.2)"');
        }
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
export function downloadSVG(
    doc: SVGDocument,
    filename: string = 'optimized.svg',
    layers?: Map<number, Path[]>
): void {
    const svgString = exportSVG(doc, layers);
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
