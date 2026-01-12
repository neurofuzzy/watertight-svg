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

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        const gl = canvas.getContext('webgl2', { alpha: false, antialias: true });
        if (!gl) throw new Error('WebGL2 not supported');
        this.gl = gl;

        // Initialize Shaders
        this.program = this.createProgram(this.vertexShaderSource, this.fragmentShaderSource);
        this.vertexBuffer = gl.createBuffer()!;

        // Setup GL state
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0.06, 0.06, 0.08, 1.0); // --bg-primary
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }

    private vertexShaderSource = `#version 300 es
    in vec2 a_position;
    in float a_cumDist;
    in float a_type; // 0 = travel (up), 1 = draw (down)

    uniform vec2 u_resolution;
    uniform vec2 u_scale;
    uniform vec2 u_offset;

    out float v_cumDist;
    out float v_type;

    void main() {
        // Convert to clip space
        vec2 position = (a_position * u_scale + u_offset);
        vec2 clipSpace = (position / u_resolution) * 2.0 - 1.0;
        gl_Position = vec4(clipSpace * vec2(1, -1), 0, 1);
        
        // Pass to fragment for smooth interpolation
        v_cumDist = a_cumDist;
        v_type = a_type;
    }`;

    private fragmentShaderSource = `#version 300 es
    precision mediump float;
    
    in float v_cumDist;
    in float v_type;
    
    uniform float u_maxDist;

    out vec4 outColor;

    void main() {
        // Smoothly discard pixels past the current distance
        if (v_cumDist > u_maxDist) discard;

        if (v_type > 0.5) {
            // Draw (Pen Down) - Bright Blue/White
            outColor = vec4(0.4, 0.6, 1.0, 1.0);
        } else {
            // Travel (Pen Up) - Dim Red, lower opacity
            outColor = vec4(1.0, 0.2, 0.4, 0.3);
        }
    }`;

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
     * Load paths into WebGL buffers
     */
    public setData(paths: Path[], bounds: { width: number, height: number }) {
        // 1. Flatten paths into vertices with cumulative distance
        // Format: [x, y, cumDist, type, x, y, cumDist, type, ...]
        // We use Line Lists for rendering (start-end pairs)

        let totalPoints = 0;
        // Calculate size first
        for (const path of paths) {
            totalPoints += (path.points.length - 1) * 2; // Each segment is 2 vertices
            // Add travel move from previous end to current start? 
            // Better: Just treat all paths as a sequence, and insert "travel" segments between them
        }
        // Add space for travel moves
        totalPoints += (paths.length - 1) * 2;

        const data = new Float32Array(totalPoints * 4);
        let offset = 0;
        let cumDist = 0;
        let lastPoint: Point | null = null;

        for (const path of paths) {
            // Travel from last point (if exists)
            if (lastPoint) {
                const dist = Math.hypot(path.points[0].x - lastPoint.x, path.points[0].y - lastPoint.y);

                // Start of travel
                data[offset++] = lastPoint.x;
                data[offset++] = lastPoint.y;
                data[offset++] = cumDist;
                data[offset++] = 0; // Travel

                cumDist += dist;

                // End of travel
                data[offset++] = path.points[0].x;
                data[offset++] = path.points[0].y;
                data[offset++] = cumDist;
                data[offset++] = 0; // Travel
            }

            // Draw segments
            for (let i = 0; i < path.points.length - 1; i++) {
                const p1 = path.points[i];
                const p2 = path.points[i + 1];
                const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);

                // Start vertex
                data[offset++] = p1.x;
                data[offset++] = p1.y;
                data[offset++] = cumDist;
                data[offset++] = 1; // Draw

                cumDist += dist;

                // End vertex
                data[offset++] = p2.x;
                data[offset++] = p2.y;
                data[offset++] = cumDist;
                data[offset++] = 1; // Draw
            }

            lastPoint = path.points[path.points.length - 1];
        }

        this.totalDistance = cumDist;
        this.vertexCount = offset / 4;

        // Upload to GPU
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

        // Setup Attributes
        const stride = 4 * 4;
        const posLoc = gl.getAttribLocation(this.program, 'a_position');
        const distLoc = gl.getAttribLocation(this.program, 'a_cumDist');
        const typeLoc = gl.getAttribLocation(this.program, 'a_type');

        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, stride, 0);

        gl.enableVertexAttribArray(distLoc);
        gl.vertexAttribPointer(distLoc, 1, gl.FLOAT, false, stride, 8);

        gl.enableVertexAttribArray(typeLoc);
        gl.vertexAttribPointer(typeLoc, 1, gl.FLOAT, false, stride, 12);

        // Fit view
        this.fitView(bounds);

        // Reset state
        this.progress = 0;
        this.draw();
    }

    private fitView(bounds: { width: number, height: number }) {
        const gl = this.gl;
        gl.useProgram(this.program);

        // Match canvas resolution
        this.canvas.width = this.canvas.clientWidth;
        this.canvas.height = this.canvas.clientHeight;
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);

        const uRes = gl.getUniformLocation(this.program, 'u_resolution');
        gl.uniform2f(uRes, this.canvas.width, this.canvas.height);

        // Calculate scale to fit with padding
        const padding = 20;
        const scaleX = (this.canvas.width - padding * 2) / bounds.width;
        const scaleY = (this.canvas.height - padding * 2) / bounds.height;
        const scale = Math.min(scaleX, scaleY);

        // Center content
        const offsetX = (this.canvas.width - bounds.width * scale) / 2;
        const offsetY = (this.canvas.height - bounds.height * scale) / 2;

        const uScale = gl.getUniformLocation(this.program, 'u_scale');
        const uOffset = gl.getUniformLocation(this.program, 'u_offset');

        gl.uniform2f(uScale, scale, scale);
        gl.uniform2f(uOffset, offsetX, offsetY);
    }

    public resize() {
        if (!this.gl) return;
        // Re-fit view (assuming bounds stored or passed again - simplified for now)
        // For accurate resize we'd need to store the bounds. 
        // We'll just update viewport resolution to match display size
        const gl = this.gl;
        const width = this.canvas.clientWidth;
        const height = this.canvas.clientHeight;

        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width;
            this.canvas.height = height;
            gl.viewport(0, 0, width, height);
            gl.useProgram(this.program);
            gl.uniform2f(gl.getUniformLocation(this.program, 'u_resolution')!, width, height);

            // Re-render
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
        // Base speed = totalDistance / 30 seconds (heuristic)
        // or just explicit units/sec. Let's say 100 units/sec is 1x
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
        const dt = (now - this.lastFrameTime) / 1000; // seconds
        this.lastFrameTime = now;

        // Advance progress based on speed
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

        // Callback for UI slider update
        this.onProgress(this.progress, this.formatTime(this.progress));

        this.animationFrameId = requestAnimationFrame(this.animate);
    }

    private draw() {
        const gl = this.gl;
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.useProgram(this.program);

        const currentMaxDist = this.totalDistance * this.progress;
        const uMaxDist = gl.getUniformLocation(this.program, 'u_maxDist');
        gl.uniform1f(uMaxDist, currentMaxDist);

        // Draw lines
        gl.drawArrays(gl.LINES, 0, this.vertexCount);
    }

    private updateTimeDisplay() {
        // handled via callback
    }

    private formatTime(progress: number): string {
        const totalSeconds = this.totalDistance / this.speed; // This varies with speed slider
        // Better: Total estimated time at current speed
        const currentSeconds = totalSeconds * progress;
        return `${this.formatSeconds(currentSeconds)} / ${this.formatSeconds(totalSeconds)}`;
    }

    private formatSeconds(s: number): string {
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return `${m}:${sec.toString().padStart(2, '0')}`;
    }
}
