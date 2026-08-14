//! Selects the optional release-contained interaction runtime at compile time.

use std::env;

const EMBEDDED_RUNTIME_INPUTS: [&str; 3] = [
    "OPENGENI_EMBEDDED_BROWSERD",
    "OPENGENI_EMBEDDED_AGENT_BROWSER",
    "OPENGENI_EMBEDDED_COMPUTER_NATIVE",
];

fn main() {
    println!("cargo:rustc-check-cfg=cfg(opengeni_embedded_runtime)");
    for name in EMBEDDED_RUNTIME_INPUTS {
        println!("cargo:rerun-if-env-changed={name}");
    }
    println!("cargo:rerun-if-env-changed=OPENGENI_RUNTIME_BUILD_ID");

    let configured = EMBEDDED_RUNTIME_INPUTS
        .into_iter()
        .filter_map(|name| env::var_os(name).map(|value| (name, value)))
        .collect::<Vec<_>>();
    if configured.is_empty() {
        return;
    }
    assert_eq!(
        configured.len(),
        EMBEDDED_RUNTIME_INPUTS.len(),
        "the interaction runtime must embed browserd, agent-browser, and computer-native together"
    );
    assert!(
        env::var_os("OPENGENI_RUNTIME_BUILD_ID").is_some(),
        "an embedded interaction runtime requires OPENGENI_RUNTIME_BUILD_ID"
    );
    for (_, path) in configured {
        println!("cargo:rerun-if-changed={}", path.to_string_lossy());
    }
    println!("cargo:rustc-cfg=opengeni_embedded_runtime");
}
