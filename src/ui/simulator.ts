/**
 * WebGL Simulator
 * Renders SVG paths progressively to simulate a plotter/laser cutter.
 */
import type { Path, Point } from '../geometry/types';

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

    // Blots Data
    private blotBuffer: WebGLBuffer;
    private blotCount: number = 0;
    private showBlots: boolean = false;
    private showTravel: boolean = true;

    // Store bounds for resize recalculation
    private currentBounds: { width: number, height: number } = { width: 1, height: 1 };

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

        // Setup GL state
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0.063, 0.063, 0.102, 1.0); // --bg-canvas (#10101a)
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }

    private vertexShaderSource = `#version 300 es
    in vec2 a_position;
    in float a_cumDist;
    in float a_type; // 0 = travel, 1 = draw, 2 = outline

    uniform vec2 u_resolution;
    uniform vec2 u_scale;
    uniform vec2 u_offset;
    uniform bool u_isPoints;
    uniform float u_pointSize;

    out float v_cumDist;
    out float v_type;

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
    }`;

    private fragmentShaderSource = `#version 300 es
    precision mediump float;

    in float v_cumDist;
    in float v_type;

    uniform float u_maxDist;
    uniform bool u_isPoints;
    uniform bool u_showTravel;

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

        if (v_type > 6.5) {
              // Outline - Dark Gray
              outColor = vec4(0.3, 0.3, 0.3, 1.0);
              return;
        }

        if (v_type > 0.5) {
            // Draw (Pen Down) - Layer-based coloring
            // Palette: depth 0 = 1 (red), depth 1 = 2 (green), etc., cycling
            int depthIndex = int(v_type - 1.0);
            vec3 palette[5] = vec3[5](
                vec3(1.0, 0.6, 0.6), // Red
                vec3(0.55, 1.0, 0.55), // Green
                vec3(0.55, 0.66, 1.0), // Blue
                vec3(1.0, 1.0, 0.4), // Yellow
                vec3(1.0, 0.55, 1.0)  // Magenta
            );
            vec3 color = palette[depthIndex % 5];
            outColor = vec4(color, 1.0);
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

    public setData(paths: Path[] | Map<number, Path[]>, bounds: { width: number, height: number }, _penWeight: number = 0.3, showOutline: boolean = false) {
        // penWeight is unused in simulator (WebGL line width limit), but kept for API compatibility if needed
        // or we can just ignore it.
        // this.penWeight = penWeight; // Removed usage

        // Normalize paths to array, and create depth mapping for coloring
        const pathArray = Array.isArray(paths) ? paths : Array.from(paths.values()).flat();
        const getPathDepth = (path: Path): number => {
            if (!Array.isArray(paths)) {
                for (const [depth, layerPaths] of paths) {
                    if (layerPaths.includes(path)) return depth;
                }
            }
            return 0; // fallback, or default depth
        };

        // 0. Outline Data
        let outlinePoints = 0;
        if (showOutline) {
            outlinePoints = 8; // 4 lines * 2 points
        }

        // 1. Line Data
        let totalPoints = 0;
        // Calculate size first
        for (const path of pathArray) {
            if (path.points.length < 2) continue;
            totalPoints += (path.points.length - 1) * 2;
            if (path.closed) totalPoints += 2; // Closing segment
        }
        totalPoints += Math.max(0, (pathArray.length - 1) * 2); // Travel moves

        const lineData = new Float32Array((totalPoints + outlinePoints) * 4);

        // 2. Blot Data (Start and End of every path)
        const blotData = new Float32Array(pathArray.length * 2 * 4);

        let lineOffset = 0;

        // write outline first
        if (showOutline) {
            const w = bounds.width;
            const h = bounds.height;
            // Top
            lineData[lineOffset++] = 0; lineData[lineOffset++] = 0; lineData[lineOffset++] = 0; lineData[lineOffset++] = 2;
            lineData[lineOffset++] = w; lineData[lineOffset++] = 0; lineData[lineOffset++] = 0; lineData[lineOffset++] = 2;
            // Right
            lineData[lineOffset++] = w; lineData[lineOffset++] = 0; lineData[lineOffset++] = 0; lineData[lineOffset++] = 2;
            lineData[lineOffset++] = w; lineData[lineOffset++] = h; lineData[lineOffset++] = 0; lineData[lineOffset++] = 2;
            // Bottom
            lineData[lineOffset++] = w; lineData[lineOffset++] = h; lineData[lineOffset++] = 0; lineData[lineOffset++] = 2;
            lineData[lineOffset++] = 0; lineData[lineOffset++] = h; lineData[lineOffset++] = 0; lineData[lineOffset++] = 2;
            // Left
            lineData[lineOffset++] = 0; lineData[lineOffset++] = h; lineData[lineOffset++] = 0; lineData[lineOffset++] = 2;
            lineData[lineOffset++] = 0; lineData[lineOffset++] = 0; lineData[lineOffset++] = 0; lineData[lineOffset++] = 2;
        }
        this.vertexCount = (totalPoints + outlinePoints); // Correct vertex count? check draw

        let blotOffset = 0;
        let cumDist = 0;
        let lastPoint: Point | null = null;

        for (const path of pathArray) {
            if (path.points.length < 2) continue;

            const pathStart = path.points[0];
            const pathEnd = path.points[path.points.length - 1];
            const pathDepth = getPathDepth(path);

            // Travel from last point
            if (lastPoint) {
                const dist = Math.hypot(pathStart.x - lastPoint.x, pathStart.y - lastPoint.y);

                // Start of travel (travel segment uses type 0)
                lineData[lineOffset++] = lastPoint.x;
                lineData[lineOffset++] = lastPoint.y;
                lineData[lineOffset++] = cumDist;
                lineData[lineOffset++] = 0;

                cumDist += dist;

                // End of travel
                lineData[lineOffset++] = pathStart.x;
                lineData[lineOffset++] = pathStart.y;
                lineData[lineOffset++] = cumDist;
                lineData[lineOffset++] = 0; // Travel segment uses type 0
            }

            // Record Pen Down Blot
            blotData[blotOffset++] = pathStart.x;
            blotData[blotOffset++] = pathStart.y;
            blotData[blotOffset++] = cumDist; // Appears right when pen lands
            blotData[blotOffset++] = 1; // Type doesn't really matter for blots, but 1 matches "draw"

            // Draw segments
            for (let i = 0; i < path.points.length - 1; i++) {
                const p1 = path.points[i];
                const p2 = path.points[i + 1];
                const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);

                // Start vertex
                lineData[lineOffset++] = p1.x;
                lineData[lineOffset++] = p1.y;
                lineData[lineOffset++] = cumDist;
                lineData[lineOffset++] = pathDepth + 1;

                cumDist += dist;

                // End vertex
                lineData[lineOffset++] = p2.x;
                lineData[lineOffset++] = p2.y;
                lineData[lineOffset++] = cumDist;
                lineData[lineOffset++] = pathDepth + 1;
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
                lineData[lineOffset++] = pathDepth + 1;

                cumDist += dist;

                // End vertex
                lineData[lineOffset++] = p2.x;
                lineData[lineOffset++] = p2.y;
                lineData[lineOffset++] = cumDist;
                lineData[lineOffset++] = pathDepth + 1;

                lastPoint = pathStart;
            } else {
                lastPoint = pathEnd;
            }

            // Record Pen Up Blot (at actual end position)
            blotData[blotOffset++] = lastPoint.x;
            blotData[blotOffset++] = lastPoint.y;
            blotData[blotOffset++] = cumDist; // Appears right when pen lifts
            blotData[blotOffset++] = 1;
        }

        this.totalDistance = cumDist;
        this.vertexCount = lineOffset / 4;
        this.blotCount = blotOffset / 4;

        // Upload Lines
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, lineData, gl.STATIC_DRAW);

        // Upload Blots
        gl.bindBuffer(gl.ARRAY_BUFFER, this.blotBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, blotData, gl.STATIC_DRAW);

        this.currentBounds = bounds;
        this.fitView(bounds);
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

    private fitView(bounds: { width: number, height: number }) {
        const gl = this.gl;
        gl.useProgram(this.program);

        this.canvas.width = this.canvas.clientWidth;
        this.canvas.height = this.canvas.clientHeight;
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);

        const uRes = gl.getUniformLocation(this.program, 'u_resolution');
        gl.uniform2f(uRes, this.canvas.width, this.canvas.height);

        const padding = 20;
        const scaleX = (this.canvas.width - padding * 2) / bounds.width;
        const scaleY = (this.canvas.height - padding * 2) / bounds.height;
        const scale = Math.min(scaleX, scaleY);
        // this.pixelScale = scale; // Store for line width calc

        const offsetX = (this.canvas.width - bounds.width * scale) / 2;
        const offsetY = (this.canvas.height - bounds.height * scale) / 2;

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

    public setSpeed(multiplier: number) {
        const baseSpeed = 100;
        this.speed = baseSpeed * multiplier;
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

        const stride = 4 * 4;
        const posLoc = gl.getAttribLocation(this.program, 'a_position');
        const distLoc = gl.getAttribLocation(this.program, 'a_cumDist');
        const typeLoc = gl.getAttribLocation(this.program, 'a_type');

        gl.enableVertexAttribArray(posLoc);
        gl.enableVertexAttribArray(distLoc);
        gl.enableVertexAttribArray(typeLoc);

        // Calculate Line Width based on Pen Weight
        // pixelScale = pixels / mm
        // penWeight = mm
        // WebGL Limit: Line width is restricted to 1px on most platforms (including Mac)
        // const lineWidth = Math.max(1, this.penWeight * this.pixelScale);
        gl.lineWidth(1.0);

        // 1. Draw Lines
        gl.uniform1i(uIsPoints, 0); // False
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, stride, 0);
        gl.vertexAttribPointer(distLoc, 1, gl.FLOAT, false, stride, 8);
        gl.vertexAttribPointer(typeLoc, 1, gl.FLOAT, false, stride, 12);
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
