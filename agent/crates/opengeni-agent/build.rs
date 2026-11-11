//! Selects the optional release-contained interaction runtime at compile time.

use std::env;

const EMBEDDED_RUNTIME_INPUTS: [&str; 2] = [
    "OPENGENI_EMBEDDED_BROWSERD",
    "OPENGENI_EMBEDDED_COMPUTER_NATIVE",
];

fn main() {
    embed_shell_tools();
    println!("cargo:rustc-check-cfg=cfg(opengeni_embedded_runtime)");
    println!("cargo:rustc-check-cfg=cfg(opengeni_embedded_cua)");
    println!("cargo:rerun-if-env-changed=OPENGENI_EMBEDDED_CUA_RUNTIME");
    for name in EMBEDDED_RUNTIME_INPUTS {
        println!("cargo:rerun-if-env-changed={name}");
    }
    println!("cargo:rerun-if-env-changed=OPENGENI_RUNTIME_BUILD_ID");

    let configured = EMBEDDED_RUNTIME_INPUTS
        .into_iter()
        .filter_map(|name| env::var_os(name).map(|value| (name, value)))
        .collect::<Vec<_>>();
    if configured.is_empty() {
        assert!(
            env::var_os("OPENGENI_EMBEDDED_CUA_RUNTIME").is_none(),
            "CUA assets require the complete interaction runtime"
        );
        return;
    }
    assert_eq!(
        configured.len(),
        EMBEDDED_RUNTIME_INPUTS.len(),
        "the interaction runtime must embed browserd and computer-native together"
    );
    assert!(
        env::var_os("OPENGENI_RUNTIME_BUILD_ID").is_some(),
        "an embedded interaction runtime requires OPENGENI_RUNTIME_BUILD_ID"
    );
    for (_, path) in configured {
        println!("cargo:rerun-if-changed={}", path.to_string_lossy());
    }
    println!("cargo:rustc-cfg=opengeni_embedded_runtime");
    if let Some(manifest) = env::var_os("OPENGENI_EMBEDDED_CUA_RUNTIME") {
        assert!(
            matches!(
                env::var("CARGO_CFG_TARGET_OS").as_deref(),
                Ok("macos" | "linux" | "windows")
            ),
            "CUA assets require a macOS, Linux or Windows target"
        );
        let path = std::path::PathBuf::from(manifest);
        println!(
            "cargo:rerun-if-changed={}",
            path.parent().expect("CUA asset directory").display()
        );
        println!("cargo:rustc-cfg=opengeni_embedded_cua");
    }
}

/// Embeds the checksum-pinned ripgrep and jq for this target. An explicit
/// `OPENGENI_EMBEDDED_SHELL_TOOLS` names a `scripts/fetch-shell-tools.ts`
/// output directory (empty embeds none). Otherwise a release build, which
/// names its exact source in `OPENGENI_RUNTIME_BUILD_ID`, fetches them itself
/// with that script. Development builds and targets without an official build
/// embed nothing.
fn embed_shell_tools() {
    println!("cargo:rustc-check-cfg=cfg(opengeni_embedded_shell_tools)");
    println!("cargo:rerun-if-env-changed=OPENGENI_EMBEDDED_SHELL_TOOLS");
    let os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    let (target, suffix) = match (os.as_str(), arch.as_str()) {
        ("linux", "x86_64") => ("x86_64-unknown-linux-musl", ""),
        ("linux", "aarch64") => ("aarch64-unknown-linux-musl", ""),
        ("macos", "x86_64") => ("x86_64-apple-darwin", ""),
        ("macos", "aarch64") => ("aarch64-apple-darwin", ""),
        ("windows", "x86_64") => ("x86_64-pc-windows-msvc", ".exe"),
        ("windows", "aarch64") => ("aarch64-pc-windows-msvc", ".exe"),
        _ => return,
    };
    let Some((root, inputs)) = shell_tools_root(target) else {
        return;
    };
    let rg = root.join(target).join(format!("rg{suffix}"));
    let jq = root.join(target).join(format!("jq{suffix}"));
    let notices = root.join("THIRD-PARTY-NOTICES.txt");
    for (name, path) in [
        ("OPENGENI_EMBEDDED_RG", &rg),
        ("OPENGENI_EMBEDDED_JQ", &jq),
        ("OPENGENI_EMBEDDED_SHELL_TOOLS_NOTICES", &notices),
    ] {
        assert!(
            path.is_file(),
            "the agent's shell tools are missing {}; run scripts/fetch-shell-tools.ts",
            path.display()
        );
        // Files this script wrote itself are outputs: watching them would
        // make Cargo rerun the script, and rebuild the agent, on every call.
        if inputs == ToolInputs::Given {
            println!("cargo:rerun-if-changed={}", path.display());
        }
        println!("cargo:rustc-env={name}={}", path.display());
    }
    println!("cargo:rustc-cfg=opengeni_embedded_shell_tools");
}

/// Where the embedded tools come from.
#[derive(PartialEq, Eq)]
enum ToolInputs {
    /// An explicit `OPENGENI_EMBEDDED_SHELL_TOOLS` directory, watched for changes.
    Given,
    /// Fetched by this script into `OUT_DIR`; only the pins are watched.
    Fetched,
}

fn shell_tools_root(target: &str) -> Option<(std::path::PathBuf, ToolInputs)> {
    if let Some(root) = env::var_os("OPENGENI_EMBEDDED_SHELL_TOOLS") {
        return (!root.is_empty()).then(|| (std::path::PathBuf::from(root), ToolInputs::Given));
    }
    env::var_os("OPENGENI_RUNTIME_BUILD_ID")?;
    // A release build: shipping without the tools must fail loudly, never
    // quietly. `OPENGENI_EMBEDDED_SHELL_TOOLS=` (empty) opts out explicitly.
    let repository = std::path::PathBuf::from(env::var_os("CARGO_MANIFEST_DIR")?).join("../../..");
    let script = repository.join("scripts/fetch-shell-tools.ts");
    assert!(
        script.is_file(),
        "a release build needs {} to embed rg and jq; set OPENGENI_EMBEDDED_SHELL_TOOLS= (empty) to build without them",
        script.display()
    );
    println!("cargo:rerun-if-changed={}", script.display());
    println!(
        "cargo:rerun-if-changed={}",
        repository
            .join("packages/runtime/src/sandbox/shell-tools-manifest.ts")
            .display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        repository
            .join("packages/runtime/src/sandbox/shell-tools-THIRD-PARTY-NOTICES.txt")
            .display()
    );
    let out = std::path::PathBuf::from(env::var_os("OUT_DIR")?).join("shell-tools");
    match std::process::Command::new("bun")
        .arg(&script)
        .args(["--target", target, "--out"])
        .arg(&out)
        .status()
    {
        Ok(status) if status.success() => Some((out, ToolInputs::Fetched)),
        Ok(status) => panic!(
            "fetching the pinned rg and jq failed ({status}); set OPENGENI_EMBEDDED_SHELL_TOOLS= (empty) to build without them"
        ),
        Err(error) => panic!(
            "a release build needs bun to fetch the pinned rg and jq ({error}); set OPENGENI_EMBEDDED_SHELL_TOOLS= (empty) to build without them"
        ),
    }
}
