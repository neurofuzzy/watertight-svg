/**
 * Shared backend types.
 *
 * These used to live alongside the axicli subprocess backend; Phase 4 of the
 * EBB-only migration moved them here so deleting axicli.ts doesn't require
 * updating every consumer.
 */

export interface RunJobResult {
  /** 0–1 fraction; 1 = fully complete */
  stoppedAt: number
  aborted: boolean
  /** Motion metrics accumulated during the run (zero on abort before any motion). */
  metrics?: { pendownM: number; travelM: number; penLifts: number }
}

export interface PreviewStats {
  pendownM: number | null
  travelM: number | null
  travelOverheadPct: number | null
  estimatedS: number | null
  penLifts: number | null
  boundingBoxMm: { width: number; height: number } | null
  fitsA4: boolean | null
  fitsA3: boolean | null
  /** Raw stdout lines (legacy axicli path; always [] for the native EBB path). */
  rawLines: string[]
}
