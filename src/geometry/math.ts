/**
 * Geometric math utilities for path manipulation
 */

import type { Point, Segment, Path, BoundingBox } from './types';

/** Tolerance for floating point comparisons */
const EPSILON = 1e-10;

/** Scale a path by a factor */
export function scalePath(path: Path, scale: number): Path {
    return {
        ...path,
        points: path.points.map(p => ({ x: p.x * scale, y: p.y * scale }))
    };
}

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

/**
 * How many points to walk when estimating a tangent at a path endpoint.
 * Splitting at intersections leaves very short stubs, so the immediately
 * adjacent point is often too close to give a stable direction.
 */
const TANGENT_LOOKAHEAD_POINTS = 8;

/**
 * Unit vector pointing from one end of a path back into its interior.
 *
 * Walks up to TANGENT_LOOKAHEAD_POINTS points looking for one at least
 * `minLength` away, so densely sampled curves and short stubs both give a
 * usable direction. Returns null for degenerate paths.
 *
 * Note the direction convention: this always points *away* from the chosen
 * endpoint. Callers wanting a direction of travel through that endpoint need
 * to negate it (see sort.ts).
 */
export function outwardTangent(path: Path, atStart: boolean, minLength: number = 0): Point | null {
    const pts = path.points;
    if (pts.length < 2) return null;

    const origin = atStart ? pts[0] : pts[pts.length - 1];
    const limit = Math.min(TANGENT_LOOKAHEAD_POINTS, pts.length - 1);

    let fallback: Point | null = null;

    for (let step = 1; step <= limit; step++) {
        const p = atStart ? pts[step] : pts[pts.length - 1 - step];
        const dx = p.x - origin.x;
        const dy = p.y - origin.y;
        const len = Math.hypot(dx, dy);

        if (len <= 1e-12) continue;

        fallback = { x: dx / len, y: dy / len };
        if (len >= minLength) return fallback;
    }

    return fallback;
}

/** Angle in radians between two unit vectors. Returns 0 if either is unknown. */
export function angleBetween(a: Point | null, b: Point | null): number {
    if (!a || !b) return 0;
    return Math.acos(Math.min(1, Math.max(-1, a.x * b.x + a.y * b.y)));
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
 * Project a point onto a line segment.
 * Returns the closest point on the segment.
 */
export function projectPointToSegment(point: Point, segment: Segment): Point {
    const dx = segment.end.x - segment.start.x;
    const dy = segment.end.y - segment.start.y;
    const lengthSq = dx * dx + dy * dy;

    if (lengthSq < EPSILON) {
        return segment.start;
    }

    const t = Math.max(0, Math.min(1,
        ((point.x - segment.start.x) * dx + (point.y - segment.start.y) * dy) / lengthSq
    ));

    return {
        x: segment.start.x + t * dx,
        y: segment.start.y + t * dy,
    };
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

/**
 * Remove sequential duplicate points from paths.
 */
export function pruneDuplicatePoints(paths: Path[], tolerance: number = 1e-5): Path[] {
    return paths.map(path => {
        if (path.points.length < 2) return path;

        const newPoints = [path.points[0]];
        for (let i = 1; i < path.points.length; i++) {
            if (!pointsEqual(path.points[i], newPoints[newPoints.length - 1], tolerance)) {
                newPoints.push(path.points[i]);
            }
        }

        // Handle closed paths having same start/end
        if (path.closed && newPoints.length > 2) {
            if (pointsEqual(newPoints[0], newPoints[newPoints.length - 1], tolerance)) {
                newPoints.pop();
            }
        }

        return { ...path, points: newPoints };
    });
}

/**
 * Remove paths that have length below the minimum threshold.
 * Also removes single-point and degenerate paths.
 */
export function removeTinyPaths(paths: Path[], minLength: number = 0.01): Path[] {
    return paths.filter(path => {
        // Remove single-point paths
        if (path.points.length < 2) return false;

        // Calculate total length
        const len = pathLength(path);
        return len >= minLength;
    });
}

/**
 * Merge colinear adjacent segments within paths.
 * This simplifies paths by removing unnecessary intermediate points on straight lines.
 */
export function mergeColinearPoints(paths: Path[], tolerance: number = 0.001): Path[] {
    return paths.map(path => {
        if (path.points.length < 3) return path;

        const newPoints: Point[] = [path.points[0]];

        for (let i = 1; i < path.points.length - 1; i++) {
            const prev = newPoints[newPoints.length - 1];
            const curr = path.points[i];
            const next = path.points[i + 1];

            // Check if prev, curr, next are colinear
            if (!areColinear(prev, curr, next, tolerance)) {
                newPoints.push(curr);
            }
            // If colinear, skip the intermediate point
        }

        // Always add the last point
        newPoints.push(path.points[path.points.length - 1]);

        return { ...path, points: newPoints };
    });
}

/**
 * Check if three points are colinear (on the same line).
 */
export function areColinear(a: Point, b: Point, c: Point, tolerance: number = 0.001): boolean {
    // Calculate cross product (area of triangle formed by the three points)
    // If area is ~0, points are colinear
    const area = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y));

    // Normalize by the longest side to make tolerance scale-independent
    const d1 = distance(a, b);
    const d2 = distance(b, c);
    const d3 = distance(a, c);
    const maxLen = Math.max(d1, d2, d3);

    if (maxLen < tolerance) return true; // Degenerate case

    return (area / maxLen) < tolerance;
}

