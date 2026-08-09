/**
 * WebGL Simulator
 * Renders SVG paths progressively to simulate a plotter/laser cutter.
 */
import type { Path, Point } from '../geometry/types';
import { getPathsOrderedByLayer } from '../optimize/nesting';

/** Cumulative pen travel at the start and end of each drawn path. */
export interface DistanceTable {
    /** Distance when the pen lands on path i — i.e. after travelling to it. */
    startDist: number[];
    /** Distance when the pen lifts off path i. */
    endDist: number[];
    totalDistance: number;
}

/**
 * Walk a path list the way the plotter does — travel to each path, draw it,
 * lift — accumulating distance.
 *
 * This is the single source of truth for the simulator's `progress` axis, which
 * is measured in distance rather than time. Kept pure and exported so the
 * contract can be tested without a WebGL context, and so `setData` derives its
 * per-vertex distances from the same numbers rather than a parallel walk that
 * could drift.
 *
 * Paths with fewer than two points are skipped, matching what actually gets
 * drawn; the returned arrays are indexed by *drawn* path order.
 */
export function buildDistanceTable(paths: Path[]): DistanceTable {
    const startDist: number[] = [];
    const endDist: number[] = [];
    let cumDist = 0;
    let lastPoint: Point | null = null;

    for (const path of paths) {
        if (path.points.length < 2) continue;

        const first = path.points[0];
        const last = path.points[path.points.length - 1];

        // Pen-up travel from wherever the previous path ended.
        if (lastPoint) {
            cumDist += Math.hypot(first.x - lastPoint.x, first.y - lastPoint.y);
        }
        startDist.push(cumDist);

        for (let i = 0; i < path.points.length - 1; i++) {
            const p1 = path.points[i];
            const p2 = path.points[i + 1];
            cumDist += Math.hypot(p2.x - p1.x, p2.y - p1.y);
        }
        if (path.closed) {
            cumDist += Math.hypot(first.x - last.x, first.y - last.y);
            lastPoint = first;
        } else {
            lastPoint = last;
        }

        endDist.push(cumDist);
    }

    return { startDist, endDist, totalDistance: cumDist };
}

export class Simulator {
    private canvas: HTMLCanvasElement;
    private gl: WebGL2RenderingContext;
    private program: WebGLProgram;

    // Buffers and Data
    private vertexBuffer: WebGLBuffer;
    private totalDistance: number = 0;
    private vertexCount: number = 0;

    // Animation State
    private isPlaying: boolean = false;
    private speed: number = 10; // mm/s (or units/s)
    private progress: number = 0; // 0 to 1
    private animationFrameId: number | null = null;

    // Event Callbacks
    public onProgress: (percent: number, timeStr: string) => void = () => { };
    public onComplete: () => void = () => { };

    // Filled machine bed / paper sheet, drawn under everything else.
    private fillBuffer: WebGLBuffer;
    private fillCount: number = 0;

    // Blots Data
    private blotBuffer: WebGLBuffer;
    private blotCount: number = 0;
    private showBlots: boolean = false;
    private showTravel: boolean = true;

    // Layer Data
    private useLayerColors: boolean = false;

    /**
     * Region to frame, stored for resize. Carries a min corner because the
     * machine bed can extend past the sheet's origin — with the pen parked over
     * the paper's top-right, the bed reaches left of x = 0.
     */
    private currentBounds = { minX: 0, minY: 0, width: 1, height: 1 };

    /**
     * Cumulative distance at the start/end of each drawn path, in draw order.
     *
     * Lets a caller sync playback to an external event stream (the plotter's
     * per-stroke `pen:down` / `pen:up`) without reimplementing the distance
     * model — which is the only thing `progress` is measured in.
     */
    private pathStartDist: number[] = [];
    private pathEndDist: number[] = [];

    /**
     * Progress to stop at, for externally-driven playback. When set, `animate`
     * halts here instead of running to 1 and does not fire `onComplete` — the
     * plot is not finished, this stroke is.
     */
    private followTarget: number | null = null;

