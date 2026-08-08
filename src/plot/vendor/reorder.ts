/**
 * Path reordering for plotter moves
 *
 * Reorders pen-down strokes to minimise travel distance between them. Matches
 * the intent of axicli's --reordering flag with three levels:
 *
 *   0 — no reorder (document order)
 *   1 — nearest-neighbor greedy on stroke endpoints
 *   2 — NN + stroke reversal (pick the endpoint that's closer) + light 2-opt
 *
 * Input is a flat `PlannerMove[]` as produced by svgToMoves; output is a new
 * array of the same shape. The first pen-up at (0,0) is preserved so downstream
 * consumers see the same origin.
 */

import type { PlannerMove } from './moves.ts'

// ─── Public API ───────────────────────────────────────────────────────────────

export type OptimizeLevel = 0 | 1 | 2

export interface ReorderStats {
  penLiftsBefore: number
  penLiftsAfter: number
  travelMmBefore: number
  travelMmAfter: number
  /** Number of stroke pairs joined end-to-end to eliminate pen lifts. */
  strokesJoined?: number
}

export interface ReorderResult {
  moves: PlannerMove[]
  stats: ReorderStats
}

export interface ReorderOptions {
  /**
   * Max endpoint distance in mm to consider two strokes joinable (eliminates
   * the pen lift between them). Set to 0 to disable joining. Default: 0.1mm
   * when level >= 1, 0 when level === 0.
   */
  joinTolerance?: number
}

/**
 * Reorder strokes for shorter travel. Level 0 returns input + computed stats.
 * When level >= 1, also joins stroke pairs whose endpoints are within
 * `joinTolerance` mm of each other, eliminating the pen lift between them.
 */
export function reorder(moves: PlannerMove[], level: OptimizeLevel, options: ReorderOptions = {}): ReorderResult {
  const origin = findOrigin(moves)
  const travelBefore = computeTravel(moves)
  const strokesBefore = extractStrokes(moves)
  const liftsBefore = strokesBefore.length

  if (level === 0 || strokesBefore.length < 2) {
    return {
      moves,
      stats: {
        penLiftsBefore: liftsBefore,
        penLiftsAfter: liftsBefore,
        travelMmBefore: travelBefore,
        travelMmAfter: travelBefore,
      },
    }
  }

  // Join strokes whose endpoints are within tolerance (eliminates pen lifts).
  const tol = options.joinTolerance ?? 0.1
  const { strokes: joined, joinedCount } = tol > 0
    ? joinStrokes(strokesBefore, tol)
    : { strokes: strokesBefore, joinedCount: 0 }

  const allowReverse = level >= 2
  let ordered = nearestNeighbor(joined, origin, allowReverse)
  if (level >= 2) ordered = twoOpt(ordered, origin, 2)

  const rebuilt = rebuildMoves(origin, ordered)
  const travelAfter = computeTravel(rebuilt)

  return {
    moves: rebuilt,
    stats: {
      penLiftsBefore: liftsBefore,
      penLiftsAfter: ordered.length,
      travelMmBefore: travelBefore,
      travelMmAfter: travelAfter,
      strokesJoined: joinedCount > 0 ? joinedCount : undefined,
    },
  }
}

// ─── Strokes ──────────────────────────────────────────────────────────────────

interface Stroke {
  points: PlannerMove[]   // first is the pen-down entry; all are penDown=true
}

/** Extract contiguous pen-down runs. The entry point is the move that flipped from up→down. */
function extractStrokes(moves: PlannerMove[]): Stroke[] {
  const strokes: Stroke[] = []
  let current: PlannerMove[] | null = null

  for (let i = 0; i < moves.length; i++) {
    const m = moves[i]
    if (m.penDown) {
      if (current === null) {
        // Start of a new stroke — prepend the last pen-up position as the entry point
        const entry = moves[i - 1]
        if (entry) current = [{ x: entry.x, y: entry.y, penDown: true }]
        else current = []
      }
      current.push(m)
    } else if (current !== null) {
      if (current.length >= 2) strokes.push({ points: current })
      current = null
    }
  }
  if (current !== null && current.length >= 2) strokes.push({ points: current })
  return strokes
}

