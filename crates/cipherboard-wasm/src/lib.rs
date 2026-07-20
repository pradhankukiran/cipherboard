//! Cipherboard Wasm helpers.
//!
//! Responsibilities: stroke smoothing, delta/event encoding and decoding,
//! input validation, snapshot/replay computation, and the protected-lesson
//! decrypt seam that invokes browser SubtleCrypto with JS handles only.
//!
//! Raw secret key *bytes* must never enter Wasm linear memory. The protected
//! lesson path accepts an opaque JS `CryptoKey` externref and buffer handles;
//! it does not accept JWK, base64 strings, or Rust byte slices of key material.

mod branch;
mod encode;
mod protected_decrypt;
mod replay;
mod smooth;
mod validate;

pub use branch::*;
pub use encode::*;
pub use protected_decrypt::*;
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
