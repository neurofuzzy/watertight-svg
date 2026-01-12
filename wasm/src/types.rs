//! Core types for the region-finding algorithm

use serde::{Deserialize, Serialize};

/// A 2D point
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

impl Point {
    pub fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }
    
    pub fn distance_sq(&self, other: &Point) -> f64 {
        let dx = self.x - other.x;
        let dy = self.y - other.y;
        dx * dx + dy * dy
    }
}

/// A path (sequence of points)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Path {
    pub points: Vec<Point>,
    #[serde(default)]
    pub closed: bool,
    #[serde(default)]
    pub meta: Option<PathMeta>,
}

/// Optional metadata for a path
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PathMeta {
    #[serde(default)]
    pub area: Option<f64>,
    #[serde(rename = "isRegion", default)]
    pub is_region: Option<bool>,
}

/// A line segment defined by two endpoints
#[derive(Debug, Clone)]
pub struct Segment {
    pub id: usize,
    pub p1: Point,
    pub p2: Point,
}

/// An intersection point with the segments involved
#[derive(Debug, Clone)]
pub struct Intersection {
    pub point: Point,
    pub segments: Vec<usize>,
}
