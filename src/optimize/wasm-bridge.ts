/**
 * WASM Bridge - Provides unified interface for region finding
 * Automatically uses WASM if available, falls back to TypeScript
 */

import type { Path } from '../geometry/types';
import { findRegions as findRegionsTS, type RegionFindingOptions } from './regions';

// WASM module (will be set if available)
let wasmModule: any = null;
let wasmAvailable = false;
let initError: string | null = null;

/**
 * Initialize WASM module (call once during worker startup)
 */
export async function initWasmBridge(): Promise<boolean> {
    console.log('[WASM Bridge] Starting initialization...');
    try {
        // Import the WASM JS wrapper
        const wasm = await import('../wasm-pkg/watertight_wasm.js');

        // Import the WASM binary URL (Vite handles this)
        // @ts-ignore - Vite URL import
        const wasmUrl = new URL('../wasm-pkg/watertight_wasm_bg.wasm', import.meta.url);

        console.log('[WASM Bridge] Loading WASM from:', wasmUrl.href);

        // Initialize with explicit URL
        await wasm.default(wasmUrl);

        wasmModule = wasm;
        wasmAvailable = true;

        console.log(`[WASM Bridge] ✅ Initialized successfully, version: ${wasm.version()}`);
        return true;
    } catch (error) {
        initError = String(error);
        console.error('[WASM Bridge] ❌ Failed to initialize WASM:', error);
        console.warn('[WASM Bridge] Using TypeScript implementation');
        wasmAvailable = false;
        return false;
    }
}

/**
 * Check if WASM is available
 */
export function isWasmReady(): boolean {
    return wasmAvailable;
}

/**
 * Find regions - uses WASM if enabled and available, otherwise TypeScript
 */
export function findRegionsBridge(
    paths: Path[],
    options: Partial<RegionFindingOptions> = {},
    useWasm: boolean = false
): Path[] {
    const { tolerance = 0.5, minArea = 1, onProgress } = options;

    console.log(`[Bridge] findRegionsBridge called: useWasm=${useWasm}, wasmAvailable=${wasmAvailable}, paths=${paths.length}`);

    if (initError) {
        console.log(`[Bridge] WASM init error was: ${initError}`);
    }

    // Use WASM if requested and available
    if (useWasm && wasmAvailable && wasmModule) {
        console.log('[Bridge] 🚀 Using WASM implementation');
        try {
            const startTime = performance.now();

            // Call WASM implementation (synchronous once loaded)
            const result = wasmModule.find_regions(paths, tolerance, minArea);

            const elapsed = performance.now() - startTime;
            console.log(`[WASM] ✅ Region finding: ${result.length} regions in ${elapsed.toFixed(2)}ms`);

            return result;
        } catch (error) {
            console.error('[WASM] ❌ Error during region finding:', error);
            console.warn('[WASM] Falling back to TypeScript');
        }
    } else {
        console.log(`[Bridge] 📝 Using TypeScript (useWasm=${useWasm}, wasmAvailable=${wasmAvailable})`);
    }

    // Use TypeScript implementation
    const startTime = performance.now();
    const result = findRegionsTS(paths, { tolerance, minArea, onProgress });
    const elapsed = performance.now() - startTime;
    console.log(`[TS] Region finding: ${result.length} regions in ${elapsed.toFixed(2)}ms`);

    return result;
}

