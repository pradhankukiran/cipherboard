# Cipherboard

**Encrypted live whiteboard for small teaching sessions** — drawing keys stay in the browser; the relay never sees plaintext board content.

Cipherboard is a full-stack portfolio system for **end-to-end encrypted collaborative drawing**, host-controlled rooms, private timeline scrubbing, and a production-quality **Protected Lesson Replay** showcase of the browser WebCrypto ↔ Rust/Wasm boundary.

| | |
|---|---|
| **Live app** | [https://cipherboard.up.railway.app](https://cipherboard.up.railway.app) |
| **Protected Lesson Replay** | [https://cipherboard.up.railway.app/demo/protected-lesson](https://cipherboard.up.railway.app/demo/protected-lesson) |

---

## Why it exists

Most “encrypted whiteboard” demos stop at marketing claims. Cipherboard implements a **ciphertext-only Axum relay**, **pairwise ECDH + AES-GCM envelopes** in the browser, **Wasm for geometry/timeline work** (not for holding secret key bytes), and an explicit **protected-lesson seam** that decrypts via SubtleCrypto using opaque `CryptoKey` handles from Rust/Wasm.

It is built to be readable by engineers reviewing **Rust-to-Wasm architecture**, WebCrypto ownership, and honest browser threat models.

---

## Features

### Live encrypted rooms
- Host creates a room; guests join with invite code and wait for host approval
- Rooms capped at **2–8** participants (`MAX_ROOM_SIZE`, default 8)
- Per-peer **P-256 ECDH** → **HKDF-SHA-256** → **AES-256-GCM** message keys
- Private keys and derived AES keys are **non-extractable** `CryptoKey`s; persistence via IndexedDB structured clone
- Server stores and relays **ciphertext + AAD metadata only** (no board plaintext)
- Safety codes (SHA-256 fingerprints of SPKI) for out-of-band comparison

### Private Time Travel
- Scrub, step, and fork branch timelines client-side
- Replay/snapshot math runs in a **Web Worker + Wasm** path that never receives CryptoKeys
- Host can fork branches; timeline UX is private to each browser’s decrypted view

### Protected Lesson Replay (architecture showcase)
- Server seals a short static lesson with a fresh AES-256-GCM key and **RSA-OAEP-SHA-256** wrap to the browser’s public key
- Browser generates an **unwrapKey-only**, non-extractable RSA private key; unwraps AES via `SubtleCrypto.unwrapKey` (no decrypt+importKey raw-AES path)
- Rust/Wasm `decryptProtectedLesson` accepts **CryptoKey + Uint8Array handles**, validates key metadata (secret, non-extractable, AES-GCM, length 256, decrypt-only), calls SubtleCrypto, returns plaintext as a **JS `ArrayBuffer`**
- UI audit panel reports runtime facts (including AES `exportKey` rejection)
- Deterministic **source/glue audit** in Docker after `wasm-pack` (externref seam, no `passStringToWasm` on key/data)

---

## Architecture

```mermaid
flowchart LR
  subgraph Browser
    UI[React UI]
    WC[WebCrypto<br/>ECDH / AES-GCM / RSA-OAEP]
    W[Board Worker]
    WASM[cipherboard-wasm<br/>smooth / encode / replay / decrypt seam]
    UI --> WC
    UI --> W
    W --> WASM
    UI --> WASM
  end

  subgraph Railway
    AX[cipherboard-server<br/>Axum REST + WebSocket]
    PG[(PostgreSQL<br/>rooms, ciphertext envelopes)]
    ST[Static SPA<br/>asset-aware fallback]
    AX --> PG
    AX --> ST
  end

  UI <-->|ciphertext envelopes| AX
  UI -->|POST SPKI| AX
```

### Room draw path (simplified)

1. Browser generates non-extractable identity keys (ECDH P-256).
2. REST: create/join room; WebSocket: `cipherboard` + `auth.<token>` subprotocol (token not in the URL).
3. On stroke commit, client derives pairwise AES-GCM keys, encrypts event JSON with authenticated AAD bound to room/sender/recipient/event/branch.
4. Server validates sizes, AAD shape, and session authority; assigns sequence; persists and broadcasts **envelopes only**.
5. Recipients decrypt with WebCrypto; Wasm worker encodes/decodes geometry and rebuilds snapshots for scrubbing—**without key material**.

### Protected lesson path

1. Browser: RSA-OAEP keypair (`unwrapKey` only on private).
2. `POST /api/demo/protected-lesson` with public SPKI (bounded body; RSA-2048 + e=65537 enforced).
3. Server: fresh AES key → seal static lesson + canonical AAD → RSA-wrap AES key → JSON (no lesson title in outer metadata).
4. Browser: `unwrapKey` → non-extractable AES decrypt-only → Wasm `decryptProtectedLesson` → JSON validate → canvas replay.

---

## WebCrypto ↔ Rust/Wasm boundary

| Concern | Behavior in this repo |
|--------|------------------------|
| Secret key **bytes** in Wasm linear memory | **Not used** on the protected-lesson decrypt path |
| What Wasm receives | Opaque JS `CryptoKey` + `Uint8Array` handles (externrefs) |
| What Wasm returns | Plaintext as a JS **`ArrayBuffer`** from SubtleCrypto |
| What Wasm must not accept at that seam | Strings, `Vec<u8>`, JWK, base64, raw key bytes |
| Board crypto (live rooms) | Entirely in TypeScript WebCrypto; Wasm does geometry/timeline only |

The protected-lesson audit UI states this honestly: **key bytes do not enter Wasm linear memory**; **plaintext does exist briefly in JS** for decode and paint. The design does **not** claim “plaintext never touches JavaScript.”

### Browser threat model (honest)

Wasm is a **cost-raising seam and engineering discipline**, not a security boundary against a hostile page:

- XSS or a compromised origin can still call WebCrypto and read decrypted lesson/board data in JS.
- Non-extractable keys reduce casual `exportKey` exfiltration; they do not stop malware running as the site.
- The server is untrusted for confidentiality of board content; it is trusted for availability, sequencing, and access control (approve/remove/lock).
- Screenshots and approved peers remain outside the crypto model.

---

## Security controls (implemented)

- Ciphertext-only relay; AAD binding checks on the server
- Non-extractable keys; pairwise direction-bound HKDF info
- Input bounds (display names, SPKI, IV, ciphertext, envelopes per message)
- Rate limiting and max message size (config)
- Session tokens hashed at rest; WebSocket auth via subprotocol
- Security headers: CSP (includes `wasm-unsafe-eval`), `nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`
- SPA static serving: client routes → `index.html` **200**; missing extension-bearing assets → **404** (no silent index for broken `.js`/`.wasm`)
- Protected-lesson: RSA size/exponent checks, response size bounds, canonical AAD, unwrapKey-only, export-attempt audit, E2E tamper fail-closed

---

## Tech stack

| Layer | Choice |
|-------|--------|
| Server | Rust, Axum 0.8, Tokio, sqlx, PostgreSQL |
| Client | React 19, TypeScript, Vite 6, React Router 7 |
| Crypto | Web Crypto API (browser); AES-GCM + RSA-OAEP (server seal via RustCrypto) |
| Wasm | `wasm-bindgen`, `web-sys` SubtleCrypto, worker-packaged board helpers |
| Deploy | Multi-stage Dockerfile on Railway; health check `/health` |

Pinned in Docker: **Rust 1.88**, **Node 22.14**, **pnpm 10.32.1**, **wasm-pack 0.13.1**.

---

## Quick start (Docker)

The authoritative path is the multi-stage `Dockerfile`: unit tests, Wasm build, boundary audit, web build, Playwright e2e, then runtime image.

```bash
# Build (runs cargo test, vitest, tsc, e2e gate)
docker build -t cipherboard .

# Run with Postgres reachable at DATABASE_URL
docker run --rm -p 8080:8080 \
  -e DATABASE_URL=postgres://user:pass@host:5432/cipherboard \
  -e PORT=8080 \
  cipherboard
```

Health: `GET /health` → `{ "status": "ok", "service": "cipherboard" }`.

---

## Local development

### Prerequisites

- Rust toolchain + `wasm32-unknown-unknown`
- `wasm-pack`
- Node ≥ 20, pnpm 10.32.1 (via Corepack)
- PostgreSQL

### Environment

Copy `.env.example` and set at least:

```bash
DATABASE_URL=postgres://cipherboard:cipherboard@localhost:5432/cipherboard
PORT=8080
HOST=0.0.0.0
# optional: MAX_ROOM_SIZE=8  RATE_LIMIT_PER_SECOND=30  STATIC_DIR=...
```

### Commands (from repo root)

```bash
# Install web deps
pnpm install

# Build Wasm package into packages/web/src/wasm/pkg
pnpm build:wasm

# Web dev server (proxies /api, /ws, /health → :8080)
pnpm dev:web

# Server (separate terminal; runs migrations on start)
cargo run -p cipherboard-server

# Tests
cargo test -p cipherboard-wasm
cargo test -p cipherboard-server --lib
pnpm test:web          # Vitest
pnpm typecheck
pnpm test:e2e          # Playwright (needs app up; see packages/web/playwright.config.ts)

# Protected-lesson Wasm seam audit (after wasm-pack)
bash packages/web/scripts/audit-protected-lesson-boundary.sh \
  crates/cipherboard-wasm/src/protected_decrypt.rs \
  packages/web/src/wasm/pkg/cipherboard_wasm.js \
  packages/web/src/lib/protectedLesson.ts
```

Vite dev proxy targets `http://127.0.0.1:8080` for API and WebSocket.

---

## Project structure

```
cipherboard/
├── crates/
│   ├── cipherboard-server/     # Axum relay, REST, WS, sealed lesson, SPA static
│   └── cipherboard-wasm/       # Smooth/encode/replay + protected decrypt seam
├── packages/web/               # React client, WebCrypto, worker, e2e
│   ├── e2e/                    # Playwright smoke + protected-lesson
│   ├── scripts/                # Boundary audit shell script
│   └── src/
│       ├── crypto/             # Identity, envelopes, session
│       ├── lib/                # API, board worker client, protected lesson
│       ├── pages/              # Landing, room, protected lesson
│       ├── workers/            # Wasm board worker
│       └── wasm/pkg/           # Generated (gitignored); produced by wasm-pack
├── docker/e2e-run.sh           # In-image Postgres + server + Playwright
├── Dockerfile                  # Full quality gate → runtime binary + static
└── railway.toml
```

---

## Verification and tests

| Gate | What it covers |
|------|----------------|
| `cargo test -p cipherboard-wasm` | Geometry/encode/validate unit tests |
| `cargo test -p cipherboard-server --lib` | Limits, AAD, protected-lesson seal, SPA static routing |
| Vitest (`pnpm test:web`) | WebCrypto envelopes, protected-lesson module, worker failure recovery, draw/scrub helpers |
| Boundary audit script | Sole `decryptProtectedLesson` export; no string/Vec seam; glue externref forward; unwrapKey-only TS |
| Playwright | Multi-user room smoke; protected-lesson audit + ciphertext/AAD tamper fail-closed |
| Docker multi-stage | All of the above must pass before the runtime image is produced |

---

## Limitations

- **Confidentiality stops at the browser origin.** XSS or a malicious extension defeats client crypto.
- **Not a substitute for verified identity.** Safety codes need an out-of-band channel the users trust.
- **Small rooms only** (≤ 8). Not designed for large classrooms or fan-out CDN drawing.
- **Server availability & policy** (approve, remove, lock, sequencing) are trusted; content confidentiality is not.
- **Protected lesson is a demo seal**, not a general CMS or multi-tenant lesson store.
- **No formal memory zeroization guarantees** for freed JS plaintext; server AES key scrubbing is best-effort via `zeroize`.

---

## License

Licensed under the [MIT License](LICENSE).

---

## Routes (client)

| Path | Purpose |
|------|---------|
| `/` | Create / join room |
| `/room/:roomId` | Live encrypted board session |
| `/demo/protected-lesson` | Server-sealed lesson + Wasm decrypt audit UI |

API highlights: `POST /api/rooms`, `POST /api/rooms/{id}/join`, `POST /api/demo/protected-lesson`, `GET /health`, WebSocket `/ws`.

---

Built as a concrete reference for encrypted edtech UX and careful **Rust/Wasm + WebCrypto** boundaries—not as a claim of unbreakable client-side security.
