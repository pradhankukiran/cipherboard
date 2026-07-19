use sha2::{Digest, Sha256};

/// Recompute SHA-256 fingerprint of SPKI bytes (base64) as spaced hex groups.
pub fn fingerprint_from_spki_b64(spki_b64: &str) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(spki_b64)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(spki_b64))
        .or_else(|_| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(spki_b64))
        .map_err(|_| "public key not valid base64".to_string())?;
    // P-256 SPKI is typically 91 bytes; allow a reasonable range
    if bytes.len() < 50 || bytes.len() > 300 {
        return Err("public key length".into());
    }
    let digest = Sha256::digest(&bytes);
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    Ok(hex
        .as_bytes()
        .chunks(4)
        .map(|c| std::str::from_utf8(c).unwrap_or(""))
        .collect::<Vec<_>>()
        .join(" "))
}

pub fn fingerprints_match(claimed: &str, actual: &str) -> bool {
    normalize(claimed) == normalize(actual)
}

fn normalize(fp: &str) -> String {
    fp.chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_spaces() {
        assert!(fingerprints_match("ab cd", "abcd"));
        assert!(!fingerprints_match("ab", "cd"));
    }
}
