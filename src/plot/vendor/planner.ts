/**
 * Motion planner — trapezoidal velocity profiles for LM-based plotting
 *
 * Phase 2a scope: each cartesian move is planned as an independent trapezoid
 * that starts and ends at rest. Phase 2b will add junction velocities so
 * consecutive moves don't fully decelerate between strokes.
 *
 * Vocabulary:
 *   - Move:       a single line from (x0,y0) to (x1,y1). Cartesian.
 *   - Trapezoid:  three phases (accel → cruise → decel). The cruise phase
 *                 may be zero length (triangular profile) if the move is
 *                 too short to reach vMax with the given accel.
 *   - Phase:      one LM command. Each phase has an entry and exit velocity
 *                 and a per-axis step count + rate + accel register value.
 */

import {
  STEPS_PER_MM,
  lmRateReg,
  lmAccelReg,
  LM_TICK_HZ,
} from './ebb-protocol.ts'

// ─── Public API ───────────────────────────────────────────────────────────────

export interface TrapezoidProfile {
  /** distance (mm) spent accelerating from vEntry to vPeak */
  accelDist: number
  /** distance (mm) spent at vPeak */
  cruiseDist: number
  /** distance (mm) spent decelerating from vPeak to vExit */
  decelDist: number
  /** peak velocity achieved (mm/s). ≤ vMax. */
  vPeak: number
  /** true = triangular (no cruise); false = real trapezoid */
  triangular: boolean
}

export interface LmPhase {
  /** number of cartesian mm covered in this phase */
  distMm: number
  /** cartesian velocity at start of phase (mm/s) */
  vEntry: number
  /** cartesian velocity at end of phase (mm/s) */
  vExit: number
  /** duration of phase (s) */
  durationS: number
  /** motor 1 signed step count for this phase */
  steps1: number
  /** motor 2 signed step count for this phase */
  steps2: number
  /** motor 1 LM rate register at phase start */
  rate1Reg: number
  /** motor 2 LM rate register at phase start */
  rate2Reg: number
  /** motor 1 LM accel register */
  accel1Reg: number
  /** motor 2 LM accel register */
  accel2Reg: number
}

export interface PlannedMove {
  /** dX, dY in mm (signed, cartesian) */
  dX: number
  dY: number
  /** total cartesian distance (mm) */
  distMm: number
  /** total duration (s) */
  durationS: number
  profile: TrapezoidProfile
  /** 1–3 LM commands: accel, cruise, decel. Zero-length phases are omitted. */
  phases: LmPhase[]
}

export interface PlanOptions {
  /** peak cartesian speed (mm/s) allowed during cruise */
  vMax: number
  /** cartesian acceleration (mm/s²). Symmetric for accel and decel. */
  accel: number
  /** minimum starting rate (steps/s per axis). Must be > 0 so the LM axis
   *  accumulator actually ticks; set low (2–5 steps/s) so accel is visible. */
  minRateStepsPerSec?: number
  /** Junction deviation in mm. Default JUNCTION_DEVIATION_MM (0.05). */
  junctionDeviationMm?: number
}

// ─── Trapezoid geometry ───────────────────────────────────────────────────────

/**
 * Plan a trapezoidal velocity profile for a single move with known entry/exit
 * speeds. If vEntry > 0 or vExit > 0, the accel/decel phases just don't start
 * from rest. If the move is too short to reach vMax, a triangular profile is
 * returned (cruiseDist = 0, vPeak < vMax).
 *
 * All inputs/outputs in cartesian mm and mm/s.
 */
