mod common;

use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

use anyhow::{Context, Result};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use common::spawn_service;

// The universal resolver is for FOREIGN DID methods. This gatekeeper is the
// authority for its own, so asking an external resolver about a `did:cid` can
// only burn the fallback timeout before failing -- 53k such requests a day on a
// live node, every one ending in a client abort (#899).
//
// The TypeScript side has covered this since that PR; this is the Rust half of
// the parity contract in AGENTS.md. Without it, dropping the `!is_own_method`
// clause from a Rust refactor would leave every check green.

/// A stand-in universal resolver that records how many requests reach it and
/// answers each one immediately, so a test never waits on the fallback timeout.
struct ResolverProbe {
    url: String,
    hits: Arc<AtomicUsize>,
}

async fn start_resolver_probe() -> Result<ResolverProbe> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .context("failed to bind resolver probe")?;
    let url = format!("http://{}", listener.local_addr()?);
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&hits);

    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            counter.fetch_add(1, Ordering::SeqCst);

            tokio::spawn(async move {
                // Read whatever the gatekeeper sends, then answer. The body does
                // not matter -- the assertion is whether we were contacted at all.
                let mut buffer = [0_u8; 1024];
                let _ = socket.read(&mut buffer).await;
                let _ = socket
                    .write_all(
                        b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
                    )
                    .await;
                let _ = socket.shutdown().await;
            });
        }
    });

    Ok(ResolverProbe { url, hits })
}

async fn resolve(service: &common::TestService, did: &str) -> Result<()> {
    // The status is irrelevant: an unresolvable DID is the point, and what
    // matters is whether the fallback was consulted on the way.
    service
        .client
        .get(format!("{}/did/{did}", service.base_url))
        .send()
        .await
        .context("resolve request failed")?;
    Ok(())
}

#[tokio::test]
async fn skips_the_universal_resolver_for_its_own_did_method() -> Result<()> {
    let probe = start_resolver_probe().await?;
    let temp_dir = tempfile::tempdir().context("failed to create temp dir")?;
    let service = spawn_service(
        "json",
        temp_dir,
        &[("ARCHON_GATEKEEPER_FALLBACK_URL", probe.url.clone())],
    )
    .await?;

    // Unresolvable, and of this node's own method.
    resolve(&service, "did:cid:bagaaieraunresolvable").await?;

    assert_eq!(
        probe.hits.load(Ordering::SeqCst),
        0,
        "the universal resolver has no driver for this node's own method, so it must not be consulted"
    );

    Ok(())
}

#[tokio::test]
async fn still_consults_the_universal_resolver_for_foreign_methods() -> Result<()> {
    // Guards against the skip being too broad: only our own prefix is exempt.
    let probe = start_resolver_probe().await?;
    let temp_dir = tempfile::tempdir().context("failed to create temp dir")?;
    let service = spawn_service(
        "json",
        temp_dir,
        &[("ARCHON_GATEKEEPER_FALLBACK_URL", probe.url.clone())],
    )
    .await?;

    resolve(&service, "did:web:example.com").await?;

    assert_eq!(
        probe.hits.load(Ordering::SeqCst),
        1,
        "a foreign method is exactly what the universal resolver is for"
    );

    Ok(())
}

#[tokio::test]
async fn an_empty_did_prefix_falls_back_to_the_default() -> Result<()> {
    // The code falls open when the prefix is empty, but a deployment cannot
    // reach that: `env_var_or_default` filters blank values, so an explicitly
    // empty ARCHON_GATEKEEPER_DID_PREFIX yields "did:cid" and the skip still
    // applies. (The TypeScript flavor does the same with `|| 'did:cid'`.) Worth
    // pinning, because it means no environment can accidentally disable the skip
    // -- and equally, the fall-open branch is defensive only.
    let probe = start_resolver_probe().await?;
    let temp_dir = tempfile::tempdir().context("failed to create temp dir")?;
    let service = spawn_service(
        "json",
        temp_dir,
        &[
            ("ARCHON_GATEKEEPER_FALLBACK_URL", probe.url.clone()),
            ("ARCHON_GATEKEEPER_DID_PREFIX", String::new()),
        ],
    )
    .await?;

    resolve(&service, "did:cid:bagaaieraunresolvable").await?;

    assert_eq!(
        probe.hits.load(Ordering::SeqCst),
        0,
        "an empty prefix falls back to the default, so this is still our own method"
    );

    Ok(())
}

#[tokio::test]
async fn a_custom_did_prefix_is_honoured() -> Result<()> {
    // The check reads the configured prefix rather than a hardcoded "did:cid",
    // so a node with its own prefix skips its own method and still delegates
    // did:cid, which is foreign to it.
    let probe = start_resolver_probe().await?;
    let temp_dir = tempfile::tempdir().context("failed to create temp dir")?;
    let service = spawn_service(
        "json",
        temp_dir,
        &[
            ("ARCHON_GATEKEEPER_FALLBACK_URL", probe.url.clone()),
            ("ARCHON_GATEKEEPER_DID_PREFIX", "did:test".to_string()),
        ],
    )
    .await?;

    resolve(&service, "did:test:unresolvable").await?;
    assert_eq!(
        probe.hits.load(Ordering::SeqCst),
        0,
        "did:test is this node's own method here"
    );

    resolve(&service, "did:cid:bagaaieraunresolvable").await?;
    assert_eq!(
        probe.hits.load(Ordering::SeqCst),
        1,
        "did:cid is foreign to a node configured with a different prefix"
    );

    Ok(())
}

#[tokio::test]
async fn resolves_a_known_did_without_consulting_the_fallback() -> Result<()> {
    // The fallback is only for a local miss; a DID this node holds must never
    // reach it, whatever its method.
    let vectors = common::deterministic_vectors();
    let operation = vectors["localAgent"]["operation"].clone();
    let did = vectors["localAgent"]["did"].as_str().unwrap();

    let probe = start_resolver_probe().await?;
    let temp_dir = tempfile::tempdir().context("failed to create temp dir")?;
    let service = spawn_service(
        "json",
        temp_dir,
        &[("ARCHON_GATEKEEPER_FALLBACK_URL", probe.url.clone())],
    )
    .await?;

    let created = service
        .client
        .post(format!("{}/did", service.base_url))
        .json(&operation)
        .send()
        .await?;
    assert!(created.status().is_success());

    let response = service
        .client
        .get(format!("{}/did/{did}", service.base_url))
        .send()
        .await?;
    assert!(response.status().is_success());
    let document: Value = response.json().await?;
    assert_eq!(document["didDocument"]["id"].as_str(), Some(did));

    assert_eq!(probe.hits.load(Ordering::SeqCst), 0);

    Ok(())
}