function findOrigin(moves: PlannerMove[]): { x: number; y: number } {
  // Use the first move (conventionally a pen-up at (0,0)) as start.
  if (moves.length === 0) return { x: 0, y: 0 }
  return { x: moves[0].x, y: moves[0].y }
}

// ─── Stroke joining ───────────────────────────────────────────────────────────

/**
 * Join strokes whose endpoints are within `toleranceMm` of each other.
 * Each join eliminates one pen lift by merging two strokes into a continuous
 * path. Greedy chain-building: extends each chain forward and backward until
 * no matching partner remains.
 *
 * Complexity: O(n²) per chain — acceptable for typical SVGs (<5000 strokes).
 * Returns the joined stroke list and a count of joins performed.
 */
function joinStrokes(
  strokes: Stroke[],
  toleranceMm: number,
): { strokes: Stroke[]; joinedCount: number } {
  const tol2 = toleranceMm * toleranceMm
  const used = new Uint8Array(strokes.length)
  const result: Stroke[] = []
  let joinedCount = 0

  const d2 = (a: PlannerMove, b: PlannerMove) => {
    const dx = a.x - b.x; const dy = a.y - b.y; return dx * dx + dy * dy
  }

  for (let i = 0; i < strokes.length; i++) {
    if (used[i]) continue
    // Build chain: start from stroke i, extend forward and backward.
    let chain = strokes[i].points.slice()
    used[i] = 1

    // Extend forward: find stroke whose START (points[0]) matches chain tail.
    let extended = true
    while (extended) {
      extended = false
      const tail = chain[chain.length - 1]
      for (let j = 0; j < strokes.length; j++) {
        if (used[j]) continue
        const pts = strokes[j].points
        if (d2(tail, pts[0]) <= tol2) {
          // A tail → B head: append B's drawing (skip B's duplicate entry)
          chain = chain.concat(pts.slice(1))
          used[j] = 1; joinedCount++; extended = true; break
        }
        if (d2(tail, pts[pts.length - 1]) <= tol2) {
          // A tail → B tail: append reversed B (skip B's last, which is the join point)
          const rev = pts.slice(0, -1).reverse()
          chain = chain.concat(rev)
          used[j] = 1; joinedCount++; extended = true; break
        }
      }
    }

    // Extend backward: find stroke whose END matches chain head.
    extended = true
    while (extended) {
      extended = false
      const head = chain[0]
      for (let j = 0; j < strokes.length; j++) {
        if (used[j]) continue
        const pts = strokes[j].points
        if (d2(head, pts[pts.length - 1]) <= tol2) {
          // B tail → A head: prepend B
          chain = pts.concat(chain.slice(1))
          used[j] = 1; joinedCount++; extended = true; break
        }
        if (d2(head, pts[0]) <= tol2) {
          // B head → A head: prepend reversed B
          const rev = pts.slice().reverse()
          chain = rev.concat(chain.slice(1))
          used[j] = 1; joinedCount++; extended = true; break
        }
      }
    }

    result.push({ points: chain })
  }

  return { strokes: result, joinedCount }
}

// ─── Nearest-neighbor greedy ──────────────────────────────────────────────────

function nearestNeighbor(
  strokes: Stroke[],
  origin: { x: number; y: number },
  allowReverse: boolean,
): Stroke[] {
  const remaining = [...strokes]
  const out: Stroke[] = []
  let cx = origin.x
  let cy = origin.y

  while (remaining.length > 0) {
    let bestIdx = 0
    let bestDist = Infinity
    let bestReversed = false

    for (let i = 0; i < remaining.length; i++) {
      const s = remaining[i]
      const head = s.points[0]
      const tail = s.points[s.points.length - 1]
      const dHead = dist2(cx, cy, head.x, head.y)
      if (dHead < bestDist) { bestDist = dHead; bestIdx = i; bestReversed = false }
      if (allowReverse) {
        const dTail = dist2(cx, cy, tail.x, tail.y)
        if (dTail < bestDist) { bestDist = dTail; bestIdx = i; bestReversed = true }
      }
    }

    const chosen = remaining.splice(bestIdx, 1)[0]
    const s = bestReversed ? { points: [...chosen.points].reverse() } : chosen
    out.push(s)
    const last = s.points[s.points.length - 1]
    cx = last.x
    cy = last.y
  }

  return out
}

