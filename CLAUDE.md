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
npm run deploy         # build + gh-pages -d dist (manual; CI does this on merge to main)
```

The full suite takes ~20s; `region-finding.test.ts` alone runs the algorithm over five sample SVGs (up to 25k segments) and dominates that time.

There is no native/WASM component. A Rust port of the region finder existed until it was removed as unused — see "Deploy" below if you are wondering why CI installs no toolchain.

### Deploy

`.github/workflows/deploy.yml` builds and publishes `dist/` to the `gh-pages` branch on every push to `main`. That push is what triggers GitHub's own generated `pages-build-deployment` run — that workflow is synthesized by GitHub and will never appear in `.github/workflows`, which is not a bug.

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

`src/optimize/regions.ts` builds a DCEL (`src/geometry/dcel.ts`) from intersection-split segments and extracts bounded faces. Intersections come from `src/geometry/intersection.ts`, which uses `spatial-hash.ts` rather than brute force. This whole subtree is intentionally DOM-free — it has to run in the worker and under Node in tests.

### Nesting / layers

`src/optimize/nesting-analytical.ts` computes enclosure depth via AABB + interior-point ray casting; `nesting.ts` groups paths into `Map<depth, Path[]>`. That map drives three things: layer coloring in the preview, layer coloring in the simulator, and Inkscape `<g inkscape:groupmode="layer">` groups in `src/ui/export.ts`. Depth 0 means open/unclassified paths.

### Post-pipeline transforms

Rotation, scale-to-fit (`src/optimize/scale.ts`), pen-weight injection, and layering are **not** part of the worker pipeline — they're applied in `main.ts` at export/simulate time only. `OptimizeOptions.scaleToFit`/`paperSize`/`penWeight` are passed to the worker but currently unused there.

`prepareOutput()` in `main.ts` applies rotation → scale-to-fit → layering and is shared by the simulator and the plotter, so what you watch on screen is the geometry the pen draws. Export doesn't use it — it builds an SVG document and does the same work inline. If you add a fourth consumer, route it through `prepareOutput()`.

It returns a `docUnits` field that any consumer needing real-world measurements **must** use instead of `SVGDocument.units`. `fitToPaper` returns paths already in millimetres, so scale-to-fit makes the document's own unit stale; `docUnits` is `undefined` (i.e. mm) in that case. Reaching past it to `optimized.units` scales an inch document by 25.4 twice — on the plotter that means driving the carriage into the end stops.

### Plotting (`src/plot/`)

Plots directly to an AxiDraw over WebSerial. `src/plot/vendor/` is a vendored subset of [jheuer/nib](https://github.com/jheuer/nib) (MIT) — the EBB protocol layer and motion planner. **Read `src/plot/vendor/README.md` before touching it**: it records the upstream commit and the exact list of divergences to reapply when re-syncing. Don't refactor vendored files to match house style; the diff against upstream is the thing of value.

`src/plot/plot.ts` is ours — the `Path[]` → nib `Stroke[]` adapter. Two conversions matter:

- A `closed` path gets its first point repeated. nib strokes are open polylines with no `closed` concept, so without this the final edge never gets drawn.
- Coordinates are scaled to **absolute mm** via `docUnitsToMM()`, the inverse of `mmToDocUnits()` in `main.ts`. This is where "user units are not pixels" gets cashed out — a `pt` document plotted as-is comes out 2.8× too small.

Nesting depth becomes `Stroke.layer`, matching the nib/axicli multi-pen convention — the same depth map that drives preview colors and Inkscape layer groups.

nib's reordering is disabled (`optimize: 0`); the pipeline's 2-opt already minimized pen-up travel and nearest-neighbour would undo it.

`Envelope` is machine travel **from wherever the arm is parked**, not an absolute page cage — the origin is set by the user positioning the carriage and re-enabling motors.

`placeForMachine()` is the only correct way to get plottable strokes: **convert to mm, then lay the page landscape**. That is the whole placement model — there is no home-corner setting and no orientation toggle, by design.

**Plots always run landscape.** An AxiDraw's X travel is the gantry and is the longer axis (the A4 model is 280×218, sized for US Letter *landscape*), so `orientLandscape()` turns any portrait page 90° **anticlockwise**, unconditionally — not "when it doesn't fit". One rule means the paper goes on the bed the same way every time.

Anticlockwise specifically: that maps the page's original **top-right** corner onto the machine origin, which is where the pen parks. The page corner always lands on the origin, so nothing needs configuring and the drawing can never run off the sheet sideways. Rotation is still surfaced in the UI — it changes how the paper must be loaded, so it must never be silent.

Bounds checking **blocks, it does not warn**. `envelopeViolation()` measures the actual stroke geometry (not the page — scale-to-fit centres content, so page size over-reports) and runs on dialog open, on every setting change, and again immediately before the first move. nib does check per-move, but by then the carriage is already at the boundary; and if the selected machine is larger than the real one, that check passes while the hardware runs into its end stops. For the same reason the machine dropdown has **no default** — a permissive envelope is worse than none, because it reads as validation.

`PlotSession` owns **one** `EBBBackend` for the whole connection. This is load-bearing: the backend tracks arm position purely in software, there is no query that recovers it, and the firmware's `HM` homes to *mechanical* home rather than the user's origin. A backend per plot would reset tracking to (0,0) and make "return to home" a silent no-op. For the same reason `plot()` ends with `liftPen()` rather than `shutdown()` — the latter de-energises the motors, after which the arm can drift and the origin is gone. Motors are released only by `releaseMotors()` or `close()`, and closing the dialog leaves both the session and the motors alive.

Homing behaviour differs by exit path: a completed plot homes itself, an envelope violation homes, but a user Stop does **not** — nib's `safeAbort` passes `returnHome: false` there so a CLI could offer resume.

Only one home is exposed: **Home machine** (`homeMachine()`, firmware `HM`), which is *absolute* and ignores software tracking, making it the recovery path after a Stop. It homes to the machine's own corner and redefines the origin there, so the paper origin is lost and has to be re-parked.

nib's relative `home()` is deliberately **not** wrapped. An abort leaves `currentX/currentY` holding the end of the last *completed* stroke while the arm sits mid-stroke, so a relative return travels a wrong delta and lands somewhere arbitrary — the failure that drove the carriage into the end stops. Don't reintroduce it.

Speeds in `Profile` are percentages of nib's LM caps (50mm/s pen-down, 100mm/s pen-up), **not** absolute rates, and are not comparable to axicli's percentages. `speedToMms()` exists so the UI can show the real figure. `penDelayUp`/`penDelayDown` are extra settle time in ms *on top of* the servo's computed SP duration, not a replacement for it. Both are honoured as **hard waits before the next movement** — upstream absorbed the pen-up delay into travel time, which let the nib drag as it left the paper (vendor divergence #10).

Plot settings persist to `localStorage` under `watertight_plot_settings` — deliberately not the `sessionStorage` page setup uses, since machine model and pen calibration describe a physical rig that outlives a tab. A saved machine is only restored if the key still exists in `MACHINE_ENVELOPES`, so a renamed option falls back to "choose one" rather than silently selecting the wrong envelope.

### Preview & Plot dialog

**There is one dialog, `#plotModal`,** opened by `#simulateBtn` ("Preview & Plot"). The separate `#simulationModal` and `#plotBtn` are gone: settings that decide paper placement have to be visible next to their effect, or you cannot see where the plot lands. `.plot-layout` is a grid — preview left, settings sidebar right, status/actions spanning the bottom. `#plotConnectSection` and `#plotActions` are hidden when `isPlottingSupported()` is false, so the dialog still works as a pure preview in Safari and Firefox.