export function planTrapezoid(
  distMm: number,
  vEntry: number,
  vExit: number,
  vMax: number,
  accel: number,
): TrapezoidProfile {
  // Distance to accel from vEntry → vMax, and decel from vMax → vExit.
  //   v² = v0² + 2·a·d  ⇒  d = (v² - v0²) / (2a)
  const accelDistFull = (vMax * vMax - vEntry * vEntry) / (2 * accel)
  const decelDistFull = (vMax * vMax - vExit  * vExit)  / (2 * accel)

  if (accelDistFull + decelDistFull <= distMm) {
    // Trapezoid with non-zero cruise
    return {
      accelDist:  Math.max(0, accelDistFull),
      cruiseDist: distMm - accelDistFull - decelDistFull,
      decelDist:  Math.max(0, decelDistFull),
      vPeak: vMax,
      triangular: false,
    }
  }

  // Triangular: solve for vPeak such that accelDist + decelDist = distMm.
  //   (vPeak² - vEntry²)/(2a) + (vPeak² - vExit²)/(2a) = distMm
  //   2·vPeak² = 2a·distMm + vEntry² + vExit²
  const vPeakSq = (2 * accel * distMm + vEntry * vEntry + vExit * vExit) / 2
  const vPeak   = Math.sqrt(Math.max(0, vPeakSq))
  const aDist   = Math.max(0, (vPeak * vPeak - vEntry * vEntry) / (2 * accel))
  const dDist   = Math.max(0, distMm - aDist)
  return {
    accelDist:  aDist,
    cruiseDist: 0,
    decelDist:  dDist,
    vPeak,
    triangular: true,
  }
}

// ─── Move planner ─────────────────────────────────────────────────────────────

/**
 * Plan a single move as up to three LM phases (accel / cruise / decel).
 * Returns the complete PlannedMove with phase-level step counts rounded so
 * the per-axis totals exactly match `steps1 = (dX+dY)·80` and
 * `steps2 = (dX-dY)·80`.
 */
export function planMove(
  dX: number,
  dY: number,
  vEntry: number,
  vExit: number,
  options: PlanOptions,
): PlannedMove {
  const distMm = Math.hypot(dX, dY)
  if (distMm < 1e-6) {
    return {
      dX, dY, distMm: 0, durationS: 0,
      profile: { accelDist: 0, cruiseDist: 0, decelDist: 0, vPeak: 0, triangular: true },
      phases: [],
    }
  }

  const profile = planTrapezoid(distMm, vEntry, vExit, options.vMax, options.accel)

  // Total signed steps per motor (CoreXY-like)
  const totalSteps1 = Math.round((dX + dY) * STEPS_PER_MM)
  const totalSteps2 = Math.round((dX - dY) * STEPS_PER_MM)

  const minRate = options.minRateStepsPerSec ?? 2

  const phases: LmPhase[] = []
  let remaining1 = totalSteps1
  let remaining2 = totalSteps2
  let distCovered = 0

  // Build candidate phases (keep only those with > 0 distance)
  const candidates: Array<{ dist: number; vEntry: number; vExit: number }> = []
  if (profile.accelDist  > 1e-9) candidates.push({ dist: profile.accelDist,  vEntry,          vExit: profile.vPeak })
  if (profile.cruiseDist > 1e-9) candidates.push({ dist: profile.cruiseDist, vEntry: profile.vPeak, vExit: profile.vPeak })
  if (profile.decelDist  > 1e-9) candidates.push({ dist: profile.decelDist,  vEntry: profile.vPeak, vExit })

  const lastIdx = candidates.length - 1
  const sign1 = Math.sign(totalSteps1) || 1
  const sign2 = Math.sign(totalSteps2) || 1

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]
    distCovered += c.dist

    // Step counts for this phase (signed).
    // Use fraction-of-total for intermediate phases; give remaining steps to
    // the last phase so per-axis totals exactly match.
    let steps1: number, steps2: number
    if (i === lastIdx) {
      steps1 = remaining1
      steps2 = remaining2
    } else {
      const frac = c.dist / distMm
      steps1 = Math.round(totalSteps1 * frac)
      steps2 = Math.round(totalSteps2 * frac)
      remaining1 -= steps1
      remaining2 -= steps2
    }

    // Phase duration: t = 2·d / (vEntry + vExit)  (for linear ramp)
    // Handles cruise (vEntry == vExit) via the same formula.
    const avgV = (c.vEntry + c.vExit) / 2
    const durationS = avgV > 1e-9 ? c.dist / avgV : 0

    // Per-axis rates at phase entry and exit (steps/sec, unsigned).
    // Axis rate = |axis_steps| / phase_duration × (c.vEntry / avgV) for entry
    // Equivalently: axis fraction of cartesian velocity × steps-per-mm-axis.
    const axis1Ratio = Math.abs(steps1) / Math.max(1, c.dist * STEPS_PER_MM)
    const axis2Ratio = Math.abs(steps2) / Math.max(1, c.dist * STEPS_PER_MM)

    const axis1EntryRate = Math.max(minRate, c.vEntry * STEPS_PER_MM * axis1Ratio)
    const axis1ExitRate  = Math.max(minRate, c.vExit  * STEPS_PER_MM * axis1Ratio)
    const axis2EntryRate = Math.max(minRate, c.vEntry * STEPS_PER_MM * axis2Ratio)
    const axis2ExitRate  = Math.max(minRate, c.vExit  * STEPS_PER_MM * axis2Ratio)

    // For axes with zero steps, send zero rate/accel. The firmware won't step
    // an axis whose step-count is 0, but 0 rate is the safest signal.
    const rate1Reg  = steps1 === 0 ? 0 : lmRateReg(axis1EntryRate)
    const rate2Reg  = steps2 === 0 ? 0 : lmRateReg(axis2EntryRate)
    const accel1Reg = (steps1 === 0 || durationS < 1e-9)
      ? 0 : lmAccelReg((axis1ExitRate - axis1EntryRate) / durationS)
    const accel2Reg = (steps2 === 0 || durationS < 1e-9)
      ? 0 : lmAccelReg((axis2ExitRate - axis2EntryRate) / durationS)

    phases.push({
      distMm: c.dist,
      vEntry: c.vEntry,
      vExit:  c.vExit,
      durationS,
      steps1,
      steps2,
      rate1Reg,
      rate2Reg,
      accel1Reg,
      accel2Reg,
    })

    // Unused: prevent "declared but never used" if compilers grumble.
    void distCovered; void sign1; void sign2
  }

  const totalDurationS = phases.reduce((s, p) => s + p.durationS, 0)

  return {
    dX, dY,
    distMm,
    durationS: totalDurationS,
    profile,
    phases,
  }
}

