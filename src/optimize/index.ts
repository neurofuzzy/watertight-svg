export { mergePaths } from './merge';
export { removeOverdraw } from './overdraw';
export { sortPaths, sortPathsWithTwoOpt, calculateTravelDistance } from './sort';
export { closePaths, autoClosePaths, findPotentialClosures, applyClosures } from './fill';
export { fixWinding } from './winding';
export { findRegions, applyRegionsToDocument, type RegionFindingOptions } from './regions';
export { optimize, optimizeDocument, calculateStats, formatStats, type OptimizeResult } from './pipeline';
