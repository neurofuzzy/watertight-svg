/**
 * Douglas-Peucker simplification, lifted from nib's `src/core/geom.ts`.
 * That module is 419 lines of geometry primitives (circles, arcs, beziers,
 * Hershey glyph helpers) we have no use for — the pipeline hands us finished
 * polylines. Only the simplifier is reachable from the plotting path, via
 * `simplifyMoves` in stroke.ts.
 */

import type { Point } from './stroke.ts'

/**
 * Simplify a polyline with the Douglas–Peucker algorithm. Keeps each point
 * whose perpendicular distance from the line between its kept neighbors
 * exceeds `toleranceMm`; drops the rest. Preserves the first and last points.
 *
 * Typical plotter use: run at 0.1–0.3 mm tolerance. Over-sampled generative
 * polylines (0.05 mm segments) compact by 5–20×. Visually indistinguishable
 * on paper, but drastically fewer LM commands to stream to the EBB.
 *
 * Iterative — no recursion, so very long polylines don't blow the stack.
 */
export function simplifyPolyline(points: Point[], toleranceMm: number): Point[] {
  if (points.length < 3 || toleranceMm <= 0) return points.slice()
  const n = points.length
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1

  const tol2 = toleranceMm * toleranceMm
  // Stack of (start, end) segments yet to inspect. Seed with the whole line.
  const stack: Array<[number, number]> = [[0, n - 1]]

  while (stack.length > 0) {
    const [start, end] = stack.pop()!
    if (end - start < 2) continue

    const { index, distSq } = maxPerpendicular(points, start, end)
    if (distSq > tol2) {
      keep[index] = 1
      stack.push([start, index])
      stack.push([index, end])
    }
    // else: the deepest inner point is within tolerance — drop everything
    // between start and end by leaving keep[] at 0 for those indices.
  }

  const out: Point[] = []
  for (let i = 0; i < n; i++) {
    if (keep[i]) out.push(points[i])
  }
  return out
}

/**
 * Find the point between `start` and `end` with the greatest perpendicular
 * distance from the chord (start→end). Returns index + squared distance.
 */
function maxPerpendicular(
  points: Point[], start: number, end: number,
): { index: number; distSq: number } {
  const ax = points[start].x, ay = points[start].y
  const bx = points[end].x,   by = points[end].y
  const dx = bx - ax, dy = by - ay
  const segLenSq = dx * dx + dy * dy

  let maxD2 = 0
  let maxI = start

  // If chord is degenerate (start == end), distance = distance from that point.
  if (segLenSq < 1e-18) {
    for (let i = start + 1; i < end; i++) {
      const px = points[i].x - ax
      const py = points[i].y - ay
      const d2 = px * px + py * py
      if (d2 > maxD2) { maxD2 = d2; maxI = i }
    }
    return { index: maxI, distSq: maxD2 }
  }

  for (let i = start + 1; i < end; i++) {
    const px = points[i].x - ax
    const py = points[i].y - ay
    // Perpendicular distance² from point p to the infinite line through a→b:
    //   numerator = (dx·py − dy·px)²
    //   denominator = dx² + dy²
    const cross = dx * py - dy * px
    const d2 = (cross * cross) / segLenSq
    if (d2 > maxD2) { maxD2 = d2; maxI = i }
  }
  return { index: maxI, distSq: maxD2 }
}