`openPlotDialog()` opens at **progress 1** — the finished plot, i.e. a print preview — with no autoplay. `refreshPreview()` rebuilds from `buildSimulatorView()` and runs on every settings change, preserving playback position unless given one.

`buildSimulatorView()` renders in **machine space** — exactly the strokes sent to the board. **The machine is the fixed frame**: bed and sheet both anchored at (0,0), gantry along the top of the view, +X right, +Y down, home always the top-left corner. The paper and drawing move within that frame — turning 90° when the page is reoriented, and mirroring when the pen parks on the right-hand corner, since machine X then runs away from it. That mirroring is not a bug to hide; it is where the pen actually travels, which is what the preview is for.

The renderer draws, by `a_type`: machine bed fill (4), paper sheet fill (5), machine outline (3), paper outline (2), origin bracket (6). **The fills are load-bearing, not decoration**: Letter on an A4 machine differs by ~1mm, which is 1–4px on screen, so outlines alone are indistinguishable. `setData`'s machine param carries `x`/`y`/`origin` and `fitView` frames a min corner, so an off-origin bed remains renderable. Dimension labels are DOM (`#plotLegend`), not WebGL — text would need a font atlas for no benefit.

### Follow-along

`openFollowAlong()` gives the machine the timeline: `play()` is never called. Each leg is anchored by a real event, then animated at the profile's actual mm/s, so the pen moves continuously and any drift is corrected at the next boundary.

