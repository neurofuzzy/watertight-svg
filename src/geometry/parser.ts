/**
 * SVG Parser - resolves an SVG document into flat polylines in root viewBox space.
 *
 * Geometry itself comes from `path-data.ts`, which reads the elements' own
 * attributes: vertices are emitted exactly and only curves are sampled. The DOM
 * is used for what only it can answer — the transform chain (`getScreenCTM`)
 * and computed styles — plus `getPointAtLength()` as a last-resort fallback for
 * path data that cannot be read, which chamfers corners but never loses a shape.
 */

import type { Point, Path, SVGDocument, PathMeta, BoundingBox } from './types';
import { pathBounds, signedArea } from './math';
import { flattenPath, rectSubpath, ellipseSubpath, parsePointsList, type Subpath } from './path-data';

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
        const box = viewBoxOf(svgElement);
        let width = box?.width || parseFloat(svgElement.getAttribute('width') || '0');
        let height = box?.height || parseFloat(svgElement.getAttribute('height') || '0');

        if (!width || !height) {
            const bbox = measureBBox(svgElement);
            width = width || bbox?.width || 100;
            height = height || bbox?.height || 100;
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
    const box = viewBoxOf(svgElement);
    const minX = box?.width ? box.x : 0;
    const minY = box?.width ? box.y : 0;
    return { minX, minY, maxX: minX + width, maxY: minY + height };
}

/**
 * The root viewBox, read through the SVG DOM where available and off the
 * attribute where it is not — same reasoning as `lengthValue`.
 */
function viewBoxOf(svgElement: SVGSVGElement): { x: number; y: number; width: number; height: number } | null {
    const baseVal = svgElement.viewBox?.baseVal;
    if (baseVal && Number.isFinite(baseVal.width)) {
        return { x: baseVal.x, y: baseVal.y, width: baseVal.width, height: baseVal.height };
    }

    const parts = (svgElement.getAttribute('viewBox') ?? '')
        .split(/[\s,]+/)
        .filter(token => token.length > 0)
        .map(parseFloat);
    if (parts.length !== 4 || parts.some(value => !Number.isFinite(value))) return null;

    return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
}

/** Rendered bounds, when the document declares no size. Unavailable off-browser. */
function measureBBox(svgElement: SVGSVGElement): { width: number; height: number } | null {
    try {
        return svgElement.getBBox();
    } catch {
        return null;
    }
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

/**
 * Extract path(s) from a single SVG geometry element.
 *
 * Geometry comes from the element's own attributes via `path-data.ts`, not from
 * `getPointAtLength()`: arc-length sampling only lands on a vertex by luck, so
 * it chamfers every corner it passes. The DOM is still the authority on the
 * *coordinate system* — hence the matrix — just not on the point list.
 */
function extractFromGeometryElement(element: SVGGeometryElement, ctx: ParseContext): Path[] {
    const tagName = element.tagName.toLowerCase();
    const meta = extractMeta(element);

    // Resolve the element's transform chain once, and convert the sampling step into
    // the element's local units so density stays uniform in root space.
    const matrix = getRootMatrix(element, ctx.root);
    const localStep = ctx.segmentLength / matrixScale(matrix);

    const subpaths = subpathsForElement(element, tagName, localStep);
    if (subpaths === null) {
        // Path data we could not read. The browser can still draw it, so fall
        // back to sampling: losing corner fidelity beats losing the geometry.
        return sampleElement(element, localStep, matrix, meta, tagName);
    }

    return subpaths
        .filter(subpath => subpath.points.length >= 2)
        .map(subpath => ({
            points: subpath.points.map(p => applyMatrix(matrix, p.x, p.y)),
            closed: subpath.closed,
            meta,
        }));
}

/**
 * Exact subpaths for an element, in its own user space.
 *
 * Returns null when the element's geometry cannot be read directly — malformed
 * path data, or an element type this does not know — so the caller can fall
 * back to the DOM.
 */
function subpathsForElement(
    element: SVGGeometryElement,
    tagName: string,
    localStep: number,
): Subpath[] | null {
    try {
        switch (tagName) {
            case 'path': {
                const d = element.getAttribute('d');
                if (!d) return [];
                return flattenPath(d, localStep);
            }

            case 'line':
                return [{
                    points: [
                        { x: lengthValue(element, 'x1'), y: lengthValue(element, 'y1') },
                        { x: lengthValue(element, 'x2'), y: lengthValue(element, 'y2') },
                    ],
                    closed: false,
                }];

            case 'polyline':
            case 'polygon':
                return [{
                    points: parsePointsList(element.getAttribute('points') ?? ''),
                    closed: tagName === 'polygon',
                }];

            case 'rect': {
                // An unspecified radius is "auto", which means "match the other
                // one" — and 0 only when neither is given. Both report 0, so the
                // attributes have to be consulted to tell them apart.
                const hasRx = element.hasAttribute('rx');
                const hasRy = element.hasAttribute('ry');
                const rx = hasRx ? lengthValue(element, 'rx')
                    : (hasRy ? lengthValue(element, 'ry') : 0);
                const ry = hasRy ? lengthValue(element, 'ry') : rx;
                return single(rectSubpath(
                    lengthValue(element, 'x'), lengthValue(element, 'y'),
                    lengthValue(element, 'width'), lengthValue(element, 'height'),
                    rx, ry, localStep,
                ));
            }

            case 'circle': {
                const r = lengthValue(element, 'r');
                return single(ellipseSubpath(
                    lengthValue(element, 'cx'), lengthValue(element, 'cy'), r, r, localStep,
                ));
            }

            case 'ellipse':
                return single(ellipseSubpath(
                    lengthValue(element, 'cx'), lengthValue(element, 'cy'),
                    lengthValue(element, 'rx'), lengthValue(element, 'ry'), localStep,
                ));

            default:
                return null;
        }
    } catch {
        return null;
    }
}

const single = (subpath: Subpath | null): Subpath[] => (subpath ? [subpath] : []);

/**
 * Resolved value of a geometry attribute, in the element's user space.
 *
 * `baseVal` is preferred because it resolves units and percentages against the
 * viewport (`width="100%"` on a background rect). The attribute is the fallback
 * for environments that do not implement the SVG length interfaces — which is
 * every non-browser DOM, and therefore the only reason these tests can run.
 */
function lengthValue(element: Element, property: string): number {
    const animated = (element as unknown as Record<string, { baseVal?: { value?: unknown } }>)[property];
    const resolved = animated?.baseVal?.value;
    if (typeof resolved === 'number' && Number.isFinite(resolved)) return resolved;

    const attribute = parseFloat(element.getAttribute(property) ?? '');
    return Number.isFinite(attribute) ? attribute : 0;
}

/**
 * Last resort: walk the element with `getPointAtLength()`.
 *
 * This is the old behaviour, corner chamfering included, kept only for geometry
 * this parser cannot read. Subpaths are not split out — an element reaching here
 * is already malformed, and the browser's own interpretation is the best
 * available account of what it draws.
 */
function sampleElement(
    element: SVGGeometryElement,
    localStep: number,
    matrix: DOMMatrix | null,
    meta: PathMeta,
    tagName: string,
): Path[] {
    try {
        const totalLength = element.getTotalLength();
        if (totalLength === 0) return [];

        const points = samplePath(element, totalLength, localStep, matrix);
        if (points.length < 2) return [];

        const closed = tagName === 'path'
            ? (element.getAttribute('d') ?? '').toLowerCase().includes('z')
            : ['rect', 'circle', 'ellipse', 'polygon'].includes(tagName);

        return [{ points, closed, meta }];
    } catch {
        return [];
    }
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
