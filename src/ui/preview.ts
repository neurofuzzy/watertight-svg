/**
 * SVG Preview Renderer
 * Renders paths to a container for visualization
 */

import type { SVGDocument } from '../geometry/types';

export interface PreviewOptions {
    /** Show travel paths (pen-up moves) */
    showTravel?: boolean;
    /** Color for draw paths */
    drawColor?: string;
    /** Color for travel paths */
    travelColor?: string;
    /** Color for closed path fills */
    fillColor?: string;
    /** Stroke width */
    strokeWidth?: number;
}

const defaultOptions: PreviewOptions = {
    showTravel: true,
    drawColor: '#e0e0e8',
    travelColor: 'rgba(255, 80, 255, 0.5)',
    fillColor: 'rgba(130, 180, 255, 0.35)',
    strokeWidth: 1.5,
};

/**
 * Render an SVG document to a container element.
 */
export function renderPreview(
    container: HTMLElement,
    doc: SVGDocument,
    options: PreviewOptions = {}
): SVGSVGElement {
    const opts = { ...defaultOptions, ...options };

    // Clear container
    container.innerHTML = '';

    // Create SVG element
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${doc.width} ${doc.height}`);
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.style.background = '#1a1a24';

    // Create groups for layering
    const fillGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const travelGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const drawGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');

    fillGroup.setAttribute('id', 'fills');
    travelGroup.setAttribute('id', 'travel');
    drawGroup.setAttribute('id', 'paths');

    // Render travel paths first (underneath)
    if (opts.showTravel) {
        let lastPoint = { x: 0, y: 0 };

        for (const path of doc.paths) {
            if (path.points.length === 0) continue;

            const start = path.points[0];
            if (lastPoint.x !== start.x || lastPoint.y !== start.y) {
                const travelLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                travelLine.setAttribute('x1', String(lastPoint.x));
                travelLine.setAttribute('y1', String(lastPoint.y));
                travelLine.setAttribute('x2', String(start.x));
                travelLine.setAttribute('y2', String(start.y));
                travelLine.setAttribute('stroke', opts.travelColor!);
                travelLine.setAttribute('stroke-width', String(opts.strokeWidth! * 0.5));
                travelLine.setAttribute('stroke-dasharray', '4 2');
                travelGroup.appendChild(travelLine);
            }

            lastPoint = path.points[path.points.length - 1];
        }
    }

    // Render fills for closed paths
    // fast-path: combining all closed paths into one d string to support evenodd filling (holes)
    const closedPaths = doc.paths.filter(p => p.closed && p.points.length >= 3);
    if (closedPaths.length > 0) {
        const d = closedPaths.map(path => {
            if (path.points.length < 1) return '';
            const start = path.points[0];
            const lines = path.points.slice(1).map(p => `L${p.x},${p.y}`).join(' ');
            return `M${start.x},${start.y} ${lines} Z`;
        }).join(' ');

        const fillPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        fillPath.setAttribute('d', d);
        fillPath.setAttribute('fill', opts.fillColor!);
        fillPath.setAttribute('fill-rule', 'evenodd'); // Critical for holes
        fillPath.setAttribute('stroke', 'none');
        fillGroup.appendChild(fillPath);
    }

    // Render draw paths
    for (const path of doc.paths) {
        if (path.points.length < 2) continue;

        const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        const points = path.points.map(p => `${p.x},${p.y}`).join(' ');
        pathEl.setAttribute('points', points);
        pathEl.setAttribute('fill', 'none');
        // Always use our draw color, ignore original stroke
        pathEl.setAttribute('stroke', opts.drawColor!);
        pathEl.setAttribute('stroke-width', String(opts.strokeWidth));
        pathEl.setAttribute('stroke-linecap', 'round');
        pathEl.setAttribute('stroke-linejoin', 'round');

        // Close the path visually if closed
        if (path.closed && path.points.length > 2) {
            const start = path.points[0];
            const end = path.points[path.points.length - 1];
            if (start.x !== end.x || start.y !== end.y) {
                const closingLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                closingLine.setAttribute('x1', String(end.x));
                closingLine.setAttribute('y1', String(end.y));
                closingLine.setAttribute('x2', String(start.x));
                closingLine.setAttribute('y2', String(start.y));
                closingLine.setAttribute('stroke', opts.drawColor!);
                closingLine.setAttribute('stroke-width', String(opts.strokeWidth));
                drawGroup.appendChild(closingLine);
            }
        }

        drawGroup.appendChild(pathEl);
    }

    // Add groups to SVG
    svg.appendChild(fillGroup);
    svg.appendChild(travelGroup);
    svg.appendChild(drawGroup);

    container.appendChild(svg);

    return svg;
}
