import { describe, it, expect } from 'vitest';
import type { Path } from '../geometry/types';
import {
    pathsToStrokes,
    docUnitsToMM,
    pageFitsMachine,
    envelopeViolation,
    placeForMachine,
    rotateStrokes,
    orientToMachine,
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

describe('pageFitsMachine', () => {
    it('accepts a page inside the machine envelope', () => {
        expect(pageFitsMachine(210, 297, MACHINE_ENVELOPES['V3A3'])).toBe(true);
    });

    it('rejects a page the arm cannot reach', () => {
        expect(pageFitsMachine(420, 297, MACHINE_ENVELOPES['Mini'])).toBe(false);
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

describe('home corner anchoring', () => {
    // A5 drawing, 148mm wide, sitting flush in the top-left of a 210mm page.
    const drawing: Path = {
        points: [{ x: 0, y: 0 }, { x: 148, y: 0 }, { x: 148, y: 100 }],
        closed: false,
    };

    it('measures X from the left edge when parked top-left', () => {
        const [s] = pathsToStrokes([drawing], { homeCorner: 'top-left' });
        expect(s.points.map(p => p.x)).toEqual([0, 148, 148]);
    });

    it('measures X from the right edge when parked top-right', () => {
        const [s] = pathsToStrokes([drawing], {
            homeCorner: 'top-right', pageWidthMM: 210,
        });
        // The page's right edge is the origin, so the drawing's right edge sits
        // 210-148 = 62mm from home and its left edge 210mm out.
        expect(s.points.map(p => p.x)).toEqual([210, 62, 62]);
    });

    it('leaves Y untouched by the corner choice', () => {
        const [s] = pathsToStrokes([drawing], {
            homeCorner: 'top-right', pageWidthMM: 210,
        });
        expect(s.points.map(p => p.y)).toEqual([0, 0, 100]);
    });

    /**
     * The anchor is the *page* corner, not the drawing's bounding box, so
     * growing the paper must not move content that is already placed.
     */
    it('keeps content at a fixed offset from home as paper grows', () => {
        const at = (w: number) =>
            pathsToStrokes([drawing], { homeCorner: 'top-right', pageWidthMM: w })[0].points[0].x;
        expect(at(210)).toBe(210);
        expect(at(297)).toBe(297);
        // Distance from the drawing's own right edge to home tracks the page.
        expect(at(297) - 148).toBe(149);
    });

    it('refuses top-right without a page width rather than silently mirroring to 0', () => {
        expect(() => pathsToStrokes([drawing], { homeCorner: 'top-right' }))
            .toThrow(/pageWidthMM/);
    });

    it('applies unit conversion before the flip', () => {
        const inches: Path = { points: [{ x: 0, y: 0 }, { x: 2, y: 0 }], closed: false };
        const [s] = pathsToStrokes([inches], {
            units: 'in', homeCorner: 'top-right', pageWidthMM: 210,
        });
        expect(s.points[0].x).toBeCloseTo(210);
        expect(s.points[1].x).toBeCloseTo(210 - 50.8);
    });
});

describe('orienting the page to the gantry', () => {
    const LETTER_PORTRAIT = { width: 215.9, height: 279.4 };
    const A4_MACHINE = MACHINE_ENVELOPES['V3'];   // 280 x 218, sized for Letter landscape

    // Full-bleed page outline, so the strokes span exactly the sheet.
    const fullPage = (w: number, h: number): Path => ({
        points: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }],
        closed: true,
    });

    it('rotateStrokes turns the page without mirroring it', () => {
        const s = pathsToStrokes([{ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], closed: false }]);
        const { strokes, page } = rotateStrokes(s, { widthMM: 100, heightMM: 200 });
        expect(page).toEqual({ widthMM: 200, heightMM: 100 });
        // (0,0) -> (200,0) and (10,0) -> (200,10): the segment stays 10mm long.
        expect(strokes[0].points).toEqual([{ x: 200, y: 0 }, { x: 200, y: 10 }]);
    });

    /**
     * Regression for the real failure: portrait Letter needs 279.4mm of Y on a
     * machine with 218mm of Y travel. Turned 90° it needs 279.4mm of X against
     * 280mm available, and fits with 0.6mm to spare.
     */
    it('rotates portrait Letter to fit an A4 machine', () => {
        const strokes = pathsToStrokes([fullPage(215.9, 279.4)]);
        const r = orientToMachine(strokes, { widthMM: 215.9, heightMM: 279.4 }, A4_MACHINE);
        expect(r.rotated).toBe(true);
        expect(r.page.widthMM).toBeCloseTo(279.4);
        expect(r.page.heightMM).toBeCloseTo(215.9);
        expect(envelopeViolation(r.strokes, A4_MACHINE)).toBeNull();
    });

    it('leaves a page that already fits alone', () => {
        const strokes = pathsToStrokes([fullPage(100, 100)]);
        const r = orientToMachine(strokes, { widthMM: 100, heightMM: 100 }, A4_MACHINE);
        expect(r.rotated).toBe(false);
    });

    it('does not rotate when neither orientation fits', () => {
        const strokes = pathsToStrokes([fullPage(500, 500)]);
        const r = orientToMachine(strokes, { widthMM: 500, heightMM: 500 }, A4_MACHINE);
        expect(r.rotated).toBe(false);
        expect(envelopeViolation(r.strokes, A4_MACHINE)).not.toBeNull();
    });

    it('places portrait Letter inside an A4 machine end to end', () => {
        const p = placeForMachine([fullPage(215.9, 279.4)], {
            page: LETTER_PORTRAIT,
            envelope: A4_MACHINE,
            homeCorner: 'top-right',
        });
        expect(p.rotated).toBe(true);
        expect(envelopeViolation(p.strokes, A4_MACHINE)).toBeNull();
    });

    /**
     * Orientation and corner-anchoring do not commute: anchoring first would
     * measure X from the pre-rotation edge and push the drawing off the sheet.
     */
    it('anchors against the oriented page width, not the original', () => {
        const p = placeForMachine([fullPage(215.9, 279.4)], {
            page: LETTER_PORTRAIT,
            envelope: A4_MACHINE,
            homeCorner: 'top-right',
        });
        const b = strokeBoundsOf(p.strokes);
        // Flush against home on one side, out to the oriented width on the other.
        expect(b.minX).toBeCloseTo(0);
        expect(b.maxX).toBeCloseTo(279.4);
        expect(b.maxY).toBeCloseTo(215.9);
    });

    it('respects autoOrient: false even when that leaves the page unplottable', () => {
        const p = placeForMachine([fullPage(215.9, 279.4)], {
            page: LETTER_PORTRAIT,
            envelope: A4_MACHINE,
            homeCorner: 'top-left',
            autoOrient: false,
        });
        expect(p.rotated).toBe(false);
        expect(envelopeViolation(p.strokes, A4_MACHINE)).not.toBeNull();
    });
});

function strokeBoundsOf(strokes: { points: { x: number; y: number }[] }[]) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of strokes) for (const p of s.points) {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    return { minX, minY, maxX, maxY };
}
