//! Watertight WASM - Region Finding Algorithm
//!
//! High-performance WASM implementation of the region-finding algorithm
//! using DCEL (Doubly Connected Edge List) for extracting enclosed faces
//! from intersecting line segments.

mod types;
mod quadtree;
mod intersection;
mod dcel;
mod regions;

use wasm_bindgen::prelude::*;
use serde_wasm_bindgen::{from_value, to_value};

use types::Path;
use regions::find_regions_impl;

// For timing in browser
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
    
    #[wasm_bindgen(js_namespace = performance)]
    fn now() -> f64;
}

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
    let t0 = now();
    
    // Deserialize paths from JavaScript
    let paths: Vec<Path> = from_value(paths_js)
        .map_err(|e| JsError::new(&format!("Failed to parse paths: {}", e)))?;
    
    let t1 = now();
    log(&format!("[WASM] Deserialization: {:.2}ms ({} paths)", t1 - t0, paths.len()));
    
    // Run the region finding algorithm
    let regions = find_regions_impl(&paths, tolerance, min_area);
    
    let t2 = now();
    log(&format!("[WASM] Algorithm: {:.2}ms ({} regions)", t2 - t1, regions.len()));
    
    // Serialize back to JavaScript
    let result = to_value(&regions)
        .map_err(|e| JsError::new(&format!("Failed to serialize regions: {}", e)))?;
    
    let t3 = now();
    log(&format!("[WASM] Serialization: {:.2}ms", t3 - t2));
    log(&format!("[WASM] Total: {:.2}ms", t3 - t0));
    
    Ok(result)
}

/// Get version information
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

