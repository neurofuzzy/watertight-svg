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
import { PanZoomController } from './ui/panzoom';
import { Simulator } from './ui/simulator';

// DOM Elements
const dropZone = document.getElementById('dropZone')!;
const fileInput = document.getElementById('fileInput') as HTMLInputElement;
const browseBtn = document.getElementById('browseBtn')!;
const workspace = document.getElementById('workspace')!;
const originalPreview = document.getElementById('originalPreview')!;
const optimizedPreview = document.getElementById('optimizedPreview')!;
const originalStats = document.getElementById('originalStats')!;
const optimizedStats = document.getElementById('optimizedStats')!;
const optimizeBtn = document.getElementById('optimizeBtn')!;
const exportBtn = document.getElementById('exportBtn')!;

// Control inputs
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
let shouldResetZoom = false;

// Worker Management
let worker: Worker | null = null;
const panZoom = new PanZoomController();

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
        shouldResetZoom = true;
        showPreview();
        runOptimization();
    } catch (error) {
        console.error('Error reading file:', error);
        alert('Error reading file');
    }
}

// Show the preview section
function showPreview() {
    workspace.removeAttribute('hidden');
    // controls are inside workspace, so they appear automatically
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
        }
    });

    // 2. Gap Tolerance only visible if Fill != None
    if (fillStrategy === 'none' || !merge) {
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
        mergePaths: mergePathsInput.checked,
        removeOverdraw: removeOverdrawInput.checked,
        splitIntersections: true, // Always split intersections for better results
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

    // Render previews
    renderPreview(originalPreview, currentResult.original, {
        showTravel: false,
        drawColor: '#a0a0b0',
    });

    renderPreview(optimizedPreview, currentResult.optimized, {
        showTravel: true,
    });

    // Attach Pan/Zoom controller
    const originalSvg = originalPreview.querySelector('svg');
    const optimizedSvg = optimizedPreview.querySelector('svg');

    if (originalSvg && optimizedSvg) {
        panZoom.attach([originalSvg, optimizedSvg], shouldResetZoom);
        shouldResetZoom = false;
    }

    // Update stats
    originalStats.textContent = formatStats(currentResult.beforeStats);
    optimizedStats.textContent = formatStats(currentResult.afterStats);

    // Enable export & simulate
    exportBtn.removeAttribute('disabled');
    (document.getElementById('simulateBtn') as HTMLButtonElement).removeAttribute('disabled');

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
// Simulator Integration
const simulateBtn = document.getElementById('simulateBtn') as HTMLButtonElement;
const simulationModal = document.getElementById('simulationModal')!;
const closeSimBtn = document.getElementById('closeSimBtn')!;
const simCanvas = document.getElementById('simCanvas') as HTMLCanvasElement;
const simPlayPauseBtn = document.getElementById('simPlayPause')!;
const playIcon = simPlayPauseBtn.querySelector('.play-icon')!;
const pauseIcon = simPlayPauseBtn.querySelector('.pause-icon')!;
const simTime = document.getElementById('simTime')!;
const simScrubber = document.getElementById('simScrubber') as HTMLInputElement;
const simProgressBar = document.getElementById('simProgressBar')!;
const simSpeedSelect = document.getElementById('simSpeed') as HTMLSelectElement;
const simBlotsCheckbox = document.getElementById('simBlots') as HTMLInputElement;
const simTravelCheckbox = document.getElementById('simTravel') as HTMLInputElement;

let simulator: Simulator | null = null;
let isUserScrubbing = false;

function initSimulator() {
    if (!currentResult) return;

    // Show modal
    simulationModal.classList.remove('hidden');

    // Init Simulator if needed
    if (!simulator) {
        try {
            simulator = new Simulator(simCanvas);

            // Wire up callbacks
            simulator.onProgress = (percent, timeStr) => {
                // Update scrubber only if user isn't dragging it
                if (!isUserScrubbing) {
                    simScrubber.value = (percent * 100).toString();
                }
                // Update progress bar visual
                simProgressBar.style.width = `${percent * 100}%`;
                // Update time display
                simTime.textContent = timeStr;
            };

            simulator.onComplete = () => {
                updatePlayPauseIcon(false);
            };

            // Resize observer to handle modal transitions
            const observer = new ResizeObserver(() => {
                simulator?.resize();
            });
            observer.observe(simulationModal.querySelector('.sim-canvas-container')!);

        } catch (e) {
            console.error('Failed to init simulator:', e);
            alert('WebGL not supported or initialization failed');
            simulationModal.classList.add('hidden');
            return;
        }
    }

    // Load data
    const viewPort = currentResult.optimized.viewBox || { width: 800, height: 600 };
    // Handle viewBox as string or object
    let width = 800, height = 600;
    if (typeof viewPort === 'string') {
        const parts = viewPort.split(' ').map(parseFloat);
        if (parts.length === 4) {
            width = parts[2];
            height = parts[3];
        }
    } else {
        width = viewPort.width;
        height = viewPort.height;
    }

    simulator.setData(currentResult.optimized.paths, { width, height });

    // Reset controls
    simScrubber.value = "0";
    simProgressBar.style.width = "0%";
    simSpeedSelect.value = "10";
    simulator.setSpeed(10);

    // Wire up blots toggle
    simBlotsCheckbox.addEventListener('change', () => {
        simulator?.setBlots(simBlotsCheckbox.checked);
    });
    // Wire up travel toggle
    simTravelCheckbox.addEventListener('change', () => {
        simulator?.setTravel(simTravelCheckbox.checked);
    });

    // Initial state
    simulator.setBlots(simBlotsCheckbox.checked);
    simulator.setTravel(simTravelCheckbox.checked);

    // Auto-play
    simulator.play();
    updatePlayPauseIcon(true);
}

function updatePlayPauseIcon(isPlaying: boolean) {
    if (isPlaying) {
        playIcon.classList.add('hidden');
        pauseIcon.classList.remove('hidden');
    } else {
        playIcon.classList.remove('hidden');
        pauseIcon.classList.add('hidden');
    }
}

// Event Listeners for Simulator
simulateBtn.addEventListener('click', initSimulator);

closeSimBtn.addEventListener('click', () => {
    simulationModal.classList.add('hidden');
    if (simulator) {
        simulator.pause();
    }
});

simPlayPauseBtn.addEventListener('click', () => {
    if (!simulator) return;
    // Toggle
    // We can't easily check isPlaying from outside without exposing it, 
    // so we'll track implied state or check icon
    const isPlaying = playIcon.classList.contains('hidden');

    if (isPlaying) {
        simulator.pause();
        updatePlayPauseIcon(false);
    } else {
        simulator.play();
        updatePlayPauseIcon(true);
    }
});

simSpeedSelect.addEventListener('change', () => {
    if (!simulator) return;
    simulator.setSpeed(parseFloat(simSpeedSelect.value));
});

simScrubber.addEventListener('mousedown', () => { isUserScrubbing = true; });
simScrubber.addEventListener('touchstart', () => { isUserScrubbing = true; }); // Mobile

const handleScrubEnd = () => {
    if (!simulator) return;
    isUserScrubbing = false;
    // Commit the value
    const percent = parseFloat(simScrubber.value) / 100;
    simulator.setProgress(percent);
};

simScrubber.addEventListener('mouseup', handleScrubEnd);
simScrubber.addEventListener('touchend', handleScrubEnd);
simScrubber.addEventListener('input', () => {
    if (!simulator) return;
    const percent = parseFloat(simScrubber.value) / 100;
    simProgressBar.style.width = `${percent * 100}%`;
    simulator.setProgress(percent);
});
// Start the app
init();
