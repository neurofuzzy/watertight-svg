/**
 * Watertight SVG - Main Application Entry Point
 */

import './index.css';
import type { OptimizeOptions } from './geometry/types';
import { parseSVG } from './geometry/parser';
import { formatStats, type OptimizeResult } from './optimize';
import type { WorkerMessage, WorkerResponse } from './worker';
import { renderPreview } from './ui/preview';
import { downloadSVG } from './ui/export';

// DOM Elements
const dropZone = document.getElementById('dropZone')!;
const fileInput = document.getElementById('fileInput') as HTMLInputElement;
const browseBtn = document.getElementById('browseBtn')!;
const previewContainer = document.getElementById('previewContainer')!;
const originalPreview = document.getElementById('originalPreview')!;
const optimizedPreview = document.getElementById('optimizedPreview')!;
const originalStats = document.getElementById('originalStats')!;
const optimizedStats = document.getElementById('optimizedStats')!;
const controls = document.getElementById('controls')!;
const optimizeBtn = document.getElementById('optimizeBtn')!;
const exportBtn = document.getElementById('exportBtn')!;

// Control inputs
const breakApartInput = document.getElementById('breakApart') as HTMLInputElement;
const mergePathsInput = document.getElementById('mergePaths') as HTMLInputElement;
const removeOverdrawInput = document.getElementById('removeOverdraw') as HTMLInputElement;
const sortPathsInput = document.getElementById('sortPaths') as HTMLInputElement;
const gapToleranceInput = document.getElementById('gapTolerance') as HTMLInputElement;
const gapToleranceContainer = document.getElementById('gapToleranceContainer')!;
const gapValueSpan = document.getElementById('gapValue')!;
const fixWindingInput = document.getElementById('fixWinding') as HTMLInputElement;
const fillRuleInput = document.getElementById('fillRule') as HTMLSelectElement;

// Application state
let currentSVG: string | null = null;
let currentResult: OptimizeResult | null = null;

// Worker Management
let worker: Worker | null = null;
let isOptimizing = false;

// Initialize
function init() {
    setupDragAndDrop();
    setupFileInput();
    setupControls();
    setupButtons();
    // Initialize dependencies on load
    updateDependencies();
}

// Drag and drop handling
function setupDragAndDrop() {
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('drag-over');
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');

        const files = e.dataTransfer?.files;
        if (files && files.length > 0) {
            handleFile(files[0]);
        }
    });
}

// File input handling
function setupFileInput() {
    browseBtn.addEventListener('click', () => {
        fileInput.click();
    });

    fileInput.addEventListener('change', () => {
        if (fileInput.files && fileInput.files.length > 0) {
            handleFile(fileInput.files[0]);
        }
    });
}

// Handle file selection
async function handleFile(file: File) {
    if (!file.type.includes('svg') && !file.name.endsWith('.svg')) {
        alert('Please select an SVG file');
        return;
    }

    try {
        currentSVG = await file.text();
        showPreview();
        runOptimization();
    } catch (error) {
        console.error('Error reading file:', error);
        alert('Error reading file');
    }
}

// Show the preview section
function showPreview() {
    previewContainer.removeAttribute('hidden');
    controls.removeAttribute('hidden');
    dropZone.style.height = '80px';
    dropZone.style.padding = 'var(--space-md)';
}

// Setup control inputs
function setupControls() {
    // Gap tolerance slider
    gapToleranceInput.addEventListener('input', () => {
        gapValueSpan.textContent = `${gapToleranceInput.value}px`;
    });

    // Auto-optimize on control changes
    const autoOptimize = () => {
        updateDependencies();
        if (currentSVG) {
            runOptimization();
        }
    };

    breakApartInput.addEventListener('change', autoOptimize);
    mergePathsInput.addEventListener('change', autoOptimize);
    removeOverdrawInput.addEventListener('change', autoOptimize);
    sortPathsInput.addEventListener('change', autoOptimize);
    gapToleranceInput.addEventListener('change', autoOptimize);
    fixWindingInput.addEventListener('change', autoOptimize);
    fillRuleInput.addEventListener('change', autoOptimize);

    // Fill Strategy Radios
    const fillRadios = document.querySelectorAll('input[name="fillStrategy"]');
    fillRadios.forEach(radio => {
        radio.addEventListener('change', autoOptimize);
    });
}

// Update UI dependencies based on rules
function updateDependencies() {
    const merge = mergePathsInput.checked;
    const overdraw = removeOverdrawInput.checked;
    const fillStrategy = getFillStrategy();

    // 1. Fill Strategy requires Merge Connected Segments
    const fillRadios = document.querySelectorAll('input[name="fillStrategy"]');
    fillRadios.forEach((radio: Element) => {
        const input = radio as HTMLInputElement;
        if (input.value !== 'none') {
            input.disabled = !merge;
            // Add tooltip or visual indicator? For now just disable.
            if (!merge && input.checked) {
                // If currently checked but disabled, should we switch to none?
                // User experience is better if we auto-check merge, but let's stick to strict guards first.
                // Or just let it be disabled.
            }
        }
    });

    // 2. Gap Tolerance only visible if Fill != None
    if (fillStrategy === 'none' || (!merge && fillStrategy !== 'none')) {
        gapToleranceContainer.style.opacity = '0.5';
        gapToleranceContainer.style.pointerEvents = 'none';
    } else {
        gapToleranceContainer.style.opacity = '1';
        gapToleranceContainer.style.pointerEvents = 'auto';
    }

    // 3. Fix Winding requires Merge + Overdraw + Fill
    const windingEnabled = merge && overdraw && (fillStrategy !== 'none');
    if (windingEnabled) {
        fixWindingInput.disabled = false;
        fixWindingInput.parentElement!.title = "";
    } else {
        fixWindingInput.disabled = true;
        fixWindingInput.checked = false;
        fixWindingInput.parentElement!.title = "Requires: Fill Strategy, Merge Paths, Remove Overdraw";
    }
}