// ─── Stroke planner (junction velocities) ───────────────────────────────────

/**
 * Default junction deviation — how far the actual path is allowed to deviate
 * from the ideal sharp corner when cornering under the given acceleration.
 * Larger = faster cornering, smaller = more accurate but slower.
 * 0.05 mm is conservative; Marlin's default is 0.013 mm, Prusa's is 0.1.
 *
 * Overridable per-stroke via PlanOptions.junctionDeviationMm.
 */
export const JUNCTION_DEVIATION_MM = 0.05

export interface Segment {
  /** endpoint X in mm */
  x: number
  /** endpoint Y in mm */
  y: number
}

/**
 * Plan a stroke of connected segments with non-zero junction velocities.
 * Input is the sequence of endpoints (starting with the pen-down entry point,
 * i.e. points[0] = where the stroke begins). Output is one PlannedMove per
 * segment between consecutive points, with vEntry/vExit chosen so consecutive
 * moves flow smoothly without stopping at internal junctions.
 *
 * Endpoints (first and last move of the stroke) start and end at rest.
 *
 * Implementation: compute per-junction speed caps from the turn angle via
 * Marlin-style junction deviation, then run forward + backward passes.
 */
export function planStroke(points: Segment[], options: PlanOptions): PlannedMove[] {
  if (points.length < 2) return []

  const n = points.length - 1   // number of segments
  const segs: { dx: number; dy: number; dist: number }[] = []
  for (let i = 0; i < n; i++) {
    const dx = points[i + 1].x - points[i].x
    const dy = points[i + 1].y - points[i].y
    segs.push({ dx, dy, dist: Math.hypot(dx, dy) })
  }

  // Junction caps: vJunction[i] = max allowed speed at the junction AFTER segment i.
  // vJunction[n-1] is the stroke's exit speed → 0 (rest at end).
  // vJunction[-1] conceptually = 0 (rest at start) — handled in forward pass.
  const vJunction: number[] = new Array(n)
  vJunction[n - 1] = 0  // end at rest

  const devMm = options.junctionDeviationMm ?? JUNCTION_DEVIATION_MM
  for (let i = 0; i < n - 1; i++) {
    vJunction[i] = junctionSpeed(segs[i], segs[i + 1], options.accel, devMm)
    if (vJunction[i] > options.vMax) vJunction[i] = options.vMax
  }

  // Forward pass: entry velocity of segment i+1 is bounded by what we can reach
  // from entry velocity of segment i, accelerating across segment i's distance.
  //   vExit[i] ≤ sqrt(vEntry[i]² + 2·a·d[i])
  // Initial: vEntry[0] = 0 (start at rest).
  const vEntry: number[] = new Array(n)
  vEntry[0] = 0
  for (let i = 0; i < n - 1; i++) {
    const vReachable = Math.sqrt(vEntry[i] * vEntry[i] + 2 * options.accel * segs[i].dist)
    vEntry[i + 1] = Math.min(vReachable, vJunction[i])
  }

  // Backward pass: entry velocity of segment i is bounded by what's reachable
  // from the (already-constrained) entry velocity of segment i+1 by decelerating.
  //   vEntry[i] ≤ sqrt(vEntry[i+1]² + 2·a·d[i])
  // End: exit of last segment is 0, so vEntry[n-1] ≤ sqrt(2·a·d[n-1]).
  let vExitNext = 0
  for (let i = n - 1; i >= 0; i--) {
    const vReachable = Math.sqrt(vExitNext * vExitNext + 2 * options.accel * segs[i].dist)
    vEntry[i] = Math.min(vEntry[i], vReachable)
    vExitNext = vEntry[i]
  }

  // vEntry[i] is now each segment's entry velocity. Each segment's exit =
  // next segment's entry, and the last segment's exit = 0.
  const out: PlannedMove[] = []
  for (let i = 0; i < n; i++) {
    const vEx = i < n - 1 ? vEntry[i + 1] : 0
    out.push(planMove(segs[i].dx, segs[i].dy, vEntry[i], vEx, options))
  }
  return out
}

