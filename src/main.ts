/**
 * Watertight SVG - Main Application Entry Point
 */

import './index.css';
import { type OptimizeOptions, type SVGDocument, type Path } from './geometry/types';
import { parseSVG } from './geometry/parser';
import { formatStats, type OptimizeResult } from './optimize';
import { fitToPaper } from './optimize/scale';
import type { WorkerMessage, WorkerResponse } from './worker';
import { renderPreview } from './ui/preview';
import { downloadSVG } from './ui/export';
import { PanZoomController } from './ui/panzoom';
import { Simulator } from './ui/simulator';
import { groupPathsByDepth } from './optimize/nesting';
import {
    isPlottingSupported, placeForMachine, PlotSession, speedToMms,
    envelopeViolation, requestEbbPort, MACHINE_ENVELOPES, DEFAULT_PROFILE,
    type Profile, type HomeCorner,
} from './plot/plot';

// DOM Elements
const dropZone = document.getElementById('dropZone')!;
const fileInput = document.getElementById('fileInput') as HTMLInputElement;
const browseBtn = document.getElementById('browseBtn')!;
const workspace = document.getElementById('workspace')!;
const originalPreview = document.getElementById('originalPreview')!;
const optimizedPreview = document.getElementById('optimizedPreview')!;
const originalStats = document.getElementById('originalStats')!;
const optimizedStats = document.getElementById('optimizedStats')!;
const exportBtn = document.getElementById('exportBtn')!;

// Control inputs
const mergePathsInput = document.getElementById('mergePaths') as HTMLInputElement;
const removeOverdrawInput = document.getElementById('removeOverdraw') as HTMLInputElement;
const sortPathsInput = document.getElementById('sortPaths') as HTMLInputElement;
const gapToleranceInput = document.getElementById('gapTolerance') as HTMLInputElement;
const gapToleranceContainer = document.getElementById('gapToleranceContainer')!;
const gapValueSpan = document.getElementById('gapValue')!;
const fixWindingInput = document.getElementById('fixWinding') as HTMLInputElement;
const discardPageRectsInput = document.getElementById('discardPageRects') as HTMLInputElement;

// Page Setup Controls
const pageSetupBtn = document.getElementById('pageSetupBtn')!;
const pageSetupModal = document.getElementById('pageSetupModal')!;
const closePageSetupBtn = document.getElementById('closePageSetupBtn')!;
const scaleToFitInput = document.getElementById('scaleToFit') as HTMLInputElement;
// Scale to Fit defaults to TRUE per user request, update DOM manual override if HTML checked attribute isn't set
scaleToFitInput.checked = true;
const rotateOutputInput = document.getElementById('rotateOutput') as HTMLInputElement;
const layerByDepthInput = document.getElementById('layerByDepth') as HTMLInputElement;

const paperSettingsContainer = document.getElementById('paperSettings')!;
const customWidthInput = document.getElementById('customWidth') as HTMLInputElement;
const customHeightInput = document.getElementById('customHeight') as HTMLInputElement;

const paperMarginInput = document.getElementById('paperMargin') as HTMLInputElement;
const marginValueSpan = document.getElementById('marginValue')!;
const penWeightInput = document.getElementById('penWeight') as HTMLInputElement;
const penWeightValueSpan = document.getElementById('penWeightValue')!;

// Units
// Units
const unitToggle = document.getElementById('unitToggle') as HTMLInputElement;
const unitLabelMM = document.getElementById('unitLabelMM')!;
const unitLabelIN = document.getElementById('unitLabelIN')!;
const unitLabels = document.querySelectorAll('.unit-label') as NodeListOf<HTMLElement>;

let currentUnit = 'in'; // Default to Imperial

// Defaults


// Application state
let currentSVG: string | null = null;
let currentResult: OptimizeResult | null = null;
let shouldResetZoom = false;

// Worker Management
let worker: Worker | null = null;
const panZoom = new PanZoomController();