// Get selected fill strategy
function getFillStrategy(): 'none' | 'close' | 'regions' {
    const checked = document.querySelector('input[name="fillStrategy"]:checked') as HTMLInputElement;
    return (checked?.value || 'none') as 'none' | 'close' | 'regions';
}

// Setup buttons
function setupButtons() {
    optimizeBtn.addEventListener('click', () => {
        if (currentSVG) {
            runOptimization();
        }
    });

    exportBtn.addEventListener('click', () => {
        if (currentResult) {
            downloadSVG(currentResult.optimized, 'optimized.svg');
        }
    });
}

// Get current options from UI
function getOptions(): OptimizeOptions {
    const fillStrategy = getFillStrategy();

    return {
        breakApart: breakApartInput.checked,
        mergePaths: mergePathsInput.checked,
        removeOverdraw: removeOverdrawInput.checked,
        sortPaths: sortPathsInput.checked,
        // Map fill strategy to options
        findRegions: fillStrategy === 'regions',
        closePaths: fillStrategy === 'close',
        gapTolerance: parseFloat(gapToleranceInput.value),
        fixWinding: fixWindingInput.checked,
        fillRule: fillRuleInput.value as 'evenodd' | 'nonzero',
    };
}

// Create or reset worker
function createWorker() {
    if (worker) {
        worker.terminate();
    }
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

    // Handle worker messages
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const { type } = e.data;

        if (type === 'success') {
            const response = e.data as { type: 'success', result: OptimizeResult };
            handleOptimizationSuccess(response.result);
        } else if (type === 'progress') {
            const response = e.data as { type: 'progress', percent: number, message?: string };
            updateProgress(response.percent, response.message);
        } else {
            const response = e.data as { type: 'error', error: string };
            handleOptimizationError(response.error);
        }
    };
}

// Run optimization via Worker
function runOptimization() {
    if (!currentSVG) return;

    // Show loading state
    setLoading(true);

    try {
        const options = getOptions();

        // Parse SVG locally to use DOM APIs
        const document = parseSVG(currentSVG);

        // Reset worker for new task (cancellation)
        createWorker();
        isOptimizing = true;

        // Send parsed document to worker
        if (worker) {
            worker.postMessage({
                type: 'optimize',
                document,
                options
            } as WorkerMessage);
        }

    } catch (error) {
        console.error('Error starting optimization:', error);
        setLoading(false);
    }
}

// Handle successful optimization from worker
function handleOptimizationSuccess(result: OptimizeResult) {
    currentResult = result;
    isOptimizing = false;

    // Render previews
    renderPreview(originalPreview, currentResult.original, {
        showTravel: false,
        drawColor: '#a0a0b0',
    });

    renderPreview(optimizedPreview, currentResult.optimized, {
        showTravel: true,
    });

    // Update stats
    originalStats.textContent = formatStats(currentResult.beforeStats);
    optimizedStats.textContent = formatStats(currentResult.afterStats);

    // Enable export
    exportBtn.removeAttribute('disabled');

    // Log improvement
    const reduction = (
        (1 - currentResult.afterStats.travelDistance /
            (currentResult.beforeStats.travelDistance || 1)) * 100
    ).toFixed(1);

    console.log(`Optimization complete: ${reduction}% travel reduction`);

    // Hide loading
    setLoading(false);
}

// Handle error from worker
function handleOptimizationError(error: string) {
    console.error('Optimization worker error:', error);
    isOptimizing = false;
    // Don't alert if terminated? Worker termination doesn't emit error usually.
    // Use generic error handling.
    if (error) {
        alert('Optimization failed: ' + error);
    }
    setLoading(false);
}

// Update progress overlay
function updateProgress(percent: number, message?: string) {
    const overlay = document.getElementById('loadingOverlay');
    if (!overlay) return;

    // Create progress elements if needed
    let container = overlay.querySelector('.progress-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'progress-container';
        container.innerHTML = `
            <div class="progress-text">Processing...</div>
            <div class="progress-bar">
                <div class="progress-fill"></div>
            </div>
        `;
        overlay.appendChild(container);
    }

    const text = container.querySelector('.progress-text')!;
    const fill = container.querySelector('.progress-fill') as HTMLElement;

    text.textContent = message || `${Math.round(percent * 100)}%`;
    fill.style.width = `${Math.round(percent * 100)}%`;
}

// Toggle loading state
function setLoading(loading: boolean) {
    if (loading) {
        // Add overlays if they don't exist
        if (!document.getElementById('loadingOverlay')) {
            const overlay = document.createElement('div');
            overlay.id = 'loadingOverlay';
            overlay.className = 'loading-overlay';
            overlay.innerHTML = '<div class="spinner"></div>';
            optimizedPreview.appendChild(overlay);
        }
        optimizeBtn.setAttribute('disabled', 'true');
        exportBtn.setAttribute('disabled', 'true');
        document.body.style.cursor = 'wait';
    } else {
        // Remove overlay
        const overlay = document.getElementById('loadingOverlay');
        if (overlay) overlay.remove();

        optimizeBtn.removeAttribute('disabled');
        // Export button state is handled in success
        document.body.style.cursor = 'default';
    }
}

// Start the app
init();
