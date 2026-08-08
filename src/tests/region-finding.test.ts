/**
 * Region Finding Test Suite
 *
 * Runs the region finder over the sample SVGs, in increasing order of
 * difficulty, and guards against regressions in how many regions it recovers.
 * Coverage is the share of input segments that ended up inside a region -
 * higher is better.
 */

import { readFileSync } from 'fs';
import { describe, it, expect } from 'vitest';
import { parseSimpleSVG } from './simple-parser';
import { findRegions } from '../optimize/regions';
import { autoClosePaths, bridgeGaps } from '../optimize/fill';
import { scalePath } from '../geometry/math';
import type { Path } from '../geometry/types';

// Test configuration
const TOLERANCE = 1.0;    // Vertex snapping tolerance
const GAP_TOLERANCE = 2;  // Gap bridging tolerance
const MIN_AREA = 1;       // Minimum region area
const SCALE = 10;         // Internal scaling for precision

/**
 * Known-good region counts. These are a regression baseline, not a spec - if an
 * algorithm change moves them, check the new numbers are better (more regions
 * and higher coverage) before updating. The band absorbs float jitter across
 * platforms while still catching a real behavioural change.
 */
const EXPECTED_REGIONS: Record<string, number> = {
    'easy.svg': 11,
    'medium.svg': 39,
    'hard.svg': 51,
    'hardest.svg': 119,
    'hurt-me.svg': 567,
};

const REGION_COUNT_TOLERANCE = 0.05; // +/- 5%

interface TestResult {
    name: string;
    totalSegments: number;
    regions: number;
    segments: number;
    coverage: number;
    timeMs: number;
}

// Helper to count segments in paths
function countSegments(paths: Path[]): number {
    return paths.reduce((sum, p) => sum + Math.max(0, p.points.length - 1), 0);
}

// Load and parse SVG file using simple parser
function loadSVG(filename: string): Path[] {
    const content = readFileSync(`samples/${filename}`, 'utf-8');
    const doc = parseSimpleSVG(content);
    return doc.paths;
}

// Prepare paths for region finding
function preparePaths(paths: Path[]): Path[] {
    // Scale geometry for precision
    const scaled = paths.map(p => scalePath(p, SCALE));
    // Bridge gaps
    let bridged = autoClosePaths(scaled, GAP_TOLERANCE * SCALE);
    bridged = bridgeGaps(bridged, GAP_TOLERANCE * SCALE);
    return bridged;
}

function testSample(filename: string): TestResult {
    const paths = loadSVG(filename);
    const totalSegments = countSegments(paths);
    const bridged = preparePaths(paths);

    const start = performance.now();
    const regions = findRegions(bridged, {
        tolerance: TOLERANCE * SCALE,
        minArea: MIN_AREA * SCALE * SCALE,
    });
    const timeMs = performance.now() - start;

    const segments = countSegments(regions);

    return {
        name: filename,
        totalSegments,
        regions: regions.length,
        segments,
        coverage: totalSegments > 0 ? (segments / totalSegments) * 100 : 0,
        timeMs,
    };
}

const SAMPLES = Object.keys(EXPECTED_REGIONS);

describe('Region Finding Test Suite', () => {
    const results: TestResult[] = [];

    for (const sample of SAMPLES) {
        it(`should find regions in ${sample}`, () => {
            const r = testSample(sample);
            results.push(r);

            console.log(
                `📊 ${r.name} (${r.totalSegments} segments): ` +
                `${r.regions} regions, ${r.coverage.toFixed(0)}% coverage, ${r.timeMs.toFixed(0)}ms`
            );

            expect(r.totalSegments).toBeGreaterThan(0);

            // Region count should stay within the expected band
            const expected = EXPECTED_REGIONS[sample];
            const slack = Math.max(1, Math.round(expected * REGION_COUNT_TOLERANCE));
            expect(r.regions).toBeGreaterThanOrEqual(expected - slack);
            expect(r.regions).toBeLessThanOrEqual(expected + slack);

            // Regions must actually account for a meaningful share of the input
            expect(r.coverage).toBeGreaterThan(30);
        });
    }

    it('should produce a summary', () => {
        console.log('\n=== REGION FINDING SUMMARY ===\n');
        console.log('| Sample | Segs | Regions | Coverage | Time |');
        console.log('|--------|------|---------|----------|------|');

        for (const r of results) {
            console.log(
                `| ${r.name.padEnd(12)} | ${String(r.totalSegments).padStart(4)} | ` +
                `${String(r.regions).padStart(7)} | ${(r.coverage.toFixed(0) + '%').padStart(8)} | ` +
                `${(r.timeMs.toFixed(0) + 'ms').padStart(7)} |`
            );
        }

        const totalTime = results.reduce((s, r) => s + r.timeMs, 0);
        console.log(`\nTotal: ${totalTime.toFixed(0)}ms`);

        expect(results.length).toBe(SAMPLES.length);
    });
});
