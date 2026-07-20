use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::Router;
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::trace::TraceLayer;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use cipherboard_server::config::Config;
use cipherboard_server::routes;
use cipherboard_server::state::AppState;
use cipherboard_server::static_files;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,cipherboard_server=info,tower_http=info".into()),
        )
        .with(
            tracing_subscriber::fmt::layer()
                .json()
                .with_current_span(true),
        )
        .init();

    let config = Config::from_env()?;
    tracing::info!(
        host = %config.host,
        port = config.port,
        "starting cipherboard-server"
    );

    let state = Arc::new(AppState::connect(&config).await?);
    state.migrate().await?;

    let static_dir = config.static_dir.clone();
    let app = build_router(state, static_dir);

    let addr: SocketAddr = format!("{}:{}", config.host, config.port).parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

fn build_router(state: Arc<AppState>, static_dir: PathBuf) -> Router {
    // Asset-aware SPA static: navigation → index@200; missing *.js/*.wasm → 404.
    let spa = static_files::spa_serve_dir(&static_dir);

    Router::new()
        .merge(routes::api_router())
        .fallback_service(spa)
        .layer(TraceLayer::new_for_http())
        .layer(SetResponseHeaderLayer::overriding(
            http::header::HeaderName::from_static("content-security-policy"),
            http::HeaderValue::from_static(
                "default-src 'self'; \
                 script-src 'self' 'wasm-unsafe-eval'; \
                 style-src 'self' 'unsafe-inline'; \
                 img-src 'self' data: blob:; \
                 connect-src 'self' ws: wss:; \
                 font-src 'self'; \
                 object-src 'none'; \
                 base-uri 'self'; \
                 frame-ancestors 'none'; \
                 form-action 'self'",
            ),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            http::header::X_CONTENT_TYPE_OPTIONS,
            http::HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            http::header::HeaderName::from_static("referrer-policy"),
            http::HeaderValue::from_static("no-referrer"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            http::header::HeaderName::from_static("x-frame-options"),
            http::HeaderValue::from_static("DENY"),
        ))
        .with_state(state)
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received");
}
