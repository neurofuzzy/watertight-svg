/**
 * Synced Pan/Zoom Controller for SVGs
 * Manages synchronized viewBox updates across multiple SVG elements.
 */

export class PanZoomController {
    private svgs: SVGSVGElement[] = [];
    private viewBox = { x: 0, y: 0, w: 0, h: 0 };
    private originalViewBox = { x: 0, y: 0, w: 0, h: 0 };
    private isPanning = false;
    private lastMouse = { x: 0, y: 0 };
    private cleanupFns: (() => void)[] = [];

    constructor() { }

    /**
     * Attach controller to a set of SVG elements.
     * If reset is true, the zoom level is reset to fit the content.
     */
    attach(svgs: SVGSVGElement[], reset: boolean = false) {
        this.detach(); // Cleanup old listeners
        this.svgs = svgs;

        if (svgs.length === 0) return;

        // Get dimensions from first SVG
        // We assume all SVGs share the same coordinate space/aspect ratio
        const vb = svgs[0].viewBox.baseVal;

        if (reset || this.originalViewBox.w === 0) {
            this.originalViewBox = { x: vb.x, y: vb.y, w: vb.width, h: vb.height };
            this.viewBox = { ...this.originalViewBox };
        } else {
            // Validate if dimensions changed significantly (new file load)
            // If aspect ratio or scale is wildly different, force reset
            if (Math.abs(vb.width - this.originalViewBox.w) > 1 || Math.abs(vb.height - this.originalViewBox.h) > 1) {
                this.originalViewBox = { x: vb.x, y: vb.y, w: vb.width, h: vb.height };
                this.viewBox = { ...this.originalViewBox };
            }
        }

        // Apply current viewbox to new elements
        this.update();

        // Attach listeners to CONTAINERS (parent of SVG) to capture events even if pointer-events:none on SVG?
        // Actually SVG itself is fine if it has pointer-events: all.
        // But `renderPreview` replaces SVGs.

        svgs.forEach(svg => {
            // wrapper for binding 'this'
            const onWheel = (e: WheelEvent) => this.handleWheel(e);
            const onDown = (e: MouseEvent) => this.handleDown(e);
            const onMove = (e: MouseEvent) => this.handleMove(e);
            const onUp = (e: MouseEvent) => this.handleUp(e);
            const onLeave = (e: MouseEvent) => this.handleUp(e); // Stop panning if leaving

            svg.addEventListener('wheel', onWheel, { passive: false });
            svg.addEventListener('mousedown', onDown);
            svg.addEventListener('mousemove', onMove);
            svg.addEventListener('mouseup', onUp);
            svg.addEventListener('mouseleave', onLeave);

            // Set cursor style
            svg.style.cursor = 'grab';

            this.cleanupFns.push(() => {
                svg.removeEventListener('wheel', onWheel);
                svg.removeEventListener('mousedown', onDown);
                svg.removeEventListener('mousemove', onMove);
                svg.removeEventListener('mouseup', onUp);
                svg.removeEventListener('mouseleave', onLeave);
            });
        });
    }

    detach() {
        this.cleanupFns.forEach(fn => fn());
        this.cleanupFns = [];
        this.svgs = [];
    }

    private update() {
        const vbString = `${this.viewBox.x} ${this.viewBox.y} ${this.viewBox.w} ${this.viewBox.h}`;
        this.svgs.forEach(svg => {
            svg.setAttribute('viewBox', vbString);
        });
    }

    private handleWheel(e: WheelEvent) {
        e.preventDefault();

        const zoomSpeed = 0.001;
        const delta = e.deltaY;
        const scale = 1 + delta * zoomSpeed;

        // Clamp zoom?
        // Prevent zooming out too far? 
        // Prevent zooming in to 0?

        // Calculate mouse position relative to SVG coordinates
        // This is tricky because we are modifying viewBox.
        // We need the mouse position in "SVG Units" BEFORE the zoom.

        const svg = e.currentTarget as SVGSVGElement;
        const rect = svg.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        // Convert screen pixels to SVG units
        const svgW = this.viewBox.w;
        const svgH = this.viewBox.h;
        const screenW = rect.width;
        const screenH = rect.height;

        const mouseSvgX = this.viewBox.x + (mx / screenW) * svgW;
        const mouseSvgY = this.viewBox.y + (my / screenH) * svgH;

        // Apply Zoom
        const newW = svgW * scale;
        const newH = svgH * scale;

        // Adjust x/y so that mouseSvgX/Y remains stationary
        // newX + (mx/screenW) * newW = mouseSvgX
        // newX = mouseSvgX - (mx/screenW) * newW

        this.viewBox.w = newW;
        this.viewBox.h = newH;
        this.viewBox.x = mouseSvgX - (mx / screenW) * newW;
        this.viewBox.y = mouseSvgY - (my / screenH) * newH;

        this.update();
    }

    private handleDown(e: MouseEvent) {
        e.preventDefault();
        this.isPanning = true;
        this.lastMouse = { x: e.clientX, y: e.clientY };
        this.svgs.forEach(s => s.style.cursor = 'grabbing');
    }

    private handleMove(e: MouseEvent) {
        if (!this.isPanning) return;
        e.preventDefault();

        const dx = e.clientX - this.lastMouse.x;
        const dy = e.clientY - this.lastMouse.y;

        this.lastMouse = { x: e.clientX, y: e.clientY };

        // Convert screen delta to SVG delta
        const svg = e.currentTarget as SVGSVGElement;
        const rect = svg.getBoundingClientRect();

        // Scale factor: SVG units per Screen pixel
        const scaleX = this.viewBox.w / rect.width;
        const scaleY = this.viewBox.h / rect.height;

        this.viewBox.x -= dx * scaleX;
        this.viewBox.y -= dy * scaleY;

        this.update();
    }

    private handleUp(e: MouseEvent) {
        if (this.isPanning) {
            this.isPanning = false;
            this.svgs.forEach(s => s.style.cursor = 'grab');
        }
    }
}
