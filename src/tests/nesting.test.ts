
import { describe, it, expect } from 'vitest';
import { parseSimpleSVG } from './simple-parser';
import { groupPathsByDepth } from '../optimize/nesting';
import { exportSVG } from '../ui/export';

describe('Layer by Nesting Depth', () => {
    // 3 Concentric Squares: 100x100, 80x80, 60x60
    // Depth 1: Outer 100x100 (10,10 to 110,110)
    // Depth 2: Middle 80x80 (20,20 to 100,100)
    // Depth 3: Inner 60x60 (30,30 to 90,90)
    const nestedSVG = `
        <svg viewBox="0 0 200 200">
            <path d="M10,10 h100 v100 h-100 Z" /> <!-- Outer -->
            <path d="M20,20 h80 v80 h-80 Z" />   <!-- Middle -->
            <path d="M30,30 h60 v60 h-60 Z" />   <!-- Inner -->
        </svg>
    `;

    // Separate disjoint squares (same depth)
    const disjointSVG = `
        <svg viewBox="0 0 200 200">
            <path d="M10,10 h20 v20 h-20 Z" /> <!-- Square 1 -->
            <path d="M50,50 h20 v20 h-20 Z" /> <!-- Square 2 -->
        </svg>
    `;

    it('should correctly group paths by nesting depth', () => {
        const doc = parseSimpleSVG(nestedSVG);
        const paths = doc.paths;

        expect(paths.length).toBe(3);

        const layers = groupPathsByDepth(paths);

        // Expect 3 levels: 1, 2, 3 (plus depth 0)
        expect(layers.size).toBe(4);
        expect(layers.has(1)).toBe(true);
        expect(layers.has(2)).toBe(true);
        expect(layers.has(3)).toBe(true);

        expect(layers.get(1)!.length).toBe(1);
        expect(layers.get(2)!.length).toBe(1);
        expect(layers.get(3)!.length).toBe(1);

        // Verify path geometries map to correct depths (largest is depth 1)
        // Path 0 is 10,10 (Outer) -> Depth 1
        // Path 1 is 20,20 (Middle) -> Depth 2
        // Path 2 is 30,30 (Inner) -> Depth 3
        // Since we don't have IDs on paths in parseSimpleSVG, we can verify counts and assumptions.
        // But let's assume the order is returned roughly as input for the layers map values if iterated.
    });

    it('should assign same depth to disjoint paths', () => {
        const doc = parseSimpleSVG(disjointSVG);
        const layers = groupPathsByDepth(doc.paths);

        // Both should be Depth 1 (plus Depth 0 which is always initialized)
        expect(layers.size).toBe(2);
        expect(layers.has(1)).toBe(true);
        expect(layers.has(0)).toBe(true);
        expect(layers.get(1)!.length).toBe(2);
    });

    it('should export SVG with Inkscape layer groups', () => {
        const doc = parseSimpleSVG(nestedSVG);
        const layers = groupPathsByDepth(doc.paths);

        const svgOutput = exportSVG(doc, layers);

        // Check for Inkscape namespace
        expect(svgOutput).toContain('xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"');

        // Check for groups
        expect(svgOutput).toContain('<g inkscape:groupmode="layer" inkscape:label="Depth 1" id="depth-1">');
        expect(svgOutput).toContain('<g inkscape:groupmode="layer" inkscape:label="Depth 2" id="depth-2">');
        expect(svgOutput).toContain('<g inkscape:groupmode="layer" inkscape:label="Depth 3" id="depth-3">');
    });
});
