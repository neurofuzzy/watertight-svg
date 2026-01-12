//! Region Finding - Extract enclosed regions from intersecting paths
//!
//! Uses DCEL (Doubly Connected Edge List) to find all enclosed faces
//! formed by intersecting line segments.

use std::collections::HashMap;
use crate::types::{Path, Point, PathMeta, Segment};
use crate::intersection::{paths_to_segments, find_all_intersections, split_segment_at_intersections};
use crate::dcel::{DCEL, find_or_create_vertex, edge_exists};

// Import timing from lib.rs
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
    
    #[wasm_bindgen(js_namespace = performance)]
    fn now() -> f64;
}

#[cfg(not(target_arch = "wasm32"))]
fn log(_s: &str) {}

#[cfg(not(target_arch = "wasm32"))]
fn now() -> f64 { 0.0 }

/// Find all enclosed regions formed by the given paths.
pub fn find_regions_impl(paths: &[Path], tolerance: f64, min_area: f64) -> Vec<Path> {
    if paths.is_empty() {
        return Vec::new();
    }
    
    let t0 = now();
    
    // Step 1: Convert paths to segments
    let segments = paths_to_segments(paths);
    if segments.is_empty() {
        return Vec::new();
    }
    
    let t1 = now();
    log(&format!("  [Step 1] paths_to_segments: {:.1}ms ({} segments)", t1 - t0, segments.len()));
    
    // Step 2: Find all intersections
    let intersections = find_all_intersections(&segments, tolerance);
    
    let t2 = now();
    log(&format!("  [Step 2] find_intersections: {:.1}ms ({} intersections)", t2 - t1, intersections.len()));
    
    // Step 3: Split segments at intersection points
    let split_segments = split_all_segments(&segments, &intersections);
    
    let t3 = now();
    log(&format!("  [Step 3] split_segments: {:.1}ms ({} split)", t3 - t2, split_segments.len()));
    
    // Step 4: Build DCEL from split segments
    let mut dcel = build_dcel(&split_segments, tolerance);
    
    let t4 = now();
    log(&format!("  [Step 4] build_dcel: {:.1}ms ({} vertices, {} edges)", 
        t4 - t3, dcel.vertices.len(), dcel.half_edges.len()));
    
    // Step 5: Compute next/prev pointers for face traversal
    dcel.compute_next_prev_pointers();
    
    let t5 = now();
    log(&format!("  [Step 5] compute_next_prev: {:.1}ms", t5 - t4));
    
    // Step 6: Extract faces
    dcel.extract_faces();
    
    let t6 = now();
    log(&format!("  [Step 6] extract_faces: {:.1}ms ({} faces)", t6 - t5, dcel.faces.len()));
    
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
    
    let t7 = now();
    log(&format!("  [Step 7] build_regions: {:.1}ms ({} regions)", t7 - t6, regions.len()));
    
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
