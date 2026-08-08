/**
 * SVG Parser - Uses native browser SVG DOM APIs for accurate path parsing
 * 
 * Leverages getPointAtLength() and getTotalLength() for precise sampling
 * of any SVG path including bezier curves and arcs.
 */

import type { Point, Path, SVGDocument, PathMeta, BoundingBox } from './types';
import { pathBounds, signedArea } from './math';

/**
 * Documents are sampled at roughly (largest dimension / this) per point.
 * Using a document-relative step keeps curve fidelity constant whether the
 * viewBox is in pixels (0..800) or physical units (0..8.27 inches).
 */
const SEGMENT_DIVISOR = 250;

/** Hard cap on samples per element, so a pathological path can't hang the tab */
const MAX_SAMPLES_PER_ELEMENT = 200_000;

/** A page-covering rect is matched to the document box within this fraction of its size */
const PAGE_RECT_TOLERANCE = 0.01;

export interface ParseOptions {
    /**
     * Distance between sampled points, in document units.
     * Defaults to a fraction of the document's largest dimension.
     */
    segmentLength?: number;
    /** Drop rectangles that cover the whole page (background/paper rects) */
    discardPageRects?: boolean;
}

/** Everything the extractors need to resolve a geometry element into root-space points */
interface ParseContext {
    root: SVGSVGElement;
    segmentLength: number;
}

/** Parse an SVG string into an SVGDocument */
export function parseSVG(svgString: string, options: ParseOptions = {}): SVGDocument {
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

        const segmentLength = options.segmentLength ?? Math.max(width, height) / SEGMENT_DIVISOR;

        // Extract all paths using native DOM
        let paths = extractPathsFromDOM(svgElement, { root: svgElement, segmentLength });

        if (options.discardPageRects) {
            paths = paths.filter(p => !isPageRect(p, documentBox(svgElement, width, height)));
        }

        return {
            width,
            height,
            paths,
            viewBox: viewBox || undefined,
            units: extractUnits(svgElement),
        };
    } finally {
        // Clean up
        document.body.removeChild(svgElement);
    }
}

/** Extract paths from SVG using native DOM geometry methods */
function extractPathsFromDOM(svgElement: SVGSVGElement, ctx: ParseContext): Path[] {
    const paths: Path[] = [];

    // Find all geometry elements
    const geometryElements = svgElement.querySelectorAll(
        'path, line, rect, circle, ellipse, polygon, polyline'
    );

    for (const element of geometryElements) {
        const extractedPaths = extractFromGeometryElement(element as SVGGeometryElement, ctx);
        paths.push(...extractedPaths);
    }

    return paths;
}

/**
 * Matrix mapping an element's own user space into the root SVG's viewBox space.
 *
 * getPointAtLength() reports coordinates in the element's local user space, so any
 * transform on the element or its ancestors would otherwise be silently dropped.
 * Deriving the matrix from two getScreenCTM() calls cancels out the viewBox -> CSS
 * pixel scaling, leaving only the transform chain between the element and the root.
 */
function getRootMatrix(element: SVGGraphicsElement, root: SVGSVGElement): DOMMatrix | null {
    try {
        const rootCTM = root.getScreenCTM();
        const elementCTM = element.getScreenCTM();
        if (!rootCTM || !elementCTM) return null;

        const matrix = rootCTM.inverse().multiply(elementCTM);
        return isIdentity(matrix) ? null : matrix;
    } catch {
        return null;
    }
}

function isIdentity(m: DOMMatrix): boolean {
    return m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0;
}

/** Uniform scale factor of a matrix, used to keep sample density constant in root space */
function matrixScale(m: DOMMatrix | null): number {
    if (!m) return 1;
    const determinant = Math.abs(m.a * m.d - m.b * m.c);
    const scale = Math.sqrt(determinant);
    return scale > 0 && isFinite(scale) ? scale : 1;
}

function applyMatrix(m: DOMMatrix | null, x: number, y: number): Point {
    if (!m) return { x, y };
    return {
        x: m.a * x + m.c * y + m.e,
        y: m.b * x + m.d * y + m.f,
    };
}

/**
 * Read the physical unit off the root width attribute (e.g. width="5.83in" -> "in").
 *
 * Only real-world units are reported. Unitless and px documents return undefined so
 * they keep being exported as mm, which is the convention this app has always used
 * for pixel-space plotter files.
 */
function extractUnits(svgElement: SVGSVGElement): string | undefined {
    const width = svgElement.getAttribute('width');
    if (!width) return undefined;

    const match = width.trim().match(/(in|cm|mm|pt|pc|q)$/i);
    return match ? match[1].toLowerCase() : undefined;
}

