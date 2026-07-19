use wasm_bindgen::prelude::*;

const MAX_DISPLAY_NAME: usize = 64;
const MAX_ROOM_ID: usize = 64;
const MAX_PARTICIPANT_ID: usize = 64;
const MAX_CIPHERTEXT_B64: usize = 96 * 1024;
const MAX_IV_B64: usize = 64;
const MAX_PUBLIC_KEY_B64: usize = 512;

#[wasm_bindgen]
pub fn validate_display_name(name: &str) -> bool {
    let t = name.trim();
    !t.is_empty() && t.len() <= MAX_DISPLAY_NAME && t.chars().all(|c| !c.is_control())
}

#[wasm_bindgen]
pub fn validate_room_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ROOM_ID
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[wasm_bindgen]
pub fn validate_participant_id(id: &str) -> bool {
    validate_room_id(id) && id.len() <= MAX_PARTICIPANT_ID
}

#[wasm_bindgen]
pub fn validate_ciphertext_b64(ct: &str) -> bool {
    !ct.is_empty() && ct.len() <= MAX_CIPHERTEXT_B64 && is_b64url_or_std(ct)
}

#[wasm_bindgen]
pub fn validate_iv_b64(iv: &str) -> bool {
    !iv.is_empty() && iv.len() <= MAX_IV_B64 && is_b64url_or_std(iv)
}

#[wasm_bindgen]
pub fn validate_public_key_b64(pk: &str) -> bool {
    !pk.is_empty() && pk.len() <= MAX_PUBLIC_KEY_B64 && is_b64url_or_std(pk)
}

fn is_b64url_or_std(s: &str) -> bool {
    s.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '=' || c == '-' || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert!(validate_display_name("Alice"));
        assert!(!validate_display_name(""));
        assert!(!validate_display_name(&"x".repeat(100)));
    }

    #[test]
    fn ids() {
        assert!(validate_room_id("room-abc_123"));
        assert!(!validate_room_id("has space"));
        assert!(!validate_room_id(""));
    }
}
