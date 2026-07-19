# syntax=docker/dockerfile:1.7
# Multi-stage build. Unit/integration/e2e failures prevent the final image.

FROM rust:1-bookworm AS rust-base
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libssl-dev clang cmake git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && rustup target add wasm32-unknown-unknown \
    && cargo install wasm-pack --locked

FROM rust-base AS wasm-test
WORKDIR /app
COPY Cargo.toml ./
COPY crates/cipherboard-wasm ./crates/cipherboard-wasm
# Workspace member stub for server
COPY crates/cipherboard-server/Cargo.toml ./crates/cipherboard-server/Cargo.toml
RUN mkdir -p crates/cipherboard-server/src \
    && printf 'fn main() {}\n' > crates/cipherboard-server/src/main.rs
WORKDIR /app/crates/cipherboard-wasm
RUN cargo test
RUN wasm-pack build --target web --out-dir /wasm-pkg --release

FROM rust-base AS server-build
WORKDIR /app
COPY Cargo.toml ./
COPY crates ./crates
WORKDIR /app/crates/cipherboard-wasm
RUN cargo test
WORKDIR /app
RUN cargo test -p cipherboard-server --lib
RUN cargo build --release -p cipherboard-server

FROM node:22-bookworm AS web-build
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml ./
COPY packages/web/package.json ./packages/web/package.json
RUN pnpm install --filter @cipherboard/web...
COPY packages/web ./packages/web
COPY --from=wasm-test /wasm-pkg ./packages/web/src/wasm/pkg
WORKDIR /app/packages/web
RUN pnpm exec vitest run
RUN pnpm exec tsc -b --pretty false
RUN pnpm exec vite build

FROM debian:bookworm-slim AS e2e-gate
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl libssl3 postgresql postgresql-contrib \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node:22-bookworm /usr/local /usr/local
WORKDIR /app
COPY --from=server-build /app/target/release/cipherboard-server /usr/local/bin/cipherboard-server
COPY --from=web-build /app/packages/web/dist /app/static
COPY packages/web/playwright.config.ts /app/packages/web/playwright.config.ts
COPY packages/web/e2e /app/packages/web/e2e
COPY docker/e2e-run.sh /e2e-run.sh
RUN chmod +x /e2e-run.sh
WORKDIR /app/packages/web
RUN npm init -y >/dev/null 2>&1 \
 && npm install -D @playwright/test@1.50.0 \
 && npx playwright install --with-deps chromium
RUN /e2e-run.sh && echo ok > /e2e-ok

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl libssl3 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -r -u 10001 -d /app cipherboard
WORKDIR /app
# Gate: final image cannot build unless e2e-gate succeeded
COPY --from=e2e-gate /e2e-ok /app/.e2e-ok
COPY --from=server-build /app/target/release/cipherboard-server /app/cipherboard-server
COPY --from=web-build /app/packages/web/dist /app/static
ENV STATIC_DIR=/app/static
ENV HOST=0.0.0.0
ENV RUST_LOG=info,cipherboard_server=info
RUN chown -R cipherboard:cipherboard /app
USER cipherboard
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-8080}/health" || exit 1
CMD ["/app/cipherboard-server"]
