/**
 * Layered export gives each nesting depth its own stroke colour, so layers are
 * distinguishable in Inkscape and can take separate pen/cut settings.
 */

import { describe, it, expect } from 'vitest';
import { exportSVG } from '../ui/export';
import type { Path, SVGDocument } from '../geometry/types';

function open(...points: [number, number][]): Path {
    return { points: points.map(([x, y]) => ({ x, y })), closed: false };
}

function box(size: number): Path {
    return {
        points: [
            { x: 0, y: 0 },
            { x: size, y: 0 },
            { x: size, y: size },
            { x: 0, y: size },
        ],
        closed: true,
    };
}

const doc: SVGDocument = { width: 100, height: 100, paths: [] };

/** stroke="..." values in document order */
function strokes(svg: string): string[] {
    return [...svg.matchAll(/stroke="([^"]+)"/g)].map(m => m[1]);
}

describe('layered export colours', () => {
    it('gives each depth a distinct colour', () => {
        const layers = new Map<number, Path[]>([
            [1, [box(50)]],
            [2, [box(30)]],
            [3, [box(10)]],
        ]);

        const svg = exportSVG({ ...doc, paths: [] }, layers);
        const used = strokes(svg);

        expect(used).toContain('#FF0000'); // depth 1
        expect(used).toContain('#0000FF'); // depth 2
        expect(used).toContain('#008000'); // depth 3
        expect(new Set(used).size).toBe(3);
    });

    it('colours open paths too, not just closed shapes', () => {
        // Plotter output is entirely open paths - the case the original
        // implementation missed by only colouring the combined closed element.
        const layers = new Map<number, Path[]>([
            [1, [open([0, 0], [10, 10])]],
            [2, [open([20, 20], [30, 30])]],
        ]);

        const svg = exportSVG({ ...doc, paths: [] }, layers);

        expect(strokes(svg)).toEqual(['#FF0000', '#0000FF']);
        expect(svg).not.toContain('stroke="black"');
    });

    it('overrides the source stroke inside a layer', () => {
        const path: Path = { ...open([0, 0], [10, 0]), meta: { stroke: '#123456' } };
        const svg = exportSVG({ ...doc, paths: [] }, new Map([[1, [path]]]));

        expect(svg).toContain('stroke="#FF0000"');
        expect(svg).not.toContain('#123456');
    });

    it('keeps depth 0 neutral for unclassified paths', () => {
        const svg = exportSVG({ ...doc, paths: [] }, new Map([[0, [open([0, 0], [5, 5])]]]));
        expect(strokes(svg)).toEqual(['#333333']);
    });

    it('cycles the palette beyond five layers', () => {
        const layers = new Map<number, Path[]>([
            [1, [open([0, 0], [1, 1])]],
            [6, [open([2, 2], [3, 3])]],
        ]);

        const used = strokes(exportSVG({ ...doc, paths: [] }, layers));
        expect(used[0]).toBe(used[1]); // depth 6 wraps back to depth 1's colour
    });

    it('leaves flat (unlayered) export uncoloured', () => {
        const path: Path = { ...open([0, 0], [10, 0]), meta: { stroke: '#abcdef' } };
        const svg = exportSVG({ ...doc, paths: [path] });

        // Source stroke preserved, no layer palette applied
        expect(svg).toContain('stroke="#abcdef"');
        for (const color of ['#FF0000', '#0000FF', '#008000', '#333333']) {
            expect(svg).not.toContain(color);
        }
    });
});
