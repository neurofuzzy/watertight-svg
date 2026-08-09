import { describe, it, expect } from 'vitest';
import type { Path } from '../geometry/types';
import {
    pathsToStrokes,
    docUnitsToMM,
    envelopeViolation,
    placeForMachine,
    rotateStrokesCCW,
    orientLandscape,
    MACHINE_ENVELOPES,
} from '../plot/plot';

const square: Path = {
    points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
    closed: true,
};

const line: Path = {
    points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
    closed: false,
};

describe('docUnitsToMM', () => {
    it('treats unitless and px documents as mm', () => {
        expect(docUnitsToMM(undefined)).toBe(1);
        expect(docUnitsToMM('px')).toBe(1);
        expect(docUnitsToMM('mm')).toBe(1);
    });

    it('converts physical units', () => {
        expect(docUnitsToMM('in')).toBeCloseTo(25.4);
        expect(docUnitsToMM('cm')).toBe(10);
        expect(docUnitsToMM('pt')).toBeCloseTo(25.4 / 72);
        expect(docUnitsToMM('q')).toBe(0.25);
    });
});

describe('pathsToStrokes', () => {
    it('repeats the first point on closed paths so the last edge is drawn', () => {
        const [stroke] = pathsToStrokes([square]);
        expect(stroke.points).toHaveLength(5);
        expect(stroke.points[4]).toEqual(stroke.points[0]);
    });

    it('leaves open paths alone', () => {
        const [stroke] = pathsToStrokes([line]);
        expect(stroke.points).toHaveLength(2);
    });

    it('scales an inch document into mm', () => {
        const [stroke] = pathsToStrokes([line], { units: 'in' });
        expect(stroke.points[1].x).toBeCloseTo(254);
        expect(stroke.points[1].y).toBeCloseTo(254);
    });

    it('drops degenerate paths that cannot be drawn', () => {
        const single: Path = { points: [{ x: 1, y: 1 }], closed: false };
        const empty: Path = { points: [], closed: true };
        expect(pathsToStrokes([single, empty, line])).toHaveLength(1);
    });

    it('carries nesting depth through as the stroke layer', () => {
        const layers = new Map<number, Path[]>([[0, [line]], [2, [square]]]);
        const strokes = pathsToStrokes([line, square], { layers });
        expect(strokes[0].layer).toBe(0);
        expect(strokes[1].layer).toBe(2);
    });

    it('defaults to layer 0 when no depth map is supplied', () => {
        expect(pathsToStrokes([square])[0].layer).toBe(0);
    });

    it('does not mutate the source paths', () => {
        const before = JSON.parse(JSON.stringify(square));
        pathsToStrokes([square], { units: 'in' });
        expect(square).toEqual(before);
    });
});

describe('envelopeViolation', () => {
    const strokesSpanning = (w: number, h: number) => pathsToStrokes([{
        points: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }],
        closed: true,
    }]);

    it('passes a drawing inside the machine envelope', () => {
        expect(envelopeViolation(strokesSpanning(148, 210), MACHINE_ENVELOPES['V3']))
            .toBeNull();
    });

    /**
     * Regression: samples/wavelet_plot.svg is A5 (148x210mm), but Scale to Fit
     * defaults on against 8.5x11in paper, enlarging it to 215.9x279.4mm. That
     * is 61mm past an A4 machine's 218mm Y travel — the carriage runs into the
     * end stop and ratchets. It must be refused before anything moves.
     */
    it('refuses a Letter-scaled A5 drawing on an A4 machine', () => {
        const v = envelopeViolation(strokesSpanning(215.9, 279.4), MACHINE_ENVELOPES['V3']);
        expect(v).not.toBeNull();
        expect(v).toContain('218mm Y travel');
    });

    it('reports travel past the X limit', () => {
        const v = envelopeViolation(strokesSpanning(600, 100), MACHINE_ENVELOPES['V3']);
        expect(v).toContain('280mm X travel');
    });

    it('catches geometry left of or above the origin', () => {
        const behind = pathsToStrokes([{
            points: [{ x: -20, y: -5 }, { x: 10, y: 10 }], closed: false,
        }]);
        const v = envelopeViolation(behind, MACHINE_ENVELOPES['V3']);
        expect(v).toContain('left of the origin');
        expect(v).toContain('above the origin');
    });

    it('treats an empty job as safe', () => {
        expect(envelopeViolation([], MACHINE_ENVELOPES['V3'])).toBeNull();
    });
});

