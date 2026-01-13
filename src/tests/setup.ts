
import { vi } from 'vitest';

// Create a mock canvas
class MockOffscreenCanvas {
    width: number;
    height: number;

    constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
    }

    getContext() {
        return {
            fillStyle: '',
            globalCompositeOperation: '',
            fillRect: vi.fn(),
            beginPath: vi.fn(),
            moveTo: vi.fn(),
            lineTo: vi.fn(),
            closePath: vi.fn(),
            fill: vi.fn(),
            getImageData: () => ({
                data: new Uint8ClampedArray(4).fill(0) // Return 0 depth by default
            })
        };
    }
}

// Mock global
vi.stubGlobal('OffscreenCanvas', MockOffscreenCanvas);
