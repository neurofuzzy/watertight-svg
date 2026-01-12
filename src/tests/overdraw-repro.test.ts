
import { removeOverdraw } from '../optimize/overdraw';
import { Path, Point } from '../geometry/types';
import { describe, it, expect } from 'vitest';

describe('Overdraw Removal Reproduction', () => {

    // Helper to create a simple square path
    function createSquare(offset: Point = { x: 0, y: 0 }, size: number = 100): Path {
        return {
            points: [
                { x: offset.x, y: offset.y },
                { x: offset.x + size, y: offset.y },
                { x: offset.x + size, y: offset.y + size },
                { x: offset.x, y: offset.y + size }
            ],
            closed: true
        };
    }

    it('should remove an exact duplicate square', () => {
        const path1 = createSquare();
        // Exact copy
        const path2 = createSquare();

        const paths = [path1, path2];
        expect(paths.length).toBe(2);

        const result = removeOverdraw(paths);

        // Should reduce to 1 path (4 segments)
        expect(result.length).toBe(1);
    });

    it('should remove a duplicate square with reversed winding', () => {
        const path1 = createSquare();
        // Reversed copy
        const path2 = {
            points: [...path1.points].reverse(),
            closed: true
        };

        const result = removeOverdraw([path1, path2]);
        expect(result.length).toBe(1);
    });

    it('should handle many duplicate copies', () => {
        const path1 = createSquare();
        const paths = [];
        for (let i = 0; i < 10; i++) {
            paths.push(JSON.parse(JSON.stringify(path1)));
        }

        const result = removeOverdraw(paths);
        expect(result.length).toBe(1);
    });

    it('should handle duplicate copies with slight noise', () => {
        const path1 = createSquare();
        const path2 = createSquare();

        // Add noise < tolerance (0.01 default)
        path2.points = path2.points.map(p => ({
            x: p.x + 0.005,
            y: p.y - 0.005
        }));

        const result = removeOverdraw([path1, path2], 0.01);
        expect(result.length).toBe(1);
    });

    it('should fail to detect noise if tolerance is not scaled', () => {
        const path1 = createSquare({ x: 0, y: 0 }, 100);
        const path2 = createSquare({ x: 0, y: 0 }, 100);

        // Scale up by 10 (simulate pipeline)
        const scale = 10;
        const p1Scaled = {
            points: path1.points.map(p => ({ x: p.x * scale, y: p.y * scale })),
            closed: true
        };
        const p2Scaled = {
            points: path2.points.map(p => ({ x: p.x * scale, y: p.y * scale })),
            closed: true
        };

        // Add small noise in ORIGINAL units (0.002) -> Scaled (0.02)
        p2Scaled.points = p2Scaled.points.map(p => ({
            x: p.x + (0.002 * scale),
            y: p.y
        }));

        // Run with default tolerance (0.01)
        // 0.02 diff > 0.01 tolerance -> Should FAIL to merge
        const result = removeOverdraw([p1Scaled, p2Scaled]); // default tol 0.01

        expect(result.length).toBe(2);
    });

    it('should succeed if tolerance is scaled', () => {
        const path1 = createSquare({ x: 0, y: 0 }, 100);
        const path2 = createSquare({ x: 0, y: 0 }, 100);

        // Scale up by 10
        const scale = 10;
        const p1Scaled = {
            points: path1.points.map(p => ({ x: p.x * scale, y: p.y * scale })),
            closed: true
        };
        const p2Scaled = {
            points: path2.points.map(p => ({ x: p.x * scale, y: p.y * scale })),
            closed: true
        };

        // Add small noise (0.002 * 10 = 0.02)
        p2Scaled.points = p2Scaled.points.map(p => ({
            x: p.x + (0.002 * scale),
            y: p.y
        }));

        // Run with SCALED tolerance (0.01 * 10 = 0.1)
        const result = removeOverdraw([p1Scaled, p2Scaled], 0.01 * scale);

        expect(result.length).toBe(1);
    });

    it('should NOT remove short consecutive segments (Self-Cannibalization)', () => {
        // Create a path with small steps
        // 0 -> 0.05 -> 0.1 (Unscaled units)
        // Scaled 10x: 0 -> 0.5 -> 1.0. 
        // Tolerance 0.1 (Scaled).
        // Segments are 0.5 len.
        const path = {
            points: [
                { x: 0, y: 0 },
                { x: 0.05, y: 0 },
                { x: 0.1, y: 0 },
                { x: 0.1, y: 0.05 }
            ],
            closed: false
        };

        // Scale up
        const scale = 10;
        const pScaled = {
            points: path.points.map(p => ({ x: p.x * scale, y: p.y * scale })),
            closed: false
        };

        const result = removeOverdraw([pScaled], 0.01 * scale);

        // Should keep all 3 segments. 
        const segments = result[0]?.points.length ? result[0].points.length - 1 : 0;
        expect(segments).toBe(3);
    });
});
