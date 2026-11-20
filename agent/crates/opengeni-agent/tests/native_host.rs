//! Exercise the same executable and argv that Chrome gets from the installed manifest.
#![cfg(any(target_os = "linux", target_os = "macos"))]

use std::{path::Path, process::Stdio, time::Duration};

use serde_json::{json, Value};
use tokio::{net::TcpListener, process::Command};

const HOST: &str = "ai.opengeni.browser.json";
const ORIGIN: &str = "chrome-extension://dddddddddddddddddddddddddddddddd/";

async fn bridge_listener(config: &Path) -> TcpListener {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("listener");
    std::fs::create_dir_all(config).expect("config directory");
    std::fs::write(
        config.join("browser-bridge-authority.json"),
        json!({
            "protocolVersion": 1,
            "port": listener.local_addr().expect("address").port(),
            "token": "fixture",
            "pid": std::process::id(),
        })
        .to_string(),
    )
    .expect("authority file");
    listener
}

#[tokio::test]
async fn browser_launched_host_uses_the_installing_desktop_runtimes_config() {
    let directory = tempfile::tempdir().expect("tempdir");
    let home = directory.path();
    let xdg = home.join("xdg");
    let standalone = bridge_listener(&xdg.join("opengeni/agent")).await;
    // A relative override is relative to the installing process, not Chrome.
    let embedded = bridge_listener(&home.join("Desktop App/config")).await;
    let manifest_dir = if cfg!(target_os = "macos") {
        home.join("Library/Application Support/Google/Chrome")
    } else {
        xdg.join("google-chrome")
    };
    let binary = env!("CARGO_BIN_EXE_opengeni-agent");

    // Hosted startup installs the manifest before it reads connections. A
    // malformed local fixture stops it there, before enrollment or any network.
    let connections = home.join("Desktop App/config/connections");
    std::fs::create_dir_all(&connections).expect("connections directory");
    std::fs::write(connections.join("offline-fixture.json"), "{}").expect("fixture");
    let install = Command::new(binary)
        .arg("run")
        .current_dir(home)
        .env("HOME", home)
        .env("XDG_CONFIG_HOME", &xdg)
        .env("OPENGENI_AGENT_HOST", "desktop-app")
        .env("OPENGENI_AGENT_SCREEN_CONTROL", "off")
        .env("OPENGENI_AGENT_BROWSER_EXTENSION", "on")
        .env("OPENGENI_AGENT_BROWSER_EXTENSION_IDS", "d".repeat(32))
        .env("OPENGENI_CONFIG_DIR", "Desktop App/config")
        .output()
        .await
        .expect("hosted startup");
    assert!(
        !install.status.success(),
        "the offline fixture must stop startup"
    );

    let manifest: Value = serde_json::from_slice(
        &std::fs::read(manifest_dir.join("NativeMessagingHosts").join(HOST)).expect("manifest"),
    )
    .expect("valid manifest");
    assert!(manifest["allowed_origins"]
        .as_array()
        .expect("origins")
        .iter()
        .any(|origin| origin == ORIGIN));

    let mut host = Command::new(manifest["path"].as_str().expect("host executable"))
        .arg(ORIGIN)
        .current_dir(manifest_dir)
        .env("HOME", home)
        .env("XDG_CONFIG_HOME", &xdg)
        .env_remove("OPENGENI_CONFIG_DIR")
        .env_remove("OPENGENI_AGENT_HOST")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("Chrome-style invocation");
    tokio::select! {
        connection = embedded.accept() => { connection.expect("embedded connection"); }
        connection = standalone.accept() => panic!("host reached standalone bridge: {connection:?}"),
        status = host.wait() => panic!("host exited without connecting: {status:?}"),
        () = tokio::time::sleep(Duration::from_secs(5)) => panic!("host never connected"),
    }
    let _ = host.kill().await;
}
