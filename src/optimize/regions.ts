/**
 * Region Finding - Extract enclosed regions from intersecting paths
 * 
 * Uses DCEL (Doubly Connected Edge List) to find all enclosed faces
 * formed by intersecting line segments. This is the "Flash-style"
 * fill algorithm that finds regions even from rough sketches.
 * 
 * No DOM dependencies - this runs in the optimization Web Worker and under
 * Node in the test suite.
 */

import type { Path, Point } from '../geometry/types';
import { DCEL, findOrCreateVertex } from '../geometry/dcel';
import {
    pathsToSegments,
    findAllIntersections,
    splitSegmentAtIntersections,
    type Segment,
    type Intersection
} from '../geometry/intersection';

export interface RegionFindingOptions {
    /** Tolerance for snapping vertices together */
    tolerance: number;
    /** Whether to include the outer (unbounded) face */
    includeOuterFace: boolean;
    /** Minimum area threshold for valid regions */
    minArea: number;
    /** Callback for progress updates (0-1) */
    onProgress?: (percent: number) => void;
}

const defaultOptions: RegionFindingOptions = {
    tolerance: 0.5,
    includeOuterFace: false,
    minArea: 1,
};

/**
 * Find all enclosed regions formed by the given paths.
 * Returns closed Path objects for each detected region.
 */
export function findRegions(paths: Path[], options: Partial<RegionFindingOptions> = {}): Path[] {
    const opts = { ...defaultOptions, ...options };

    if (paths.length === 0) return [];

    // Step 1: Convert paths to segments
    const segments = pathsToSegments(paths);
    if (segments.length === 0) return [];

    // Step 2: Find all intersections
    const intersections = findAllIntersections(segments, opts.tolerance, opts.onProgress);

    // Step 3: Split segments at intersection points
    const splitSegments = splitAllSegments(segments, intersections);

    // Step 4: Build DCEL from split segments
    const dcel = buildDCEL(splitSegments, opts.tolerance);

    // Step 5: Compute next/prev pointers for face traversal
    dcel.computeNextPrevPointers();

    // Step 6: Extract faces
    dcel.extractFaces();

    // Step 7: Convert faces to paths
    const regions: Path[] = [];

    for (const [faceId, face] of dcel.faces) {
        if (face.isOuterFace && !opts.includeOuterFace) continue;

        const polygon = dcel.getFacePolygon(faceId);
        if (polygon.length < 3) continue;

        // Check minimum area
        const area = Math.abs(computePolygonArea(polygon));
        if (area < opts.minArea) continue;

        regions.push({
            points: polygon,
            closed: true,
            meta: {
                area,
                isRegion: true,
            },
        });
    }

    return regions;
}

/**
 * Split all segments at their intersection points.
 */
function splitAllSegments(segments: Segment[], intersections: Intersection[]): Segment[] {
    // Group intersections by segment ID
    const segmentIntersections = new Map<number, Point[]>();

    for (const intersection of intersections) {
        for (const segmentId of intersection.segments) {
            if (!segmentIntersections.has(segmentId)) {
                segmentIntersections.set(segmentId, []);
            }
            segmentIntersections.get(segmentId)!.push(intersection.point);
        }
    }

    // Split each segment
    const result: Segment[] = [];

    for (const segment of segments) {
        const points = segmentIntersections.get(segment.id) || [];
        const split = splitSegmentAtIntersections(segment, points);
        result.push(...split);
    }

    return result;
}

/**
 * Build a DCEL from split segments.
 */
function buildDCEL(segments: Segment[], tolerance: number): DCEL {
    const dcel = new DCEL();

    for (const segment of segments) {
        // Find or create vertices for endpoints
        const v1 = findOrCreateVertex(dcel, segment.p1.x, segment.p1.y, tolerance);
        const v2 = findOrCreateVertex(dcel, segment.p2.x, segment.p2.y, tolerance);

        // Skip degenerate segments
        if (v1 === v2) continue;

        // Check if edge already exists
        if (edgeExists(dcel, v1, v2)) continue;

        // Create edge pair
        dcel.createEdgePair(v1, v2);
    }

    return dcel;
}

/**
 * Check if an edge already exists between two vertices.
 */
function edgeExists(dcel: DCEL, v1: number, v2: number): boolean {
    for (const [, edge] of dcel.halfEdges) {
        const twinEdge = dcel.halfEdges.get(edge.twin)!;
        if (edge.origin === v1 && twinEdge.origin === v2) return true;
        if (edge.origin === v2 && twinEdge.origin === v1) return true;
    }
    return false;
}

/**
 * Compute signed area of a polygon (positive = CCW, negative = CW).
 */
function computePolygonArea(points: Point[]): number {
    if (points.length < 3) return 0;

    let area = 0;
    for (let i = 0; i < points.length; i++) {
        const j = (i + 1) % points.length;
        area += points[i].x * points[j].y;
        area -= points[j].x * points[i].y;
    }

    return area / 2;
}

/**
 * Utility: Merge detected regions with original paths.
 * Replaces overlapping open paths with closed region paths.
 */
export function applyRegionsToDocument(
    originalPaths: Path[],
    regions: Path[]
): Path[] {
    // For now, just return regions + already-closed paths
    const closedOriginals = originalPaths.filter(p => p.closed);
    return [...closedOriginals, ...regions];
}
