# Vendored: nib (AxiDraw/EBB control)

Source: https://github.com/jheuer/nib @ `507939ff692787a51a379eb63622460f91686536`
License: MIT © 2026 Jeff Heuer (see `LICENSE`)

## Why vendored rather than depended on

nib declares `prepublishOnly`, not `prepare`, and commits no `dist/`. npm runs
`prepare` for git dependencies, so `npm i github:jheuer/nib` installs a package
with no build output; making it work would require Bun in the install path and
in CI. The npm name `nib` belongs to an unrelated Stylus package, so there is no
registry version to install either.

Copying the browser-reachable subset avoids all of that and keeps the parts that
are expensive to re-derive — the EBB protocol encoding and the motion planner —
byte-identical to upstream.

## What was taken

~2,900 lines of nib's 12,600. Kept: `ebb.ts` (session/stroke execution),
`ebb-protocol.ts` (command encoding), `planner.ts` (trapezoid + junction
velocity), `web-serial.ts`, `transport.ts`, `interface.ts`, `types.ts`,
`stroke.ts`, `reorder.ts`, `job.ts`, `envelope.ts`.

Dropped: the CLI, TUI, TOML config, Node `serialport` transport, Hershey text,
SVG parsing (`svgson`/`svg-pathdata`), and preview rendering.

## Deliberate divergences from upstream

Keep this list current — it is the diff to reapply when re-syncing.

1. **Flat directory.** Upstream splits `src/core/` and `src/backends/`; imports
   were rewritten from `../core/x.ts` / `../backends/x.ts` to `./x.ts`.

2. **`events.ts` rewritten.** Upstream extends Node's `EventEmitter` via a bare
   `import { EventEmitter } from 'events'` — the one Node dependency reachable
   from nib's browser entry point. Reimplemented with the same typed surface and
   no imports. The job/layer events were dropped with the job runner.

3. **`moves.ts` added.** Holds the `PlannerMove` interface, extracted from
   `backends/svg-to-moves.ts` so we don't pull in the SVG parser for one type.

4. **`geom.ts` reduced.** Only `simplifyPolyline` + `maxPerpendicular`, which
   `stroke.ts::simplifyMoves` needs. Upstream's other 380 lines are geometry
   primitives we don't use.

5. **`ebb.ts`: `runJob` / `runJobEbb` / `EbbPlotOptions` removed.** Those are the
   SVG-string and Node-auto-detect entry points. We enter at `runStrokes`.

6. **`ebb.ts`: `waitForMotorsIdle` removed.** Dead code upstream too — it only
   went unnoticed because nib's tsconfig omits `noUnusedLocals`.

7. **`ebb.ts`: `stderrWrite` routes to `console.debug`** instead of
   `process.stderr`.

8. **`ebb.ts`: `home()` uses LM when available.** Upstream always used SM,
   commented as "a fail-safe return that doesn't need the extra speed". SM has
   no acceleration ramp so it is capped at `SPEED_PENUP_MAX_MMS` (13mm/s) —
   crossing an A3 sheet took ~30s, which reads as a hang in a GUI. It now plans
   a trapezoid at pen-up speed (up to 100mm/s) when the firmware supports LM and
   a profile is known, falling back to SM otherwise. Requires the new
   `activeProfile` field, set wherever a profile enters the backend
   (`runMoves`, `configureSession`).

9. **`ebb.ts`: added a public `commands` getter** exposing the `EbbCommands`
   instance, so the UI can read the raw `V` response. Needed because
   `connect()` swallows a failed version query and `firmwareVersion()` returns
   `[0,0,0]` on an unparseable reply — without the raw string, "no LM" is
   ambiguous between old firmware, a malformed answer, and a silent board.
   Upstream had no need: its CLI printed the version at connect time.

10. **`ebb.ts`: `runMoves` waits the full settle window after a pen lift.**
    Upstream sent SP, then slept only the part of `servoRaise + penDelayUp` not
    covered by the upcoming travel, on the reasoning that a long travel leaves
    the pen up "before the arm arrives". But the arm starts moving immediately,
    so the nib is still touching for the first part of the move and drags a line
    out of the stroke — precisely what `penDelayUp` exists to prevent. nib's own
    `plotLiveStroke` already waits properly; only the batch path took the
    shortcut. Removed `ACCEL_MAX_MMS2` from the imports with the dead
    `travelLowerBoundMs` maths.

Nothing in the protocol encoding or the planner was modified.

## Known upstream behaviour worth remembering

Not bugs to fix here, but things the UI has to work around:

- **Software position is stale after an abort.** `runStroke` writes
  `currentX/currentY` only after a stroke completes and returns early on abort,
  while `safeAbort` issues an emergency stop that halts the arm mid-motion. So
  after a stopped plot the tracked position is the end of the last *completed*
  stroke and the arm is elsewhere. Any relative move from there — including
  `home()` — goes to the wrong place. This is why `PlotSession` exposes only
  `homeMachine()` (HM), which is absolute; there is deliberately no wrapper for
  the relative `home()`.

- **`progress` fires per stroke, valued over the *simplified* move list.**
  `simplifyMoves` rewrites the move array inside `runMoves` before any event
  fires, so `fraction × moves.length` cannot be mapped back to caller geometry.
  Stroke ordinal (via `pen:down`) survives simplification; move index does not.

- **`progress`'s ETA argument is hardcoded `0`.** There is no time estimate.
