# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Watertight SVG — a browser-only geometric optimizer that turns messy vector art into clean, continuous paths for pen plotters, laser/vinyl cutters, and CNC. No backend; everything runs locally in the browser (Vite + TypeScript, vanilla DOM, no framework). Deployed to GitHub Pages via `npm run deploy`.

## Commands

```bash
npm run dev            # Vite dev server on :5173 (auto-opens)
npm run build          # tsc (typecheck, noEmit) then vite build
npm test               # vitest in WATCH mode
npx vitest run         # single run (use this in agent workflows)
npx vitest run src/tests/nesting.test.ts        # one file
npx vitest run -t "plotter"                     # one test by name
npm run deploy         # build + gh-pages -d dist
```

The full suite takes ~20s; `region-finding.test.ts` alone runs the algorithm over five sample SVGs (up to 25k segments) and dominates that time.

### WASM

The Rust crate in `wasm/` is a port of the region-finding algorithm. Both output packages are gitignored, so they must be built locally before anything that uses them works:

```bash
npm run wasm:build     # --target web -> src/wasm-pkg      (browser)
cd wasm && wasm-pack build --target nodejs --out-dir ../src/wasm-pkg-node   # needed by region-finding.test.ts
```

Requires `wasm-pack` and a Rust toolchain. `region-finding.test.ts` degrades gracefully (skips WASM comparisons) if `src/wasm-pkg-node` is missing.

**Important:** the WASM path is *not* wired into the running app. `src/optimize/wasm-bridge.ts` and `src/optimize/regions-wasm.ts` exist but nothing imports them — the pipeline calls the TypeScript `findRegions` directly. WASM is currently only exercised by tests (~2x faster than TS). Treat the Rust code in `wasm/src/` as a parallel implementation that must be kept behaviorally identical to `src/optimize/regions.ts` + `src/geometry/{dcel,intersection,quadtree-ish}` if you touch either side.

## Architecture

### Data model

Everything is flattened to `Path { points: Point[], closed: boolean, meta? }` (`src/geometry/types.ts`). Curves, arcs, shapes — all sampled into polylines at parse time. There are no beziers anywhere past the parser.

**Coordinates are always root-SVG viewBox space.** `getPointAtLength()` reports element-local coordinates, so the parser resolves each element's transform chain (`getRootMatrix`, derived from two `getScreenCTM()` calls) and lifts every sample into root space. Anything new that reads geometry off the DOM must do the same.

**Do not assume user units are pixels.** A viewBox can be `0 0 800 600` or `0 0 5.83 8.27` (inches). Sampling density (parser), pipeline tolerances, and preview stroke widths are all derived from the document's largest dimension for this reason. `SVGDocument.units` carries the source unit through to export; it's `undefined` for unitless/px documents, which export as mm by convention.

### Threading split (matters for any change to parsing)

`parseSVG` (`src/geometry/parser.ts`) uses **browser SVG DOM APIs** (`getTotalLength`/`getPointAtLength`) so it must run on the main thread. `src/main.ts` parses, then posts the plain `SVGDocument` to `src/worker.ts`, which runs `optimizeDocument` off-thread and posts back progress + result. Consequently:

- Nothing under `src/optimize/` or `src/geometry/` (other than `parser.ts`) may touch the DOM — that code has to run in the worker, and in Node under vitest.
- Tests can't use `parser.ts`; they use `src/tests/simple-parser.ts`, a regex-based parser that handles line/polyline/polygon/rect/circle only (no curves, no text).
- Each optimization run **creates a fresh worker** (`createWorker()` terminates the old one) — that is the cancellation mechanism for a superseded run.

### The pipeline

`src/optimize/pipeline.ts::optimizeDocument` is the spine. Order is deliberate:

1. Normalize geometry into a **fixed working space**: the document's largest dimension is scaled to `REFERENCE_SIZE` (1000) and then by `BASE_SCALE` (10) for float headroom, so the working space is always ~10000 units wide regardless of whether the source viewBox is in pixels or inches. Scaled back down at the end. Every hard-coded tolerance is written as `x * BASE_SCALE` — i.e. in reference units, not document units. **Never write a bare tolerance or one based on `SCALE`**; that reintroduces the assumption that user units are pixels.
2. Remove overdraw → split at intersections → remove overdraw again (the second pass catches partial overlaps only visible after splitting).
3. Merge connected segments, then prune tiny paths and colinear points.
4. Fill strategy: `findRegions` (bridge gaps → DCEL face extraction → winding fix) **or** `closePaths`, never both. Region finding *replaces* the path list; if it finds nothing it falls back to the bridged paths.
5. 2-opt sort to minimize pen-up travel.

**Plotter Mode** is implicit, not a flag: `mergePaths && !findRegions && !closePaths` triggers an override block that disables intersection splitting (to preserve long continuous strokes) and forces sorting on. The same condition is recomputed in `main.ts` to suppress fill rendering in the preview — keep the two in sync.

### Region finding

`src/optimize/regions.ts` builds a DCEL (`src/geometry/dcel.ts`) from intersection-split segments and extracts bounded faces. Intersections come from `src/geometry/intersection.ts`, which uses spatial indexing (quadtree in Rust, `spatial-hash.ts` in TS) rather than brute force. This whole subtree is intentionally DOM-free and written to be portable to Rust.

### Nesting / layers

`src/optimize/nesting-analytical.ts` computes enclosure depth via AABB + interior-point ray casting; `nesting.ts` groups paths into `Map<depth, Path[]>`. That map drives three things: layer coloring in the preview, layer coloring in the simulator, and Inkscape `<g inkscape:groupmode="layer">` groups in `src/ui/export.ts`. Depth 0 means open/unclassified paths.

### Post-pipeline transforms

Rotation, scale-to-fit (`src/optimize/scale.ts`), pen-weight injection, and layering are **not** part of the worker pipeline — they're applied in `main.ts` at export/simulate time only. `OptimizeOptions.scaleToFit`/`paperSize`/`penWeight` are passed to the worker but currently unused there.

### UI

`index.html` holds all the markup with hardcoded `id`s; `src/main.ts` (~1000 lines) binds them via `getElementById` at module scope. Adding a control means editing both files. Notable pieces:

- Presets (Cutter/Plotter/Custom) are radio buttons; `applyPreset` sets checkboxes and `checkPresets` reverse-matches current checkbox state back to a preset after any manual change.
- Page-setup values persist to `sessionStorage` under `watertight_settings`. Units (mm/in) are a UI-level concern — everything internal is mm, converted via `toMM()`.
- `src/ui/simulator.ts` is a raw WebGL2 renderer for plot playback; `src/ui/panzoom.ts` is a shared controller attached to both preview SVGs so they pan/zoom together, and it must be re-attached whenever previews re-render.

## Samples

`samples/*.svg` are graded difficulty fixtures (easy → medium → hard → hardest → hurt-me) used both for manual testing and as test inputs. `region-finding.test.ts` prints a TS-vs-WASM timing/coverage table for them.
