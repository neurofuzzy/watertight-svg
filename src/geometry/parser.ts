/**
 * SVG Parser - Uses native browser SVG DOM APIs for accurate path parsing
 * 
 * Leverages getPointAtLength() and getTotalLength() for precise sampling
 * of any SVG path including bezier curves and arcs.
 */

import type { Point, Path, SVGDocument, PathMeta } from './types';

/** Default segment length for path sampling (in SVG units) */
const DEFAULT_SEGMENT_LENGTH = 2;

/** Parse an SVG string into an SVGDocument */
export function parseSVG(svgString: string, segmentLength: number = DEFAULT_SEGMENT_LENGTH): SVGDocument {
    // Create an offscreen SVG element to leverage the DOM
    const container = document.createElement('div');
    container.innerHTML = svgString;

    const svgElement = container.querySelector('svg');
    if (!svgElement) {
        throw new Error('No SVG element found');
    }

    // Append to document temporarily to enable geometry methods
    svgElement.style.position = 'absolute';
    svgElement.style.visibility = 'hidden';
    svgElement.style.left = '-9999px';
    document.body.appendChild(svgElement);

    try {
        // Get dimensions
        const viewBox = svgElement.getAttribute('viewBox');
        let width = svgElement.viewBox.baseVal.width || parseFloat(svgElement.getAttribute('width') || '0');
        let height = svgElement.viewBox.baseVal.height || parseFloat(svgElement.getAttribute('height') || '0');

        if (!width || !height) {
            const bbox = svgElement.getBBox();
            width = width || bbox.width || 100;
            height = height || bbox.height || 100;
        }

        // Extract all paths using native DOM
        const paths = extractPathsFromDOM(svgElement, segmentLength);

        return {
            width,
            height,
            paths,
            viewBox: viewBox || undefined,
        };
    } finally {
        // Clean up
        document.body.removeChild(svgElement);
    }
}

/** Extract paths from SVG using native DOM geometry methods */
function extractPathsFromDOM(svgElement: SVGSVGElement, segmentLength: number): Path[] {
    const paths: Path[] = [];

    // Find all geometry elements
    const geometryElements = svgElement.querySelectorAll(
        'path, line, rect, circle, ellipse, polygon, polyline'
    );

    for (const element of geometryElements) {
        const extractedPaths = extractFromGeometryElement(element as SVGGeometryElement, segmentLength);
        paths.push(...extractedPaths);
    }

    return paths;
}

/** Extract path(s) from a single SVG geometry element */
function extractFromGeometryElement(element: SVGGeometryElement, segmentLength: number): Path[] {
    const tagName = element.tagName.toLowerCase();
    const meta = extractMeta(element);

    // For path elements, we need to handle subpaths
    if (tagName === 'path') {
        return extractFromPathElement(element as SVGPathElement, segmentLength, meta);
    }

    // For other geometry elements, use getPointAtLength directly
    try {
        const totalLength = element.getTotalLength();
        if (totalLength === 0) return [];

        const points = samplePath(element, totalLength, segmentLength);
        if (points.length < 2) return [];

        // Determine if closed
        const closed = ['rect', 'circle', 'ellipse', 'polygon'].includes(tagName);

        return [{
            points,
            closed,
            meta,
        }];
    } catch {
        // Fallback for elements that don't support getTotalLength
        return [];
    }
}

/** 
 * Extract paths from a path element, properly handling subpaths.
 * Uses the path's d attribute to detect M commands for subpath splitting.
 */
function extractFromPathElement(element: SVGPathElement, segmentLength: number, meta: PathMeta): Path[] {
    const d = element.getAttribute('d');
    if (!d) return [];

    // Get path segments using native API if available
    // @ts-ignore - getPathData is not in types but available via polyfill or modern browsers
    if (typeof element.getPathData === 'function') {
        return extractUsingPathData(element, segmentLength, meta);
    }

    // Fallback: Parse d attribute to find subpath boundaries
    return extractWithSubpathDetection(element, d, segmentLength, meta);
}

