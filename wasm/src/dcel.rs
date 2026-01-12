//! DCEL - Doubly Connected Edge List
//!
//! A data structure for representing planar subdivisions.
//! Enables efficient traversal of faces (enclosed regions).

use std::collections::{HashMap, HashSet};
use crate::types::Point;

/// Unique identifiers for DCEL elements
pub type VertexId = usize;
pub type HalfEdgeId = usize;
pub type FaceId = usize;

/// A vertex in the DCEL
#[derive(Debug, Clone)]
pub struct DCELVertex {
    pub id: VertexId,
    pub x: f64,
    pub y: f64,
    /// Any half-edge originating from this vertex
    pub incident_edge: Option<HalfEdgeId>,
}

/// A half-edge in the DCEL
#[derive(Debug, Clone)]
pub struct DCELHalfEdge {
    pub id: HalfEdgeId,
    /// Origin vertex of this half-edge
    pub origin: VertexId,
    /// Twin half-edge (same edge, opposite direction)
    pub twin: HalfEdgeId,
    /// Next half-edge around the face (counter-clockwise)
    pub next: HalfEdgeId,
    /// Previous half-edge around the face
    pub prev: HalfEdgeId,
    /// Face to the left of this half-edge
    pub face: Option<FaceId>,
}

/// A face (enclosed region) in the DCEL
#[derive(Debug, Clone)]
pub struct DCELFace {
    pub id: FaceId,
    /// One half-edge on the outer boundary
    pub outer_component: Option<HalfEdgeId>,
    /// Whether this is the unbounded outer face
    pub is_outer_face: bool,
}

/// The complete DCEL data structure
#[derive(Debug)]
pub struct DCEL {
    pub vertices: HashMap<VertexId, DCELVertex>,
    pub half_edges: HashMap<HalfEdgeId, DCELHalfEdge>,
    pub faces: HashMap<FaceId, DCELFace>,
    
    next_vertex_id: VertexId,
    next_half_edge_id: HalfEdgeId,
    next_face_id: FaceId,
}

impl DCEL {
    pub fn new() -> Self {
        Self {
            vertices: HashMap::new(),
            half_edges: HashMap::new(),
            faces: HashMap::new(),
            next_vertex_id: 0,
            next_half_edge_id: 0,
            next_face_id: 0,
        }
    }
    
    /// Create a new vertex
    pub fn create_vertex(&mut self, x: f64, y: f64) -> VertexId {
        let id = self.next_vertex_id;
        self.next_vertex_id += 1;
        
        self.vertices.insert(id, DCELVertex {
            id,
            x,
            y,
            incident_edge: None,
        });
        
        id
    }
    
    /// Create a pair of twin half-edges between two vertices
    pub fn create_edge_pair(&mut self, origin_a: VertexId, origin_b: VertexId) -> (HalfEdgeId, HalfEdgeId) {
        let id_a = self.next_half_edge_id;
        let id_b = self.next_half_edge_id + 1;
        self.next_half_edge_id += 2;
        
        let half_edge_a = DCELHalfEdge {
            id: id_a,
            origin: origin_a,
            twin: id_b,
            next: id_a, // Will be updated during face extraction
            prev: id_a,
            face: None,
        };
        
        let half_edge_b = DCELHalfEdge {
            id: id_b,
            origin: origin_b,
            twin: id_a,
            next: id_b,
            prev: id_b,
            face: None,
        };
        
        self.half_edges.insert(id_a, half_edge_a);
        self.half_edges.insert(id_b, half_edge_b);
        
        // Update incident edges on vertices
        if let Some(vertex_a) = self.vertices.get_mut(&origin_a) {
            if vertex_a.incident_edge.is_none() {
                vertex_a.incident_edge = Some(id_a);
            }
        }
        if let Some(vertex_b) = self.vertices.get_mut(&origin_b) {
            if vertex_b.incident_edge.is_none() {
                vertex_b.incident_edge = Some(id_b);
            }
        }
        
        (id_a, id_b)
    }
    
    /// Create a new face
    pub fn create_face(&mut self, outer_component: Option<HalfEdgeId>, is_outer_face: bool) -> FaceId {
        let id = self.next_face_id;
        self.next_face_id += 1;
        
        self.faces.insert(id, DCELFace {
            id,
            outer_component,
            is_outer_face,
        });
        
        id
    }
    
    /// Get all half-edges originating from a vertex, sorted by angle
    pub fn get_outgoing_edges(&self, vertex_id: VertexId) -> Vec<HalfEdgeId> {
        let mut edges: Vec<HalfEdgeId> = self.half_edges
            .values()
            .filter(|e| e.origin == vertex_id)
            .map(|e| e.id)
            .collect();
        
        // Sort by angle
        if let Some(vertex) = self.vertices.get(&vertex_id) {
            edges.sort_by(|&a, &b| {
                let target_a = self.get_edge_target(a);
                let target_b = self.get_edge_target(b);
                
                let angle_a = (target_a.y - vertex.y).atan2(target_a.x - vertex.x);
                let angle_b = (target_b.y - vertex.y).atan2(target_b.x - vertex.x);
                
                angle_a.partial_cmp(&angle_b).unwrap_or(std::cmp::Ordering::Equal)
            });
        }
        
        edges
    }
    
    /// Get the target vertex coordinates of a half-edge
    fn get_edge_target(&self, edge_id: HalfEdgeId) -> Point {
        let edge = self.half_edges.get(&edge_id).unwrap();
        let twin = self.half_edges.get(&edge.twin).unwrap();
        let target = self.vertices.get(&twin.origin).unwrap();
        Point::new(target.x, target.y)
    }
    
