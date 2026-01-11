/**
 * DCEL - Doubly Connected Edge List
 * 
 * A data structure for representing planar subdivisions.
 * Enables efficient traversal of faces (enclosed regions).
 * 
 * Designed for Rust/WASM portability - no DOM dependencies.
 */

import type { Point } from './types';

/** Unique identifier for DCEL elements */
export type VertexId = number;
export type HalfEdgeId = number;
export type FaceId = number;

/** A vertex in the DCEL */
export interface DCELVertex {
    id: VertexId;
    x: number;
    y: number;
    /** Any half-edge originating from this vertex */
    incidentEdge: HalfEdgeId | null;
}

/** A half-edge in the DCEL */
export interface DCELHalfEdge {
    id: HalfEdgeId;
    /** Origin vertex of this half-edge */
    origin: VertexId;
    /** Twin half-edge (same edge, opposite direction) */
    twin: HalfEdgeId;
    /** Next half-edge around the face (counter-clockwise) */
    next: HalfEdgeId;
    /** Previous half-edge around the face */
    prev: HalfEdgeId;
    /** Face to the left of this half-edge */
    face: FaceId | null;
}

/** A face (enclosed region) in the DCEL */
export interface DCELFace {
    id: FaceId;
    /** One half-edge on the outer boundary */
    outerComponent: HalfEdgeId | null;
    /** Half-edges on inner boundaries (holes) */
    innerComponents: HalfEdgeId[];
    /** Whether this is the unbounded outer face */
    isOuterFace: boolean;
}

/** The complete DCEL data structure */
export class DCEL {
    vertices: Map<VertexId, DCELVertex> = new Map();
    halfEdges: Map<HalfEdgeId, DCELHalfEdge> = new Map();
    faces: Map<FaceId, DCELFace> = new Map();

    private nextVertexId = 0;
    private nextHalfEdgeId = 0;
    private nextFaceId = 0;

    /** Create a new vertex */
    createVertex(x: number, y: number): VertexId {
        const id = this.nextVertexId++;
        this.vertices.set(id, {
            id,
            x,
            y,
            incidentEdge: null,
        });
        return id;
    }

    /** Create a pair of twin half-edges between two vertices */
    createEdgePair(originA: VertexId, originB: VertexId): [HalfEdgeId, HalfEdgeId] {
        const idA = this.nextHalfEdgeId++;
        const idB = this.nextHalfEdgeId++;

        const halfEdgeA: DCELHalfEdge = {
            id: idA,
            origin: originA,
            twin: idB,
            next: idA, // Will be updated during face extraction
            prev: idA,
            face: null,
        };

        const halfEdgeB: DCELHalfEdge = {
            id: idB,
            origin: originB,
            twin: idA,
            next: idB,
            prev: idB,
            face: null,
        };

        this.halfEdges.set(idA, halfEdgeA);
        this.halfEdges.set(idB, halfEdgeB);

        // Update incident edges on vertices
        const vertexA = this.vertices.get(originA)!;
        const vertexB = this.vertices.get(originB)!;
        if (vertexA.incidentEdge === null) vertexA.incidentEdge = idA;
        if (vertexB.incidentEdge === null) vertexB.incidentEdge = idB;

        return [idA, idB];
    }

    /** Create a new face */
    createFace(outerComponent: HalfEdgeId | null, isOuterFace: boolean = false): FaceId {
        const id = this.nextFaceId++;
        this.faces.set(id, {
            id,
            outerComponent,
            innerComponents: [],
            isOuterFace,
        });
        return id;
    }

    /** Get all half-edges originating from a vertex, sorted by angle */
    getOutgoingEdges(vertexId: VertexId): HalfEdgeId[] {
        const edges: HalfEdgeId[] = [];

        for (const [id, edge] of this.halfEdges) {
            if (edge.origin === vertexId) {
                edges.push(id);
            }
        }

        // Sort by angle
        const vertex = this.vertices.get(vertexId)!;
        edges.sort((a, b) => {
            const edgeA = this.halfEdges.get(a)!;
            const edgeB = this.halfEdges.get(b)!;
            const targetA = this.vertices.get(this.halfEdges.get(edgeA.twin)!.origin)!;
            const targetB = this.vertices.get(this.halfEdges.get(edgeB.twin)!.origin)!;

            const angleA = Math.atan2(targetA.y - vertex.y, targetA.x - vertex.x);
            const angleB = Math.atan2(targetB.y - vertex.y, targetB.x - vertex.x);

            return angleA - angleB;
        });

        return edges;
    }

