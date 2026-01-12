/**
 * Web Worker for SVG Optimization
 * Handles CPU-intensive optimization tasks off the main thread.
 */

import { optimizeDocument, type OptimizeResult } from './optimize';
import type { OptimizeOptions, SVGDocument } from './geometry/types';
import { initWasmBridge, isWasmReady } from './optimize/wasm-bridge';

// Define message types
export type WorkerMessage = {
    type: 'optimize';
    document: SVGDocument;
    options: OptimizeOptions;
};

export type WorkerResponse = {
    type: 'success';
    result: OptimizeResult;
} | {
    type: 'error';
    error: string;
} | {
    type: 'progress';
    percent: number;
    message?: string;
} | {
    type: 'wasm-ready';
    ready: boolean;
};

// WASM initialization promise
let wasmInitPromise: Promise<boolean> | null = null;

// Start WASM initialization immediately
wasmInitPromise = initWasmBridge().then((ready) => {
    // Notify main thread if WASM is ready
    self.postMessage({
        type: 'wasm-ready',
        ready
    } as WorkerResponse);
    return ready;
});

// Handle incoming messages
self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
    const { type, document, options } = e.data;

    if (type === 'optimize') {
        try {
            // Wait for WASM to finish initializing if user wants it
            if (options.useWasm && wasmInitPromise) {
                console.log('[Worker] Waiting for WASM to initialize...');
                await wasmInitPromise;
                console.log('[Worker] WASM ready:', isWasmReady());
            }

            // Log WASM status
            if (options.useWasm && !isWasmReady()) {
                console.warn('[Worker] WASM requested but not available, using TypeScript');
            } else if (options.useWasm && isWasmReady()) {
                console.log('[Worker] 🚀 Using WASM implementation');
            }

            // Run the optimization pipeline on parsed document
            const result = optimizeDocument(document, options, (percent) => {
                // Throttle progress updates here or just pass through
                self.postMessage({
                    type: 'progress',
                    percent,
                    message: 'Finding regions...'
                } as WorkerResponse);
            });

            // Send back result
            self.postMessage({
                type: 'success',
                result
            } as WorkerResponse);
        } catch (error) {
            console.error('Optimization worker error:', error);
            self.postMessage({
                type: 'error',
                error: String(error)
            } as WorkerResponse);
        }
    }
};
