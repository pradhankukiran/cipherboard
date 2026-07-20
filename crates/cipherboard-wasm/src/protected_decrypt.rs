//! Protected lesson decryption at the Rust/Wasm ↔ browser SubtleCrypto boundary.
//!
//! # Ownership and lifetime
//! - `key` is a JS `CryptoKey` handle (externref). It is never read as bytes and
//!   must not be copied into Wasm linear memory.
//! - `ciphertext`, `iv`, and `aad` are JS `Uint8Array` handles. Lengths are read
//!   via JS typed-array metadata only; contents are passed straight to
//!   `SubtleCrypto.decrypt` without an intermediate Rust `Vec`/`&[u8]`.
//! - On success, plaintext is returned as a JS `ArrayBuffer` handle owned by the
//!   JS heap — not as a Rust-owned buffer that would copy into linear memory.
//!
//! # Error semantics
//! Failures are `JsValue` error strings suitable for UI display. They must not
//! include key material, ciphertext hex dumps, or plaintext. Prefer stable codes.
//!
//! Generated wasm-bindgen glue for this export must carry key/data as JS values
//! (externrefs), not `passStringToWasm` / copied Rust slices.
//!
//! Production surface: only `decryptProtectedLesson`.

use js_sys::{Array, Promise, Reflect, Uint8Array};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;
use web_sys::{AesGcmParams, CryptoKey, SubtleCrypto};

const IV_LEN: u32 = 12;
const AES_LENGTH_BITS: f64 = 256.0;
const MAX_CIPHERTEXT_LEN: u32 = 96 * 1024;
const MAX_AAD_LEN: u32 = 2048;

fn err(msg: &str) -> JsValue {
    JsValue::from_str(msg)
}

/// Obtain SubtleCrypto from window or worker global without pulling secrets.
fn subtle_crypto() -> Result<SubtleCrypto, JsValue> {
    let global = js_sys::global();
    let crypto = Reflect::get(&global, &JsValue::from_str("crypto"))
        .map_err(|_| err("crypto unavailable"))?;
    if crypto.is_undefined() || crypto.is_null() {
        return Err(err("crypto unavailable"));
    }
    let subtle = Reflect::get(&crypto, &JsValue::from_str("subtle"))
        .map_err(|_| err("subtle crypto unavailable"))?;
    if subtle.is_undefined() || subtle.is_null() {
        return Err(err("subtle crypto unavailable"));
    }
    subtle
        .dyn_into::<SubtleCrypto>()
        .map_err(|_| err("subtle crypto unavailable"))
}

/// Validate CryptoKey invariants before decrypt. Does not read key bytes.
fn validate_content_key(key: &CryptoKey) -> Result<(), JsValue> {
    let key_type = key.type_();
    if key_type != "secret" {
        return Err(err("key type must be secret"));
    }
    if key.extractable() {
        return Err(err("key must be non-extractable"));
    }

    let algo = key.algorithm().map_err(|_| err("key algorithm missing"))?;
    let name_val = Reflect::get(&algo, &JsValue::from_str("name"))
        .map_err(|_| err("key algorithm missing"))?;
    let name = name_val
        .as_string()
        .ok_or_else(|| err("key algorithm name invalid"))?;
    if name != "AES-GCM" {
        return Err(err("key algorithm must be AES-GCM"));
    }

    let length_val = Reflect::get(&algo, &JsValue::from_str("length"))
        .map_err(|_| err("key length missing"))?;
    let length = length_val
        .as_f64()
        .ok_or_else(|| err("key length invalid"))?;
    if length != AES_LENGTH_BITS {
        return Err(err("key length must be 256"));
    }

    let usages: Array = key.usages();
    let mut has_decrypt = false;
    for i in 0..usages.length() {
        if let Some(u) = usages.get(i).as_string() {
            if u == "decrypt" {
                has_decrypt = true;
            } else {
                return Err(err("key usage must be decrypt-only"));
            }
        }
    }
    if !has_decrypt {
        return Err(err("key must allow decrypt"));
    }
    Ok(())
}

/// Validate buffer handles by JS length only — do not copy contents into Wasm.
fn validate_buffers(
    ciphertext: &Uint8Array,
    iv: &Uint8Array,
    aad: &Uint8Array,
) -> Result<(), JsValue> {
    if iv.length() != IV_LEN {
        return Err(err("iv must be 12 bytes"));
    }
    let ct_len = ciphertext.length();
    if ct_len == 0 || ct_len > MAX_CIPHERTEXT_LEN {
        return Err(err("ciphertext length out of bounds"));
    }
    if aad.length() > MAX_AAD_LEN {
        return Err(err("aad length out of bounds"));
    }
    Ok(())
}

/// Decrypt a protected lesson via browser SubtleCrypto.
///
/// Accepts opaque JS handles only. Returns plaintext as a JS `ArrayBuffer`.
#[wasm_bindgen(js_name = decryptProtectedLesson)]
pub async fn decrypt_protected_lesson(
    key: CryptoKey,
    ciphertext: Uint8Array,
    iv: Uint8Array,
    aad: Uint8Array,
) -> Result<js_sys::ArrayBuffer, JsValue> {
    validate_content_key(&key)?;
    validate_buffers(&ciphertext, &iv, &aad)?;

    let subtle = subtle_crypto()?;

    let params = AesGcmParams::new("AES-GCM", &iv);
    params.set_additional_data(&aad);

    // Pass JS views directly — wasm-bindgen keeps them as externrefs.
    let promise: Promise =
        subtle.decrypt_with_object_and_buffer_source(&params, &key, &ciphertext)?;
    let result = JsFuture::from(promise)
        .await
        .map_err(|_| err("decrypt failed"))?;

    result
        .dyn_into::<js_sys::ArrayBuffer>()
        .map_err(|_| err("decrypt result type"))
}