describe('laying the page landscape', () => {
    // Full-bleed page outline, so the strokes span exactly the sheet.
    const fullPage = (w: number, h: number): Path => ({
        points: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }],
        closed: true,
    });

    it('rotates counter-clockwise, mapping the top-right corner onto the origin', () => {
        // A single point at the page's top-right.
        const s = pathsToStrokes([{
            points: [{ x: 100, y: 0 }, { x: 100, y: 10 }], closed: false,
        }]);
        const { strokes, page } = rotateStrokesCCW(s, { widthMM: 100, heightMM: 200 });
        expect(page).toEqual({ widthMM: 200, heightMM: 100 });
        // (100,0) is the top-right corner, and lands on the machine origin —
        // which is what makes anticlockwise the correct direction.
        expect(strokes[0].points[0]).toEqual({ x: 0, y: 0 });
        expect(strokes[0].points[1]).toEqual({ x: 10, y: 0 });
    });

    it('preserves lengths — a rotation, not a scale or mirror', () => {
        const s = pathsToStrokes([{ points: [{ x: 0, y: 0 }, { x: 30, y: 40 }], closed: false }]);
        const { strokes } = rotateStrokesCCW(s, { widthMM: 100, heightMM: 200 });
        const [a, b] = strokes[0].points;
        expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(50);
    });

    it('turns a portrait page', () => {
        const r = orientLandscape(pathsToStrokes([fullPage(216, 279)]), { widthMM: 216, heightMM: 279 });
        expect(r.rotated).toBe(true);
        expect(r.page).toEqual({ widthMM: 279, heightMM: 216 });
    });

    it('leaves a landscape page alone', () => {
        const r = orientLandscape(pathsToStrokes([fullPage(279, 216)]), { widthMM: 279, heightMM: 216 });
        expect(r.rotated).toBe(false);
        expect(r.page).toEqual({ widthMM: 279, heightMM: 216 });
    });

    it('leaves a square page alone rather than turning it pointlessly', () => {
        const r = orientLandscape(pathsToStrokes([fullPage(200, 200)]), { widthMM: 200, heightMM: 200 });
        expect(r.rotated).toBe(false);
    });

    /**
     * Regression: portrait Letter needs 279.4mm of Y on a machine with 218mm of
     * Y travel. Laid landscape it needs 279.4mm of X against 280mm available.
     */
    it('places portrait Letter inside an A4 machine', () => {
        const p = placeForMachine([fullPage(215.9, 279.4)], {
            page: { width: 215.9, height: 279.4 },
        });
        expect(p.rotated).toBe(true);
        expect(p.page.widthMM).toBeCloseTo(279.4);
        expect(p.page.heightMM).toBeCloseTo(215.9);
        expect(envelopeViolation(p.strokes, MACHINE_ENVELOPES['V3'])).toBeNull();
    });

    it('keeps the whole sheet in +X/+Y, since the machine cannot go negative', () => {
        const p = placeForMachine([fullPage(215.9, 279.4)], {
            page: { width: 215.9, height: 279.4 },
        });
        for (const s of p.strokes) {
            for (const pt of s.points) {
                expect(pt.x).toBeGreaterThanOrEqual(-0.001);
                expect(pt.y).toBeGreaterThanOrEqual(-0.001);
            }
        }
    });

    it('converts units before deciding orientation', () => {
        // 5.83 x 8.27in is portrait; in mm that is 148 x 210.
        const p = placeForMachine([fullPage(5.83, 8.27)], {
            units: 'in',
            page: { width: 5.83, height: 8.27 },
        });
        expect(p.rotated).toBe(true);
        expect(p.page.widthMM).toBeCloseTo(210.1, 1);
        expect(p.page.heightMM).toBeCloseTo(148.1, 1);
    });
});