// Initialize
function init() {
    loadSettings();
    updateUnitLabels();

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

// Update preview with current layer settings
function updatePreviewWithCurrentLayers() {
    if (!currentResult) return;

    // Calculate layers if layer by depth is enabled
    let layers: Map<number, Path[]> | undefined;
    if (layerByDepthInput.checked) {
        layers = groupPathsByDepth(currentResult.optimized.paths);
    }

    // Check for Plotter Mode (Merge + None) to disable fill preview
    const options = getOptions();
    const isPlotterMode = options.mergePaths && !options.findRegions && !options.closePaths;

    renderPreview(optimizedPreview, currentResult.optimized, {
        showTravel: true,
        useLayerColors: layerByDepthInput.checked,
        ...(isPlotterMode && { fillColor: 'none' })
    }, layers);

    // Re-attach pan/zoom controller to new SVG elements to maintain sync and state
    const originalSvg = originalPreview.querySelector('svg');
    const optimizedSvg = optimizedPreview.querySelector('svg');

    if (originalSvg && optimizedSvg) {
        // Pass false to preserve current zoom/pan state
        panZoom.attach([originalSvg, optimizedSvg], false);
    }

    // Update optimized stats display with current layer count
    const optimizedStatsWithLayers = { ...currentResult.afterStats };
    if (layerByDepthInput.checked) {
        optimizedStatsWithLayers.layerCount = layers ? layers.size : 1;
    } else {
        optimizedStatsWithLayers.layerCount = 1;
    }
    optimizedStats.textContent = formatStats(optimizedStatsWithLayers);
}

/**
 * Point the preset radio at whichever preset the current control state matches,
 * falling back to "custom". Module scope so it can also run after loadSettings().
 */
function checkPresets() {
    const isOverdraw = removeOverdrawInput.checked;
    const isMerge = mergePathsInput.checked;
    const fillStrategy = getFillStrategy();
    const isWinding = fixWindingInput.checked; // Note: might be disabled/unchecked in plotter mode
    const isSort = sortPathsInput.checked;

    // Cutter Definition
    const isCutter = isOverdraw && isMerge && fillStrategy === 'regions' && isWinding && isSort;

    // Plotter Definition
    // Note: fixWinding input is unchecked in plotter mode.
    // We strictly check the inputs state here.
    const isPlotter = isOverdraw && isMerge && fillStrategy === 'none' && !isWinding && isSort; // Plotter mode forces Sort internally, but UI should reflect desired state

    const match = isCutter ? 'cutter' : isPlotter ? 'plotter' : 'custom';
    const radio = document.querySelector(`input[name="preset"][value="${match}"]`) as HTMLInputElement;
    if (radio) radio.checked = true;
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



    // Preset Radios
    const presetRadios = document.querySelectorAll('input[name="preset"]') as NodeListOf<HTMLInputElement>;

    // Define Presets
    const applyPreset = (preset: 'cutter' | 'plotter') => {
        if (preset === 'cutter') {
            // Cutter defaults: All Optimizations ON, Regions Fill
            removeOverdrawInput.checked = true;
            mergePathsInput.checked = true;

            // Set Fill to Regions
            const regionsRadio = document.querySelector('input[name="fillStrategy"][value="regions"]') as HTMLInputElement;
            if (regionsRadio) regionsRadio.checked = true;

            fixWindingInput.checked = true;
            sortPathsInput.checked = true;
        } else if (preset === 'plotter') {
            // Plotter defaults: Overdraw+Merge ON, Fill NONE, Winding OFF, Sort ON
            removeOverdrawInput.checked = true;
            mergePathsInput.checked = true;

            // Set Fill to None
            const noneRadio = document.querySelector('input[name="fillStrategy"][value="none"]') as HTMLInputElement;
            if (noneRadio) noneRadio.checked = true;

            fixWindingInput.checked = false; // Disabled naturally by logic, but explicit check off
            sortPathsInput.checked = true;
        }

        // Trigger updates
        autoOptimize();
        saveSettings();
    };

    // Preset Listener
    presetRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            const val = (e.target as HTMLInputElement).value;
            if (val !== 'custom') {
                applyPreset(val as 'cutter' | 'plotter');
            }
        });
    });

    // Modified listener wrapper to sync presets
    const onSettingChange = () => {
        autoOptimize();
        checkPresets();
        saveSettings();
    };

    mergePathsInput.addEventListener('change', onSettingChange);
    removeOverdrawInput.addEventListener('change', onSettingChange);
    sortPathsInput.addEventListener('change', onSettingChange);
    gapToleranceInput.addEventListener('change', onSettingChange);
    fixWindingInput.addEventListener('change', onSettingChange);

    // Not part of any preset - re-parses the source SVG, so just re-run
    discardPageRectsInput.addEventListener('change', () => {
        autoOptimize();
        saveSettings();
    });

    // Layer by depth checkbox - need to re-render preview when changed
    layerByDepthInput.addEventListener('change', () => {
        updatePreviewWithCurrentLayers();
        updatePageSettings();
        saveSettings();
    });

    // Fill Strategy Radios
    const fillRadios = document.querySelectorAll('input[name="fillStrategy"]');
    fillRadios.forEach(radio => {
        radio.addEventListener('change', onSettingChange);
    });

    // Output Settings Listeners
    // Decoupled from autoOptimize as per user request
    scaleToFitInput.addEventListener('change', () => {
        updatePageSettings();
        saveSettings();
    });



    // Custom Size Inputs
    customWidthInput.addEventListener('change', () => { updatePageSettings(); saveSettings(); });
    customHeightInput.addEventListener('change', () => { updatePageSettings(); saveSettings(); });

    // Unit Toggle
    unitToggle.addEventListener('change', () => {
        const newUnit = unitToggle.checked ? 'in' : 'mm';
        setUnit(newUnit);
    });

    paperMarginInput.addEventListener('input', () => {
        updateMarginDisplay();
    });
    paperMarginInput.addEventListener('change', () => {
        updatePageSettings();
        saveSettings();
    });

    penWeightInput.addEventListener('input', () => {
        updatePenWeightDisplay();
    });
    penWeightInput.addEventListener('change', () => {
        updatePageSettings();
        saveSettings();
    });

    // Page Setup Modal Controls
    pageSetupBtn.addEventListener('click', () => {
        pageSetupModal.classList.remove('hidden');
    });

    closePageSetupBtn.addEventListener('click', () => {
        pageSetupModal.classList.add('hidden');
    });

    // Close modal on click outside
    pageSetupModal.addEventListener('click', (e) => {
        if (e.target === pageSetupModal) {
            pageSetupModal.classList.add('hidden');
        }
    });
}

