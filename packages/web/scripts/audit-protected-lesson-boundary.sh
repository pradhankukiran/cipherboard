#!/usr/bin/env bash
# Deterministic source/glue audit for the protected-lesson Wasm decrypt seam.
# Run after wasm-pack generation.
set -euo pipefail

RUST_SRC="${1:-crates/cipherboard-wasm/src/protected_decrypt.rs}"
GLUE_JS="${2:-packages/web/src/wasm/pkg/cipherboard_wasm.js}"

fail() { echo "audit-protected-lesson-boundary: FAIL: $*" >&2; exit 1; }
ok() { echo "audit-protected-lesson-boundary: ok: $*"; }

[[ -f "$RUST_SRC" ]] || fail "missing rust source: $RUST_SRC"
[[ -f "$GLUE_JS" ]] || fail "missing wasm glue: $GLUE_JS"

# Extract decrypt_protected_lesson parameter list.
PARAMS="$(
  awk '
    /pub async fn decrypt_protected_lesson/ { capture=1 }
    capture {
      buf = buf $0 ORS
      if ($0 ~ /\)\s*->/) { print buf; exit }
    }
  ' "$RUST_SRC"
)"

[[ -n "$PARAMS" ]] || fail "decrypt_protected_lesson export not found"

echo "$PARAMS" | grep -q 'CryptoKey' || fail "CryptoKey handle missing from signature"
echo "$PARAMS" | grep -q 'Uint8Array' || fail "Uint8Array handles missing from signature"

# Banned seam types (Rust-owned bytes / strings at the decrypt boundary).
if echo "$PARAMS" | grep -E -q ':\s*&str\b|:\s*String\b|Vec\s*<\s*u8\s*>|:\s*&\s*\[\s*u8\s*\]|:\s*JsString\b'; then
  fail "banned seam type in decrypt_protected_lesson parameters"
fi

if echo "$PARAMS" | grep -E -i -q 'jwk|base64|raw_key|key_bytes'; then
  fail "suspicious key-material parameter name in seam signature"
fi

ok "rust decrypt_protected_lesson uses JS handles only"

# Extract only the decryptProtectedLesson function body from generated glue.
BODY="$(
  awk '
    /^export function decryptProtectedLesson\(/ { capture=1 }
    capture {
      print
      if (/^}/) exit
    }
  ' "$GLUE_JS"
)"

[[ -n "$BODY" ]] || fail "decryptProtectedLesson export not found in glue"

if echo "$BODY" | grep -E -q 'passStringToWasm0?\s*\('; then
  fail "generated glue uses passStringToWasm inside decryptProtectedLesson"
fi

if echo "$BODY" | grep -E -q 'passArray8ToWasm0?\s*\('; then
  fail "generated glue copies typed-array bytes into Wasm linear memory for decryptProtectedLesson"
fi

# Arguments must be forwarded as JS values to the wasm import.
if ! echo "$BODY" | grep -q 'wasm.decryptProtectedLesson(key, ciphertext, iv, aad)'; then
  fail "expected externref-style call wasm.decryptProtectedLesson(key, ciphertext, iv, aad)"
fi

ok "generated glue keeps key/data as JS values (no passStringToWasm)"
echo "audit-protected-lesson-boundary: PASS"
