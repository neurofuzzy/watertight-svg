/**
 * Segment Intersection - Find all intersection points between line segments
 * 
 * Uses a simplified sweep line algorithm for finding intersections.
 * Designed for Rust/WASM portability - no DOM dependencies.
 */

import type { Point } from './types';

/** A line segment defined by two endpoints */
export interface Segment {
    id: number;
    p1: Point;
    p2: Point;
}

/** An intersection point with the segments involved */
export interface Intersection {
    point: Point;
    segments: number[];  // IDs of segments that intersect here
}

/** Epsilon for floating point comparisons */
const EPSILON = 1e-10;

/**
 * Find all intersection points between a set of segments.
 * Uses a brute-force O(n²) approach for simplicity.
 * For large inputs, Bentley-Ottmann would be O((n + k) log n).
 */
/**
 * Find all intersection points between a set of segments.
 * Uses a brute-force O(n²) approach for simplicity.
 * For large inputs, Bentley-Ottmann would be O((n + k) log n).
 */
export function findAllIntersections(
    segments: Segment[],
    tolerance: number = 0.001,
    onProgress?: (percent: number) => void
): Intersection[] {
    const intersections: Map<string, Intersection> = new Map();
    const total = segments.length;
    let lastReport = 0;

    for (let i = 0; i < segments.length; i++) {
        // Report progress every ~1% or so to avoid spamming
        if (onProgress) {
            const now = Date.now();
            if (now - lastReport > 100) { // Throttle to 100ms
                onProgress(i / total);
                lastReport = now;
            }
        }

        for (let j = i + 1; j < segments.length; j++) {
            const intersection = segmentIntersection(segments[i], segments[j]);

            if (intersection) {
                // Snap to grid for deduplication
                const key = `${Math.round(intersection.x / tolerance) * tolerance},${Math.round(intersection.y / tolerance) * tolerance}`;

                if (intersections.has(key)) {
                    const existing = intersections.get(key)!;
                    if (!existing.segments.includes(segments[i].id)) {
                        existing.segments.push(segments[i].id);
                    }
                    if (!existing.segments.includes(segments[j].id)) {
                        existing.segments.push(segments[j].id);
                    }
                } else {
                    intersections.set(key, {
                        point: intersection,
                        segments: [segments[i].id, segments[j].id],
                    });
                }
            }
        }
    }

    if (onProgress) onProgress(1.0); // Ensure 100% at end

    return Array.from(intersections.values());
}

/**
 * Find the intersection point of two line segments.
 * Returns null if segments don't intersect.
 */
export function segmentIntersection(s1: Segment, s2: Segment): Point | null {
    const x1 = s1.p1.x, y1 = s1.p1.y;
    const x2 = s1.p2.x, y2 = s1.p2.y;
    const x3 = s2.p1.x, y3 = s2.p1.y;
    const x4 = s2.p2.x, y4 = s2.p2.y;

    const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);

    // Parallel or nearly parallel
    if (Math.abs(denom) < EPSILON) {
        return null;
    }

    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
    const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;

    // Check if intersection is within both segments
    // Use small epsilon to include endpoints
    if (t >= -EPSILON && t <= 1 + EPSILON && u >= -EPSILON && u <= 1 + EPSILON) {
        return {
            x: x1 + t * (x2 - x1),
            y: y1 + t * (y2 - y1),
        };
    }

    return null;
}

/**
 * Split a segment at given intersection points.
 * Returns sub-segments in order from p1 to p2.
 */
export function splitSegmentAtIntersections(
    segment: Segment,
    intersections: Point[]
): Segment[] {
    if (intersections.length === 0) {
        return [segment];
    }

    // Sort intersections along the segment direction
    const sorted = [...intersections].sort((a, b) => {
        const da = distanceAlong(segment, a);
        const db = distanceAlong(segment, b);
        return da - db;
    });

    // Filter out intersections that are essentially at the endpoints
    const filtered = sorted.filter(p => {
        const d = distanceAlong(segment, p);
        return d > EPSILON && d < 1 - EPSILON;
    });

    if (filtered.length === 0) {
        return [segment];
    }

    // Create sub-segments
    const result: Segment[] = [];
    let lastPoint = segment.p1;
    let subId = 0;

    for (const point of filtered) {
        result.push({
            id: segment.id * 1000 + subId++,
            p1: lastPoint,
            p2: point,
        });
        lastPoint = point;
    }

    // Final segment to p2
    result.push({
        id: segment.id * 1000 + subId,
        p1: lastPoint,
        p2: segment.p2,
    });

    return result;
}

