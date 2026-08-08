/**
 * Machine envelopes — the drawable rectangle for each AxiDraw model.
 *
 * Dimensions are the AxiDraw's physical XY travel in mm, measured from the
 * firmware's (0,0) corner. Sending a command that moves the carriage beyond
 * these coordinates will stall or crash the arm against the end-stops.
 *
 * In nib's coordinate system, the origin (0,0) is wherever the user parked
 * the arm before `nib motors on`. The envelope below tells us how far the
 * arm can travel FROM THAT ORIGIN in each direction — not an absolute cage.
 * Users who park mid-machine effectively have a smaller usable envelope;
 * that's on them.
 *
 * Published by Evil Mad Scientist:
 *   https://wiki.evilmadscientist.com/AxiDraw_Technical_Specifications
 */

export interface Envelope {
  widthMm: number
  heightMm: number
}

export const MACHINE_ENVELOPES: Record<string, Envelope> = {
  'V3':    { widthMm: 280, heightMm: 218 },
  'V3A3':  { widthMm: 430, heightMm: 297 },
  'SE/A3': { widthMm: 430, heightMm: 297 },
  'V3XL':  { widthMm: 595, heightMm: 218 },
  'Mini':  { widthMm: 152, heightMm: 101 },
  'MiniKit': { widthMm: 152, heightMm: 101 },
}

/**
 * Resolve an envelope from a user-provided model string (case-insensitive,
 * common aliases accepted), or return null if unrecognised.
 */
export function resolveEnvelope(model: string | undefined): Envelope | null {
  if (!model) return null
  const key = model.trim().toLowerCase()
  for (const [name, env] of Object.entries(MACHINE_ENVELOPES)) {
    if (name.toLowerCase() === key) return env
  }
  // Alias: "A3" → V3A3
  if (key === 'a3') return MACHINE_ENVELOPES['V3A3']
  if (key === 'a4') return MACHINE_ENVELOPES['V3']
  return null
}

/**
 * Parse a custom envelope string like "280x218" or "280,218" (mm). Returns
 * null if unparseable.
 */
export function parseEnvelope(str: string): Envelope | null {
  const m = str.match(/^\s*(\d+(?:\.\d+)?)\s*[x,×]\s*(\d+(?:\.\d+)?)\s*(mm)?\s*$/i)
  if (!m) return null
  return { widthMm: parseFloat(m[1]), heightMm: parseFloat(m[2]) }
}

/**
 * Check whether the given (x, y) position lies within the envelope,
 * inset by `marginMm` on all sides (default 0 = no margin). Returns null if
 * env is null (no envelope configured → bounds check disabled).
 *
 * (0, 0) is the lower bound, (envelope.widthMm, envelope.heightMm) the upper.
 * With margin > 0, safe region is [margin, widthMm-margin] × [margin, heightMm-margin].
 */
export function isInEnvelope(
  x: number, y: number,
  env: Envelope | null,
  marginMm = 0,
): boolean {
  if (env === null) return true
  const tol = 0.1  // float-drift allowance at the boundary
  return x >= marginMm - tol && y >= marginMm - tol
      && x <= env.widthMm - marginMm + tol && y <= env.heightMm - marginMm + tol
}

/**
 * Walk a sequence of (x, y) positions and return the first out-of-bounds
 * point, or null if all points fit. `env === null` disables the check.
 * `marginMm` inset applied to all edges.
 */
export function findFirstOutOfBounds(
  points: { x: number; y: number }[],
  env: Envelope | null,
  marginMm = 0,
): { index: number; point: { x: number; y: number } } | null {
  if (env === null) return null
  for (let i = 0; i < points.length; i++) {
    if (!isInEnvelope(points[i].x, points[i].y, env, marginMm)) {
      return { index: i, point: points[i] }
    }
  }
  return null
}
