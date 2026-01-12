/**
 * Core types for SVG path representation and manipulation
 */

/** A 2D point */
export interface Point {
    x: number;
    y: number;
}

/** A line segment between two points */
export interface Segment {
    start: Point;
    end: Point;
}

/** Path metadata */
export interface PathMeta {
    /** Original SVG element ID if present */
    id?: string;
    /** Original stroke color */
    stroke?: string;
    /** Original fill color */
    fill?: string;
    /** Original stroke width */
    strokeWidth?: number;
    /** Computed area (for regions) */
    area?: number;
    /** Whether this path was detected as an enclosed region */
    isRegion?: boolean;
}

/**
 * A path is a series of connected segments.
 * If closed, the last point connects back to the first.
 */
export interface Path {
    /** Ordered list of points forming the path */
    points: Point[];
    /** Whether the path forms a closed shape */
    closed: boolean;
    /** Optional metadata from original SVG */
    meta?: PathMeta;
}

/** Axis-aligned bounding box */
export interface BoundingBox {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

/** An SVG document represented as a collection of paths */
export interface SVGDocument {
    /** Width of the SVG viewBox */
    width: number;
    /** Height of the SVG viewBox */
    height: number;
    /** All paths extracted from the SVG */
    paths: Path[];
    /** Original viewBox string if present */
    viewBox?: string;
}

/** Statistics about a set of paths */
export interface PathStats {
    /** Number of paths */
    pathCount: number;
    /** Number of segments (individual lines) */
    segmentCount: number;
    /** Total length of all paths in drawing units */
    totalLength: number;
    /** Total travel distance (pen-up moves) */
    travelDistance: number;
    /** Number of closed paths */
    closedPaths: number;
}

/** Optimization options */
export interface OptimizeOptions {
    /** Merge connected segments into paths */
    mergePaths: boolean;
    /** Remove overlapping/duplicate segments */
    removeOverdraw: boolean;
    /** Split segments at all intersection points (recommended for complex SVGs) */
    splitIntersections: boolean;
    /** Sort paths to minimize travel distance */
    sortPaths: boolean;
    /** Find enclosed regions (Flash-style fill) */
    findRegions: boolean;
    /** Close paths that are nearly closed */
    closePaths: boolean;
    /** Gap tolerance for closing paths (in SVG units) */
    gapTolerance: number;
    /** Fix winding direction for nested shapes */
    fixWinding: boolean;
    /** Fill rule to use for winding correction */
    fillRule: 'evenodd' | 'nonzero';
}

/** Default optimization options */
export const DEFAULT_OPTIONS: OptimizeOptions = {
    mergePaths: true,
    removeOverdraw: true,
    splitIntersections: true,
    sortPaths: true,
    findRegions: true,
    closePaths: true,
    gapTolerance: 2,
    fixWinding: true,
    fillRule: 'evenodd',
};