/**
 * Calculate the parameter t (0 to 1) for a point along a segment.
 */
function distanceAlong(segment: Segment, point: Point): number {
    const dx = segment.p2.x - segment.p1.x;
    const dy = segment.p2.y - segment.p1.y;
    const len = Math.sqrt(dx * dx + dy * dy);

    if (len < EPSILON) return 0;

    const px = point.x - segment.p1.x;
    const py = point.y - segment.p1.y;

    return (px * dx + py * dy) / (len * len);
}

/**
 * Convert paths to segments for intersection finding.
 */
export function pathsToSegments(paths: { points: Point[] }[]): Segment[] {
    const segments: Segment[] = [];
    let id = 0;

    for (const path of paths) {
        for (let i = 0; i < path.points.length - 1; i++) {
            segments.push({
                id: id++,
                p1: path.points[i],
                p2: path.points[i + 1],
            });
        }
    }

    return segments;
}

/** Check if a point is close to a segment endpoint */
export function isEndpoint(segment: Segment, point: Point, tolerance: number = 0.001): boolean {
    const d1 = Math.hypot(point.x - segment.p1.x, point.y - segment.p1.y);
    const d2 = Math.hypot(point.x - segment.p2.x, point.y - segment.p2.y);
    return d1 < tolerance || d2 < tolerance;
}

/**
 * Split all paths at intersection points to eliminate crossing segments.
 * This should be run BEFORE overdraw removal and path merging.
 * 
 * @returns Array of Path objects with no crossing segments (all intersections become vertices)
 */
export function splitPathsAtIntersections(
    paths: { points: Point[], closed?: boolean, meta?: unknown }[],
    tolerance: number = 1.0,
    onProgress?: (percent: number) => void
): { points: Point[], closed: boolean, meta?: unknown }[] {
    if (paths.length === 0) return [];

    // Step 1: Convert paths to segments
    const segments = pathsToSegments(paths);
    if (segments.length === 0) return paths as { points: Point[], closed: boolean, meta?: unknown }[];

    // Step 2: Find all intersections
    const intersections = findAllIntersections(segments, tolerance, onProgress ?
        (p) => onProgress(p * 0.5) : undefined);

    if (intersections.length === 0) {
        // No intersections - return original paths
        return paths as { points: Point[], closed: boolean, meta?: unknown }[];
    }

    // Step 3: Group intersections by segment ID
    const segmentIntersections = new Map<number, Point[]>();
    for (const intersection of intersections) {
        for (const segId of intersection.segments) {
            if (!segmentIntersections.has(segId)) {
                segmentIntersections.set(segId, []);
            }
            segmentIntersections.get(segId)!.push(intersection.point);
        }
    }

    // Step 4: Split each segment at its intersection points
    const splitSegments: Segment[] = [];
    for (const segment of segments) {
        const points = segmentIntersections.get(segment.id) || [];
        const splits = splitSegmentAtIntersections(segment, points);
        splitSegments.push(...splits);
    }

    // Step 5: Convert split segments back to paths (each segment becomes a 2-point path)
    const result: { points: Point[], closed: boolean, meta?: unknown }[] = [];
    for (const seg of splitSegments) {
        result.push({
            points: [seg.p1, seg.p2],
            closed: false,
        });
    }

    if (onProgress) onProgress(1.0);

    console.log(`[splitPathsAtIntersections] ${paths.length} paths -> ${segments.length} segments -> ${intersections.length} intersections -> ${splitSegments.length} split segments`);

    return result;
}