// ─── 2-opt polish ─────────────────────────────────────────────────────────────

/**
 * Light 2-opt on the ordered stroke list. For each pair (i, j), test whether
 * reversing the sub-range [i..j] reduces total travel. Up to `passes` sweeps.
 * Complexity: O(passes * n²). Cheap for typical plotter SVGs (< 500 strokes).
 */
function twoOpt(
  strokes: Stroke[],
  origin: { x: number; y: number },
  passes: number,
): Stroke[] {
  if (strokes.length < 3) return strokes
  let order = strokes.slice()
  const n = order.length

  for (let pass = 0; pass < passes; pass++) {
    let improved = false
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const delta = twoOptDelta(order, origin, i, j)
        if (delta < -1e-6) {
          order = reverseRange(order, i, j)
          improved = true
        }
      }
    }
    if (!improved) break
  }
  return order
}

/** Travel-distance delta for reversing strokes[i..j] (negative = improvement). */
function twoOptDelta(
  strokes: Stroke[],
  origin: { x: number; y: number },
  i: number,
  j: number,
): number {
  const prevEnd = i === 0
    ? origin
    : endpoint(strokes[i - 1], 'end')
  const nextStart = j + 1 < strokes.length
    ? endpoint(strokes[j + 1], 'start')
    : null

  const iHead  = endpoint(strokes[i], 'start')
  const jTail  = endpoint(strokes[j], 'end')

  // Current travel: prevEnd → iHead, jTail → nextStart (if exists)
  const curIn  = Math.sqrt(dist2(prevEnd.x, prevEnd.y, iHead.x, iHead.y))
  const curOut = nextStart ? Math.sqrt(dist2(jTail.x, jTail.y, nextStart.x, nextStart.y)) : 0

  // Reversed: the block becomes strokes[j..i] each also reversed
  // prevEnd → reversed head of (was strokes[j]) = jTail, then reversed tail of (was strokes[i]) = iHead → nextStart
  const newIn  = Math.sqrt(dist2(prevEnd.x, prevEnd.y, jTail.x, jTail.y))
  const newOut = nextStart ? Math.sqrt(dist2(iHead.x, iHead.y, nextStart.x, nextStart.y)) : 0

  return (newIn + newOut) - (curIn + curOut)
}

function reverseRange(strokes: Stroke[], i: number, j: number): Stroke[] {
  const out = strokes.slice()
  const sub = out.slice(i, j + 1).reverse().map(s => ({ points: [...s.points].reverse() }))
  out.splice(i, j - i + 1, ...sub)
  return out
}

function endpoint(s: Stroke, which: 'start' | 'end'): PlannerMove {
  return which === 'start' ? s.points[0] : s.points[s.points.length - 1]
}

// ─── Rebuild PlannerMove[] from ordered strokes ──────────────────────────────

function rebuildMoves(
  origin: { x: number; y: number },
  strokes: Stroke[],
): PlannerMove[] {
  const out: PlannerMove[] = [{ x: origin.x, y: origin.y, penDown: false }]
  for (const s of strokes) {
    // Entry point as pen-up travel
    const entry = s.points[0]
    out.push({ x: entry.x, y: entry.y, penDown: false })
    // Pen-down points (skip entry; it was just the travel target)
    for (let i = 1; i < s.points.length; i++) {
      out.push({ x: s.points[i].x, y: s.points[i].y, penDown: true })
    }
  }
  // End pen-up at the last stroke's tail
  const last = out[out.length - 1]
  if (last.penDown) out.push({ x: last.x, y: last.y, penDown: false })
  return out
}

// ─── Stats helpers ────────────────────────────────────────────────────────────

function computeTravel(moves: PlannerMove[]): number {
  let travel = 0
  for (let i = 1; i < moves.length; i++) {
    const cur = moves[i]
    if (cur.penDown) continue
    const prev = moves[i - 1]
    travel += Math.sqrt(dist2(prev.x, prev.y, cur.x, cur.y))
  }
  return travel
}

function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx
  const dy = ay - by
  return dx * dx + dy * dy
}