/** Extract using native getPathData if available */
function extractUsingPathData(element: SVGPathElement, _segmentLength: number, meta: PathMeta): Path[] {
    // @ts-ignore
    const pathData = element.getPathData({ normalize: true });
    const paths: Path[] = [];

    let currentPoints: Point[] = [];
    let currentClosed = false;

    for (const seg of pathData) {
        if (seg.type === 'M') {
            // Save previous path
            if (currentPoints.length >= 2) {
                paths.push({ points: currentPoints, closed: currentClosed, meta });
            }
            currentPoints = [{ x: seg.values[0], y: seg.values[1] }];
            currentClosed = false;
        } else if (seg.type === 'Z') {
            currentClosed = true;
        } else if (seg.type === 'L') {
            currentPoints.push({ x: seg.values[0], y: seg.values[1] });
        }
        // Other segment types are normalized to L by { normalize: true }
    }

    if (currentPoints.length >= 2) {
        paths.push({ points: currentPoints, closed: currentClosed, meta });
    }

    return paths;
}

/** Extract paths by detecting subpaths from M commands in d attribute */
function extractWithSubpathDetection(
    element: SVGPathElement,
    d: string,
    segmentLength: number,
    meta: PathMeta
): Path[] {
    // Find positions of M/m commands (subpath starts)
    const subpathBoundaries = findSubpathBoundaries(d);

    if (subpathBoundaries.length <= 1) {
        // Single path - sample directly
        try {
            const totalLength = element.getTotalLength();
            if (totalLength === 0) return [];

            const points = samplePath(element, totalLength, segmentLength);
            if (points.length < 2) return [];

            const closed = d.toLowerCase().includes('z');
            return [{ points, closed, meta }];
        } catch {
            return [];
        }
    }

    // Multiple subpaths - need to create separate path elements for each
    const paths: Path[] = [];

    for (let i = 0; i < subpathBoundaries.length; i++) {
        const start = subpathBoundaries[i];
        const end = i + 1 < subpathBoundaries.length ? subpathBoundaries[i + 1] : d.length;
        const subD = d.substring(start, end).trim();

        if (!subD) continue;

        // Create a temporary path element for this subpath
        const tempPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        tempPath.setAttribute('d', subD);

        // Append to same parent to get correct coordinate system
        element.parentElement?.appendChild(tempPath);

        try {
            const totalLength = tempPath.getTotalLength();
            if (totalLength > 0) {
                const points = samplePath(tempPath, totalLength, segmentLength);
                if (points.length >= 2) {
                    const closed = subD.toLowerCase().includes('z');
                    paths.push({ points, closed, meta });
                }
            }
        } catch {
            // Skip invalid subpaths
        } finally {
            tempPath.remove();
        }
    }

    return paths;
}

/** Find character positions where M/m commands start new subpaths */
function findSubpathBoundaries(d: string): number[] {
    const boundaries: number[] = [];
    const regex = /[Mm]/g;
    let match;

    while ((match = regex.exec(d)) !== null) {
        boundaries.push(match.index);
    }

    return boundaries;
}

/** Sample points along a path using getPointAtLength */
function samplePath(element: SVGGeometryElement, totalLength: number, segmentLength: number): Point[] {
    const points: Point[] = [];
    const numSamples = Math.max(2, Math.ceil(totalLength / segmentLength));

    for (let i = 0; i <= numSamples; i++) {
        const distance = (i / numSamples) * totalLength;
        const point = element.getPointAtLength(distance);
        points.push({ x: point.x, y: point.y });
    }

    return points;
}

/** Extract metadata from an SVG element */
function extractMeta(element: Element): PathMeta {
    const id = element.getAttribute('id');

    // Get computed styles
    const computedStyle = window.getComputedStyle(element);
    const stroke = computedStyle.stroke !== 'none' ? computedStyle.stroke : element.getAttribute('stroke');
    const fill = computedStyle.fill !== 'none' ? computedStyle.fill : element.getAttribute('fill');
    const strokeWidth = parseFloat(computedStyle.strokeWidth) || parseFloat(element.getAttribute('stroke-width') || '1');

    return {
        id: id || undefined,
        stroke: stroke || undefined,
        fill: fill || undefined,
        strokeWidth: isNaN(strokeWidth) ? undefined : strokeWidth,
    };
}
