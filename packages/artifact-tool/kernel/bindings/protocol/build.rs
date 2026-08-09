#![forbid(unsafe_code)]

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    let protocol_root = fs::canonicalize(PathBuf::from(
        env::var_os("CARGO_MANIFEST_DIR").expect("manifest dir"),
    ))
    .expect("canonical protocol root");
    let kernel_root = fs::canonicalize(protocol_root.join("../..")).expect("canonical kernel root");
    let mut files = vec![
        kernel_root.join("Cargo.toml"),
        kernel_root.join("Cargo.lock"),
        protocol_root.join("Cargo.toml"),
        protocol_root.join("Cargo.lock"),
        protocol_root.join("build.rs"),
    ];
    collect_rust_files(&kernel_root.join("src"), &mut files);
    collect_rust_files(&protocol_root.join("src"), &mut files);
    files.sort();

    let mut source = blake3::Hasher::new();
    for file in files {
        println!("cargo:rerun-if-changed={}", file.display());
        let logical_path = file.strip_prefix(&kernel_root).unwrap_or(&file);
        let logical_path = logical_path
            .components()
            .map(|component| component.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        source.update(logical_path.as_bytes());
        source.update(&[0]);
        source.update(&fs::read(&file).unwrap_or_else(|error| {
            panic!(
                "failed reading build-identity input {}: {error}",
                file.display()
            )
        }));
        source.update(&[0xff]);
    }

    let rustc = env::var_os("RUSTC").expect("RUSTC");
    let rustc_version = Command::new(rustc)
        .arg("-Vv")
        .output()
        .expect("run rustc -Vv");
    if !rustc_version.status.success() {
        panic!("rustc -Vv failed");
    }
    let source = source.finalize();
    let toolchain = blake3::hash(&canonical_rustc_identity(&rustc_version.stdout));
    println!("cargo:rustc-env=OPENGENI_ARTIFACT_KERNEL_SOURCE_ID={source}");
    println!("cargo:rustc-env=OPENGENI_ARTIFACT_KERNEL_TOOLCHAIN_ID={toolchain}");
}

fn canonical_rustc_identity(verbose_version: &[u8]) -> Vec<u8> {
    let verbose_version = std::str::from_utf8(verbose_version).expect("rustc -Vv is UTF-8");
    let mut canonical = String::new();
    for line in verbose_version.lines() {
        // Host triples differ between otherwise byte-reproducible builders and
        // are not an input to the wasm32-unknown-unknown target. The executable
        // label is likewise nonsemantic. Compiler release/commit/LLVM identity
        // remains pinned and hashed.
        if line.starts_with("host:") || line.starts_with("binary:") {
            continue;
        }
        canonical.push_str(line.trim());
        canonical.push('\n');
    }
    canonical.into_bytes()
}

fn collect_rust_files(directory: &Path, output: &mut Vec<PathBuf>) {
    let mut entries = fs::read_dir(directory)
        .unwrap_or_else(|error| panic!("failed reading {}: {error}", directory.display()))
        .map(|entry| entry.expect("directory entry").path())
        .collect::<Vec<_>>();
    entries.sort();
    for entry in entries {
        if entry.is_dir() {
            collect_rust_files(&entry, output);
        } else if entry.extension().is_some_and(|extension| extension == "rs") {
            output.push(entry);
        }
    }
}
