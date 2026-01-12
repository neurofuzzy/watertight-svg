//! Region Finding - Extract enclosed regions from intersecting paths
//!
//! Uses DCEL (Doubly Connected Edge List) to find all enclosed faces
//! formed by intersecting line segments.

use std::collections::HashMap;
use crate::types::{Path, Point, PathMeta, Segment};
use crate::intersection::{paths_to_segments, find_all_intersections, split_segment_at_intersections};
use crate::dcel::{DCEL, find_or_create_vertex, edge_exists};

/// Find all enclosed regions formed by the given paths.
pub fn find_regions_impl(paths: &[Path], tolerance: f64, min_area: f64) -> Vec<Path> {
    if paths.is_empty() {
        return Vec::new();
    }
    
    // Step 1: Convert paths to segments
    let segments = paths_to_segments(paths);
    if segments.is_empty() {
        return Vec::new();
    }
    
    // Step 2: Find all intersections
    let intersections = find_all_intersections(&segments, tolerance);
    
    // Step 3: Split segments at intersection points
    let split_segments = split_all_segments(&segments, &intersections);
    
    // Step 4: Build DCEL from split segments
    let mut dcel = build_dcel(&split_segments, tolerance);
    
    // Step 5: Compute next/prev pointers for face traversal
    dcel.compute_next_prev_pointers();
    
    // Step 6: Extract faces
    dcel.extract_faces();
    
    // Step 7: Convert faces to paths
    let mut regions = Vec::new();
    
    for (face_id, face) in &dcel.faces {
        if face.is_outer_face {
            continue;
        }
        
        let polygon = dcel.get_face_polygon(*face_id);
        if polygon.len() < 3 {
            continue;
        }
        
        // Check minimum area
        let area = compute_polygon_area(&polygon).abs();
        if area < min_area {
            continue;
        }
        
        regions.push(Path {
            points: polygon,
            closed: true,
            meta: Some(PathMeta {
                area: Some(area),
                is_region: Some(true),
            }),
        });
    }
    
    regions
}

/// Split all segments at their intersection points
fn split_all_segments(segments: &[Segment], intersections: &[crate::types::Intersection]) -> Vec<Segment> {
    // Group intersections by segment ID
    let mut segment_intersections: HashMap<usize, Vec<Point>> = HashMap::new();
    
    for intersection in intersections {
        for &segment_id in &intersection.segments {
            segment_intersections
                .entry(segment_id)
                .or_default()
                .push(intersection.point);
        }
    }
    
    // Split each segment
    let mut result = Vec::new();
    
    for segment in segments {
        let points = segment_intersections.get(&segment.id).map(|v| v.as_slice()).unwrap_or(&[]);
        let split = split_segment_at_intersections(segment, points);
        result.extend(split);
    }
    
    result
}

/// Build a DCEL from split segments
fn build_dcel(segments: &[Segment], tolerance: f64) -> DCEL {
    let mut dcel = DCEL::new();
    
    for segment in segments {
        // Find or create vertices for endpoints
        let v1 = find_or_create_vertex(&mut dcel, segment.p1.x, segment.p1.y, tolerance);
        let v2 = find_or_create_vertex(&mut dcel, segment.p2.x, segment.p2.y, tolerance);
        
        // Skip degenerate segments
        if v1 == v2 {
            continue;
        }
        
        // Check if edge already exists
        if edge_exists(&dcel, v1, v2) {
            continue;
        }
        
        // Create edge pair
        dcel.create_edge_pair(v1, v2);
    }
    
    dcel
}

/// Compute signed area of a polygon (positive = CCW, negative = CW)
fn compute_polygon_area(points: &[Point]) -> f64 {
    if points.len() < 3 {
        return 0.0;
    }
    
    let mut area = 0.0;
    for i in 0..points.len() {
        let j = (i + 1) % points.len();
        area += points[i].x * points[j].y;
        area -= points[j].x * points[i].y;
    }
    
    area / 2.0
}
