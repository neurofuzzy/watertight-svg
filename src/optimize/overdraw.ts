/**
 * Overdraw Detection and Removal
 * Finds and removes duplicate or overlapping path segments
 */

import type { Path, Point, Segment } from '../geometry/types';
import { pointsEqual, segmentOverlap, segmentLength } from '../geometry/math';

/**
 * Remove overlapping/duplicate segments from paths.
 * This reduces the amount of redundant cutting/drawing.
 */
export function removeOverdraw(paths: Path[], tolerance: number = 0.01): Path[] {
    // Extract all segments from all paths
    const allSegments = extractSegments(paths);

    // Find and remove duplicates/overlaps
    const cleanedSegments = removeDuplicateSegments(allSegments, tolerance);

    // Rebuild paths from cleaned segments
    return rebuildPaths(cleanedSegments, paths);
}

interface IndexedSegment {
    segment: Segment;
    pathIndex: number;
    segmentIndex: number;
}

/** Extract all segments from paths */
function extractSegments(paths: Path[]): IndexedSegment[] {
    const segments: IndexedSegment[] = [];

    for (let pathIndex = 0; pathIndex < paths.length; pathIndex++) {
        const path = paths[pathIndex];
        const points = path.points;

        for (let i = 0; i < points.length - 1; i++) {
            segments.push({
                segment: { start: points[i], end: points[i + 1] },
                pathIndex,
                segmentIndex: i,
            });
        }

        // Add closing segment for closed paths
        if (path.closed && points.length > 2) {
            segments.push({
                segment: { start: points[points.length - 1], end: points[0] },
                pathIndex,
                segmentIndex: points.length - 1,
            });
        }
    }

    return segments;
}

/** Remove duplicate and overlapping segments */
function removeDuplicateSegments(
    segments: IndexedSegment[],
    tolerance: number
): IndexedSegment[] {
    const result: IndexedSegment[] = [];
    const removed = new Set<number>();

    for (let i = 0; i < segments.length; i++) {
        if (removed.has(i)) continue;

        const segA = segments[i].segment;
        let keepSegment = true;

        for (let j = i + 1; j < segments.length; j++) {
            if (removed.has(j)) continue;

            const segB = segments[j].segment;

            // Check for exact duplicates (in either direction)
            if (areSegmentsEqual(segA, segB, tolerance)) {
                removed.add(j);
                continue;
            }

            // Check for overlapping segments
            const overlap = segmentOverlap(segA, segB, tolerance);
            if (overlap) {
                // If one segment fully contains the other, keep the larger one
                const lenA = segmentLength(segA);
                const lenB = segmentLength(segB);
                const lenOverlap = segmentLength(overlap);

                // If overlap is almost the entire shorter segment, remove the shorter
                const minLen = Math.min(lenA, lenB);
                if (lenOverlap > minLen * 0.9) {
                    if (lenA <= lenB) {
                        // segA is shorter or equal, but we're iterating, so mark for removal later
                        keepSegment = false;
                    } else {
                        removed.add(j);
                    }
                }
            }
        }

        if (keepSegment) {
            result.push(segments[i]);
        }
    }

    return result;
}

/** Check if two segments are equal (in either direction) */
function areSegmentsEqual(a: Segment, b: Segment, tolerance: number): boolean {
    return (
        (pointsEqual(a.start, b.start, tolerance) && pointsEqual(a.end, b.end, tolerance)) ||
        (pointsEqual(a.start, b.end, tolerance) && pointsEqual(a.end, b.start, tolerance))
    );
}

/** Rebuild paths from cleaned segments */
function rebuildPaths(segments: IndexedSegment[], originalPaths: Path[]): Path[] {
    // Group segments by original path
    const pathSegments = new Map<number, IndexedSegment[]>();

    for (const seg of segments) {
        if (!pathSegments.has(seg.pathIndex)) {
            pathSegments.set(seg.pathIndex, []);
        }
        pathSegments.get(seg.pathIndex)!.push(seg);
    }

    // Rebuild each path
    const result: Path[] = [];

    for (let pathIndex = 0; pathIndex < originalPaths.length; pathIndex++) {
        const original = originalPaths[pathIndex];
        const segs = pathSegments.get(pathIndex) || [];

        if (segs.length === 0) {
            // All segments were removed
            continue;
        }

        // Sort by original segment index to maintain order
        segs.sort((a, b) => a.segmentIndex - b.segmentIndex);

        // Check if path is still continuous
        const isContinuous = checkContinuity(segs);

        if (isContinuous) {
            // Rebuild as single path
            const points: Point[] = [segs[0].segment.start];
            for (const seg of segs) {
                points.push(seg.segment.end);
            }

            result.push({
                points,
                closed: original.closed && segs.length === original.points.length,
                meta: original.meta,
            });
        } else {
            // Path was fragmented, create separate paths for each contiguous section
            let currentPoints: Point[] = [segs[0].segment.start, segs[0].segment.end];

            for (let i = 1; i < segs.length; i++) {
                const prevEnd = segs[i - 1].segment.end;
                const currStart = segs[i].segment.start;

                if (pointsEqual(prevEnd, currStart, 0.01)) {
                    // Continuous, add to current path
                    currentPoints.push(segs[i].segment.end);
                } else {
                    // Discontinuity, save current path and start new one
                    if (currentPoints.length >= 2) {
                        result.push({
                            points: currentPoints,
                            closed: false,
                            meta: original.meta,
                        });
                    }
                    currentPoints = [segs[i].segment.start, segs[i].segment.end];
                }
            }

            // Don't forget the last path
            if (currentPoints.length >= 2) {
                result.push({
                    points: currentPoints,
                    closed: false,
                    meta: original.meta,
                });
            }
        }
    }

    return result;
}

/** Check if segments form a continuous path */
function checkContinuity(segments: IndexedSegment[]): boolean {
    for (let i = 1; i < segments.length; i++) {
        if (segments[i].segmentIndex !== segments[i - 1].segmentIndex + 1) {
            return false;
        }
    }
    return true;
}