/**
 * Compute the max allowed speed at the junction between two segments, using
 * Marlin's junction-deviation model.
 *
 *   cosθ = dot(a_hat, b_hat)     where a points INTO the junction,
 *                                      b points OUT of the junction
 *   θ = 0 (straight)     → cos=1     → no constraint (return Infinity)
 *   θ = π (reversal)     → cos=-1    → must stop (return 0)
 *
 * Formula:
 *   vJunction² = accel · JUNCTION_DEVIATION · (1 + cosθ) / (1 - cosθ)
 */
function junctionSpeed(
  a: { dx: number; dy: number; dist: number },
  b: { dx: number; dy: number; dist: number },
  accel: number,
  deviationMm: number,
): number {
  if (a.dist < 1e-9 || b.dist < 1e-9) return 0
  const cosTheta = (a.dx * b.dx + a.dy * b.dy) / (a.dist * b.dist)
  const c = Math.max(-1, Math.min(1, cosTheta))
  if (c <= -1 + 1e-9) return 0
  if (c >= 1 - 1e-9)  return Infinity
  const num = accel * deviationMm * (1 + c)
  const den = 1 - c
  return Math.sqrt(num / den)
}

// ─── Speed / accel resolution from profile ───────────────────────────────────

import type { ResolvedProfile } from './job.ts'
import { LM_SPEED_PENDOWN_MAX_MMS, LM_SPEED_PENUP_MAX_MMS, ACCEL_MAX_MMS2 } from './ebb-protocol.ts'

/**
 * Resolve plan options for a profile, for pen-down or pen-up motion.
 *
 * Profile percentages (speedPendown, speedPenup, accel) are applied against
 * per-profile caps when set, falling back to the library-wide conservative
 * defaults. This lets `nib calibrate speed` discover safe caps for a specific
 * pen + paper + rig and pin them in the profile.
 */
export function optionsForProfile(profile: ResolvedProfile, penDown: boolean): PlanOptions {
  const downCap  = profile.speedCapMms    ?? LM_SPEED_PENDOWN_MAX_MMS
  const upCap    = profile.speedCapUpMms  ?? LM_SPEED_PENUP_MAX_MMS
  const accelCap = profile.accelCapMms2   ?? ACCEL_MAX_MMS2

  const vMax  = penDown ? (profile.speedPendown / 100) * downCap
                        : (profile.speedPenup   / 100) * upCap
  const accel = (profile.accel / 100) * accelCap
  return {
    vMax: Math.max(1, vMax),
    accel: Math.max(100, accel),
    junctionDeviationMm: profile.junctionDeviationMm,
  }
}

// Re-export for consumers
export { LM_TICK_HZ }
