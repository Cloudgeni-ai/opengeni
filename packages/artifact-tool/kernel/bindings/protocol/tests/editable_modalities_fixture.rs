#![forbid(unsafe_code)]

use std::process::Command;

#[test]
fn rust_modalities_fixture_matches_shared_typescript_vectors() {
    let output = Command::new(env!("CARGO_BIN_EXE_editable_modalities_fixture"))
        .output()
        .expect("run editable modalities fixture generator");
    assert!(output.status.success(), "fixture generator failed");
    let generated: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("parse generated fixture");
    let shared: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../contracts/test/fixtures/editable-artifact-modalities-v1.json"
    ))
    .expect("parse shared fixture");
    let generated = generated.as_object().expect("generated fixture object");
    for (key, value) in generated {
        assert_eq!(
            shared.get(key),
            Some(value),
            "shared TypeScript fixture drifted for {key}"
        );
    }
}