    // Background Data (removed - keeping buffer for compatibility if needed, but not using it)
    // private penWeight: number = 0.3;
    // private pixelScale: number = 1;

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        const gl = canvas.getContext('webgl2', { alpha: false, antialias: true });
        if (!gl) throw new Error('WebGL2 not supported');
        this.gl = gl;

        // Initialize Shaders
        this.program = this.createProgram(this.vertexShaderSource, this.fragmentShaderSource);
        this.vertexBuffer = gl.createBuffer()!;
        this.blotBuffer = gl.createBuffer()!;
        this.fillBuffer = gl.createBuffer()!;

        // Setup GL state
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0.063, 0.063, 0.102, 1.0); // --bg-canvas (#10101a)
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }

    private vertexShaderSource = `#version 300 es
    in vec2 a_position;
    in float a_cumDist;
    in float a_type; // 0 = travel, 1 = draw, 2 = paper outline, 3 = machine footprint
    in float a_layerDepth; // Layer depth for coloring

    uniform vec2 u_resolution;
    uniform vec2 u_scale;
    uniform vec2 u_offset;
    uniform bool u_isPoints;
    uniform float u_pointSize;
    uniform bool u_useLayerColors;

    out float v_cumDist;
    out float v_type;
    out float v_layerDepth;

    void main() {
        // Convert to clip space
        vec2 position = (a_position * u_scale + u_offset);
        vec2 clipSpace = (position / u_resolution) * 2.0 - 1.0;
        gl_Position = vec4(clipSpace * vec2(1, -1), 0, 1);
        
        if (u_isPoints) {
            gl_PointSize = u_pointSize;
        }

        // Pass to fragment for smooth interpolation
        v_cumDist = a_cumDist;
        v_type = a_type;
        v_layerDepth = a_layerDepth;
    }`;

    private fragmentShaderSource = `#version 300 es
    precision mediump float;
    
    in float v_cumDist;
    in float v_type;
    in float v_layerDepth;
    
    uniform float u_maxDist;
    uniform bool u_isPoints;
    uniform bool u_showTravel;
    uniform bool u_useLayerColors;

    out vec4 outColor;

    void main() {
        // Smoothly discard pixels past the current distance
        if (v_cumDist > u_maxDist) discard;

        if (u_isPoints) {
            // Circle shape for points
            vec2 cxy = 2.0 * gl_PointCoord - 1.0;
            float r = dot(cxy, cxy);
            if (r > 1.0) discard;
            
            // Blot color (Slightly lighter blue)
            outColor = vec4(0.6, 0.8, 1.0, 0.9);
            return;
        }

        // 6 = origin marker: where the pen homes. Accent so it reads instantly.
        if (v_type > 5.5) {
             outColor = vec4(0.51, 0.55, 0.97, 1.0);
             return;
        }

        // 5 = paper fill. Deliberately lighter than the machine bed so the
        // sheet reads as a distinct surface even when the two rectangles are
        // nearly the same size (Letter on an A4 machine differs by ~1mm).
        if (v_type > 4.5) {
             outColor = vec4(0.16, 0.16, 0.21, 1.0);
             return;
        }

        // 4 = machine bed fill
        if (v_type > 3.5) {
             outColor = vec4(0.09, 0.09, 0.13, 1.0);
             return;
        }

        if (v_type > 2.5) {
             // Machine footprint outline
             outColor = vec4(0.38, 0.38, 0.48, 1.0);
             return;
        }

        if (v_type > 1.5) {
             // Paper outline - brighter than the bed so the sheet edge is clear
             outColor = vec4(0.62, 0.62, 0.68, 1.0);
             return;
        }

        if (v_type > 0.5) {
            // Draw (Pen Down)
            if (u_useLayerColors) {
                // Use layer-based coloring with pastel palette
                float layerIndex = mod(v_layerDepth, 5.0);
                if (layerIndex < 1.0) {
                    outColor = vec4(1.0, 0.6, 0.67, 1.0); // #FF99AA
                } else if (layerIndex < 2.0) {
                    outColor = vec4(0.53, 1.0, 0.53, 1.0); // #88FF88
                } else if (layerIndex < 3.0) {
                    outColor = vec4(0.53, 0.67, 1.0, 1.0); // #88AAFF
                } else if (layerIndex < 4.0) {
                    outColor = vec4(1.0, 1.0, 0.4, 1.0); // #FFFF66
                } else {
                    outColor = vec4(1.0, 0.53, 1.0, 1.0); // #FF88FF
                }
            } else {
                // Default blue for visibility on dark background
                outColor = vec4(0.3, 0.6, 1.0, 1.0); 
            }
        } else {
            // Travel (Pen Up)
            if (!u_showTravel) discard;
            // Travel - Red
            outColor = vec4(1.0, 0.2, 0.4, 0.3);
        }
    }`;

    // ... createProgram and compileShader methods stay the same ...
    private createProgram(vsSource: string, fsSource: string): WebGLProgram {
        const gl = this.gl;
        const vs = this.compileShader(gl.VERTEX_SHADER, vsSource);
        const fs = this.compileShader(gl.FRAGMENT_SHADER, fsSource);
        const program = gl.createProgram()!;
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            throw new Error(gl.getProgramInfoLog(program)!);
        }
        return program;
    }

    private compileShader(type: number, source: string): WebGLShader {
        const gl = this.gl;
        const shader = gl.createShader(type)!;
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            throw new Error(gl.getShaderInfoLog(shader)!);
        }
        return shader;
    }

    /**
     * @param machine Machine bed drawn behind the paper, in the same units and
     *   the same space as `paths` — which is **paper space**, not machine
     *   space. The distinction matters: with the pen parked over the paper's
     *   top-right, machine X runs away from that corner, so rendering machine
     *   coordinates would show the sheet mirrored. `x`/`y` place the bed
     *   relative to the sheet, and `origin` marks the corner the pen homes to.
     */
    public setData(
        paths: Path[],
        bounds: { width: number, height: number },
        _penWeight: number = 0.3,
        showOutline: boolean = false,
        layers?: Map<number, Path[]>,
        machine?: { x: number, y: number, width: number, height: number, origin: Point },
    ) {
        // penWeight is unused in simulator (WebGL line width limit), but kept for API compatibility if needed
        // or we can just ignore it.
        // this.penWeight = penWeight; // Removed usage

        // 0. Outline Data — 4 lines * 2 points per rectangle, plus a 2-line
        // origin bracket when there is a machine to anchor it to.
        const outlinePoints = (showOutline ? 8 : 0) + (machine ? 8 + 4 : 0);

        // Setup layer coloring and order paths by layer when layers are provided
        this.useLayerColors = !!layers;
        const pathsToProcess = this.useLayerColors ? getPathsOrderedByLayer(paths) : paths;
        
        const pathToLayer = new Map<Path, number>();
        if (layers) {
            for (const [depth, pathsInLayer] of layers) {
                for (const path of pathsInLayer) {
                    pathToLayer.set(path, depth);
                }
            }
        }

        // 1. Line Data
        let totalPoints = 0;
        // Calculate size first
        for (const path of pathsToProcess) {
            if (path.points.length < 2) continue;
            totalPoints += (path.points.length - 1) * 2;
            if (path.closed) totalPoints += 2; // Closing segment
        }
        totalPoints += Math.max(0, (paths.length - 1) * 2); // Travel moves

        const lineData = new Float32Array((totalPoints + outlinePoints) * 5); // x, y, cumDist, type, layerDepth

        // 2. Blot Data (Start and End of every path)
        const blotData = new Float32Array(pathsToProcess.length * 2 * 5); // x, y, cumDist, type, layerDepth

        let lineOffset = 0;

        const writeSeg = (ax: number, ay: number, bx: number, by: number, type: number) => {
            lineData[lineOffset++] = ax; lineData[lineOffset++] = ay;
            lineData[lineOffset++] = 0; lineData[lineOffset++] = type; lineData[lineOffset++] = 0;
            lineData[lineOffset++] = bx; lineData[lineOffset++] = by;
            lineData[lineOffset++] = 0; lineData[lineOffset++] = type; lineData[lineOffset++] = 0;
        };

        // Rectangle writer — cumDist 0 so outlines are never progressively
        // revealed; they are context, not part of the plot.
        const writeRect = (x: number, y: number, w: number, h: number, type: number) => {
            const corners: [number, number][] = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
            for (let i = 0; i < 4; i++) {
                const [ax, ay] = corners[i];
                const [bx, by] = corners[(i + 1) % 4];
                writeSeg(ax, ay, bx, by, type);
            }
        };

        // Machine first so the paper draws over it.
        if (machine) writeRect(machine.x, machine.y, machine.width, machine.height, 3);

        // write outline first
        if (showOutline) {
            writeRect(0, 0, bounds.width, bounds.height, 2);
        }

        // Bracket at the corner the pen homes to, with arms pointing into the
        // sheet. Sized as a fraction of the bed so it stays legible at any
        // machine size.
        if (machine) {
            const arm = Math.max(machine.width, machine.height) * 0.05;
            const { x: ox, y: oy } = machine.origin;
            // Point the arms inward, away from whichever corner this is.
            const sx = ox > machine.x + machine.width / 2 ? -1 : 1;
            const sy = oy > machine.y + machine.height / 2 ? -1 : 1;
            writeSeg(ox, oy, ox + arm * sx, oy, 6);
            writeSeg(ox, oy, ox, oy + arm * sy, 6);
        }

        // Filled bed + sheet, drawn beneath the lines. Two triangles each.
        const quad = (x: number, y: number, w: number, h: number, type: number): number[] => [
            x, y, 0, type, 0, x + w, y, 0, type, 0, x + w, y + h, 0, type, 0,
            x, y, 0, type, 0, x + w, y + h, 0, type, 0, x, y + h, 0, type, 0,
        ];
        const fills: number[] = [];
        if (machine) fills.push(...quad(machine.x, machine.y, machine.width, machine.height, 4));
        if (machine || showOutline) fills.push(...quad(0, 0, bounds.width, bounds.height, 5));
        const fillData = new Float32Array(fills);
        this.fillCount = fills.length / 5;

        let blotOffset = 0;
        let cumDist = 0;
        let lastPoint: Point | null = null;

        // Distances come from the shared walk so playback position and vertex
        // data can never disagree.
        const table = buildDistanceTable(pathsToProcess);
        this.pathStartDist = table.startDist;
        this.pathEndDist = table.endDist;
        let k = -1;

        for (const path of pathsToProcess) {
            if (path.points.length < 2) continue;
            k++;

            const pathStart = path.points[0];
            const pathEnd = path.points[path.points.length - 1];
            const layerDepth = pathToLayer.get(path) || 0;

            // Travel from last point
            if (lastPoint) {
                // Start of travel
                lineData[lineOffset++] = lastPoint.x;
                lineData[lineOffset++] = lastPoint.y;
                lineData[lineOffset++] = cumDist;
                lineData[lineOffset++] = 0;
                lineData[lineOffset++] = layerDepth;

                cumDist = table.startDist[k];

                // End of travel
                lineData[lineOffset++] = pathStart.x;
                lineData[lineOffset++] = pathStart.y;
                lineData[lineOffset++] = cumDist;
                lineData[lineOffset++] = 0;
                lineData[lineOffset++] = layerDepth;
            }

            // Record Pen Down Blot
            blotData[blotOffset++] = pathStart.x;
            blotData[blotOffset++] = pathStart.y;
            blotData[blotOffset++] = cumDist; // Appears right when pen lands
            blotData[blotOffset++] = 1; // Type doesn't really matter for blots, but 1 matches "draw"
            blotData[blotOffset++] = layerDepth;

            // Draw segments
            for (let i = 0; i < path.points.length - 1; i++) {
                const p1 = path.points[i];
                const p2 = path.points[i + 1];
                const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);

                // Start vertex
                lineData[lineOffset++] = p1.x;
                lineData[lineOffset++] = p1.y;
                lineData[lineOffset++] = cumDist;
                lineData[lineOffset++] = 1;
                lineData[lineOffset++] = layerDepth;

                cumDist += dist;

                // End vertex
                lineData[lineOffset++] = p2.x;
                lineData[lineOffset++] = p2.y;
                lineData[lineOffset++] = cumDist;
                lineData[lineOffset++] = 1;
                lineData[lineOffset++] = layerDepth;
            }

            // Draw Closing Segment if closed
            if (path.closed) {
                const p1 = pathEnd;
                const p2 = pathStart;
                const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);

                // Start vertex
                lineData[lineOffset++] = p1.x;
                lineData[lineOffset++] = p1.y;
                lineData[lineOffset++] = cumDist;
                lineData[lineOffset++] = 1;
                lineData[lineOffset++] = layerDepth;

                cumDist += dist;

                // End vertex
                lineData[lineOffset++] = p2.x;
                lineData[lineOffset++] = p2.y;
                lineData[lineOffset++] = cumDist;
                lineData[lineOffset++] = 1;
                lineData[lineOffset++] = layerDepth;

                lastPoint = pathStart;
            } else {
                lastPoint = pathEnd;
            }

            // Snap to the table's figure so per-segment float drift cannot
            // accumulate across thousands of paths.
            cumDist = table.endDist[k];

            // Record Pen Up Blot (at actual end position)
            blotData[blotOffset++] = lastPoint.x;
            blotData[blotOffset++] = lastPoint.y;
            blotData[blotOffset++] = cumDist; // Appears right when pen lifts
            blotData[blotOffset++] = 1;
            blotData[blotOffset++] = layerDepth;
        }

        this.totalDistance = table.totalDistance;
        this.vertexCount = lineOffset / 5;
        this.blotCount = blotOffset / 5;

        // Upload Lines
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, lineData, gl.STATIC_DRAW);

        // Upload Blots
        gl.bindBuffer(gl.ARRAY_BUFFER, this.blotBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, blotData, gl.STATIC_DRAW);

        // Upload bed/sheet fills
        gl.bindBuffer(gl.ARRAY_BUFFER, this.fillBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, fillData, gl.STATIC_DRAW);

        // Frame the union of sheet and bed so neither is cropped.
        if (machine) {
            const minX = Math.min(0, machine.x);
            const minY = Math.min(0, machine.y);
            const maxX = Math.max(bounds.width, machine.x + machine.width);
            const maxY = Math.max(bounds.height, machine.y + machine.height);
            this.currentBounds = { minX, minY, width: maxX - minX, height: maxY - minY };
        } else {
            this.currentBounds = { minX: 0, minY: 0, width: bounds.width, height: bounds.height };
        }
        this.fitView(this.currentBounds);
        this.progress = 0;
        this.draw();
    }

    public setBlots(enabled: boolean) {
        this.showBlots = enabled;
        this.draw();
    }

    public setTravel(enabled: boolean) {
        this.showTravel = enabled;
        this.draw();
    }

    private fitView(bounds: { minX: number, minY: number, width: number, height: number }) {
        const gl = this.gl;
        gl.useProgram(this.program);

        this.canvas.width = this.canvas.clientWidth;
        this.canvas.height = this.canvas.clientHeight;
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);

        const uRes = gl.getUniformLocation(this.program, 'u_resolution');
        gl.uniform2f(uRes, this.canvas.width, this.canvas.height);

        // Generous padding: the machine bed runs right to the edge of the
        // bounds, and flush against the canvas it reads as a crop rather than a
        // footprint.
        const padding = 44;
        const scaleX = (this.canvas.width - padding * 2) / bounds.width;
        const scaleY = (this.canvas.height - padding * 2) / bounds.height;
        const scale = Math.min(scaleX, scaleY);
        // this.pixelScale = scale; // Store for line width calc

        // The shader does `pos * scale + offset`, so the min corner is folded
        // into the offset rather than subtracted per vertex.
        const offsetX = (this.canvas.width - bounds.width * scale) / 2 - bounds.minX * scale;
        const offsetY = (this.canvas.height - bounds.height * scale) / 2 - bounds.minY * scale;

        const uScale = gl.getUniformLocation(this.program, 'u_scale');
        const uOffset = gl.getUniformLocation(this.program, 'u_offset');

        gl.uniform2f(uScale, scale, scale);
        gl.uniform2f(uOffset, offsetX, offsetY);
    }

    public resize() {
        if (!this.gl) return;
        const gl = this.gl;
        const width = this.canvas.clientWidth;
        const height = this.canvas.clientHeight;

        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width;
            this.canvas.height = height;
            gl.viewport(0, 0, width, height);
            // Recalculate scale/offset with stored bounds for proper fit
            this.fitView(this.currentBounds);
            this.draw();
        }
    }

    public play() {
        if (this.isPlaying) return;
        // Manual playback runs to the end; drop any follow leg still pending.
        this.followTarget = null;
        this.isPlaying = true;
        this.lastFrameTime = performance.now();
        this.animate();
    }

    public pause() {
        this.isPlaying = false;
        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
    }

    /**
     * Playback speed as a UI multiplier — 1x is 100 units/s, not 1mm/s.
     * Use `setSpeedMms` when you mean a real machine speed.
     */
    public setSpeed(multiplier: number) {
        const baseSpeed = 100;
        this.speed = baseSpeed * multiplier;
    }

    /** Playback speed in real mm/s, for tracking an actual plot. */
    public setSpeedMms(mms: number) {
        this.speed = Math.max(0.1, mms);
    }

    /**
     * Where the Nth drawn path starts and ends, as progress fractions.
     *
     * Stroke ordinal is the only signal that survives nib's move
     * simplification: its `progress` fraction is measured over a rewritten move
     * list the caller never sees, while stroke count is preserved. Returns null
     * for an out-of-range index so a desync degrades to "stop animating"
     * rather than throwing mid-plot.
     */
    public pathRange(index: number): { start: number; end: number } | null {
        if (index < 0 || index >= this.pathEndDist.length) return null;
        if (this.totalDistance <= 0) return null;
        return {
            start: this.pathStartDist[index] / this.totalDistance,
            end: this.pathEndDist[index] / this.totalDistance,
        };
    }

    /** Number of drawn paths, for callers syncing against an external stream. */
    public get pathCount(): number {
        return this.pathEndDist.length;
    }

    /**
     * Animate forward to `target` at a real machine speed, then stop there.
     *
     * Unlike `play()`, this halts at the target without firing `onComplete` —
     * it is one leg of an externally-driven playback, not the end of the plot.
     */
    public followTo(target: number, mmPerSec: number) {
        this.setSpeedMms(mmPerSec);
        this.followTarget = Math.max(0, Math.min(1, target));
        if (this.progress >= this.followTarget) {
            // Already there (or past it after a resync) — nothing to animate.
            this.pause();
            return;
        }
        this.isPlaying = true;
        this.lastFrameTime = performance.now();
        this.animate();
    }

    /**
     * Hard-set playback position without animating, cancelling any follow leg.
     * Used to resync to the machine at each stroke boundary.
     */
    public syncTo(percent: number) {
        this.followTarget = null;
        this.pause();
        this.setProgress(percent);
    }

    public setProgress(percent: number) {
        this.progress = Math.max(0, Math.min(1, percent));
        this.draw();
        this.updateTimeDisplay();
    }

    private lastFrameTime = 0;

    private animate = () => {
        if (!this.isPlaying) return;

        const now = performance.now();
        const dt = (now - this.lastFrameTime) / 1000;
        this.lastFrameTime = now;

        const distTraveled = this.speed * dt;
        const percentDelta = distTraveled / this.totalDistance;

        this.progress += percentDelta;

        // A follow leg ends at its target, not at the end of the plot, so it
        // stops without announcing completion.
        if (this.followTarget !== null && this.progress >= this.followTarget) {
            this.progress = this.followTarget;
            this.pause();
            this.draw();
            this.updateTimeDisplay();
            this.onProgress(this.progress, this.formatTime(this.progress));
            return;
        }

        if (this.progress >= 1) {
            this.progress = 1;
            this.pause();
            this.onComplete();
        }

        this.draw();
        this.updateTimeDisplay();
        this.onProgress(this.progress, this.formatTime(this.progress));
        this.animationFrameId = requestAnimationFrame(this.animate);
    }

    private draw() {
        const gl = this.gl;
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.useProgram(this.program);

        const currentMaxDist = this.totalDistance * this.progress;
        const uMaxDist = gl.getUniformLocation(this.program, 'u_maxDist');
        const uIsPoints = gl.getUniformLocation(this.program, 'u_isPoints');
        const uPointSize = gl.getUniformLocation(this.program, 'u_pointSize');
        const uShowTravel = gl.getUniformLocation(this.program, 'u_showTravel');

        gl.uniform1f(uMaxDist, currentMaxDist);
        gl.uniform1i(uShowTravel, this.showTravel ? 1 : 0);
        gl.uniform1i(gl.getUniformLocation(this.program, 'u_useLayerColors'), this.useLayerColors ? 1 : 0);

        const stride = 5 * 4; // 5 floats per vertex: x, y, cumDist, type, layerDepth
        const posLoc = gl.getAttribLocation(this.program, 'a_position');
        const distLoc = gl.getAttribLocation(this.program, 'a_cumDist');
        const typeLoc = gl.getAttribLocation(this.program, 'a_type');
        const layerLoc = gl.getAttribLocation(this.program, 'a_layerDepth');

        gl.enableVertexAttribArray(posLoc);
        gl.enableVertexAttribArray(distLoc);
        gl.enableVertexAttribArray(typeLoc);
        gl.enableVertexAttribArray(layerLoc);

        // Calculate Line Width based on Pen Weight
        // pixelScale = pixels / mm
        // penWeight = mm
        // WebGL Limit: Line width is restricted to 1px on most platforms (including Mac)
        // const lineWidth = Math.max(1, this.penWeight * this.pixelScale);
        gl.lineWidth(1.0);

        // 0. Draw the machine bed and paper sheet beneath everything. These are
        // context, not plot geometry, so they ignore progress entirely.
        gl.uniform1i(uIsPoints, 0);
        if (this.fillCount > 0) {
            gl.bindBuffer(gl.ARRAY_BUFFER, this.fillBuffer);
            gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, stride, 0);
            gl.vertexAttribPointer(distLoc, 1, gl.FLOAT, false, stride, 8);
            gl.vertexAttribPointer(typeLoc, 1, gl.FLOAT, false, stride, 12);
            gl.vertexAttribPointer(layerLoc, 1, gl.FLOAT, false, stride, 16);
            gl.drawArrays(gl.TRIANGLES, 0, this.fillCount);
        }

        // 1. Draw Lines
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, stride, 0);
        gl.vertexAttribPointer(distLoc, 1, gl.FLOAT, false, stride, 8);
        gl.vertexAttribPointer(typeLoc, 1, gl.FLOAT, false, stride, 12);
        gl.vertexAttribPointer(layerLoc, 1, gl.FLOAT, false, stride, 16);
        gl.drawArrays(gl.LINES, 0, this.vertexCount);

        // 2. Draw Blots (if enabled)
        if (this.showBlots) {
            gl.uniform1i(uIsPoints, 1); // True
            // Fixed blot size since we aren't simulating weight
            gl.uniform1f(uPointSize, 5.0);

            gl.bindBuffer(gl.ARRAY_BUFFER, this.blotBuffer);
            gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, stride, 0);
            gl.vertexAttribPointer(distLoc, 1, gl.FLOAT, false, stride, 8);
            gl.vertexAttribPointer(typeLoc, 1, gl.FLOAT, false, stride, 12);
            gl.vertexAttribPointer(layerLoc, 1, gl.FLOAT, false, stride, 16);
            gl.drawArrays(gl.POINTS, 0, this.blotCount);
        }
    }

    private updateTimeDisplay() {
        // handled via callback
    }

    private formatTime(progress: number): string {
        const totalSeconds = this.totalDistance > 0 ? this.totalDistance / this.speed : 0;
        const currentSeconds = totalSeconds * progress;
        return `${this.formatSeconds(currentSeconds)} / ${this.formatSeconds(totalSeconds)}`;
    }

    private formatSeconds(s: number): string {
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return `${m}:${sec.toString().padStart(2, '0')}`;
    }
}
