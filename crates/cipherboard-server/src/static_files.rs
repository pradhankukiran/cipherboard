//! Static SPA file serving.
//!
//! Deep module over tower-http file services:
//! - Existing files under the static root are served as usual (200).
//! - Missing **client navigation** paths (e.g. `/demo/protected-lesson`) fall
//!   back to `index.html` with **200** (not `not_found_service`, which forces 404).
//! - Missing **asset-like** paths (final segment has a file extension, e.g.
//!   `/assets/missing.js`, `*.wasm`) stay **404** and never return the SPA index.
//!
//! That keeps broken asset deploys visible and avoids wrong MIME/cache hits.

use std::convert::Infallible;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::task::{Context, Poll};

use axum::body::Body;
use bytes::Bytes;
use http::{Request, Response, StatusCode};
use tower::{Service, ServiceExt};
use tower_http::services::{ServeDir, ServeFile};

/// True when the request path looks like a static asset (extension-bearing file).
///
/// Used to refuse SPA index fallback for broken asset URLs.
pub fn is_asset_like_path(path: &str) -> bool {
    let path = path.split(['?', '#']).next().unwrap_or(path);
    let file = match path.rsplit('/').next() {
        Some(f) if !f.is_empty() => f,
        _ => return false, // "/" or trailing slash → navigation
    };
    let Some((_stem, ext)) = file.rsplit_once('.') else {
        return false;
    };
    // e.g. js, css, wasm, map, svg, woff2 — not "protected-lesson"
    !ext.is_empty()
        && ext.len() <= 16
        && ext.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// SPA-aware static file service for the Vite/web build output directory.
#[derive(Clone, Debug)]
pub struct SpaStatic {
    files: ServeDir,
    index: ServeFile,
}

/// Build the SPA static service for `static_dir` (expects `index.html` present).
pub fn spa_serve_dir(static_dir: impl AsRef<Path>) -> SpaStatic {
    let static_dir = static_dir.as_ref();
    let index = static_dir.join("index.html");
    SpaStatic {
        // No unconditional index fallback — asset 404s must stay 404.
        files: ServeDir::new(static_dir),
        index: ServeFile::new(index),
    }
}

type BoxFuture = Pin<Box<dyn Future<Output = Result<Response<Body>, Infallible>> + Send>>;

impl Service<Request<Body>> for SpaStatic {
    type Response = Response<Body>;
    type Error = Infallible;
    type Future = BoxFuture;

    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, req: Request<Body>) -> Self::Future {
        let path = req.uri().path().to_owned();
        let mut files = self.files.clone();
        let mut index = self.index.clone();

        Box::pin(async move {
            // 1) Try a real file first.
            let file_res = match files.oneshot(req).await {
                Ok(res) => res,
                Err(_) => {
                    return Ok(internal_error());
                }
            };

            if file_res.status() != StatusCode::NOT_FOUND {
                return Ok(map_body(file_res));
            }

            // 2) Missing path: assets stay 404; navigation gets index @ 200.
            if is_asset_like_path(&path) {
                return Ok(Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(Body::empty())
                    .expect("empty body"));
            }

            let index_req = Request::builder()
                .method(http::Method::GET)
                .uri("/index.html")
                .body(Body::empty())
                .expect("index request");
            match index.oneshot(index_req).await {
                Ok(res) => Ok(map_body(res)),
                Err(_) => Ok(internal_error()),
            }
        })
    }
}

fn internal_error() -> Response<Body> {
    Response::builder()
        .status(StatusCode::INTERNAL_SERVER_ERROR)
        .body(Body::empty())
        .expect("empty body")
}

fn map_body<B>(res: Response<B>) -> Response<Body>
where
    B: http_body::Body<Data = Bytes> + Send + 'static,
    B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    res.map(Body::new)
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

    #[test]
    fn asset_like_path_detection() {
        assert!(is_asset_like_path("/assets/missing.js"));
        assert!(is_asset_like_path("/pkg/cipherboard_wasm_bg.wasm"));
        assert!(is_asset_like_path("/favicon.svg"));
        assert!(is_asset_like_path("/assets/index-abc123.css"));
        assert!(is_asset_like_path("/foo/bar.map"));
        assert!(!is_asset_like_path("/demo/protected-lesson"));
        assert!(!is_asset_like_path("/room/rm_abc"));
        assert!(!is_asset_like_path("/"));
        assert!(!is_asset_like_path("/demo/protected-lesson/"));
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
            "SPA client routes must return 200 with index"
        );
        let bytes = to_bytes(res.into_body(), 64 * 1024).await.expect("body");
        assert_eq!(bytes.as_ref(), index_body);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn missing_asset_path_stays_404_without_spa_index() {
        let dir = temp_static_dir("missing-asset");
        let index_body = b"<!doctype html><html><title>Cipherboard SPA</title></html>";
        std::fs::write(dir.join("index.html"), index_body).expect("write index");

        let svc = spa_serve_dir(&dir);
        for uri in [
            "/assets/missing.js",
            "/cipherboard_wasm_bg.wasm",
            "/styles/nope.css",
        ] {
            let res = svc
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(uri)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .expect("service call");

            assert_eq!(
                res.status(),
                StatusCode::NOT_FOUND,
                "{uri} must remain 404"
            );
            let bytes = to_bytes(res.into_body(), 64 * 1024).await.expect("body");
            assert_ne!(
                bytes.as_ref(),
                index_body,
                "{uri} must not return SPA index"
            );
            assert!(
                !bytes
                    .as_ref()
                    .windows(index_body.len())
                    .any(|w| w == index_body),
                "{uri} body must not contain index html"
            );
        }

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
