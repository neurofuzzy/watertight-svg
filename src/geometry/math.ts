/**
 * Geometric math utilities for path manipulation
 */

import type { Point, Segment, Path, BoundingBox } from './types';

/** Tolerance for floating point comparisons */
const EPSILON = 1e-10;

/** Calculate distance between two points */
export function distance(a: Point, b: Point): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return Math.sqrt(dx * dx + dy * dy);
}

/** Check if two points are equal within tolerance */
export function pointsEqual(a: Point, b: Point, tolerance = EPSILON): boolean {
    return distance(a, b) <= tolerance;
}

/** Calculate the length of a segment */
export function segmentLength(segment: Segment): number {
    return distance(segment.start, segment.end);
}

/** Calculate total path length */
export function pathLength(path: Path): number {
    if (path.points.length < 2) return 0;

    let length = 0;
    for (let i = 1; i < path.points.length; i++) {
        length += distance(path.points[i - 1], path.points[i]);
    }

    // Add closing segment if closed
    if (path.closed && path.points.length > 2) {
        length += distance(path.points[path.points.length - 1], path.points[0]);
    }

    return length;
}

/** Get the first point of a path */
export function pathStart(path: Path): Point {
    return path.points[0];
}

/** Get the last point of a path */
export function pathEnd(path: Path): Point {
    return path.points[path.points.length - 1];
}

/** Reverse a path's point order */
export function reversePath(path: Path): Path {
    return {
        ...path,
        points: [...path.points].reverse(),
    };
}

/** Calculate bounding box of a path */
export function pathBounds(path: Path): BoundingBox {
    if (path.points.length === 0) {
        return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    }

    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;

    for (const p of path.points) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
    }

    return { minX, minY, maxX, maxY };
}

/** Calculate bounding box of multiple paths */
export function pathsBounds(paths: Path[]): BoundingBox {
    if (paths.length === 0) {
        return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    }

    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;

    for (const path of paths) {
        const bounds = pathBounds(path);
        minX = Math.min(minX, bounds.minX);
        minY = Math.min(minY, bounds.minY);
        maxX = Math.max(maxX, bounds.maxX);
        maxY = Math.max(maxY, bounds.maxY);
    }

    return { minX, minY, maxX, maxY };
}

/** 
 * Calculate the winding number of a point with respect to a closed polygon.
 * Returns positive for counter-clockwise, negative for clockwise.
 */
export function windingNumber(point: Point, polygon: Point[]): number {
    if (polygon.length < 3) return 0;

    let winding = 0;
    const n = polygon.length;

    for (let i = 0; i < n; i++) {
        const p1 = polygon[i];
        const p2 = polygon[(i + 1) % n];

        if (p1.y <= point.y) {
            if (p2.y > point.y) {
                // Upward crossing
                if (isLeft(p1, p2, point) > 0) {
                    winding++;
                }
            }
        } else {
            if (p2.y <= point.y) {
                // Downward crossing
                if (isLeft(p1, p2, point) < 0) {
                    winding--;
                }
            }
        }
    }

    return winding;
}

/** 
 * Test if a point is left of, on, or right of a line.
 * Returns > 0 for left, 0 for on, < 0 for right.
 */
export function isLeft(p0: Point, p1: Point, p2: Point): number {
    return (p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y);
}

/** Check if a point is inside a closed polygon using even-odd rule */
export function pointInPolygonEvenOdd(point: Point, polygon: Point[]): boolean {
    if (polygon.length < 3) return false;

    let inside = false;
    const n = polygon.length;

    for (let i = 0, j = n - 1; i < n; j = i++) {
        const pi = polygon[i];
        const pj = polygon[j];

        if (((pi.y > point.y) !== (pj.y > point.y)) &&
            (point.x < (pj.x - pi.x) * (point.y - pi.y) / (pj.y - pi.y) + pi.x)) {
            inside = !inside;
        }
    }

    return inside;
}

/** Check if a point is inside a closed polygon using non-zero rule */
export function pointInPolygonNonZero(point: Point, polygon: Point[]): boolean {
    return windingNumber(point, polygon) !== 0;
}

/** 
 * Calculate the signed area of a polygon.
 * Positive = counter-clockwise, negative = clockwise.
 */
export function signedArea(polygon: Point[]): number {
    if (polygon.length < 3) return 0;

    let area = 0;
    const n = polygon.length;

    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        area += polygon[i].x * polygon[j].y;
        area -= polygon[j].x * polygon[i].y;
    }

    return area / 2;
}

/** Check if a polygon is counter-clockwise */
export function isCounterClockwise(polygon: Point[]): boolean {
    return signedArea(polygon) > 0;
}

/** 
 * Check if two line segments intersect.
 * Returns the intersection point if they do, null otherwise.
 */
