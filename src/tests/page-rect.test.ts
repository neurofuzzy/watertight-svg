import { describe, it, expect } from 'vitest';
import { isPageRect } from '../geometry/parser';
import type { BoundingBox, Path } from '../geometry/types';

/** Build a closed rectangular path, optionally sampled with extra points per edge */
function rect(minX: number, minY: number, maxX: number, maxY: number, samplesPerEdge = 1): Path {
    const corners = [
        [minX, minY],
        [maxX, minY],
        [maxX, maxY],
        [minX, maxY],
    ] as const;

    const points = [];
    for (let i = 0; i < corners.length; i++) {
        const [x0, y0] = corners[i];
        const [x1, y1] = corners[(i + 1) % corners.length];
        for (let s = 0; s < samplesPerEdge; s++) {
            const t = s / samplesPerEdge;
            points.push({ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t });
        }
    }

    return { points, closed: true };
}

// An inch-based page, the case that motivated this: viewBox="0 0 5.83 8.27"
const page: BoundingBox = { minX: 0, minY: 0, maxX: 5.83, maxY: 8.27 };

describe('isPageRect', () => {
    it('matches a rect covering the full page', () => {
        expect(isPageRect(rect(0, 0, 5.83, 8.27), page)).toBe(true);
    });

    it('matches a densely sampled page rect (as getPointAtLength produces)', () => {
        expect(isPageRect(rect(0, 0, 5.83, 8.27, 200), page)).toBe(true);
    });

    it('matches within tolerance for near-page-sized rects', () => {
        expect(isPageRect(rect(0.01, 0.01, 5.82, 8.26), page)).toBe(true);
    });

    it('honours a viewBox with a non-zero origin', () => {
        const offset: BoundingBox = { minX: -100, minY: -50, maxX: 380, maxY: 622 };
        expect(isPageRect(rect(-100, -50, 380, 622), offset)).toBe(true);
        expect(isPageRect(rect(0, 0, 480, 672), offset)).toBe(false);
    });

    it('keeps rects smaller than the page', () => {
        expect(isPageRect(rect(1, 1, 4, 6), page)).toBe(false);
    });

    it('keeps open paths even when they span the page', () => {
        expect(isPageRect({ ...rect(0, 0, 5.83, 8.27), closed: false }, page)).toBe(false);
    });

    it('keeps page-spanning artwork that is not a rectangle', () => {
        // A diamond inscribed in the page: same bounds, half the area
        const diamond: Path = {
            points: [
                { x: 2.915, y: 0 },
                { x: 5.83, y: 4.135 },
                { x: 2.915, y: 8.27 },
                { x: 0, y: 4.135 },
            ],
            closed: true,
        };
        expect(isPageRect(diamond, page)).toBe(false);
    });

    it('keeps a page-spanning circle', () => {
        // Ellipse filling the page: matching bounds, but only ~78% of the box area
        const points = [];
        for (let i = 0; i < 128; i++) {
            const a = (i / 128) * Math.PI * 2;
            points.push({
                x: 2.915 + Math.cos(a) * 2.915,
                y: 4.135 + Math.sin(a) * 4.135,
            });
        }
        expect(isPageRect({ points, closed: true }, page)).toBe(false);
    });
});
