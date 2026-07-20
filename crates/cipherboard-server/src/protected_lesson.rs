//! Server-sealed demo lesson for Protected Lesson Replay.
//!
//! Creates a short static lesson payload, encrypts it with a fresh AES-256-GCM
//! content key (authenticated AAD), and wraps that key to a browser-provided
//! RSA-OAEP SHA-256 public key. Raw AES key bytes never leave this module
//! except inside the RSA-wrapped ciphertext field of the response.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use rand::RngCore;
use rsa::pkcs8::DecodePublicKey;
use rsa::traits::PublicKeyParts;
use rsa::{BigUint, Oaep, RsaPublicKey};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::error::{AppError, AppResult};
use crate::limits::valid_b64;

/// Max base64 length for an RSA-2048 SPKI (~392 chars with padding headroom).
pub const MAX_RSA_SPKI_B64: usize = 800;
/// RSA-2048 SPKI DER is typically ~294 bytes.
const MIN_RSA_SPKI_BYTES: usize = 250;
const MAX_RSA_SPKI_BYTES: usize = 400;
const REQUIRED_RSA_BITS: u64 = 2048;
const AES_KEY_LEN: usize = 32;
const IV_LEN: usize = 12;
/// RSA-OAEP wrap of 32-byte AES key under RSA-2048 yields 256 ciphertext bytes.
const RSA2048_WRAPPED_KEY_LEN: usize = 256;
/// Coherent protected-lesson ciphertext bound (plaintext ≤16 KiB).
pub const MAX_PROTECTED_LESSON_CIPHERTEXT: usize = 32 * 1024;
pub const MAX_PROTECTED_LESSON_PLAINTEXT: usize = 16 * 1024;

/// Tight body limit for the public seal endpoint (JSON SPKI request).
pub const SEAL_REQUEST_BODY_LIMIT: usize = 2048;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// Stable demo lesson id bound into AAD (mirrored by browser canonical AAD).
pub const DEMO_LESSON_ID: &str = "demo-slope-intro";
pub const CONTENT_ALG: &str = "AES-256-GCM";
pub const KEY_WRAP_ALG: &str = "RSA-OAEP-256";
pub const AAD_PURPOSE: &str = "protected-lesson";

#[derive(Debug, Deserialize)]
pub struct SealLessonRequest {
    pub rsa_public_key_spki_b64: String,
}

/// Outer response carries ciphertext + wrap only — real title lives in plaintext.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct SealLessonResponse {
    pub lesson_id: String,
    /// Nonsensitive demo marker (not lesson content).
    pub demo: String,
    pub content_alg: String,
    pub key_wrap: String,
    pub iv_b64: String,
    pub ciphertext_b64: String,
    pub aad_b64: String,
    pub wrapped_key_b64: String,
}

/// Canonical AAD contract shared with the browser (single format).
///
/// `{"v":1,"purpose":"protected-lesson","lesson_id":"<id>"}`
pub fn canonical_aad_bytes(lesson_id: &str) -> Vec<u8> {
    format!(
        r#"{{"v":1,"purpose":"{}","lesson_id":"{}"}}"#,
        AAD_PURPOSE, lesson_id
    )
    .into_bytes()
}

pub fn demo_aad_bytes() -> Vec<u8> {
    canonical_aad_bytes(DEMO_LESSON_ID)
}

/// Bounded static lesson JSON (plaintext before seal). Kept short for the demo.
pub fn demo_lesson_plaintext() -> Vec<u8> {
    // Strokes use simple CSS-pixel paths for canvas replay.
    // Use r## so hex colors with '#' do not terminate the raw string.
    let json = r##"{"v":1,"id":"demo-slope-intro","title":"Slope intuition in three strokes","steps":[{"index":0,"label":"Draw the axes","note":"Horizontal run and vertical rise frame the plane.","strokes":[{"color":"#0a0a0a","width":2.5,"points":[{"x":40,"y":200},{"x":360,"y":200}]},{"color":"#0a0a0a","width":2.5,"points":[{"x":80,"y":40},{"x":80,"y":280}]}]},{"index":1,"label":"Mark run and rise","note":"Run is delta-x; rise is delta-y.","strokes":[{"color":"#0033aa","width":3,"points":[{"x":80,"y":200},{"x":220,"y":200}]},{"color":"#0d5c2e","width":3,"points":[{"x":220,"y":200},{"x":220,"y":100}]}]},{"index":2,"label":"Connect the slope","note":"Slope m equals rise over run.","strokes":[{"color":"#9b1c1c","width":3.5,"points":[{"x":80,"y":200},{"x":140,"y":160},{"x":220,"y":100}]}]}]}"##;
    json.as_bytes().to_vec()
}

