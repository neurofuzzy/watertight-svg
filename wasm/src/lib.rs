//! Watertight WASM - Region Finding Algorithm
//!
//! High-performance WASM implementation of the region-finding algorithm
//! using DCEL (Doubly Connected Edge List) for extracting enclosed faces
//! from intersecting line segments.

mod types;
mod intersection;
mod dcel;
mod regions;

use wasm_bindgen::prelude::*;
use serde_wasm_bindgen::{from_value, to_value};

use types::Path;
use regions::find_regions_impl;

/// Find all enclosed regions formed by the given paths.
/// 
/// # Arguments
/// * `paths_js` - JavaScript array of Path objects
/// * `tolerance` - Vertex snapping tolerance
/// * `min_area` - Minimum area threshold for valid regions
/// 
/// # Returns
/// JavaScript array of closed Path objects representing detected regions
#[wasm_bindgen]
pub fn find_regions(
    paths_js: JsValue,
    tolerance: f64,
    min_area: f64,
) -> Result<JsValue, JsError> {
    // Deserialize paths from JavaScript
    let paths: Vec<Path> = from_value(paths_js)
        .map_err(|e| JsError::new(&format!("Failed to parse paths: {}", e)))?;
    
    // Run the region finding algorithm
    let regions = find_regions_impl(&paths, tolerance, min_area);
    
    // Serialize back to JavaScript
    to_value(&regions)
        .map_err(|e| JsError::new(&format!("Failed to serialize regions: {}", e)))
}

/// Get version information
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