// Update page settings (Simulator/Export only)
function updatePageSettings() {
    updateDependencies();
    // If simulator is active/open, we might want to refresh it?
    // For now, initSimulator() reads from inputs, so clicking "Simulate" again works.
    // If we wanted live simulator updates, we'd check visibility:
    // if (!simulationModal.classList.contains('hidden')) initSimulator();
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

    if (scaleToFitInput.checked) {
        paperSettingsContainer.style.opacity = '1';
        paperSettingsContainer.style.pointerEvents = 'auto';
    } else {
        paperSettingsContainer.style.opacity = '0.5';
        paperSettingsContainer.style.pointerEvents = 'none';
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

// --- Unit & Persistence Logic ---

function setUnit(unit: string) {
    if (currentUnit === unit) return;

    // Convert generic values
    const margin = parseFloat(paperMarginInput.value);
    const cWidth = parseFloat(customWidthInput.value);
    const cHeight = parseFloat(customHeightInput.value);

    // Update state
    currentUnit = unit;

    // Update Limits & Step
    if (unit === 'in') {
        // MM -> IN
        paperMarginInput.max = '2.0'; paperMarginInput.step = '0.05';
        paperMarginInput.value = (margin / 25.4).toFixed(3);

        // Pen weight stays in mm (no conversion)

        customWidthInput.value = (cWidth / 25.4).toFixed(2);
        customHeightInput.value = (cHeight / 25.4).toFixed(2);
    } else {
        // IN -> MM
        paperMarginInput.max = '50'; paperMarginInput.step = '1';
        paperMarginInput.value = (margin * 25.4).toFixed(1);

        // Pen weight stays in mm (no conversion)

        customWidthInput.value = (cWidth * 25.4).toFixed(1);
        customHeightInput.value = (cHeight * 25.4).toFixed(1);
    }

    updateUnitLabels();
    updateMarginDisplay();
    updatePenWeightDisplay();
    saveSettings();
}

function updateUnitLabels() {
    unitLabels.forEach(el => el.textContent = currentUnit);

    // Update Toggle Visuals
    unitToggle.checked = (currentUnit === 'in');
    if (currentUnit === 'in') {
        unitLabelIN.style.opacity = '1';
        unitLabelIN.style.fontWeight = 'bold';
        unitLabelMM.style.opacity = '0.5';
        unitLabelMM.style.fontWeight = 'normal';
    } else {
        unitLabelIN.style.opacity = '0.5';
        unitLabelIN.style.fontWeight = 'normal';
        unitLabelMM.style.opacity = '1';
        unitLabelMM.style.fontWeight = 'bold';
    }
}

function updateMarginDisplay() {
    marginValueSpan.textContent = `${parseFloat(paperMarginInput.value)}${currentUnit}`;
}

function updatePenWeightDisplay() {
    penWeightValueSpan.textContent = `${parseFloat(penWeightInput.value)}mm`;
}

function toMM(val: number): number {
    return currentUnit === 'in' ? val * 25.4 : val;
}

/**
 * Convert a millimetre value into the unit the document will be exported in.
 * Unrelated to toMM(), which converts the UI's mm/in toggle.
 */
function mmToDocUnits(val: number, units?: string): number {
    switch (units) {
        case 'in': return val / 25.4;
        case 'cm': return val / 10;
        case 'pt': return (val * 72) / 25.4;
        case 'pc': return (val * 6) / 25.4;
        case 'q': return val * 4;
        default: return val; // mm, or unitless documents which we treat as mm
    }
}

function loadSettings() {
    const saved = sessionStorage.getItem('watertight_settings');
    if (saved) {
        try {
            const s = JSON.parse(saved);
            if (s.unit) {
                currentUnit = s.unit;
                // Set inputs to correct limits first implicitly or reset them
                if (currentUnit === 'in') {
                    paperMarginInput.max = '2.0'; paperMarginInput.step = '0.05';
                    // Pen weight always mm - no change needed
                } else {
                    paperMarginInput.max = '50'; paperMarginInput.step = '1';
                    // Pen weight always mm - no change needed
                }
            }
            if (s.margin) paperMarginInput.value = s.margin;
            if (s.penWeight) penWeightInput.value = s.penWeight;
            if (s.scaleToFit !== undefined) scaleToFitInput.checked = s.scaleToFit;
            if (s.rotateOutput !== undefined) rotateOutputInput.checked = s.rotateOutput;
            if (s.layerByDepth !== undefined) layerByDepthInput.checked = s.layerByDepth;
            if (s.customWidth) customWidthInput.value = s.customWidth;
            if (s.customHeight) customHeightInput.value = s.customHeight;

            // Optimization controls. Without these the UI snaps back to the
            // markup defaults (which are the Cutter preset) on every reload.
            if (s.removeOverdraw !== undefined) removeOverdrawInput.checked = s.removeOverdraw;
            if (s.mergePaths !== undefined) mergePathsInput.checked = s.mergePaths;
            if (s.sortPaths !== undefined) sortPathsInput.checked = s.sortPaths;
            if (s.fixWinding !== undefined) fixWindingInput.checked = s.fixWinding;
            if (s.discardPageRects !== undefined) discardPageRectsInput.checked = s.discardPageRects;
            if (s.gapTolerance) {
                gapToleranceInput.value = s.gapTolerance;
                gapValueSpan.textContent = `${s.gapTolerance}px`;
            }
            if (s.fillStrategy) {
                const radio = document.querySelector(
                    `input[name="fillStrategy"][value="${s.fillStrategy}"]`
                ) as HTMLInputElement;
                if (radio) radio.checked = true;
            }
        } catch (e) { console.error('Failed to load settings', e); }
    }

    // Derive the preset radio from the restored control state
    checkPresets();
}

function saveSettings() {
    const s = {
        unit: currentUnit,
        margin: paperMarginInput.value,
        penWeight: penWeightInput.value,
        scaleToFit: scaleToFitInput.checked,
        rotateOutput: rotateOutputInput.checked,
        layerByDepth: layerByDepthInput.checked,
        customWidth: customWidthInput.value,
        customHeight: customHeightInput.value,

        // Optimization controls
        removeOverdraw: removeOverdrawInput.checked,
        mergePaths: mergePathsInput.checked,
        sortPaths: sortPathsInput.checked,
        fixWinding: fixWindingInput.checked,
        discardPageRects: discardPageRectsInput.checked,
        gapTolerance: gapToleranceInput.value,
        fillStrategy: getFillStrategy()
    };
    sessionStorage.setItem('watertight_settings', JSON.stringify(s));
}

function getCurrentPaperSizeMM(): { width: number, height: number } {
    return {
        width: toMM(parseFloat(customWidthInput.value)),
        height: toMM(parseFloat(customHeightInput.value))
    };
}

// Get selected fill strategy
function getFillStrategy(): 'none' | 'close' | 'regions' {
    const checked = document.querySelector('input[name="fillStrategy"]:checked') as HTMLInputElement;
    return (checked?.value || 'none') as 'none' | 'close' | 'regions';
}

// Setup buttons
function setupButtons() {
    // optimizeBtn removed - optimization is automatic

    exportBtn.addEventListener('click', () => {
        if (currentResult) {
            let paths = currentResult.optimized.paths;
            let width = currentResult.optimized.width;
            let height = currentResult.optimized.height;
            let viewBox = currentResult.optimized.viewBox;
            let units = currentResult.optimized.units;

            // Apply Rotation if enabled
            if (rotateOutputInput.checked) {
                const rotated = rotatePaths(paths, width, height);
                paths = rotated.paths;
                width = rotated.width;
                height = rotated.height;
            }

            // Apply Scale to Fit if enabled
            if (scaleToFitInput.checked) {
                const { width: pWidth, height: pHeight } = getCurrentPaperSizeMM();
                let marginMM = toMM(parseFloat(paperMarginInput.value));

                const { paths: scaledPaths } = fitToPaper(paths, pWidth, pHeight, marginMM);
                paths = scaledPaths;
                width = pWidth;
                height = pHeight;
                viewBox = `0 0 ${width} ${height}`;
                // fitToPaper rewrites geometry into millimetre paper coordinates
                units = 'mm';
            }

            // Inject Pen Weight for Export. The slider is always in mm, but stroke-width
            // is in user units, so convert into whatever unit the document is exported in.
            const penWeightMM = parseFloat(penWeightInput.value);

            // We need to apply this to all paths
            paths = paths.map(p => ({
                ...p,
                meta: {
                    ...p.meta,
                    strokeWidth: mmToDocUnits(penWeightMM, units)
                }
            }));

            // Handle Layering
            let layers: Map<number, Path[]> | undefined;
            if (layerByDepthInput.checked) {
                // Dynamically import grouping logic or ensure it's imported
                layers = groupPathsByDepth(paths);
            }

            const docToExport: SVGDocument = {
                ...currentResult.optimized,
                paths,
                width,
                height,
                viewBox,
                units
            };

            downloadSVG(docToExport, 'optimized.svg', layers);
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
        fillRule: 'evenodd',

        scaleToFit: scaleToFitInput.checked,
        // paperSize is simpler now, we just pass what we have
        paperSize: getCurrentPaperSizeMM(),
        paperMargin: toMM(parseFloat(paperMarginInput.value)),
        penWeight: parseFloat(penWeightInput.value), // always mm
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
        const document = parseSVG(currentSVG, {
            discardPageRects: discardPageRectsInput.checked,
        });

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

    // Calculate layers if layer by depth is enabled
    let layers: Map<number, Path[]> | undefined;
    if (layerByDepthInput.checked) {
        layers = groupPathsByDepth(currentResult.optimized.paths);
    }

    // Render previews
    renderPreview(originalPreview, currentResult.original, {
        showTravel: false,
        drawColor: '#a0a0b0',
    });

    // Check for Plotter Mode (Merge + None) to disable fill preview
    const options = getOptions();
    const isPlotterMode = options.mergePaths && !options.findRegions && !options.closePaths;

    renderPreview(optimizedPreview, currentResult.optimized, {
        showTravel: true,
        useLayerColors: layerByDepthInput.checked,
        ...(isPlotterMode && { fillColor: 'none' })
    }, layers);

    // Attach Pan/Zoom controller
    const originalSvg = originalPreview.querySelector('svg');
    const optimizedSvg = optimizedPreview.querySelector('svg');

    if (originalSvg && optimizedSvg) {
        panZoom.attach([originalSvg, optimizedSvg], shouldResetZoom);
        shouldResetZoom = false;
    }

    // Update stats
    originalStats.textContent = formatStats(currentResult.beforeStats);

    // Calculate layer count for optimized stats based on current UI state
    const optimizedStatsWithLayers = { ...currentResult.afterStats };
    if (layerByDepthInput.checked) {
        const layers = groupPathsByDepth(currentResult.optimized.paths);
        optimizedStatsWithLayers.layerCount = layers.size;
    } else {
        optimizedStatsWithLayers.layerCount = 1;
    }

    optimizedStats.textContent = formatStats(optimizedStatsWithLayers);

    // Enable export & simulate
    exportBtn.removeAttribute('disabled');
    (document.getElementById('simulateBtn') as HTMLButtonElement).removeAttribute('disabled');
    plotBtn.removeAttribute('disabled');

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

        exportBtn.setAttribute('disabled', 'true');
        plotBtn.setAttribute('disabled', 'true');
        document.body.style.cursor = 'wait';
    } else {
        // Remove overlay
        const overlay = document.getElementById('loadingOverlay');
        if (overlay) overlay.remove();

        // Export button state is handled in success
        document.body.style.cursor = 'default';
    }
}

/** Geometry after the post-pipeline transforms, ready for a consumer. */
interface PreparedOutput {
    paths: Path[];
    width: number;
    height: number;
    layers?: Map<number, Path[]>;
    /**
     * Unit that `paths`/`width`/`height` are expressed in, for consumers that
     * need real-world measurements.
     *
     * `undefined` means millimetres. Scale-to-fit resolves everything into mm
     * (`fitToPaper` maps into paper space), so this is only the document's own
     * unit when scale-to-fit is off. Getting this backwards scales an inch
     * document by 25.4 twice.
     */
    docUnits?: string;
}

/**
 * Apply the post-pipeline transforms — rotation, scale-to-fit, layering — that
 * live outside the worker.
 *
 * Shared by the simulator and the plotter so the two can't drift: whatever you
 * watch on screen is the same geometry the pen draws. Export builds its own
 * SVG document and so does this work inline instead.
 */
function prepareOutput(): PreparedOutput {
    let paths = currentResult!.optimized.paths;
    let width = currentResult!.optimized.width;
    let height = currentResult!.optimized.height;

    // Fallback if width/height missing
    if (!width || !height) {
        const viewPort = currentResult!.optimized.viewBox || { width: 800, height: 600 };
        if (typeof viewPort === 'string') {
            const parts = viewPort.split(' ').map(parseFloat);
            if (parts.length === 4) { width = parts[2]; height = parts[3]; }
        } else { width = viewPort.width; height = viewPort.height; }
    }

    // Apply transformations first
    if (rotateOutputInput.checked) {
        const rotated = rotatePaths(paths, width, height);
        paths = rotated.paths;
        width = rotated.width;
        height = rotated.height;
    }

    // Apply Page Setup Scanning
    let docUnits = currentResult!.optimized.units;
    if (scaleToFitInput.checked) {
        const { width: pWidth, height: pHeight } = getCurrentPaperSizeMM();
        const marginMM = toMM(parseFloat(paperMarginInput.value));

        const { paths: scaledPaths } = fitToPaper(paths, pWidth, pHeight, marginMM);
        paths = scaledPaths;
        width = pWidth;
        height = pHeight;
        // fitToPaper maps into paper space, which is mm by definition.
        docUnits = undefined;
    }

    // Calculate layers once after all transformations
    let layers: Map<number, Path[]> | undefined;
    if (layerByDepthInput.checked) {
        layers = groupPathsByDepth(paths);
    }

    return { paths, width, height, layers, docUnits };
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

    const { paths, width, height, layers } = prepareOutput();

    const penWeight = parseFloat(penWeightInput.value);
    simulator.setData(paths, { width, height }, penWeight, scaleToFitInput.checked, layers);

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
// Helper: Rotate paths 90 degrees clockwise
function rotatePaths(paths: Path[], width: number, height: number): { paths: Path[], width: number, height: number } {
    // New dimensions (swapped)
    const newWidth = height;
    const newHeight = width;

    // Rotate points: x' = height - y, y' = x
    const newPaths = paths.map(p => ({
        ...p,
        points: p.points.map(pt => ({
            x: height - pt.y,
            y: pt.x
        }))
    }));

    return { paths: newPaths, width: newWidth, height: newHeight };
}

// ─── Plotter Integration (AxiDraw over WebSerial) ────────────────────────────

const plotBtn = document.getElementById('plotBtn') as HTMLButtonElement;
const plotModal = document.getElementById('plotModal')!;
const closePlotBtn = document.getElementById('closePlotBtn')!;
const plotMachineSelect = document.getElementById('plotMachine') as HTMLSelectElement;
const plotHomeCornerSelect = document.getElementById('plotHomeCorner') as HTMLSelectElement;
const plotAutoOrientInput = document.getElementById('plotAutoOrient') as HTMLInputElement;
const plotSpeedDownInput = document.getElementById('plotSpeedDown') as HTMLInputElement;
const plotSpeedUpInput = document.getElementById('plotSpeedUp') as HTMLInputElement;
const plotPenDownInput = document.getElementById('plotPenDown') as HTMLInputElement;
const plotPenUpInput = document.getElementById('plotPenUp') as HTMLInputElement;
const plotStatus = document.getElementById('plotStatus')!;
const plotFirmware = document.getElementById('plotFirmware')!;
const plotProgressBar = document.getElementById('plotProgressBar')!;
const plotConnectBtn = document.getElementById('plotConnectBtn') as HTMLButtonElement;
const plotMotorsBtn = document.getElementById('plotMotorsBtn') as HTMLButtonElement;
const plotCancelBtn = document.getElementById('plotCancelBtn') as HTMLButtonElement;
const plotStartBtn = document.getElementById('plotStartBtn') as HTMLButtonElement;

const plotHomeBtn = document.getElementById('plotHomeBtn') as HTMLButtonElement;
const plotHomeMachineBtn = document.getElementById('plotHomeMachineBtn') as HTMLButtonElement;

let plotSession: PlotSession | null = null;
let plotAbort: AbortController | null = null;
let motorsReleased = false;

function setPlotStatus(msg: string, kind: 'info' | 'warning' | 'error' = 'info') {
    plotStatus.textContent = msg;
    plotStatus.classList.toggle('is-error', kind === 'error');
    plotStatus.classList.toggle('is-warning', kind === 'warning');
}

const plotSpeedDownMms = document.getElementById('plotSpeedDownMms')!;
const plotSpeedUpMms = document.getElementById('plotSpeedUpMms')!;

/**
 * Show what the percentages actually mean. They scale against nib's LM caps
 * (50mm/s pen-down, 100mm/s pen-up) and are not comparable to the percentages
 * in axicli, so the raw number tells you nothing on its own.
 */
function updatePlotSpeedLabels() {
    const down = speedToMms(parseFloat(plotSpeedDownInput.value), true);
    const up = speedToMms(parseFloat(plotSpeedUpInput.value), false);
    plotSpeedDownMms.textContent = `${Number.isFinite(down) ? down.toFixed(0) : '–'} mm/s`;
    plotSpeedUpMms.textContent = `${Number.isFinite(up) ? up.toFixed(0) : '–'} mm/s`;
}

plotSpeedDownInput.addEventListener('input', updatePlotSpeedLabels);
plotSpeedUpInput.addEventListener('input', updatePlotSpeedLabels);

function currentPlotProfile(): Profile {
    return {
        ...DEFAULT_PROFILE,
        speedPendown: parseFloat(plotSpeedDownInput.value),
        speedPenup: parseFloat(plotSpeedUpInput.value),
        penPosDown: parseFloat(plotPenDownInput.value),
        penPosUp: parseFloat(plotPenUpInput.value),
    };
}

/**
 * Warn when the page is larger than the machine can reach. The envelope is
 * travel from wherever the arm is parked, so this can only ever be advisory —
 * nib still enforces it per-move once plotting starts.
 */
/**
 * Read the board's identity into the dialog.
 *
 * Always shows the raw `V` response, because a board answering with an
 * unparseable string and a board not answering at all both end up as version
 * 0.0.0 with every capability off — indistinguishable from genuinely old
 * firmware unless you can see what it actually said.
 */
async function reportFirmware() {
    if (!plotSession) return;
    let raw: string;
    try {
        raw = (await plotSession.firmwareString()).trim();
    } catch (e) {
        plotFirmware.textContent =
            `Board did not answer the V (version) command: ${e instanceof Error ? e.message : String(e)}`;
        plotFirmware.classList.add('is-error');
        return;
    }
    const caps = plotSession.capabilities;
    const parsed = caps.firmware.join('.');
    const lm = caps.lm
        ? 'LM motion planning available.'
        : 'No LM motion planning (needs 2.7.0) — every move falls back to SM, capped near 13mm/s.';
    plotFirmware.textContent = `${raw} — parsed as ${parsed}. ${lm}`;
    plotFirmware.classList.toggle('is-warning', !caps.lm);
    plotFirmware.classList.remove('is-error');
}

/** Envelope for the selected machine, or null while none is chosen. */
function selectedEnvelope() {
    return MACHINE_ENVELOPES[plotMachineSelect.value] ?? null;
}

/**
 * Gate plotting on the geometry actually fitting the machine.
 *
 * This blocks rather than warns. nib does check the envelope per-move, but by
 * the time it aborts the carriage is already at the boundary — and if the
 * selected machine is bigger than the real one, that check passes while the
 * hardware runs into its end stops.
 */
function checkPlotFit(): boolean {
    if (!currentResult) return false;

    const envelope = selectedEnvelope();
    if (!envelope) {
        setPlotStatus('Select your machine — the envelope is the only bounds check.', 'warning');
        plotStartBtn.disabled = true;
        return false;
    }

    // Measure the real geometry, not the page: scale-to-fit centres content
    // inside the sheet, so page size alone over-reports, and a rotated or
    // unscaled document can extend past the page entirely.
    const { paths, layers, docUnits, width, height } = prepareOutput();
    const placement = placeForMachine(paths, {
        units: docUnits, layers,
        page: { width, height },
        envelope,
        homeCorner: plotHomeCornerSelect.value as HomeCorner,
        autoOrient: plotAutoOrientInput.checked,
    });
    const strokes = placement.strokes;
    const violation = envelopeViolation(strokes, envelope);

    if (violation) {
        const turnable = !plotAutoOrientInput.checked
            ? ' Try laying the paper\'s long edge along the gantry.'
            : '';
        setPlotStatus(
            `${violation} The machine reaches ${envelope.widthMm}×${envelope.heightMm}mm.` +
            `${turnable} Reduce the paper size, or enable Scale to Fit.`,
            'error',
        );
        plotStartBtn.disabled = true;
        return false;
    }

    // Never let a rotation happen silently — it changes which way the drawing
    // sits on the sheet, and the user has to load the paper to match.
    const orientation = placement.rotated
        ? `Rotated 90° to fit — load the paper landscape (${placement.page.widthMM.toFixed(0)}×${placement.page.heightMM.toFixed(0)}mm). `
        : '';

    plotStartBtn.disabled = !plotSession;
    if (!plotSession) {
        setPlotStatus(`${orientation}Not connected.`, placement.rotated ? 'warning' : 'info');
        return true;
    }

    setPlotStatus(`${orientation}Connected. Park the pen, then plot.`,
        placement.rotated ? 'warning' : 'info');
    return true;
}

function setPlotConnectedUI(connected: boolean) {
    plotMotorsBtn.disabled = !connected;
    plotHomeMachineBtn.disabled = !connected;
    // Returning to the origin is a relative move, so it is only offered while
    // software tracking is still valid — never after a stopped plot.
    plotHomeBtn.disabled = !connected || !plotSession?.positionTrusted || motorsReleased;
    // Plot stays gated on the bounds check, never on connection alone.
    plotStartBtn.disabled = true;
    if (connected) checkPlotFit();
}

async function connectPlotter() {
    try {
        setPlotStatus('Waiting for device selection…');
        await plotSession?.close().catch(() => undefined);
        plotSession = new PlotSession(await requestEbbPort());
        plotConnectBtn.textContent = 'Reconnect';
        motorsReleased = false;
        plotMotorsBtn.textContent = 'Release motors';
        await reportFirmware();
        setPlotConnectedUI(true);
    } catch (e) {
        plotSession = null;
        setPlotConnectedUI(false);
        // A user dismissing the browser's port picker throws; that is not an error.
        const msg = e instanceof Error ? e.message : String(e);
        setPlotStatus(/No port selected|cancel/i.test(msg) ? 'Not connected.' : msg, 'error');
    }
}

async function runPlot() {
    if (!currentResult || !plotSession) return;

    const envelope = selectedEnvelope();
    if (!envelope) {
        setPlotStatus('Select your machine first.', 'error');
        return;
    }

    const { paths, layers, docUnits, width, height } = prepareOutput();
    const placement = placeForMachine(paths, {
        units: docUnits, layers,
        page: { width, height },
        envelope,
        homeCorner: plotHomeCornerSelect.value as HomeCorner,
        autoOrient: plotAutoOrientInput.checked,
    });
    const strokes = placement.strokes;

    if (strokes.length === 0) {
        setPlotStatus('Nothing to plot.', 'error');
        return;
    }

    // Re-check immediately before moving: page setup may have changed since the
    // dialog opened, and this is the last point where nothing has moved yet.
    const violation = envelopeViolation(strokes, envelope);
    if (violation) {
        setPlotStatus(`${violation} Refusing to plot.`, 'error');
        plotStartBtn.disabled = true;
        return;
    }

    plotAbort = new AbortController();
    setPlotConnectedUI(false);
    plotConnectBtn.disabled = true;
    plotCancelBtn.classList.remove('hidden');
    setPlotStatus(`Plotting ${strokes.length} strokes…`);

    try {
        const result = await plotSession.plot(strokes, {
            profile: currentPlotProfile(),
            envelope,
            // The parser samples curves densely; without this a single curve
            // becomes hundreds of LM commands.
            simplifyMm: 0.05,
            signal: plotAbort.signal,
            onProgress: (fraction, etaS) => {
                plotProgressBar.style.width = `${fraction * 100}%`;
                const eta = Number.isFinite(etaS) && etaS > 0
                    ? ` — ${Math.ceil(etaS / 60)} min left`
                    : '';
                setPlotStatus(`Plotting… ${Math.round(fraction * 100)}%${eta}`);
            },
        });
        // A completed plot homes itself; a stopped one deliberately does not.
        // After a stop the tracked position is stale, so the only trustworthy
        // recovery is the firmware's absolute HM seek.
        setPlotStatus(result.aborted
            ? `Stopped at ${Math.round(result.stoppedAt * 100)}%. Arm position is no longer tracked — use Home machine.`
            : 'Plot complete.',
            result.aborted ? 'warning' : 'info');
    } catch (e) {
        setPlotStatus(e instanceof Error ? e.message : String(e), 'error');
    } finally {
        plotAbort = null;
        setPlotConnectedUI(true);
        plotConnectBtn.disabled = false;
        plotCancelBtn.classList.add('hidden');
    }
}

plotBtn.addEventListener('click', () => {
    plotModal.classList.remove('hidden');
    plotProgressBar.style.width = '0%';
    updatePlotSpeedLabels();
    checkPlotFit();
});

// Closing the dialog deliberately keeps the session open and the motors
// energised: de-energising lets the arm drift, which would lose the origin the
// user set by hand. Reopening resumes against the same machine state.
closePlotBtn.addEventListener('click', () => {
    plotModal.classList.add('hidden');
});

// WebSerial is Chromium-only. Rather than show a button that can never work in
// Safari or Firefox, reveal it only where the API exists.
if (isPlottingSupported()) {
    plotBtn.classList.remove('hidden');
}

plotMachineSelect.addEventListener('change', checkPlotFit);
plotHomeCornerSelect.addEventListener('change', checkPlotFit);
plotAutoOrientInput.addEventListener('change', checkPlotFit);
plotConnectBtn.addEventListener('click', connectPlotter);
plotStartBtn.addEventListener('click', runPlot);
plotCancelBtn.addEventListener('click', () => {
    plotAbort?.abort();
    setPlotStatus('Stopping…');
});

// Motors off lets the user drag the carriage to the paper corner by hand;
// motors on re-arms and makes that position the origin.
plotMotorsBtn.addEventListener('click', async () => {
    if (!plotSession) return;
    plotMotorsBtn.disabled = true;
    try {
        if (motorsReleased) {
            await plotSession.reenableMotors();
            motorsReleased = false;
            plotMotorsBtn.textContent = 'Release motors';
            setPlotStatus('Motors on — this position is now the origin.');
        } else {
            await plotSession.releaseMotors();
            motorsReleased = true;
            plotMotorsBtn.textContent = 'Set origin here';
            setPlotStatus('Motors released — move the pen to the paper corner.');
        }
    } catch (e) {
        setPlotStatus(e instanceof Error ? e.message : String(e), 'error');
    } finally {
        // With the motors off the arm can be dragged anywhere, so returning to
        // the origin is meaningless until they are re-enabled.
        setPlotConnectedUI(true);
        plotMotorsBtn.disabled = false;
    }
});

plotHomeBtn.addEventListener('click', async () => {
    if (!plotSession) return;
    plotHomeBtn.disabled = true;
    try {
        setPlotStatus('Returning to origin…');
        await plotSession.home(currentPlotProfile(), selectedEnvelope() ?? undefined);
        setPlotStatus('At origin.');
    } catch (e) {
        setPlotStatus(e instanceof Error ? e.message : String(e), 'error');
    } finally {
        setPlotConnectedUI(true);
    }
});

plotHomeMachineBtn.addEventListener('click', async () => {
    if (!plotSession) return;
    plotHomeMachineBtn.disabled = true;
    try {
        setPlotStatus('Seeking machine home…');
        await plotSession.homeMachine();
        // HM redefines the origin as the machine's corner, so the paper origin
        // the user parked by hand is gone.
        motorsReleased = false;
        plotMotorsBtn.textContent = 'Release motors';
        setPlotStatus('At machine home. Origin is now the machine corner — re-park before plotting.', 'warning');
    } catch (e) {
        setPlotStatus(e instanceof Error ? e.message : String(e), 'error');
    } finally {
        setPlotConnectedUI(true);
    }
});

// Start the app
init();