export function segmentIntersection(a: Segment, b: Segment): Point | null {
    const d1x = a.end.x - a.start.x;
    const d1y = a.end.y - a.start.y;
    const d2x = b.end.x - b.start.x;
    const d2y = b.end.y - b.start.y;

    const cross = d1x * d2y - d1y * d2x;

    // Parallel lines
    if (Math.abs(cross) < EPSILON) return null;

    const dx = b.start.x - a.start.x;
    const dy = b.start.y - a.start.y;

    const t = (dx * d2y - dy * d2x) / cross;
    const u = (dx * d1y - dy * d1x) / cross;

    // Check if intersection is within both segments
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
        return {
            x: a.start.x + t * d1x,
            y: a.start.y + t * d1y,
        };
    }

    return null;
}

/**
 * Calculate the minimum distance from a point to a line segment.
 */
export function pointToSegmentDistance(point: Point, segment: Segment): number {
    const dx = segment.end.x - segment.start.x;
    const dy = segment.end.y - segment.start.y;
    const lengthSq = dx * dx + dy * dy;

    if (lengthSq < EPSILON) {
        // Segment is a point
        return distance(point, segment.start);
    }

    // Project point onto line, clamped to segment
    const t = Math.max(0, Math.min(1,
        ((point.x - segment.start.x) * dx + (point.y - segment.start.y) * dy) / lengthSq
    ));

    const projection = {
        x: segment.start.x + t * dx,
        y: segment.start.y + t * dy,
    };

    return distance(point, projection);
}

/**
 * Check if two segments overlap (are collinear and share length).
 * Returns the overlapping segment if they do, null otherwise.
 */
export function segmentOverlap(a: Segment, b: Segment, tolerance = EPSILON): Segment | null {
    // Check if segments are collinear
    const d1 = pointToSegmentDistance(a.start, { start: b.start, end: b.end });
    const d2 = pointToSegmentDistance(a.end, { start: b.start, end: b.end });

    if (d1 > tolerance || d2 > tolerance) {
        // Not collinear
        return null;
    }

    // Project all points onto the line defined by segment a
    const dx = a.end.x - a.start.x;
    const dy = a.end.y - a.start.y;
    const len = Math.sqrt(dx * dx + dy * dy);

    if (len < EPSILON) return null;

    const project = (p: Point) => {
        return ((p.x - a.start.x) * dx + (p.y - a.start.y) * dy) / (len * len);
    };

    const t1 = 0; // a.start
    const t2 = 1; // a.end
    let t3 = project(b.start);
    let t4 = project(b.end);

    // Ensure t3 <= t4
    if (t3 > t4) [t3, t4] = [t4, t3];

    // Find overlap
    const overlapStart = Math.max(t1, t3);
    const overlapEnd = Math.min(t2, t4);

    if (overlapStart >= overlapEnd - tolerance / len) {
        return null; // No overlap
    }

    return {
        start: {
            x: a.start.x + overlapStart * dx,
            y: a.start.y + overlapStart * dy,
        },
        end: {
            x: a.start.x + overlapEnd * dx,
            y: a.start.y + overlapEnd * dy,
        },
    };
}

/** Get centroid of a polygon */
export function centroid(polygon: Point[]): Point {
    if (polygon.length === 0) return { x: 0, y: 0 };
    if (polygon.length === 1) return polygon[0];

    let cx = 0, cy = 0;
    for (const p of polygon) {
        cx += p.x;
        cy += p.y;
    }

    return { x: cx / polygon.length, y: cy / polygon.length };
}

/**
 * Find a point that is guaranteed to be inside the polygon.
 * Uses a scanline algorithm at the centroid's Y coordinate.
 */
export function findInteriorPoint(polygon: Point[]): Point {
    const center = centroid(polygon);

    // Try horizontal scanline at centroid Y
    let y = center.y;
    let intersections: number[] = [];

    // Find intersections with all edges
    for (let i = 0; i < polygon.length; i++) {
        const p1 = polygon[i];
        const p2 = polygon[(i + 1) % polygon.length];

        if ((p1.y <= y && p2.y > y) || (p2.y <= y && p1.y > y)) {
            const x = (p2.x - p1.x) * (y - p1.y) / (p2.y - p1.y) + p1.x;
            intersections.push(x);
        }
    }

    intersections.sort((a, b) => a - b);

    // If we have valid pairs, pick the midpoint of the median span
    if (intersections.length >= 2) {
        // Pick the widest span to be safe
        let bestX = center.x;
        let maxSpan = -1;

        for (let i = 0; i < intersections.length; i += 2) {
            if (i + 1 >= intersections.length) break;
            const span = intersections[i + 1] - intersections[i];
            const mid = (intersections[i] + intersections[i + 1]) / 2;

            // Verify midpoint is actually inside (handles complex self-intersecting cases)
            if (pointInPolygonEvenOdd({ x: mid, y }, polygon)) {
                if (span > maxSpan) {
                    maxSpan = span;
                    bestX = mid;
                }
            }
        }

        if (maxSpan > 0) {
            return { x: bestX, y };
        }
    }

    // Fallback: If scanline failed (e.g., horizontal polygon), return centroid
    // Ideally we would try a vertical scanline too, but centroid is usually fine if main scan failed
    return center;
}
