//! The build cache as `turbo` uses it, over an in-memory store.

use std::sync::Arc;
use std::time::Duration;

use compute_runners::cache::Cache;
use object_store::ObjectStore;
use object_store::memory::InMemory;
use object_store::path::Path;
use reqwest::StatusCode;

async fn serve(cache: Cache) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let app = Arc::new(cache).router();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    base
}

#[tokio::test]
async fn artifacts_are_stored_and_read_back_with_their_headers() {
    let store = Arc::new(InMemory::new());
    let base = serve(Cache::new(
        store.clone(),
        Path::from("cache/ci"),
        "secret".into(),
        Duration::from_secs(86_400),
    ))
    .await;
    let http = reqwest::Client::new();
    let url = format!("{base}/v8/artifacts/0123abcd?teamId=ci");

    let status = http
        .get(format!("{base}/v8/artifacts/status"))
        .bearer_auth("secret")
        .send()
        .await
        .unwrap();
    assert_eq!(status.status(), StatusCode::OK);
    assert_eq!(
        status.json::<serde_json::Value>().await.unwrap()["status"],
        "enabled"
    );

    let missing = http.get(&url).bearer_auth("secret").send().await.unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    let head = http.head(&url).bearer_auth("secret").send().await.unwrap();
    assert_eq!(head.status(), StatusCode::NOT_FOUND);

    let body: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
    let stored = http
        .put(&url)
        .bearer_auth("secret")
        .header("x-artifact-tag", "tag-1")
        .header("x-artifact-duration", "4200")
        .body(body.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(stored.status(), StatusCode::ACCEPTED);
    assert!(
        store
            .head(&Path::from("cache/ci/artifacts/0123abcd"))
            .await
            .is_ok(),
        "stored under the pool's prefix"
    );

    let head = http.head(&url).bearer_auth("secret").send().await.unwrap();
    assert_eq!(head.status(), StatusCode::OK);
    let read = http.get(&url).bearer_auth("secret").send().await.unwrap();
    assert_eq!(read.status(), StatusCode::OK);
    assert_eq!(read.headers()["x-artifact-tag"], "tag-1");
    assert_eq!(read.headers()["x-artifact-duration"], "4200");
    assert_eq!(read.bytes().await.unwrap().as_ref(), body.as_slice());

    let events = http
        .post(format!("{base}/v8/artifacts/events"))
        .bearer_auth("secret")
        .body("[]")
        .send()
        .await
        .unwrap();
    assert_eq!(events.status(), StatusCode::OK);
}

#[tokio::test]
async fn only_the_pools_token_is_let_in_and_names_stay_plain() {
    let base = serve(Cache::new(
        Arc::new(InMemory::new()),
        Path::from("c"),
        "secret".into(),
        Duration::from_secs(60),
    ))
    .await;
    let http = reqwest::Client::new();
    let url = format!("{base}/v8/artifacts/abc");
    for request in [
        http.get(&url),
        http.get(&url).bearer_auth("wrong"),
        http.get(&url).bearer_auth("secre"),
        http.put(&url).bearer_auth("wrong").body("x"),
        http.get(format!("{base}/v8/artifacts/status")),
    ] {
        assert_eq!(
            request.send().await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
    }
    let dotted = http
        .get(format!("{base}/v8/artifacts/a.b"))
        .bearer_auth("secret")
        .send()
        .await
        .unwrap();
    assert_eq!(dotted.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn a_sweep_deletes_artifacts_unused_for_the_days_kept() {
    let store = Arc::new(InMemory::new());
    let path = |area: &str, hash: &str| Path::from(format!("c/{area}/{hash}"));
    store
        .put(&path("artifacts", "old"), "x".into())
        .await
        .unwrap();
    store.put(&path("read", "old"), "".into()).await.unwrap();
    store.put(&path("read", "orphan"), "".into()).await.unwrap();

    let keeping = Cache::new(
        store.clone(),
        Path::from("c"),
        "t".into(),
        Duration::from_secs(86_400),
    );
    assert_eq!(keeping.sweep().await.unwrap(), 0);
    assert!(
        store.head(&path("artifacts", "old")).await.is_ok(),
        "used within the days kept"
    );
    assert!(
        store.head(&path("read", "orphan")).await.is_err(),
        "a marker without its artifact goes"
    );

    tokio::time::sleep(Duration::from_millis(20)).await;
    let expiring = Cache::new(
        store.clone(),
        Path::from("c"),
        "t".into(),
        Duration::from_millis(10),
    );
    assert_eq!(expiring.sweep().await.unwrap(), 1);
    assert!(store.head(&path("artifacts", "old")).await.is_err());
    assert!(store.head(&path("read", "old")).await.is_err());
}
