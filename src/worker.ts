/**
 * Web Worker for SVG Optimization
 * Handles CPU-intensive optimization tasks off the main thread.
 */

import { optimizeDocument, type OptimizeResult } from './optimize';
import type { OptimizeOptions, SVGDocument } from './geometry/types';

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
};

// Handle incoming messages
self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
    const { type, document, options } = e.data;

    if (type === 'optimize') {
        try {
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
