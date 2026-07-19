pub const MAX_DISPLAY_NAME: usize = 64;
pub const MAX_PUBLIC_KEY_B64: usize = 512;
pub const MAX_FINGERPRINT: usize = 128;
pub const MAX_EVENT_ID: usize = 128;
pub const MAX_IV_B64: usize = 64;
pub const MAX_CIPHERTEXT_B64: usize = 96 * 1024;
pub const MAX_AAD_JSON: usize = 2048;
pub const MAX_BRANCH_NAME: usize = 64;
pub const MAX_ENVELOPES_PER_MESSAGE: usize = 16;
pub const PROTOCOL_VERSION: i32 = 1;

pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn valid_display_name(name: &str) -> bool {
    let t = name.trim();
    !t.is_empty() && t.len() <= MAX_DISPLAY_NAME && t.chars().all(|c| !c.is_control())
}

pub fn valid_b64(s: &str, max: usize) -> bool {
    !s.is_empty()
        && s.len() <= max
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=' | '-' | '_'))
}