/** The document's coordinate box, honouring a viewBox with a non-zero origin */
function documentBox(svgElement: SVGSVGElement, width: number, height: number): BoundingBox {
    const minX = svgElement.viewBox.baseVal.width ? svgElement.viewBox.baseVal.x : 0;
    const minY = svgElement.viewBox.baseVal.width ? svgElement.viewBox.baseVal.y : 0;
    return { minX, minY, maxX: minX + width, maxY: minY + height };
}

/**
 * Is this path a filled rectangle covering the whole page?
 * Matches both <rect> elements and hand-written rectangular paths, which is how
 * plotter exports (Inkscape, vpype, plotter libraries) emit their paper background.
 */
export function isPageRect(path: Path, box: BoundingBox): boolean {
    if (!path.closed || path.points.length < 4) return false;

    const docWidth = box.maxX - box.minX;
    const docHeight = box.maxY - box.minY;
    const tolerance = Math.max(docWidth, docHeight) * PAGE_RECT_TOLERANCE;
    if (tolerance <= 0) return false;

    const bounds = pathBounds(path);
    if (Math.abs(bounds.minX - box.minX) > tolerance) return false;
    if (Math.abs(bounds.minY - box.minY) > tolerance) return false;
    if (Math.abs(bounds.maxX - box.maxX) > tolerance) return false;
    if (Math.abs(bounds.maxY - box.maxY) > tolerance) return false;

    // Bounds alone would also match any drawing that fills the page, so require the
    // shape to actually be its own bounding box (area within 1% of the box area).
    const boxArea = (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY);
    if (boxArea <= 0) return false;

    return Math.abs(signedArea(path.points)) >= boxArea * 0.99;
}

/** Extract path(s) from a single SVG geometry element */
function extractFromGeometryElement(element: SVGGeometryElement, ctx: ParseContext): Path[] {
    const tagName = element.tagName.toLowerCase();
    const meta = extractMeta(element);

    // Resolve the element's transform chain once, and convert the sampling step into
    // the element's local units so density stays uniform in root space.
    const matrix = getRootMatrix(element, ctx.root);
    const localStep = ctx.segmentLength / matrixScale(matrix);

    // For path elements, we need to handle subpaths
    if (tagName === 'path') {
        return extractFromPathElement(element as SVGPathElement, localStep, matrix, meta);
    }

    // For other geometry elements, use getPointAtLength directly
    try {
        const totalLength = element.getTotalLength();
        if (totalLength === 0) return [];

        const points = samplePath(element, totalLength, localStep, matrix);
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
function extractFromPathElement(
    element: SVGPathElement,
    localStep: number,
    matrix: DOMMatrix | null,
    meta: PathMeta
): Path[] {
    const d = element.getAttribute('d');
    if (!d) return [];

    // Get path segments using native API if available
    // @ts-ignore - getPathData is not in types but available via polyfill or modern browsers
    if (typeof element.getPathData === 'function') {
        return extractUsingPathData(element, matrix, meta);
    }

    // Fallback: Parse d attribute to find subpath boundaries
    return extractWithSubpathDetection(element, d, localStep, matrix, meta);
}

/** Extract using native getPathData if available */
function extractUsingPathData(element: SVGPathElement, matrix: DOMMatrix | null, meta: PathMeta): Path[] {
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
            currentPoints = [applyMatrix(matrix, seg.values[0], seg.values[1])];
            currentClosed = false;
        } else if (seg.type === 'Z') {
            currentClosed = true;
        } else if (seg.type === 'L') {
            currentPoints.push(applyMatrix(matrix, seg.values[0], seg.values[1]));
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
    localStep: number,
    matrix: DOMMatrix | null,
    meta: PathMeta
): Path[] {
    // Find positions of M/m commands (subpath starts)
    const subpathBoundaries = findSubpathBoundaries(d);

    if (subpathBoundaries.length <= 1) {
        // Single path - sample directly
        try {
            const totalLength = element.getTotalLength();
            if (totalLength === 0) return [];

            const points = samplePath(element, totalLength, localStep, matrix);
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
                const points = samplePath(tempPath, totalLength, localStep, matrix);
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

/**
 * Sample points along a path using getPointAtLength.
 *
 * `localStep` and `totalLength` are both in the element's local user space; the
 * matrix lifts each sample into the root SVG's coordinate space.
 */
function samplePath(
    element: SVGGeometryElement,
    totalLength: number,
    localStep: number,
    matrix: DOMMatrix | null
): Point[] {
    const points: Point[] = [];
    const step = localStep > 0 && isFinite(localStep) ? localStep : totalLength;
    const numSamples = Math.min(
        MAX_SAMPLES_PER_ELEMENT,
        Math.max(2, Math.ceil(totalLength / step))
    );

    for (let i = 0; i <= numSamples; i++) {
        const distance = (i / numSamples) * totalLength;
        const point = element.getPointAtLength(distance);
        points.push(applyMatrix(matrix, point.x, point.y));
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
