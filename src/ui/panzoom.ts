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

        // Get dimensions from first SVG content
        const vb = svgs[0].viewBox.baseVal;

        // Measure the PARENT container because the SVG might not have layout yet
        // or might be constrained. We want to fill the parent.
        const parent = svgs[0].parentElement;
        const rect = parent ? parent.getBoundingClientRect() : svgs[0].getBoundingClientRect();

        // Target Aspect Ratio (Container)
        // Guard against 0 height
        const containerAR = rect.height > 0 ? rect.width / rect.height : vb.width / vb.height;
        const contentAR = vb.height > 0 ? vb.width / vb.height : 1;

        // Calculate corrected ViewBox that encloses content but matches container AR
        let newW = vb.width;
        let newH = vb.height;
        let newX = vb.x;
        let newY = vb.y;

        if (containerAR > contentAR) {
            // Container is wider than content -> Increase Width
            newW = newH * containerAR;
            // Center horizontally
            newX = vb.x - (newW - vb.width) / 2;
        } else {
            // Container is taller than content -> Increase Height
            newH = newW / containerAR;
            // Center vertically
            newY = vb.y - (newH - vb.height) / 2;
        }

        if (reset || this.originalViewBox.w === 0) {
            this.originalViewBox = { x: newX, y: newY, w: newW, h: newH };
            this.viewBox = { ...this.originalViewBox };
        }

        // Apply current viewbox to new elements
        this.update();

        // Attach listeners
        svgs.forEach(svg => {
            // FORCE fill by disabling native AR handling. 
            // We are mathematically guaranteeing AR match via viewBox padding above.
            svg.setAttribute('preserveAspectRatio', 'none');
            svg.style.display = 'block'; // Remove inline gaps

            const onWheel = (e: WheelEvent) => this.handleWheel(e);
            const onDown = (e: MouseEvent) => this.handleDown(e);
            const onMove = (e: MouseEvent) => this.handleMove(e);
            const onUp = (e: MouseEvent) => this.handleUp(e);
            const onLeave = (e: MouseEvent) => this.handleUp(e);

            svg.addEventListener('wheel', onWheel, { passive: false });
            svg.addEventListener('mousedown', onDown);
            svg.addEventListener('mousemove', onMove);
            svg.addEventListener('mouseup', onUp);
            svg.addEventListener('mouseleave', onLeave);

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

        const svg = e.currentTarget as SVGSVGElement;
        const parent = svg.parentElement;
        const rect = parent ? parent.getBoundingClientRect() : svg.getBoundingClientRect();

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

        const svg = e.currentTarget as SVGSVGElement;
        const parent = svg.parentElement;
        const rect = parent ? parent.getBoundingClientRect() : svg.getBoundingClientRect();

        const scaleX = this.viewBox.w / rect.width;
        const scaleY = this.viewBox.h / rect.height;

        this.viewBox.x -= dx * scaleX;
        this.viewBox.y -= dy * scaleY;

        this.update();
    }

    private handleUp(_e: MouseEvent) {
        if (this.isPanning) {
            this.isPanning = false;
            this.svgs.forEach(s => s.style.cursor = 'grab');
        }
    }
}
