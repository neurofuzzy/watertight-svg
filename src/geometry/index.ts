export * from './types';
export * from './math';
export * from './parser';
export * from './dcel';
// Export intersection module with renamed exports to avoid conflicts
export {
    findAllIntersections,
    splitSegmentAtIntersections,
    pathsToSegments,
    isEndpoint,
    segmentIntersection as lineSegmentIntersection,
    type Segment as LineSegment,
    type Intersection as SegmentIntersection,
} from './intersection';
