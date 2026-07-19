use serde::Deserialize;

use crate::limits::PROTOCOL_VERSION;

#[derive(Debug, Clone, Deserialize)]
pub struct AadFields {
    pub v: i32,
    pub room: String,
    pub from: String,
    pub to: String,
    pub event: String,
    pub branch: String,
}

pub fn parse_aad(aad_json: &str) -> Result<AadFields, String> {
    let aad: AadFields =
        serde_json::from_str(aad_json).map_err(|_| "invalid aad json".to_string())?;
    if aad.v != PROTOCOL_VERSION {
        return Err("aad protocol version".into());
    }
    if aad.room.is_empty()
        || aad.from.is_empty()
        || aad.to.is_empty()
        || aad.event.is_empty()
        || aad.branch.is_empty()
    {
        return Err("aad empty field".into());
    }
    if aad.room.len() > 64
        || aad.from.len() > 64
        || aad.to.len() > 64
        || aad.event.len() > 128
        || aad.branch.len() > 64
    {
        return Err("aad field too long".into());
    }
    Ok(aad)
}

pub fn assert_aad_matches(
    aad: &AadFields,
    room_id: &str,
    sender_id: &str,
    recipient_id: &str,
    event_id: &str,
    branch_id: &str,
) -> Result<(), String> {
    if aad.room != room_id {
        return Err("aad room mismatch".into());
    }
    if aad.from != sender_id {
        return Err("aad sender mismatch".into());
    }
    if aad.to != recipient_id {
        return Err("aad recipient mismatch".into());
    }
    if aad.event != event_id {
        return Err("aad event mismatch".into());
    }
    if aad.branch != branch_id {
        return Err("aad branch mismatch".into());
    }
    Ok(())
}

/// Decode standard or url-safe base64 and require exact IV length 12.
pub fn validate_iv_bytes(iv_b64: &str) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(iv_b64)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(iv_b64))
        .or_else(|_| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(iv_b64))
        .map_err(|_| "iv not valid base64".to_string())?;
    if bytes.len() != 12 {
        return Err("iv must be 12 bytes".into());
    }
    Ok(())
}

pub fn validate_ciphertext_bytes(ct_b64: &str) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(ct_b64)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(ct_b64))
        .or_else(|_| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(ct_b64))
        .map_err(|_| "ciphertext not valid base64".to_string())?;
    if bytes.is_empty() || bytes.len() > 96 * 1024 {
        return Err("ciphertext size".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aad_roundtrip_fields() {
        let json = r#"{"v":1,"room":"r1","from":"a","to":"b","event":"e1","branch":"br"}"#;
        let aad = parse_aad(json).unwrap();
        assert_aad_matches(&aad, "r1", "a", "b", "e1", "br").unwrap();
        assert!(assert_aad_matches(&aad, "r2", "a", "b", "e1", "br").is_err());
    }

    #[test]
    fn iv_length() {
        use base64::Engine;
        let good = base64::engine::general_purpose::STANDARD.encode([0u8; 12]);
        assert!(validate_iv_bytes(&good).is_ok());
        let bad = base64::engine::general_purpose::STANDARD.encode([0u8; 16]);
        assert!(validate_iv_bytes(&bad).is_err());
    }
}
