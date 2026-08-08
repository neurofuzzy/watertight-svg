/**
 * Stroke — the canonical intermediate format for nib consumers who produce
 * polylines programmatically (generative sketches, canvas apps, code-first
 * tooling). Sits one level above `PlannerMove[]` and avoids the
 * round-trip-through-SVG tax for consumers that already have point lists.
 *
 * A Stroke is a single pen-down polyline. Multiple strokes plot with pen-up
 * travel between them. Set `skip: true` to include a stroke in a list but
 * never plot it (useful for preview overlays or toggleable layers). `layer`
 * is optional multi-pen metadata matching the axicli/nib layer convention.
 */

import type { PlannerMove } from './moves.ts'

export interface Point {
  x: number
  y: number
}

export interface Stroke {
  /** Absolute mm. Two or more points make a drawn segment; one or zero is a no-op. */
  points: Point[]
  /** Optional numeric layer ID — matches inkscape:label prefix convention. */
  layer?: number
  /** True = never plot this stroke. */
  skip?: boolean
}

// ─── Conversions ──────────────────────────────────────────────────────────────

/**
 * Convert a list of strokes into the flat `PlannerMove[]` sequence the planner
 * and backend expect. Prepends pen-up at (0,0) and inserts a pen-up travel
 * before each stroke's first point.
 *
 * Skipped and empty strokes are dropped. If a layer filter is provided, only
 * strokes with matching `.layer` are emitted.
 */
export function strokesToMoves(
  strokes: Stroke[],
  options: { layer?: number } = {},
): PlannerMove[] {
  const out: PlannerMove[] = [{ x: 0, y: 0, penDown: false }]
  const layerFilter = options.layer

  for (const s of strokes) {
    if (s.skip) continue
    if (s.points.length < 2) continue
    if (layerFilter !== undefined && s.layer !== layerFilter) continue

    const [first, ...rest] = s.points
    out.push({ x: first.x, y: first.y, penDown: false })
    for (const p of rest) {
      out.push({ x: p.x, y: p.y, penDown: true })
    }
  }

  // Canonicalise: ensure we end pen-up so downstream knows to lift.
  const last = out[out.length - 1]
  if (last?.penDown) {
    out.push({ x: last.x, y: last.y, penDown: false })
  }

  return out
}

/**
 * Inverse conversion — useful for adapters (e.g. starting from SVG, turning
 * into strokes, doing something with them). Walks a PlannerMove sequence and
 * groups consecutive pen-down runs into strokes. Pen-up travel between runs
 * becomes the boundary between strokes; the pen-up point preceding each run
 * is the stroke's first point.
 */
export function movesToStrokes(moves: PlannerMove[]): Stroke[] {
  const out: Stroke[] = []
  let current: Point[] | null = null

  for (let i = 0; i < moves.length; i++) {
    const m = moves[i]
    if (m.penDown) {
      if (current === null) {
        // The pen-up point right before us is the stroke entry.
        const prev = moves[i - 1]
        current = prev ? [{ x: prev.x, y: prev.y }] : []
      }
      current.push({ x: m.x, y: m.y })
    } else if (current !== null) {
      if (current.length >= 2) out.push({ points: current })
      current = null
    }
  }
  if (current !== null && current.length >= 2) out.push({ points: current })
  return out
}

// ─── Stats (pure, browser-safe) ──────────────────────────────────────────────

/**
 * Rotate a flat PlannerMove sequence by `degrees` around its bounding-box
 * center, then translate so the rotated bbox sits at (0, 0).
 *
 * Useful as a diagnostic (plot the same content at a different orientation
 * to isolate hardware- vs content-specific artifacts) and for fitting
 * portrait SVGs onto landscape paper without editing the source.
 */
