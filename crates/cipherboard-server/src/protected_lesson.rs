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
use rsa::{Oaep, RsaPublicKey};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::error::{AppError, AppResult};
use crate::limits::valid_b64;

/// Max base64 length for an RSA SPKI (covers RSA-2048 and RSA-4096).
pub const MAX_RSA_SPKI_B64: usize = 1024;
/// Minimum decoded SPKI size (RSA-2048 SPKI is ~294 bytes).
const MIN_RSA_SPKI_BYTES: usize = 100;
const MAX_RSA_SPKI_BYTES: usize = 768;
const AES_KEY_LEN: usize = 32;
const IV_LEN: usize = 12;
const MAX_WRAPPED_KEY_BYTES: usize = 512;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// Stable demo lesson id bound into AAD.
pub const DEMO_LESSON_ID: &str = "demo-slope-intro";
pub const DEMO_LESSON_TITLE: &str = "Slope intuition in three strokes";
pub const CONTENT_ALG: &str = "AES-256-GCM";
pub const KEY_WRAP_ALG: &str = "RSA-OAEP-256";

#[derive(Debug, Deserialize)]
pub struct SealLessonRequest {
    pub rsa_public_key_spki_b64: String,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct SealLessonResponse {
    pub lesson_id: String,
    pub title: String,
    pub content_alg: String,
    pub key_wrap: String,
    pub iv_b64: String,
    pub ciphertext_b64: String,
    pub aad_b64: String,
    pub wrapped_key_b64: String,
}

/// Canonical AAD bytes bound to the sealed demo lesson (not logged).
pub fn demo_aad_bytes() -> Vec<u8> {
    // Compact, stable, authenticated associated data — no secrets.
    format!(
        r#"{{"v":1,"purpose":"protected-lesson","lesson_id":"{}"}}"#,
        DEMO_LESSON_ID
    )
    .into_bytes()
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

fn parse_rsa_public_key(spki: &[u8]) -> AppResult<RsaPublicKey> {
    RsaPublicKey::from_public_key_der(spki)
        .map_err(|_| AppError::BadRequest("invalid rsa public key".into()))
}

/// Seal the static demo lesson to a browser RSA-OAEP public key.
///
/// Does not log plaintext, AES key material, or unwrapped secrets.
pub fn seal_demo_lesson(rsa_public_key_spki_b64: &str) -> AppResult<SealLessonResponse> {
    let spki = decode_spki_b64(rsa_public_key_spki_b64)?;
    let rsa_pub = parse_rsa_public_key(&spki)?;

    let mut aes_key = [0u8; AES_KEY_LEN];
    let mut iv = [0u8; IV_LEN];
    rand::thread_rng().fill_bytes(&mut aes_key);
    rand::thread_rng().fill_bytes(&mut iv);

    let plaintext = demo_lesson_plaintext();
    let aad = demo_aad_bytes();

    let cipher = Aes256Gcm::new_from_slice(&aes_key)
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

    let padding = Oaep::new::<Sha256>();
    let wrapped = rsa_pub
        .encrypt(&mut rand::thread_rng(), padding, &aes_key)
        .map_err(|_| AppError::BadRequest("rsa wrap failed".into()))?;
    if wrapped.is_empty() || wrapped.len() > MAX_WRAPPED_KEY_BYTES {
        return Err(AppError::Internal(anyhow::anyhow!("wrapped key size")));
    }

    // Best-effort scrub of stack key material (not a formal zeroize guarantee claim).
    aes_key.fill(0);

    Ok(SealLessonResponse {
        lesson_id: DEMO_LESSON_ID.into(),
        title: DEMO_LESSON_TITLE.into(),
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

    fn test_rsa_spki_b64() -> (RsaPrivateKey, String) {
        let mut rng = rand::thread_rng();
        let private = RsaPrivateKey::new(&mut rng, 2048).expect("rsa keygen");
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
    fn seals_and_roundtrips_with_matching_rsa() {
        let (private, spki_b64) = test_rsa_spki_b64();
        let sealed = seal_demo_lesson(&spki_b64).expect("seal");

        assert_eq!(sealed.lesson_id, DEMO_LESSON_ID);
        assert_eq!(sealed.title, DEMO_LESSON_TITLE);
        assert_eq!(sealed.content_alg, CONTENT_ALG);
        assert_eq!(sealed.key_wrap, KEY_WRAP_ALG);
        assert!(!sealed.iv_b64.is_empty());
        assert!(!sealed.ciphertext_b64.is_empty());
        assert!(!sealed.aad_b64.is_empty());
        assert!(!sealed.wrapped_key_b64.is_empty());

        let iv = B64.decode(&sealed.iv_b64).unwrap();
        assert_eq!(iv.len(), IV_LEN);
        let aad = B64.decode(&sealed.aad_b64).unwrap();
        assert_eq!(aad, demo_aad_bytes());
        let ct = B64.decode(&sealed.ciphertext_b64).unwrap();
        let wrapped = B64.decode(&sealed.wrapped_key_b64).unwrap();

        let padding = Oaep::new::<Sha256>();
        let aes_key = private
            .decrypt(padding, &wrapped)
            .expect("unwrap aes");
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

        // Tampered AAD must fail
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

        // Tampered ciphertext must fail
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
        let (_private, spki_b64) = test_rsa_spki_b64();
        let sealed = seal_demo_lesson(&spki_b64).unwrap();
        let json = serde_json::to_value(&sealed).unwrap();
        for key in [
            "lesson_id",
            "title",
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
}
