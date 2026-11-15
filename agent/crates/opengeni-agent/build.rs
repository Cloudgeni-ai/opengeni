//! Selects the optional release-contained interaction runtime at compile time.

use std::env;
use std::fmt::Write as _;

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
    for (_, path) in &configured {
        println!("cargo:rerun-if-changed={}", path.to_string_lossy());
    }
    println!("cargo:rustc-cfg=opengeni_embedded_runtime");
    let cua = env::var_os("OPENGENI_EMBEDDED_CUA_RUNTIME").map(std::path::PathBuf::from);
    if let Some(path) = &cua {
        assert!(
            matches!(
                env::var("CARGO_CFG_TARGET_OS").as_deref(),
                Ok("macos" | "linux" | "windows")
            ),
            "CUA assets require a macOS, Linux or Windows target"
        );
        println!(
            "cargo:rerun-if-changed={}",
            path.parent().expect("CUA asset directory").display()
        );
        println!("cargo:rustc-cfg=opengeni_embedded_cua");
    }
    write_runtime_digests(
        std::path::Path::new(&configured[0].1),
        std::path::Path::new(&configured[1].1),
        cua.as_deref(),
    );
}

/// Writes `embedded_runtime_digests.rs` into `OUT_DIR`: the name of the
/// embedded runtime's helper generation and each helper's digest, computed
/// here from the files the agent embeds. The agent then names and checks
/// the helpers it wrote out without reading its own embedded copies, some
/// 230 MB in a release, at all. The generation is the digest the agent
/// computed itself before: the length and bytes of browserd and
/// computer-native, then the length and name, and the length and bytes, of
/// each CUA asset in the manifest's order.
fn write_runtime_digests(
    browserd: &std::path::Path,
    computer_native: &std::path::Path,
    cua: Option<&std::path::Path>,
) {
    let read = |path: &std::path::Path| {
        std::fs::read(path)
            .unwrap_or_else(|error| panic!("read embedded helper {}: {error}", path.display()))
    };
    let mut generation = blake3::Hasher::new();
    let mut helpers = Vec::new();
    for path in [browserd, computer_native] {
        let bytes = read(path);
        generation.update(&(bytes.len() as u64).to_le_bytes());
        generation.update(&bytes);
        helpers.push(*blake3::hash(&bytes).as_bytes());
    }
    let mut assets = Vec::new();
    for (name, path) in cua.map(cua_manifest_entries).unwrap_or_default() {
        let bytes = read(&path);
        generation.update(&(name.len() as u64).to_le_bytes());
        generation.update(name.as_bytes());
        generation.update(&(bytes.len() as u64).to_le_bytes());
        generation.update(&bytes);
        assets.push((name, *blake3::hash(&bytes).as_bytes()));
    }
    let generation = generation.finalize().to_hex();
    let mut source = format!(
        "/// The embedded runtime's helper generation (build.rs).\n\
         pub(crate) const GENERATION: &str = {:?};\n\
         /// The digest of the embedded browserd (build.rs).\n\
         pub(crate) const BROWSERD_DIGEST: [u8; 32] = {:?};\n\
         /// The digest of the embedded computer-native (build.rs).\n\
         pub(crate) const COMPUTER_NATIVE_DIGEST: [u8; 32] = {:?};\n\
         /// Each CUA asset's name and digest, in the manifest's order (build.rs).\n\
         #[allow(dead_code)]\n\
         pub(crate) const CUA_DIGESTS: &[(&str, [u8; 32])] = &[\n",
        &generation[..24],
        helpers[0],
        helpers[1],
    );
    for (name, digest) in assets {
        writeln!(source, "    ({name:?}, {digest:?}),").expect("write to a String");
    }
    source.push_str("];\n");
    let out = std::path::PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR"));
    std::fs::write(out.join("embedded_runtime_digests.rs"), source)
        .expect("write the embedded runtime's digests");
}

/// The `(name, path)` of each asset in a CUA manifest, which
/// `packages/browserd/scripts/stage-cua-runtime.ts` writes as a Rust array
/// of `("name", include_bytes!("path") as &[u8])`. Anything else fails the
/// build: the agent must embed exactly the files digested here.
fn cua_manifest_entries(manifest: &std::path::Path) -> Vec<(String, std::path::PathBuf)> {
    let text = std::fs::read_to_string(manifest)
        .unwrap_or_else(|error| panic!("read CUA manifest {}: {error}", manifest.display()));
    let mut literals = Vec::new();
    let mut rest = text.as_str();
    while let Some(start) = rest.find('"') {
        let before = rest[..start].to_owned();
        let (value, after) = string_literal(&rest[start + 1..]);
        literals.push((before, value));
        rest = after;
    }
    assert!(
        literals.len() % 2 == 0,
        "the CUA manifest must pair every asset name with one include_bytes! path"
    );
    let directory = manifest.parent().expect("CUA asset directory");
    literals
        .chunks(2)
        .map(|pair| {
            assert!(
                pair[1].0.trim_end().ends_with("include_bytes!("),
                "the CUA manifest must name each asset, then include_bytes! its path"
            );
            (pair[0].1.clone(), directory.join(&pair[1].1))
        })
        .collect()
}

/// The value of the Rust string literal that `text` continues after its
/// opening quote, and what follows its closing quote.
fn string_literal(text: &str) -> (String, &str) {
    let mut value = String::new();
    let mut chars = text.char_indices();
    while let Some((index, character)) = chars.next() {
        match character {
            '"' => return (value, &text[index + 1..]),
            '\\' => value.push(match chars.next() {
                Some((_, '\\')) => '\\',
                Some((_, '"')) => '"',
                Some((_, '\'')) => '\'',
                Some((_, 'n')) => '\n',
                Some((_, 'r')) => '\r',
                Some((_, 't')) => '\t',
                Some((_, '0')) => '\0',
                other => panic!("unsupported escape {other:?} in the CUA manifest"),
            }),
            character => value.push(character),
        }
    }
    panic!("unterminated string in the CUA manifest")
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
