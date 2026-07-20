//! Static SPA file serving.
//!
//! Uses `ServeDir::fallback(ServeFile)` so client routes (e.g. `/demo/protected-lesson`)
//! return the index document with HTTP 200. Do not use `not_found_service`, which
//! tower-http wraps with `StatusCode::NOT_FOUND` even when the index body is served.

use std::path::Path;

use tower_http::services::{ServeDir, ServeFile};

/// Build the SPA static service for `static_dir` (expects `index.html` present).
pub fn spa_serve_dir(static_dir: impl AsRef<Path>) -> ServeDir<ServeFile> {
    let static_dir = static_dir.as_ref();
    let index = static_dir.join("index.html");
    ServeDir::new(static_dir).fallback(ServeFile::new(index))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use http::{Request, StatusCode};
    use tower::ServiceExt;

    fn temp_static_dir(marker: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cipherboard-spa-{}-{}",
            marker,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp static dir");
        dir
    }

    #[tokio::test]
    async fn missing_spa_route_returns_200_with_index_html() {
        let dir = temp_static_dir("route");
        let index_body = b"<!doctype html><html><title>Cipherboard SPA</title></html>";
        std::fs::write(dir.join("index.html"), index_body).expect("write index");

        let svc = spa_serve_dir(&dir);
        let res = svc
            .oneshot(
                Request::builder()
                    .uri("/demo/protected-lesson")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .expect("service call");

        assert_eq!(
            res.status(),
            StatusCode::OK,
            "SPA client routes must not be forced to 404 by not_found_service"
        );
        let bytes = to_bytes(res.into_body(), 64 * 1024).await.expect("body");
        assert_eq!(bytes.as_ref(), index_body);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn existing_asset_still_served() {
        let dir = temp_static_dir("asset");
        std::fs::write(dir.join("index.html"), b"<!doctype html><title>idx</title>").unwrap();
        std::fs::write(dir.join("app.js"), b"console.log(1)").unwrap();

        let svc = spa_serve_dir(&dir);
        let res = svc
            .oneshot(
                Request::builder()
                    .uri("/app.js")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .expect("service call");

        assert_eq!(res.status(), StatusCode::OK);
        let bytes = to_bytes(res.into_body(), 64 * 1024).await.expect("body");
        assert_eq!(bytes.as_ref(), b"console.log(1)");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