- `pen:down(i)` → `syncTo(start of i)`, `followTo(end of i, penDownMms)`
- `pen:up(i)` → `syncTo(end of i)`, `followTo(start of i+1, penUpMms)`

Three things make this work and are easy to break:

- **Stroke ordinal is the only usable sync signal.** nib's `progress` fraction is measured over the move list *after* `simplifyMoves` has rewritten it, and the caller never sees that list. Stroke count survives simplification; move index does not.
- **Draw order must match.** `prepareOutput()` commits to layer order via `getPathsOrderedByLayer` so both consumers agree — the simulator reorders internally when given layers, the plotter never does. A consumer that reorders would sync to the wrong stroke.
- **`setSpeed(m)` is `100 * m`**, a UI multiplier. Follow-along must use `setSpeedMms()`.

`buildDistanceTable()` (exported, pure, tested in `src/tests/simulator.test.ts`) is the single source for the distance axis — `setData` derives its per-vertex distances from it rather than walking separately, and `pathRange()` indexes it. The simulated pen leads the real one by the pen-down delay, since `pen:down` fires before the servo settles; it resyncs at every boundary.

This subtree is main-thread only (WebSerial is on `navigator`) — never import it from `src/worker.ts` or `src/optimize/`. It has no import-time DOM access, so `plot.ts` is testable under Node (`src/tests/plot.test.ts`).

### UI

`index.html` holds all the markup with hardcoded `id`s; `src/main.ts` (~1000 lines) binds them via `getElementById` at module scope. Adding a control means editing both files. Notable pieces:

- Presets (Cutter/Plotter/Custom) are radio buttons; `applyPreset` sets checkboxes and `checkPresets` reverse-matches current checkbox state back to a preset after any manual change.
- Page-setup values persist to `sessionStorage` under `watertight_settings`. Units (mm/in) are a UI-level concern — everything internal is mm, converted via `toMM()`.
- `src/ui/simulator.ts` is a raw WebGL2 renderer for plot playback; `src/ui/panzoom.ts` is a shared controller attached to both preview SVGs so they pan/zoom together, and it must be re-attached whenever previews re-render.
- `#simulateBtn` ("Preview & Plot") is the single entry to `#plotModal`; it is always visible and its enable/disable follows `#exportBtn`. Only the hardware controls inside are gated on `navigator.serial`.

## Samples

`samples/*.svg` are graded difficulty fixtures (easy → medium → hard → hardest → hurt-me) used both for manual testing and as test inputs. `region-finding.test.ts` asserts region counts against a known-good baseline for each (see `EXPECTED_REGIONS`) and prints a coverage/timing table.
