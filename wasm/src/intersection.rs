//! Segment intersection detection
//!
//! Finds all intersection points between line segments using
//! a brute-force O(n²) approach.

use std::collections::HashMap;
use crate::types::{Path, Point, Segment, Intersection};

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

/// Find all intersection points between a set of segments
pub fn find_all_intersections(segments: &[Segment], tolerance: f64) -> Vec<Intersection> {
    let mut intersections: HashMap<String, Intersection> = HashMap::new();
    
    for i in 0..segments.len() {
        for j in (i + 1)..segments.len() {
            if let Some(point) = segment_intersection(&segments[i], &segments[j]) {
                // Snap to grid for deduplication
                let key = format!(
                    "{},{}",
                    (point.x / tolerance).round() * tolerance,
                    (point.y / tolerance).round() * tolerance
                );
                
                intersections
                    .entry(key)
                    .and_modify(|existing| {
                        if !existing.segments.contains(&segments[i].id) {
                            existing.segments.push(segments[i].id);
                        }
                        if !existing.segments.contains(&segments[j].id) {
                            existing.segments.push(segments[j].id);
                        }
                    })
                    .or_insert(Intersection {
                        point,
                        segments: vec![segments[i].id, segments[j].id],
                    });
            }
        }
    }
    
    intersections.into_values().collect()
}

/// Find the intersection point of two line segments
fn segment_intersection(s1: &Segment, s2: &Segment) -> Option<Point> {
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
