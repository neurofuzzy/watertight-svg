
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { optimizeDocument } from '../optimize/pipeline';
import { parseSimpleSVG } from './simple-parser';
import { OptimizeOptions } from '../geometry/types';

describe('Plotter Mode Optimization', () => {
    // Load sample file
    const samplePath = path.resolve(__dirname, '../../samples/plottermode.svg');
    const svgContent = fs.readFileSync(samplePath, 'utf-8');

    // Parse using simple parser (Node-compatible)
    const originalDoc = parseSimpleSVG(svgContent);

    it('should improve efficiency in Plotter Mode (Merge+None) vs Standard Mode', () => {
        // 1. Standard Mode: No Merging, Default Splitting
        // This resembles the default state where "Merge Connected Segments" is off
        const standardOptions: OptimizeOptions = {
            mergePaths: false,
            removeOverdraw: false,
            splitIntersections: true, // Default
            sortPaths: false,         // Default off
            findRegions: false,
            closePaths: false,
            gapTolerance: 0.1,
            fixWinding: false,
            fillRule: 'evenodd',
            scaleToFit: false,
            paperSize: { width: 100, height: 100 },
            paperMargin: 10,
            penWeight: 0.5
        };

        const standardResult = optimizeDocument(originalDoc, standardOptions);

        // 2. Plotter Mode: Merge=On, Fill=None
        // The pipeline should FORCE splitIntersections=false and sortPaths=true
        const plotterOptions: OptimizeOptions = {
            mergePaths: true,         // TRIGGER
            removeOverdraw: false,
            splitIntersections: true, // Should be overridden to false
            sortPaths: false,         // Should be overridden to true
            findRegions: false,       // TRIGGER (None)
            closePaths: false,        // TRIGGER (None)
            gapTolerance: 0.1,
            fixWinding: false,
            fillRule: 'evenodd',
            scaleToFit: false,
            paperSize: { width: 100, height: 100 },
            paperMargin: 10,
            penWeight: 0.5
        };

        const plotterResult = optimizeDocument(originalDoc, plotterOptions);

        // Assertions

        // A) Path Count
        // Standard: Many small segments (from M commands and splitting)
        // Plotter: Segments merged into long continuous lines
        // Expect Plotter path count to be significantly LOWER
        console.log(`Standard Paths: ${standardResult.afterStats.pathCount}`);
        console.log(`Plotter Paths: ${plotterResult.afterStats.pathCount}`);
        expect(plotterResult.afterStats.pathCount).toBeLessThan(standardResult.afterStats.pathCount);

        // B) Travel Distance
        // Plotter mode forces Sort, so travel distance should be minimized
        // Even if standard had sorting off, the plotter result should be better or equal (but usually better due to merging)
        console.log(`Standard Travel: ${standardResult.afterStats.travelDistance}`);
        console.log(`Plotter Travel: ${plotterResult.afterStats.travelDistance}`);
        expect(plotterResult.afterStats.travelDistance).toBeLessThan(standardResult.afterStats.travelDistance);

        // C) Split Intersections Check (Indirect)
        // If splitting was enabled in plotter mode, cutting complex crossing lines would fragment them.
        // It's hard to test boolean "splitIntersections" directly without a spy, 
        // but significantly lower path count on a complex file is a strong indicator.
        // We can also check if segment count increased significantly in standard (due to splits) vs plotter.
        // Actually, merging reduces segment count (by bridging vertices), splitting increases it.
        // So Plotter Mode (Merge - Split) should have FEWER vertices/segments than Standard (Split - Merge).

        // Note: segmentCount in stats tracks (points - 1).
        // Merging 2 segments (A-B, B-C) -> (A-B-C) : 2 segments -> 2 segments (no change in logical count, just grouped).
        // Splitting (A-C) at B -> (A-B, B-C) : 1 segment -> 2 segments.
        // So Standard Mode (Splitting) should have MORE segments than Plotter Mode (No Split).
        console.log(`Standard Segments: ${standardResult.afterStats.segmentCount}`);
        console.log(`Plotter Segments: ${plotterResult.afterStats.segmentCount}`);
        expect(plotterResult.afterStats.segmentCount).toBeLessThanOrEqual(standardResult.afterStats.segmentCount);
    });
});
