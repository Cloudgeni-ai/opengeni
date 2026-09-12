//! Exercise the actual helper's Rust threads, not the test harness's Cocoa pool.

#![cfg(target_os = "macos")]

use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncWriteExt as _;
use tokio::process::Command;

#[tokio::test]
#[ignore = "requires an unlocked local macOS GUI session"]
async fn native_discovery_drains_cocoa_temporaries() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_opengeni-computer-native"))
        .env("OBJC_DEBUG_MISSING_POOLS", "YES")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("start native helper with Cocoa lifetime diagnostics");
    let mut input = child.stdin.take().expect("helper input");
    // Discovery is read-only and also works without Screen Recording grants:
    // the helper then enumerates applications through AppKit alone.
    for (request_id, method) in ["capabilities", "targets", "targets"].iter().enumerate() {
        let request = serde_json::to_vec(&serde_json::json!({
            "protocolVersion": 2,
            "requestId": request_id.to_string(),
            "method": method,
        }))
        .expect("encode native request");
        input
            .write_all(
                &u32::try_from(request.len())
                    .expect("bounded request")
                    .to_be_bytes(),
            )
            .await
            .expect("write frame length");
        input.write_all(&request).await.expect("write request");
    }
    drop(input);
    let output = tokio::time::timeout(Duration::from_secs(45), child.wait_with_output())
        .await
        .expect("native helper must drain requests and exit")
        .expect("wait for helper");
    let diagnostics = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "native helper failed: {diagnostics}"
    );
    assert!(
        !diagnostics.contains("MISSING POOLS"),
        "native operations leaked autoreleased Cocoa objects: {diagnostics}"
    );
    let mut bytes = output.stdout.as_slice();
    let mut response_ids = Vec::new();
    while !bytes.is_empty() {
        let size = u32::from_be_bytes(bytes[..4].try_into().expect("response header")) as usize;
        let response: serde_json::Value =
            serde_json::from_slice(&bytes[4..4 + size]).expect("response JSON");
        assert_eq!(
            response["status"], "ok",
            "native request failed: {:?}",
            response["error"]
        );
        response_ids.push(
            response["requestId"]
                .as_str()
                .expect("request id")
                .to_owned(),
        );
        if response["requestId"] != "0" {
            assert!(
                response["result"].is_array(),
                "discovery must return targets"
            );
        }
        bytes = &bytes[4 + size..];
    }
    response_ids.sort();
    assert_eq!(response_ids, ["0", "1", "2"]);
}
