/**
 * WASM Region Finding Wrapper
 * 
 * Provides a TypeScript interface to the Rust WASM region-finding implementation.
 * Falls back to the TypeScript implementation if WASM is unavailable.
 */

import type { Path } from '../geometry/types';
import { findRegions as findRegionsTS } from './regions';

// WASM module interface
interface WasmModule {
    find_regions: (paths: unknown, tolerance: number, minArea: number) => Path[];
    version: () => string;
}

// Cached WASM module
let wasmModule: WasmModule | null = null;
let wasmLoadAttempted = false;
let wasmLoadError: Error | null = null;

/**
 * Initialize the WASM module
 */
async function initWasm(): Promise<WasmModule | null> {
    if (wasmLoadAttempted) {
        return wasmModule;
    }
    wasmLoadAttempted = true;

    try {
        // Dynamic import of the WASM package
        const wasm = await import('../wasm-pkg/watertight_wasm.js');
        await wasm.default(); // Initialize WASM

        wasmModule = {
            find_regions: wasm.find_regions,
            version: wasm.version,
        };

        console.log(`[WASM] Region finding module loaded, version: ${wasmModule.version()}`);
        return wasmModule;
    } catch (error) {
        wasmLoadError = error as Error;
        console.warn('[WASM] Failed to load region finding module:', error);
        console.warn('[WASM] Falling back to TypeScript implementation');
        return null;
    }
}

/**
 * Check if WASM module is available
 */
export async function isWasmAvailable(): Promise<boolean> {
    const module = await initWasm();
    return module !== null;
}

/**
 * Get WASM load error if any
 */
export function getWasmError(): Error | null {
    return wasmLoadError;
}

export interface WasmRegionOptions {
    tolerance?: number;
    minArea?: number;
    /** If true, run both implementations and compare */
    compareMode?: boolean;
    /** Progress callback */
    onProgress?: (percent: number) => void;
}

/**
 * Find regions using WASM implementation
 * Falls back to TypeScript if WASM unavailable
 */
export async function findRegionsWasm(
    paths: Path[],
    options: WasmRegionOptions = {}
): Promise<Path[]> {
    const {
        tolerance = 0.5,
        minArea = 1,
        compareMode = false,
        onProgress,
    } = options;

    const module = await initWasm();

    if (!module) {
        // Fall back to TypeScript implementation
        return findRegionsTS(paths, { tolerance, minArea, onProgress });
    }

    try {
        const startTime = performance.now();

        // Run WASM implementation
        const wasmResult = module.find_regions(paths, tolerance, minArea);

        const wasmTime = performance.now() - startTime;
        console.log(`[WASM] Region finding completed in ${wasmTime.toFixed(2)}ms`);

        if (compareMode) {
            // Also run TypeScript for comparison
            const tsStart = performance.now();
            const tsResult = findRegionsTS(paths, { tolerance, minArea });
            const tsTime = performance.now() - tsStart;

            console.log(`[TS] Region finding completed in ${tsTime.toFixed(2)}ms`);
            console.log(`[Compare] WASM: ${wasmResult.length} regions, TS: ${tsResult.length} regions`);
            console.log(`[Compare] Speedup: ${(tsTime / wasmTime).toFixed(2)}x`);

            // Verify results match
            if (wasmResult.length !== tsResult.length) {
                console.warn('[Compare] Region count mismatch!');
            }
        }

        return wasmResult;
    } catch (error) {
        console.error('[WASM] Error during region finding:', error);
        console.warn('[WASM] Falling back to TypeScript implementation');
        return findRegionsTS(paths, { tolerance, minArea, onProgress });
    }
}
