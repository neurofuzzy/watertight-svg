export { mergePaths } from './merge';
export { removeOverdraw } from './overdraw';
export { sortPaths, sortPathsWithTwoOpt, calculateTravelDistance } from './sort';
export { closePaths, autoClosePaths, findPotentialClosures, applyClosures } from './fill';
export { fixWinding, analyzeNesting } from './winding';
export { findRegions, applyRegionsToDocument, type RegionFindingOptions } from './regions';
export { optimize, calculateStats, formatStats, type OptimizeResult } from './pipeline';
