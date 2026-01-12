//! Segment intersection detection
//!
//! Uses Quadtree spatial indexing for O(n log n) intersection detection
//! instead of brute-force O(n²).

use std::collections::HashMap;
use crate::types::{Path, Point, Segment, Intersection};
use crate::quadtree::Quadtree;

const EPSILON: f64 = 1e-10;

/// Convert paths to segments for intersection finding
pub fn paths_to_segments(paths: &[Path]) -> Vec<Segment> {
    let mut segments = Vec::new();
    let mut id = 0;
    
    for path in paths {
        for i in 0..path.points.len().saturating_sub(1) {
            segments.push(Segment {
                id,
                p1: path.points[i],
                p2: path.points[i + 1],
            });
            id += 1;
        }
    }
    
    segments
}

/// Find all intersection points using Quadtree spatial indexing
pub fn find_all_intersections(segments: &[Segment], tolerance: f64) -> Vec<Intersection> {
    if segments.is_empty() {
        return Vec::new();
    }
    
    let mut intersections: HashMap<String, Intersection> = HashMap::new();
    
    // Build quadtree for spatial indexing
    let quadtree = Quadtree::build(segments);
    
    // For each segment, query nearby segments and test for intersection
    for i in 0..quadtree.len() {
        let seg_i = quadtree.get_segment(i);
        let candidates = quadtree.query_segment(i);
        
        for j in candidates {
            // Only process each pair once (i < j)
            if i >= j {
                continue;
            }
            
            let seg_j = quadtree.get_segment(j);
            
            if let Some(point) = segment_intersection(seg_i, seg_j) {
                // Snap to grid for deduplication
                let key = format!(
                    "{},{}",
                    (point.x / tolerance).round() * tolerance,
                    (point.y / tolerance).round() * tolerance
                );
                
                intersections
                    .entry(key)
                    .and_modify(|existing| {
                        if !existing.segments.contains(&seg_i.id) {
                            existing.segments.push(seg_i.id);
                        }
                        if !existing.segments.contains(&seg_j.id) {
                            existing.segments.push(seg_j.id);
                        }
                    })
                    .or_insert(Intersection {
                        point,
                        segments: vec![seg_i.id, seg_j.id],
                    });
            }
        }
    }
    
    intersections.into_values().collect()
}


/// Find the intersection point of two line segments
fn segment_intersection(s1: &Segment, s2: &Segment) -> Option<Point> {
    // AABB early-out: check if bounding boxes overlap
    let s1_min_x = s1.p1.x.min(s1.p2.x);
    let s1_max_x = s1.p1.x.max(s1.p2.x);
    let s1_min_y = s1.p1.y.min(s1.p2.y);
    let s1_max_y = s1.p1.y.max(s1.p2.y);
    
    let s2_min_x = s2.p1.x.min(s2.p2.x);
    let s2_max_x = s2.p1.x.max(s2.p2.x);
    let s2_min_y = s2.p1.y.min(s2.p2.y);
    let s2_max_y = s2.p1.y.max(s2.p2.y);
    
    // If AABBs don't overlap, segments can't intersect
    if s1_max_x < s2_min_x || s2_max_x < s1_min_x ||
       s1_max_y < s2_min_y || s2_max_y < s1_min_y {
        return None;
    }
    
    let x1 = s1.p1.x;
    let y1 = s1.p1.y;
    let x2 = s1.p2.x;
    let y2 = s1.p2.y;
    let x3 = s2.p1.x;
    let y3 = s2.p1.y;
    let x4 = s2.p2.x;
    let y4 = s2.p2.y;
    
    let denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    
    // Parallel or nearly parallel
    if denom.abs() < EPSILON {
        return None;
    }
    
    let t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
    let u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;
    
    // Check if intersection is within both segments
    if t >= -EPSILON && t <= 1.0 + EPSILON && u >= -EPSILON && u <= 1.0 + EPSILON {
        Some(Point::new(
            x1 + t * (x2 - x1),
            y1 + t * (y2 - y1),
        ))
    } else {
        None
    }
}

/// Split a segment at given intersection points
pub fn split_segment_at_intersections(segment: &Segment, points: &[Point]) -> Vec<Segment> {
    if points.is_empty() {
        return vec![segment.clone()];
    }
    
    // Sort intersections along the segment direction
    let mut sorted: Vec<(f64, Point)> = points
        .iter()
        .map(|p| (distance_along(segment, p), *p))
        .collect();
    sorted.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    
    // Filter out intersections that are essentially at the endpoints
    let filtered: Vec<Point> = sorted
        .into_iter()
        .filter(|(d, _)| *d > EPSILON && *d < 1.0 - EPSILON)
        .map(|(_, p)| p)
        .collect();
    
    if filtered.is_empty() {
        return vec![segment.clone()];
    }
    
    // Create sub-segments
    let mut result = Vec::new();
    let mut last_point = segment.p1;
    let mut sub_id = 0;
    
    for point in filtered {
        result.push(Segment {
            id: segment.id * 1000 + sub_id,
            p1: last_point,
            p2: point,
        });
        last_point = point;
        sub_id += 1;
    }
    
    // Final segment to p2
    result.push(Segment {
        id: segment.id * 1000 + sub_id,
        p1: last_point,
        p2: segment.p2,
    });
    
    result
}

/// Calculate the parameter t (0 to 1) for a point along a segment
fn distance_along(segment: &Segment, point: &Point) -> f64 {
    let dx = segment.p2.x - segment.p1.x;
    let dy = segment.p2.y - segment.p1.y;
    let len_sq = dx * dx + dy * dy;
    
    if len_sq < EPSILON {
        return 0.0;
    }
    
    let px = point.x - segment.p1.x;
    let py = point.y - segment.p1.y;
    
    (px * dx + py * dy) / len_sq
}