export function rotateMoves(moves: PlannerMove[], degrees: number): PlannerMove[] {
  const normDeg = ((degrees % 360) + 360) % 360
  if (normDeg === 0) return moves
  const theta = (normDeg * Math.PI) / 180
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)

  // Rotate around (0, 0), then translate the result's bbox back to (0, 0).
  // Two-pass: compute new bbox, then emit translated moves.
  let minX = Infinity, minY = Infinity
  const rotated: PlannerMove[] = []
  for (const m of moves) {
    const rx = m.x * cos - m.y * sin
    const ry = m.x * sin + m.y * cos
    if (rx < minX) minX = rx
    if (ry < minY) minY = ry
    rotated.push({ x: rx, y: ry, penDown: m.penDown })
  }
  if (!isFinite(minX)) return rotated
  for (const m of rotated) {
    m.x -= minX
    m.y -= minY
  }
  return rotated
}

/**
 * Translate every move by (dx, dy). No-op when both are zero. Used to shift
 * content into paper-space when a paper offset is configured — SVG (0,0) then
 * corresponds to the paper's top-left corner instead of the machine origin.
 */
export function translateMoves(moves: PlannerMove[], dx: number, dy: number): PlannerMove[] {
  if (dx === 0 && dy === 0) return moves
  return moves.map(m => ({ x: m.x + dx, y: m.y + dy, penDown: m.penDown }))
}

/**
 * Simplify a flat PlannerMove sequence via stroke-level Douglas–Peucker.
 * Groups consecutive pen-down moves into strokes, simplifies each stroke's
 * interior at the given tolerance, and re-emits the flat move list.
 *
 * Useful when the source SVG is an over-sampled polyline (sub-0.1mm segments)
 * that explodes into hundreds of LM commands per stroke. A 0.2mm tolerance
 * typically compacts 10–20× with no visible paper difference.
 */
import { simplifyPolyline } from './geom.ts'

export function simplifyMoves(moves: PlannerMove[], toleranceMm: number): PlannerMove[] {
  if (toleranceMm <= 0 || moves.length < 3) return moves
  const strokes = movesToStrokes(moves)
  const simplified: Stroke[] = strokes.map(s => ({
    ...s,
    points: simplifyPolyline(s.points, toleranceMm),
  }))
  return strokesToMoves(simplified)
}

/**
 * Remove duplicate strokes from a list. Two strokes are considered duplicates
 * if every corresponding point pair is within `toleranceMm` (default 0.1 mm)
 * of each other, in either forward or reverse order.
 *
 * Runs in O(n²) which is acceptable for typical plot sizes (< 10k strokes).
 */
export function deduplicateStrokes(strokes: Stroke[], toleranceMm = 0.1): Stroke[] {
  const tol2 = toleranceMm * toleranceMm
  const kept: Stroke[] = []

  outer: for (const s of strokes) {
    if (s.skip || s.points.length < 2) {
      kept.push(s)
      continue
    }
    for (const k of kept) {
      if (k.skip || k.points.length !== s.points.length) continue
      if (strokesMatch(s.points, k.points, tol2) || strokesMatch(s.points, [...k.points].reverse(), tol2)) {
        continue outer
      }
    }
    kept.push(s)
  }

  return kept
}

function strokesMatch(a: Point[], b: Point[], tol2: number): boolean {
  for (let i = 0; i < a.length; i++) {
    const dx = a[i].x - b[i].x
    const dy = a[i].y - b[i].y
    if (dx * dx + dy * dy > tol2) return false
  }
  return true
}

/**
 * Cheap structural stats — stroke count, total pen-down distance, bounding box.
 * Useful for UI previews without running the planner.
 */
export interface StrokeStats {
  strokeCount: number
  pointCount: number
  pendownMm: number
  bbox: { minX: number; minY: number; maxX: number; maxY: number } | null
}

export function strokeStats(strokes: Stroke[]): StrokeStats {
  let strokeCount = 0
  let pointCount = 0
  let pendownMm = 0
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity

  for (const s of strokes) {
    if (s.skip || s.points.length < 2) continue
    strokeCount++
    pointCount += s.points.length
    for (let i = 0; i < s.points.length; i++) {
      const p = s.points[i]
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
      if (i > 0) {
        const prev = s.points[i - 1]
        pendownMm += Math.hypot(p.x - prev.x, p.y - prev.y)
      }
    }
  }

  return {
    strokeCount,
    pointCount,
    pendownMm,
    bbox: isFinite(minX) ? { minX, minY, maxX, maxY } : null,
  }
}
