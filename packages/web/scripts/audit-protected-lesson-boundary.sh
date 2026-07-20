#!/usr/bin/env bash
# Deterministic source/glue audit for the protected-lesson Wasm decrypt seam.
# POSIX awk/grep compatible (Debian mawk/gawk). Run after wasm-pack generation.
set -euo pipefail

RUST_SRC="${1:-crates/cipherboard-wasm/src/protected_decrypt.rs}"
GLUE_JS="${2:-packages/web/src/wasm/pkg/cipherboard_wasm.js}"
# Optional browser module path (when present in the build context).
BROWSER_TS="${3:-packages/web/src/lib/protectedLesson.ts}"

fail() { echo "audit-protected-lesson-boundary: FAIL: $*" >&2; exit 1; }
ok() { echo "audit-protected-lesson-boundary: ok: $*"; }

[ -f "$RUST_SRC" ] || fail "missing rust source: $RUST_SRC"
[ -f "$GLUE_JS" ] || fail "missing wasm glue: $GLUE_JS"

# --- Single production decrypt export ---
EXPORT_COUNT="$(grep -c 'pub async fn decrypt_protected_lesson' "$RUST_SRC" || true)"
[ "$EXPORT_COUNT" = "1" ] || fail "expected exactly one decrypt_protected_lesson export, got $EXPORT_COUNT"

if grep -E -q 'js_name[[:space:]]*=[[:space:]]*validateProtectedLesson' "$RUST_SRC"; then
  fail "test-only validate helpers must not be exported from production Wasm"
fi
if grep -E -q '#\[wasm_bindgen[^]]*\][[:space:]]*(pub[[:space:]]+)?(async[[:space:]]+)?fn[[:space:]]+validate_' "$RUST_SRC"; then
  fail "unexpected extra wasm_bindgen validate export"
fi

# Extract multiline decrypt_protected_lesson signature through ") ->".
# Use POSIX [[:space:]] — Debian mawk does not support \s.
PARAMS="$(
  awk '
    /pub async fn decrypt_protected_lesson/ { capture=1 }
    capture {
      buf = buf $0 "\n"
      if ($0 ~ /\)[[:space:]]*->/) {
        print buf
        exit
      }
    }
  ' "$RUST_SRC"
)"

[ -n "$PARAMS" ] || fail "decrypt_protected_lesson export not found"

echo "$PARAMS" | grep -q 'CryptoKey' || fail "CryptoKey handle missing from signature"
echo "$PARAMS" | grep -q 'Uint8Array' || fail "Uint8Array handles missing from signature"

if echo "$PARAMS" | grep -E -q ':[[:space:]]*&str([^[:alnum:]_]|$)|:[[:space:]]*String([^[:alnum:]_]|$)|Vec[[:space:]]*<[[:space:]]*u8[[:space:]]*>|:[[:space:]]*&[[:space:]]*\[[[:space:]]*u8[[:space:]]*\]|:[[:space:]]*JsString([^[:alnum:]_|$])'; then
  fail "banned seam type in decrypt_protected_lesson parameters"
fi

if echo "$PARAMS" | grep -E -i -q 'jwk|base64|raw_key|key_bytes'; then
  fail "suspicious key-material parameter name in seam signature"
fi

# AES-256 length validation must be present.
grep -q 'key length must be 256' "$RUST_SRC" || fail "missing AES length 256 validation error"
grep -E -q 'AES_LENGTH_BITS|length != 256|length != AES_LENGTH' "$RUST_SRC" \
  || fail "missing AES length 256 check"

ok "rust decrypt_protected_lesson is sole production export with JS handles + AES-256 check"

# --- Generated glue ---
# wasm-bindgen may emit:
#   export function decryptProtectedLesson(...) { ... }
#   export async function decryptProtectedLesson(...) { ... }
# Brace-depth extraction so nested blocks (if any) do not truncate early.
BODY="$(
  awk '
    /export[[:space:]]+(async[[:space:]]+)?function[[:space:]]+decryptProtectedLesson[[:space:]]*\(/ {
      capture=1
      depth=0
    }
    capture {
      print
      for (i = 1; i <= length($0); i++) {
        c = substr($0, i, 1)
        if (c == "{") depth++
        if (c == "}") {
          depth--
          if (depth <= 0) exit
        }
      }
    }
  ' "$GLUE_JS"
)"

[ -n "$BODY" ] || fail "decryptProtectedLesson export not found in glue"

# Ensure no other protected-lesson validate exports leaked into glue.
if grep -E -q 'export[[:space:]]+(async[[:space:]]+)?function[[:space:]]+validateProtectedLesson' "$GLUE_JS"; then
  fail "validateProtectedLesson* must not appear in generated glue"
fi

if echo "$BODY" | grep -E -q 'passStringToWasm[0-9]*[[:space:]]*\('; then
  fail "generated glue uses passStringToWasm inside decryptProtectedLesson"
fi

if echo "$BODY" | grep -E -q 'passArray8ToWasm[0-9]*[[:space:]]*\('; then
  fail "generated glue copies typed-array bytes into Wasm linear memory for decryptProtectedLesson"
fi

# Externref-style forward: key/data passed as JS values, not copied slices.
if ! echo "$BODY" | grep -E -q 'wasm\.decryptProtectedLesson[[:space:]]*\([[:space:]]*key[[:space:]]*,[[:space:]]*ciphertext[[:space:]]*,[[:space:]]*iv[[:space:]]*,[[:space:]]*aad[[:space:]]*\)'; then
  fail "expected externref-style call wasm.decryptProtectedLesson(key, ciphertext, iv, aad)"
fi

ok "generated glue keeps key/data as JS values (no passStringToWasm)"

# --- Browser seam: unwrapKey only, no decrypt+importKey raw AES path ---
if [ -f "$BROWSER_TS" ]; then
  if grep -E -q 'subtle\.decrypt[[:space:]]*\(' "$BROWSER_TS"; then
    fail "browser module must not call subtle.decrypt (raw AES surface risk)"
  fi
  if grep -E -q 'importKey[[:space:]]*\([[:space:]]*["'\'']raw["'\'']' "$BROWSER_TS"; then
    fail "browser module must not importKey(raw) for content key"
  fi
  grep -q 'unwrapKey' "$BROWSER_TS" || fail "browser module must use unwrapKey"
  if grep -E -q 'unwrapContentKeyDirect|decrypt\+importKey|Falls back to decrypt' "$BROWSER_TS"; then
    fail "banned raw AES fallback path markers in browser module"
  fi
  ok "browser module uses unwrapKey only (no raw AES fallback)"
else
  ok "browser module not in context; skipped TS audit"
fi

echo "audit-protected-lesson-boundary: PASS"