fn decode_spki_b64(spki_b64: &str) -> AppResult<Vec<u8>> {
    if !valid_b64(spki_b64, MAX_RSA_SPKI_B64) {
        return Err(AppError::BadRequest("invalid rsa_public_key_spki_b64".into()));
    }
    let bytes = B64
        .decode(spki_b64.trim())
        .map_err(|_| AppError::BadRequest("invalid rsa_public_key_spki_b64 encoding".into()))?;
    if bytes.len() < MIN_RSA_SPKI_BYTES || bytes.len() > MAX_RSA_SPKI_BYTES {
        return Err(AppError::BadRequest("invalid rsa public key size".into()));
    }
    Ok(bytes)
}

fn parse_and_validate_rsa_public_key(spki: &[u8]) -> AppResult<RsaPublicKey> {
    let rsa_pub = RsaPublicKey::from_public_key_der(spki)
        .map_err(|_| AppError::BadRequest("invalid rsa public key".into()))?;
    let bits = rsa_pub.n().bits() as u64;
    if bits != REQUIRED_RSA_BITS {
        return Err(AppError::BadRequest("rsa modulus must be 2048 bits".into()));
    }
    // Accept only the common F4 exponent (65537).
    let e = rsa_pub.e();
    let expected = BigUint::from(65537u32);
    if e != &expected {
        return Err(AppError::BadRequest("rsa exponent must be 65537".into()));
    }
    Ok(rsa_pub)
}

