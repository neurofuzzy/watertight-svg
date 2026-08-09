// ─── Profile types ───────────────────────────────────────────────────────────

export interface Profile {
  speedPendown: number    // 1–100, percent
  speedPenup: number      // 1–100, percent
  penPosDown: number      // 0–100, servo position
  penPosUp: number        // 0–100, servo position
  accel: number           // 1–100, percent
  constSpeed?: boolean
  description?: string

  // ── Per-profile tuning caps (optional) ───────────────────────────────────
  // Override the library-wide defaults when a given pen + paper combo can
  // safely handle more (or less) than the conservative global numbers.
  // Discoverable via `nib calibrate speed <profile>`.
  //
  // When set, these replace the global LM_SPEED_PENDOWN_MAX_MMS /
  // LM_SPEED_PENUP_MAX_MMS / ACCEL_MAX_MMS2 constants for THIS profile.
  // `speedPendown` / `speedPenup` / `accel` percentages are then applied
  // against the profile's caps instead of the library defaults.
  /** Max pen-down cruise speed in mm/s. Default: LM_SPEED_PENDOWN_MAX_MMS (50). */
  speedCapMms?: number
  /** Max pen-up cruise speed in mm/s. Default: LM_SPEED_PENUP_MAX_MMS (100). */
  speedCapUpMms?: number
  /** Max cartesian acceleration in mm/s². Default: ACCEL_MAX_MMS2 (2000). */
  accelCapMms2?: number
  /** Junction-deviation tolerance in mm for corner-smoothing. Default: 0.05. */
  junctionDeviationMm?: number
  /** Servo idle timeout in ms before power-off. Default: 60000 (quiet=5000). */
  servoIdleMs?: number

  // ── Servo transition rates + delays (axicli-compatible) ──────────────────
  // These map directly to axicli's pen_rate_raise / pen_rate_lower /
  // pen_delay_up / pen_delay_down fields so profiles can be shared or
  // translated between the two tools without manual conversion.
  //
  // The SP command duration sent to the EBB is derived from the rate and the
  // position delta so the servo speed is calibrated to actual pen travel, not
  // an arbitrary millisecond value:
  //
  //   sp_duration_ms = max(10, round((100 − rate) × |penPosUp − penPosDown| × 0.1))
  //
  // At axicli defaults (raise=75, lower=50, delta=30): raise→75ms, lower→150ms.
  //
  /** Servo raise rate 1–100 (axicli: pen_rate_raise). Default 75. */
  penRateRaise?: number
  /** Servo lower rate 1–100 (axicli: pen_rate_lower). Default 50. */
  penRateLower?: number
  /** Extra ms to wait after raising before any lateral move (axicli: pen_delay_up). Default 0. */
  penDelayUp?: number
  /** Extra ms to wait after lowering before beginning the stroke (axicli: pen_delay_down). Default 0. */
  penDelayDown?: number

  /**
   * Physical nib diameter in mm (e.g. 0.3 for a Staedtler 0.3, 0.5 for a
   * Pilot V5). Used to render the preview at realistic stroke width and to
   * stamp the plot card.
   */
  nibSizeMm?: number
  /**
   * Ink colour as a CSS colour string (e.g. "#1a1a1a", "royalblue"). Used by
   * preview rendering and the plot card. Defaults to black.
   */
  color?: string
}

export interface ResolvedProfile extends Profile {
  name: string
}

// ─── Layer config ────────────────────────────────────────────────────────────

export interface LayerConfig {
  id: number
  name?: string
  profile?: string        // profile name to use for this layer
  prompt?: string         // pen-swap message shown to user
  port?: string           // override port for multi-machine splits
}

// ─── Preprocess pipeline ─────────────────────────────────────────────────────

export type PreprocessStep =
  | 'strip-fills'
  | 'center'
  | 'scale-to-paper'
  | 'registration-marks'

// ─── Hooks ───────────────────────────────────────────────────────────────────

export interface HookConfig {
  onLayerComplete?: string  // shell command; {{layer}}, {{duration}} available
  onComplete?: string       // {{file}}, {{duration}}, {{pendownM}} available
  onAbort?: string
}

// ─── Job metrics ─────────────────────────────────────────────────────────────

export interface JobMetrics {
  pendownM: number
  travelM: number
  penLifts: number
  durationS: number
}

// ─── Job ─────────────────────────────────────────────────────────────────────

export type JobStatus = 'pending' | 'running' | 'complete' | 'aborted'
export type BackendName = 'ebb'

export interface Job {
  id: number
  file: string | null     // null = piped from stdin
  svg: string             // resolved SVG content
  profile: ResolvedProfile
  layers: LayerConfig[]
  preprocess: PreprocessStep[]
  copies: number
  optimize: 0 | 1 | 2    // reordering level — maps to axicli --reordering
  guided: boolean
  status: JobStatus
  startedAt?: Date
  completedAt?: Date
  stoppedAt?: number      // fraction 0–1 where job was aborted
  metrics: JobMetrics
  hooks: HookConfig
  backend: BackendName
  seed?: number           // generative seed (series mode)
  seriesId?: string       // shared ID across a series run
  session?: number        // multi-session counter (increments per plot --session)
}

// ─── Profile validation ───────────────────────────────────────────────────────

/**
 * Validate a Profile for in-range values and internal consistency.
 * Returns an array of human-readable error strings (empty = valid).
 */
export function validateProfile(p: Profile): string[] {
  const errors: string[] = []

  function inRange(field: string, val: number | undefined, min: number, max: number) {
    if (val === undefined) return
    if (val < min || val > max) errors.push(`${field} must be ${min}–${max}, got ${val}`)
  }

  inRange('speedPendown', p.speedPendown, 1, 100)
  inRange('speedPenup',   p.speedPenup,   1, 100)
  inRange('penPosDown',   p.penPosDown,   0, 100)
  inRange('penPosUp',     p.penPosUp,     0, 100)
  inRange('accel',        p.accel,        1, 100)

  if (p.penPosUp !== undefined && p.penPosDown !== undefined && p.penPosUp <= p.penPosDown) {
    errors.push(`penPosUp (${p.penPosUp}) must be greater than penPosDown (${p.penPosDown})`)
  }

  if (p.speedCapMms  !== undefined && p.speedCapMms  <= 0) errors.push('speedCapMms must be > 0')
  if (p.speedCapUpMms !== undefined && p.speedCapUpMms <= 0) errors.push('speedCapUpMms must be > 0')
  if (p.accelCapMms2  !== undefined && p.accelCapMms2  <= 0) errors.push('accelCapMms2 must be > 0')
  if (p.nibSizeMm     !== undefined && p.nibSizeMm     <= 0) errors.push('nibSizeMm must be > 0')
  inRange('penRateRaise', p.penRateRaise, 1, 100)
  inRange('penRateLower', p.penRateLower, 1, 100)
  if (p.penDelayUp   !== undefined && p.penDelayUp   < 0) errors.push('penDelayUp must be ≥ 0')
  if (p.penDelayDown !== undefined && p.penDelayDown < 0) errors.push('penDelayDown must be ≥ 0')

  return errors
}

// ─── Job builder ─────────────────────────────────────────────────────────────

export function createJob(overrides: Partial<Job> & Pick<Job, 'svg' | 'profile'>): Job {
  return {
    id: 0,
    file: null,
    layers: [],
    preprocess: [],
    copies: 1,
    optimize: 0,
    guided: false,
    status: 'pending',
    metrics: { pendownM: 0, travelM: 0, penLifts: 0, durationS: 0 },
    hooks: {},
    backend: 'ebb',
    ...overrides,
  }
}