    /// Set up next/prev pointers based on angular ordering
    pub fn compute_next_prev_pointers(&mut self) {
        let vertex_ids: Vec<VertexId> = self.vertices.keys().copied().collect();
        
        for vertex_id in vertex_ids {
            let outgoing = self.get_outgoing_edges(vertex_id);
            
            if outgoing.is_empty() {
                continue;
            }
            
            // For each outgoing edge, its twin's next is the next outgoing edge (CCW)
            for i in 0..outgoing.len() {
                let current_outgoing = outgoing[i];
                let next_outgoing = outgoing[(i + 1) % outgoing.len()];
                
                // The twin of current_outgoing arrives at this vertex
                let incoming = self.half_edges.get(&current_outgoing).unwrap().twin;
                
                // Update next pointer on incoming edge
                if let Some(incoming_edge) = self.half_edges.get_mut(&incoming) {
                    incoming_edge.next = next_outgoing;
                }
                
                // Update prev pointer on next edge
                if let Some(next_edge) = self.half_edges.get_mut(&next_outgoing) {
                    next_edge.prev = incoming;
                }
            }
        }
    }
    
    /// Extract all faces by traversing half-edge cycles
    pub fn extract_faces(&mut self) {
        let mut visited: HashSet<HalfEdgeId> = HashSet::new();
        let edge_ids: Vec<HalfEdgeId> = self.half_edges.keys().copied().collect();
        
        for edge_id in edge_ids {
            if visited.contains(&edge_id) {
                continue;
            }
            
            // Traverse the face boundary
            let mut boundary = Vec::new();
            let mut current = edge_id;
            
            loop {
                if visited.contains(&current) {
                    break;
                }
                visited.insert(current);
                boundary.push(current);
                
                current = self.half_edges.get(&current).unwrap().next;
                if current == edge_id {
                    break;
                }
            }
            
            if boundary.len() < 3 {
                continue;
            }
            
            // Create face
            let face_id = self.create_face(Some(boundary[0]), false);
            
            // Assign face to all half-edges in this cycle
            for he_id in &boundary {
                if let Some(edge) = self.half_edges.get_mut(he_id) {
                    edge.face = Some(face_id);
                }
            }
        }
        
        // Identify the outer (unbounded) face
        self.identify_outer_face();
    }
    
    /// Identify the unbounded outer face by finding the one with largest negative area
    fn identify_outer_face(&mut self) {
        let mut outer_face_id: Option<FaceId> = None;
        let mut min_area = f64::INFINITY;
        
        let face_ids: Vec<FaceId> = self.faces.keys().copied().collect();
        
        for face_id in face_ids {
            let area = self.compute_face_area(face_id);
            if area < min_area {
                min_area = area;
                outer_face_id = Some(face_id);
            }
        }
        
        if let Some(id) = outer_face_id {
            if let Some(face) = self.faces.get_mut(&id) {
                face.is_outer_face = true;
            }
        }
    }
    
    /// Compute signed area of a face
    pub fn compute_face_area(&self, face_id: FaceId) -> f64 {
        let face = match self.faces.get(&face_id) {
            Some(f) => f,
            None => return 0.0,
        };
        
        let start = match face.outer_component {
            Some(s) => s,
            None => return 0.0,
        };
        
        let mut area = 0.0;
        let mut current = start;
        
        loop {
            let edge = self.half_edges.get(&current).unwrap();
            let origin = self.vertices.get(&edge.origin).unwrap();
            let twin = self.half_edges.get(&edge.twin).unwrap();
            let target = self.vertices.get(&twin.origin).unwrap();
            
            area += origin.x * target.y - target.x * origin.y;
            
            current = edge.next;
            if current == start {
                break;
            }
        }
        
        area / 2.0
    }
    
    /// Get the polygon points for a face
    pub fn get_face_polygon(&self, face_id: FaceId) -> Vec<Point> {
        let face = match self.faces.get(&face_id) {
            Some(f) => f,
            None => return Vec::new(),
        };
        
        let start = match face.outer_component {
            Some(s) => s,
            None => return Vec::new(),
        };
        
        let mut points = Vec::new();
        let mut current = start;
        
        loop {
            let edge = self.half_edges.get(&current).unwrap();
            let origin = self.vertices.get(&edge.origin).unwrap();
            points.push(Point::new(origin.x, origin.y));
            
            current = edge.next;
            if current == start {
                break;
            }
        }
        
        points
    }
}

/// Find or create a vertex at the given position, with snapping tolerance
pub fn find_or_create_vertex(dcel: &mut DCEL, x: f64, y: f64, tolerance: f64) -> VertexId {
    let tolerance_sq = tolerance * tolerance;
    let mut best_dist_sq = tolerance_sq;
    let mut best_id: Option<VertexId> = None;
    
    for (id, vertex) in &dcel.vertices {
        let dx = vertex.x - x;
        let dy = vertex.y - y;
        let dist_sq = dx * dx + dy * dy;
        
        if dist_sq <= best_dist_sq {
            best_dist_sq = dist_sq;
            best_id = Some(*id);
            
            // Optimization: if exact match, stop early
            if dist_sq < 1e-10 {
                break;
            }
        }
    }
    
    best_id.unwrap_or_else(|| dcel.create_vertex(x, y))
}

/// Check if an edge already exists between two vertices
pub fn edge_exists(dcel: &DCEL, v1: VertexId, v2: VertexId) -> bool {
    for edge in dcel.half_edges.values() {
        let twin = dcel.half_edges.get(&edge.twin).unwrap();
        if (edge.origin == v1 && twin.origin == v2) || (edge.origin == v2 && twin.origin == v1) {
            return true;
        }
    }
    false
}
