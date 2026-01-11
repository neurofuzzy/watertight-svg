/**
 * Watertight SVG - Main Application Entry Point
 */

import './index.css';
import type { OptimizeOptions } from './geometry/types';
import { optimize, formatStats, type OptimizeResult } from './optimize';
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
const mergePathsInput = document.getElementById('mergePaths') as HTMLInputElement;
const removeOverdrawInput = document.getElementById('removeOverdraw') as HTMLInputElement;
const sortPathsInput = document.getElementById('sortPaths') as HTMLInputElement;
const findRegionsInput = document.getElementById('findRegions') as HTMLInputElement;
const closePathsInput = document.getElementById('closePaths') as HTMLInputElement;
const gapToleranceInput = document.getElementById('gapTolerance') as HTMLInputElement;
const gapValueSpan = document.getElementById('gapValue')!;
const fixWindingInput = document.getElementById('fixWinding') as HTMLInputElement;
const fillRuleInput = document.getElementById('fillRule') as HTMLSelectElement;

// Application state
let currentSVG: string | null = null;
let currentResult: OptimizeResult | null = null;

// Initialize
function init() {
    setupDragAndDrop();
    setupFileInput();
    setupControls();
    setupButtons();
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
        if (currentSVG) {
            runOptimization();
        }
    };

    mergePathsInput.addEventListener('change', autoOptimize);
    removeOverdrawInput.addEventListener('change', autoOptimize);
    sortPathsInput.addEventListener('change', autoOptimize);
    findRegionsInput.addEventListener('change', autoOptimize);
    closePathsInput.addEventListener('change', autoOptimize);
    gapToleranceInput.addEventListener('change', autoOptimize);
    fixWindingInput.addEventListener('change', autoOptimize);
    fillRuleInput.addEventListener('change', autoOptimize);
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
    return {
        mergePaths: mergePathsInput.checked,
        removeOverdraw: removeOverdrawInput.checked,
        sortPaths: sortPathsInput.checked,
        findRegions: findRegionsInput.checked,
        closePaths: closePathsInput.checked,
        gapTolerance: parseFloat(gapToleranceInput.value),
        fixWinding: fixWindingInput.checked,
        fillRule: fillRuleInput.value as 'evenodd' | 'nonzero',
    };
}

// Run optimization
function runOptimization() {
    if (!currentSVG) return;

    try {
        const options = getOptions();
        currentResult = optimize(currentSVG, options);

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

    } catch (error) {
        console.error('Optimization error:', error);
    }
}

// Start the app
init();
