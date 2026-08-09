/**
 * Extracted from nib's `src/backends/svg-to-moves.ts`, which we do not vendor:
 * that module pulls in svgson + svg-pathdata to turn an SVG string into moves,
 * and we already have geometry as `Path[]` long before this point. Only the
 * type crosses the boundary.
 */

export interface PlannerMove {
  x: number          // mm from SVG origin
  y: number          // mm from SVG origin
  penDown: boolean   // true = pen contact with paper
}
