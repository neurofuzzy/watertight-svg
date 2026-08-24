/**
 * Parser coverage under jsdom.
 *
 * This used to be impossible: geometry came from `getPointAtLength()`, which no
 * non-browser DOM implements, and that is why `simple-parser.ts` exists. Now
 * that points come from the elements' own attributes, everything except the
 * transform chain (`getScreenCTM`) and rendered bounds (`getBBox`) can be
 * checked here. Those two still need a real browser.
 */
import { describe, it, expect } from 'vitest';
import { parseSVG } from '../geometry/parser';
import type { Point } from '../geometry/types';

const svg = (body: string, attrs = 'viewBox="0 0 100 100" width="100" height="100"') =>
    `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;

function hasVertex(points: Point[], x: number, y: number, tolerance = 1e-9): boolean {
    return points.some(p => Math.abs(p.x - x) < tolerance && Math.abs(p.y - y) < tolerance);
}

describe('parseSVG geometry', () => {
    it('keeps every corner of a polygonal path', () => {
        // The regression this guards: arc-length sampling chamfered each corner
        // by up to one step, which on a small triangle was a quarter of the edge.
        const doc = parseSVG(svg('<path d="M10,10 L90,10 L50,80 Z"/>'));
        expect(doc.paths).toHaveLength(1);
        expect(doc.paths[0].points).toEqual([
            { x: 10, y: 10 },
            { x: 90, y: 10 },
            { x: 50, y: 80 },
        ]);
        expect(doc.paths[0].closed).toBe(true);
    });

    it('keeps corners on a tiny shape in a large document', () => {
        // Sampling density is document-relative, so this is where the old
        // parser did the most damage.
        const doc = parseSVG(svg('<path d="M50,50 L50.6,50 L50.3,50.5 Z"/>'));
        for (const corner of [{ x: 50, y: 50 }, { x: 50.6, y: 50 }, { x: 50.3, y: 50.5 }]) {
            expect(hasVertex(doc.paths[0].points, corner.x, corner.y)).toBe(true);
        }
    });

    it('splits a path into subpaths', () => {
        const doc = parseSVG(svg('<path d="M0,0 L10,0 M20,20 L30,20 L30,30 Z"/>'));
        expect(doc.paths).toHaveLength(2);
        expect(doc.paths[0].closed).toBe(false);
        expect(doc.paths[1].closed).toBe(true);
    });

    it('reads a rectangle as four exact corners', () => {
        const doc = parseSVG(svg('<rect x="10" y="20" width="30" height="40"/>'));
        expect(doc.paths[0].points).toEqual([
            { x: 10, y: 20 },
            { x: 40, y: 20 },
            { x: 40, y: 60 },
            { x: 10, y: 60 },
        ]);
        expect(doc.paths[0].closed).toBe(true);
    });

    it('rounds a rect given only rx, treating ry as auto', () => {
        const doc = parseSVG(svg('<rect x="0" y="0" width="40" height="40" rx="10"/>'));
        // Corner is rounded on both axes, so the sharp corner is gone.
        expect(hasVertex(doc.paths[0].points, 0, 0)).toBe(false);
        expect(doc.paths[0].points.length).toBeGreaterThan(8);
    });

    it('reads polygon and polyline points, and their closedness', () => {
        const doc = parseSVG(svg(
            '<polygon points="0,0 10,0 5,9"/><polyline points="20,20 30,20 30,30"/>'
        ));
        expect(doc.paths[0].points).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 9 }]);
        expect(doc.paths[0].closed).toBe(true);
        expect(doc.paths[1].points).toHaveLength(3);
        expect(doc.paths[1].closed).toBe(false);
    });

    it('reads a line as its two endpoints', () => {
        const doc = parseSVG(svg('<line x1="1" y1="2" x2="3" y2="4"/>'));
        expect(doc.paths[0].points).toEqual([{ x: 1, y: 2 }, { x: 3, y: 4 }]);
        expect(doc.paths[0].closed).toBe(false);
    });

    it('samples a circle onto its own radius', () => {
        const doc = parseSVG(svg('<circle cx="50" cy="50" r="20"/>'));
        expect(doc.paths[0].closed).toBe(true);
        for (const p of doc.paths[0].points) {
            expect(Math.hypot(p.x - 50, p.y - 50)).toBeCloseTo(20, 9);
        }
    });

    it('samples curves densely enough to stay smooth', () => {
        const doc = parseSVG(svg('<path d="M10,50 C10,10 90,10 90,50"/>'));
        const points = doc.paths[0].points;
        expect(points[0]).toEqual({ x: 10, y: 50 });
        expect(points[points.length - 1]).toEqual({ x: 90, y: 50 });
        expect(points.length).toBeGreaterThan(10);
    });

    it('drops elements with no geometry', () => {
        expect(parseSVG(svg('<path d=""/><rect width="0" height="10"/>')).paths).toHaveLength(0);
    });
});

describe('parseSVG document', () => {
    it('reports the viewBox size and the declared unit', () => {
        const doc = parseSVG(svg('<path d="M0,0 L1,1"/>', 'viewBox="0 0 8.5 11" width="8.5in" height="11in"'));
        expect(doc.width).toBe(8.5);
        expect(doc.height).toBe(11);
        expect(doc.units).toBe('in');
    });

    it('leaves pixel and unitless documents without a unit', () => {
        expect(parseSVG(svg('<path d="M0,0 L1,1"/>')).units).toBeUndefined();
        expect(parseSVG(svg('<path d="M0,0 L1,1"/>', 'width="800px" height="600px"')).units).toBeUndefined();
    });

    it('discards a page-sized background rect only when asked', () => {
        const body = '<rect x="0" y="0" width="100" height="100" fill="#fff"/><path d="M10,10 L90,90"/>';
        expect(parseSVG(svg(body)).paths).toHaveLength(2);
        expect(parseSVG(svg(body), { discardPageRects: true }).paths).toHaveLength(1);
    });

    it('honours a viewBox origin when matching page rects', () => {
        const body = '<rect x="50" y="50" width="100" height="100"/>';
        const doc = parseSVG(svg(body, 'viewBox="50 50 100 100" width="100" height="100"'), {
            discardPageRects: true,
        });
        expect(doc.paths).toHaveLength(0);
    });
});
