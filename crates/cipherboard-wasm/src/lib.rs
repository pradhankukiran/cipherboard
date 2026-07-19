//! Cipherboard Wasm helpers.
//!
//! Responsibilities: stroke smoothing, delta/event encoding and decoding,
//! input validation, snapshot/replay computation.
//!
//! This crate must NEVER receive CryptoKey objects or raw secret key bytes.
//! All cryptography stays in the browser WebCrypto layer (JS/TS).

mod branch;
mod encode;
mod replay;
mod smooth;
mod validate;

pub use branch::*;
pub use encode::*;
pub use replay::*;
pub use smooth::*;
pub use validate::*;

use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn start() {
    // no-op init hook for wasm-bindgen
}

#[wasm_bindgen]
pub fn protocol_version() -> u32 {
    1
}