/// Seal the static demo lesson to a browser RSA-OAEP public key.
///
/// Does not log plaintext, AES key material, or unwrapped secrets.
pub fn seal_demo_lesson(rsa_public_key_spki_b64: &str) -> AppResult<SealLessonResponse> {
    let spki = decode_spki_b64(rsa_public_key_spki_b64)?;
    let rsa_pub = parse_and_validate_rsa_public_key(&spki)?;

    // Best-effort key scrub via zeroize (not a formal zeroization guarantee).
    let mut aes_key = Zeroizing::new([0u8; AES_KEY_LEN]);
    rand::thread_rng().fill_bytes(aes_key.as_mut());
    let mut iv = [0u8; IV_LEN];
    rand::thread_rng().fill_bytes(&mut iv);

    let plaintext = demo_lesson_plaintext();
    if plaintext.len() > MAX_PROTECTED_LESSON_PLAINTEXT {
        return Err(AppError::Internal(anyhow::anyhow!("lesson plaintext bound")));
    }
    let aad = demo_aad_bytes();

    let cipher = Aes256Gcm::new_from_slice(aes_key.as_ref())
        .map_err(|_| AppError::Internal(anyhow::anyhow!("aes key init")))?;
    let nonce = Nonce::from_slice(&iv);
    let ciphertext = cipher
        .encrypt(
            nonce,
            Payload {
                msg: &plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| AppError::Internal(anyhow::anyhow!("aes encrypt")))?;
    if ciphertext.is_empty() || ciphertext.len() > MAX_PROTECTED_LESSON_CIPHERTEXT {
        return Err(AppError::Internal(anyhow::anyhow!("ciphertext bound")));
    }

    let padding = Oaep::new::<Sha256>();
    let wrapped = rsa_pub
        .encrypt(&mut rand::thread_rng(), padding, aes_key.as_ref())
        .map_err(|_| AppError::BadRequest("rsa wrap failed".into()))?;
    if wrapped.len() != RSA2048_WRAPPED_KEY_LEN {
        return Err(AppError::Internal(anyhow::anyhow!("wrapped key size")));
    }
    // aes_key (Zeroizing) drops here and best-effort scrubs.

    Ok(SealLessonResponse {
        lesson_id: DEMO_LESSON_ID.into(),
        demo: "protected-lesson".into(),
        content_alg: CONTENT_ALG.into(),
        key_wrap: KEY_WRAP_ALG.into(),
        iv_b64: B64.encode(iv),
        ciphertext_b64: B64.encode(ciphertext),
        aad_b64: B64.encode(aad),
        wrapped_key_b64: B64.encode(wrapped),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::aead::{Aead, KeyInit, Payload};
    use aes_gcm::{Aes256Gcm, Nonce};
    use rsa::pkcs8::EncodePublicKey;
    use rsa::{Oaep, RsaPrivateKey};
    use sha2::Sha256;

    fn test_rsa_spki_b64(bits: usize) -> (RsaPrivateKey, String) {
        let mut rng = rand::thread_rng();
        let private = RsaPrivateKey::new(&mut rng, bits).expect("rsa keygen");
        let public = RsaPublicKey::from(&private);
        let der = public.to_public_key_der().expect("spki").as_bytes().to_vec();
        (private, B64.encode(der))
    }

    #[test]
    fn rejects_empty_spki() {
        let err = seal_demo_lesson("").expect_err("empty");
        assert!(matches!(err, AppError::BadRequest(_)));
    }

    #[test]
    fn rejects_non_b64_spki() {
        let err = seal_demo_lesson("!!!not-base64!!!").expect_err("bad b64");
        assert!(matches!(err, AppError::BadRequest(_)));
    }

    #[test]
    fn rejects_oversized_spki_b64() {
        let huge = "A".repeat(MAX_RSA_SPKI_B64 + 1);
        let err = seal_demo_lesson(&huge).expect_err("oversized");
        assert!(matches!(err, AppError::BadRequest(_)));
    }

    #[test]
    fn rejects_truncated_spki() {
        let tiny = B64.encode([1u8, 2, 3, 4]);
        let err = seal_demo_lesson(&tiny).expect_err("tiny");
        assert!(matches!(err, AppError::BadRequest(_)));
    }

    #[test]
    fn rejects_non_2048_modulus() {
        let (_private, spki_b64) = test_rsa_spki_b64(1024);
        let err = seal_demo_lesson(&spki_b64).expect_err("1024");
        assert!(matches!(err, AppError::BadRequest(_)));
    }

    #[test]
    fn seals_and_roundtrips_with_matching_rsa() {
        let (private, spki_b64) = test_rsa_spki_b64(2048);
        let sealed = seal_demo_lesson(&spki_b64).expect("seal");

        assert_eq!(sealed.lesson_id, DEMO_LESSON_ID);
        assert_eq!(sealed.demo, "protected-lesson");
        assert_eq!(sealed.content_alg, CONTENT_ALG);
        assert_eq!(sealed.key_wrap, KEY_WRAP_ALG);
        // Title must not appear as outer plaintext metadata.
        let json = serde_json::to_value(&sealed).unwrap();
        assert!(json.get("title").is_none());

        let iv = B64.decode(&sealed.iv_b64).unwrap();
        assert_eq!(iv.len(), IV_LEN);
        let aad = B64.decode(&sealed.aad_b64).unwrap();
        assert_eq!(aad, demo_aad_bytes());
        assert_eq!(aad, canonical_aad_bytes(DEMO_LESSON_ID));
        let ct = B64.decode(&sealed.ciphertext_b64).unwrap();
        let wrapped = B64.decode(&sealed.wrapped_key_b64).unwrap();
        assert_eq!(wrapped.len(), RSA2048_WRAPPED_KEY_LEN);

        let padding = Oaep::new::<Sha256>();
        let aes_key = private.decrypt(padding, &wrapped).expect("unwrap aes");
        assert_eq!(aes_key.len(), AES_KEY_LEN);

        let cipher = Aes256Gcm::new_from_slice(&aes_key).unwrap();
        let nonce = Nonce::from_slice(&iv);
        let pt = cipher
            .decrypt(
                nonce,
                Payload {
                    msg: &ct,
                    aad: &aad,
                },
            )
            .expect("decrypt lesson");
        assert_eq!(pt, demo_lesson_plaintext());

        let mut bad_aad = aad.clone();
        bad_aad[0] ^= 0xff;
        assert!(cipher
            .decrypt(
                nonce,
                Payload {
                    msg: &ct,
                    aad: &bad_aad,
                },
            )
            .is_err());

        let mut bad_ct = ct.clone();
        let last = bad_ct.len() - 1;
        bad_ct[last] ^= 0x01;
        assert!(cipher
            .decrypt(
                nonce,
                Payload {
                    msg: &bad_ct,
                    aad: &aad,
                },
            )
            .is_err());
    }

    #[test]
    fn demo_plaintext_is_bounded() {
        let pt = demo_lesson_plaintext();
        assert!(pt.len() > 64);
        assert!(pt.len() < 8 * 1024);
        let v: serde_json::Value = serde_json::from_slice(&pt).unwrap();
        assert_eq!(v["id"], DEMO_LESSON_ID);
        assert!(v["steps"].as_array().unwrap().len() >= 2);
    }

    #[test]
    fn response_fields_are_stable_typed_shape() {
        let (_private, spki_b64) = test_rsa_spki_b64(2048);
        let sealed = seal_demo_lesson(&spki_b64).unwrap();
        let json = serde_json::to_value(&sealed).unwrap();
        for key in [
            "lesson_id",
            "demo",
            "content_alg",
            "key_wrap",
            "iv_b64",
            "ciphertext_b64",
            "aad_b64",
            "wrapped_key_b64",
        ] {
            assert!(json.get(key).and_then(|v| v.as_str()).is_some(), "{key}");
        }
    }

    #[test]
    fn canonical_aad_contract() {
        let aad = String::from_utf8(canonical_aad_bytes("demo-slope-intro")).unwrap();
        assert_eq!(
            aad,
            r#"{"v":1,"purpose":"protected-lesson","lesson_id":"demo-slope-intro"}"#
        );
    }
}