    /** 
     * Set up next/prev pointers based on angular ordering.
     * Call this after all edges are added.
     */
    computeNextPrevPointers(): void {
        // For each vertex, get outgoing edges sorted by angle
        for (const [vertexId] of this.vertices) {
            const outgoing = this.getOutgoingEdges(vertexId);

            if (outgoing.length === 0) continue;

            // For each outgoing edge, its twin's next is the next outgoing edge (CCW)
            for (let i = 0; i < outgoing.length; i++) {
                const currentOutgoing = outgoing[i];
                const nextOutgoing = outgoing[(i + 1) % outgoing.length];

                // The twin of currentOutgoing arrives at this vertex
                // Its next should be nextOutgoing (leaving this vertex)
                const incoming = this.halfEdges.get(currentOutgoing)!.twin;
                const incomingEdge = this.halfEdges.get(incoming)!;
                incomingEdge.next = nextOutgoing;

                // And nextOutgoing's prev is incoming
                const nextEdge = this.halfEdges.get(nextOutgoing)!;
                nextEdge.prev = incoming;
            }
        }
    }

    /**
     * Extract all faces by traversing half-edge cycles.
     * Call after computeNextPrevPointers().
     */
    extractFaces(): void {
        const visited = new Set<HalfEdgeId>();

        for (const [edgeId] of this.halfEdges) {
            if (visited.has(edgeId)) continue;

            // Traverse the face boundary
            const boundary: HalfEdgeId[] = [];
            let current = edgeId;

            do {
                if (visited.has(current)) break;
                visited.add(current);
                boundary.push(current);
                current = this.halfEdges.get(current)!.next;
            } while (current !== edgeId);

            if (boundary.length < 3) continue;

            // Create face
            const faceId = this.createFace(boundary[0], false);

            // Assign face to all half-edges in this cycle
            for (const heId of boundary) {
                this.halfEdges.get(heId)!.face = faceId;
            }
        }

        // Identify the outer (unbounded) face
        this.identifyOuterFace();
    }

    /** Identify the unbounded outer face by finding the one with largest negative area */
    private identifyOuterFace(): void {
        let outerFaceId: FaceId | null = null;
        let minArea = Infinity;

        for (const [faceId, face] of this.faces) {
            if (face.outerComponent === null) continue;

            const area = this.computeFaceArea(faceId);

            // The outer face has the most negative (clockwise) area
            if (area < minArea) {
                minArea = area;
                outerFaceId = faceId;
            }
        }

        if (outerFaceId !== null) {
            this.faces.get(outerFaceId)!.isOuterFace = true;
        }
    }

    /** Compute signed area of a face (positive = CCW, negative = CW) */
    computeFaceArea(faceId: FaceId): number {
        const face = this.faces.get(faceId);
        if (!face || face.outerComponent === null) return 0;

        let area = 0;
        let current = face.outerComponent;
        const start = current;

        do {
            const edge = this.halfEdges.get(current)!;
            const origin = this.vertices.get(edge.origin)!;
            const target = this.vertices.get(this.halfEdges.get(edge.twin)!.origin)!;

            area += origin.x * target.y - target.x * origin.y;

            current = edge.next;
        } while (current !== start);

        return area / 2;
    }

    /** Get the polygon points for a face */
    getFacePolygon(faceId: FaceId): Point[] {
        const face = this.faces.get(faceId);
        if (!face || face.outerComponent === null) return [];

        const points: Point[] = [];
        let current = face.outerComponent;
        const start = current;

        do {
            const edge = this.halfEdges.get(current)!;
            const origin = this.vertices.get(edge.origin)!;
            points.push({ x: origin.x, y: origin.y });
            current = edge.next;
        } while (current !== start);

        return points;
    }

    /** Get all bounded (non-outer) faces as polygons */
    getBoundedFaces(): Point[][] {
        const result: Point[][] = [];

        for (const [faceId, face] of this.faces) {
            if (face.isOuterFace) continue;

            const polygon = this.getFacePolygon(faceId);
            if (polygon.length >= 3) {
                result.push(polygon);
            }
        }

        return result;
    }
}

/** Find or create a vertex at the given position, with snapping tolerance */
export function findOrCreateVertex(
    dcel: DCEL,
    x: number,
    y: number,
    tolerance: number = 0.001
): VertexId {
    // Check for existing vertex within tolerance
    for (const [id, vertex] of dcel.vertices) {
        const dx = vertex.x - x;
        const dy = vertex.y - y;
        if (dx * dx + dy * dy <= tolerance * tolerance) {
            return id;
        }
    }

    // Create new vertex
    return dcel.createVertex(x, y);
}
