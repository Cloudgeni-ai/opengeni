//! Exercise the executables and argv Chrome gets from the installed manifests.
#![cfg(any(target_os = "linux", target_os = "macos"))]

use std::{path::Path, process::Stdio, time::Duration};

use serde_json::{json, Value};
use tokio::{net::TcpListener, process::Command};

const STANDALONE_HOST: &str = "ai.opengeni.browser";
const STANDALONE_ID: &str = "phpmmcbeelfkcinjfbbggegjdcdmnnch";
const BRANDED_ID: &str = "dddddddddddddddddddddddddddddddd";

async fn bridge_listener(config: &Path) -> TcpListener {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("listener");
    let connections = config.join("connections");
    std::fs::create_dir_all(&connections).expect("connections directory");
    // Hosted startup installs the manifest before reading connections. Stop
    // there without needing to enroll or to start a real service manager.
    std::fs::write(connections.join("offline-fixture.json"), "{}").expect("fixture");
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

async fn install(home: &Path, binary: &Path, branded: bool) {
    let mut command = Command::new(binary);
    command
        .arg("run")
        .current_dir(home)
        .env("HOME", home)
        .env("XDG_CONFIG_HOME", home.join("xdg"))
        .env("OPENGENI_AGENT_HOST", "desktop-app")
        .env("OPENGENI_AGENT_SCREEN_CONTROL", "off")
        .env("OPENGENI_AGENT_BROWSER_EXTENSION", "on");
    if branded {
        // A relative override is relative to the installer, not Chrome.
        command
            .env("OPENGENI_CONFIG_DIR", "Desktop App/config")
            .env("OPENGENI_AGENT_BROWSER_EXTENSION_IDS", BRANDED_ID);
    } else {
        command
            .env_remove("OPENGENI_CONFIG_DIR")
            .env_remove("OPENGENI_AGENT_BROWSER_EXTENSION_IDS");
    }
    let result = command.output().await.expect("hosted startup");
    assert!(
        !result.status.success(),
        "the offline fixture must stop startup"
    );
}

async fn connect(
    home: &Path,
    host: &str,
    extension: &str,
    expected: &TcpListener,
    other: &TcpListener,
) {
    let manifests = if cfg!(target_os = "macos") {
        home.join("Library/Application Support/Google/Chrome/NativeMessagingHosts")
    } else {
        home.join("xdg/google-chrome/NativeMessagingHosts")
    };
    let path = manifests.join(format!("{host}.json"));
    let manifest: Value = serde_json::from_slice(
        &std::fs::read(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display())),
    )
    .expect("valid manifest");
    let origin = format!("chrome-extension://{extension}/");
    assert_eq!(manifest["name"], host);
    assert!(manifest["allowed_origins"]
        .as_array()
        .expect("origins")
        .iter()
        .any(|allowed| allowed == &origin));
    if host == STANDALONE_HOST {
        let branded_origin = format!("chrome-extension://{BRANDED_ID}/");
        assert!(!manifest["allowed_origins"]
            .as_array()
            .expect("origins")
            .iter()
            .any(|allowed| allowed == &branded_origin));
    } else {
        assert_eq!(manifest["allowed_origins"], json!([origin]));
    }

    let mut host = Command::new(manifest["path"].as_str().expect("host executable"))
        .arg(&origin)
        .current_dir(manifests)
        .env("HOME", home)
        .env("XDG_CONFIG_HOME", home.join("xdg"))
        .env_remove("OPENGENI_CONFIG_DIR")
        .env_remove("OPENGENI_AGENT_HOST")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("Chrome-style invocation");
    tokio::select! {
        connection = expected.accept() => { connection.expect("matching bridge connection"); }
        connection = other.accept() => panic!("host reached the other runtime: {connection:?}"),
        status = host.wait() => panic!("host exited without connecting: {status:?}"),
        () = tokio::time::sleep(Duration::from_secs(5)) => panic!("host never connected"),
    }
    let _ = host.kill().await;
}

#[tokio::test]
async fn standalone_and_branded_extensions_reach_their_own_runtimes_in_either_install_order() {
    let source = Path::new(env!("CARGO_BIN_EXE_opengeni-agent"));
    let branded_host = format!("{STANDALONE_HOST}.{BRANDED_ID}");
    for branded_first in [false, true] {
        let directory = tempfile::tempdir().expect("tempdir");
        let home = directory.path();
        let standalone = bridge_listener(&home.join("xdg/opengeni/agent")).await;
        let branded = bridge_listener(&home.join("Desktop App/config")).await;
        let app_binary = home.join("Desktop App/Branded Agent");
        std::fs::copy(source, &app_binary).expect("copy packaged executable");
        for is_branded in [branded_first, !branded_first] {
            if is_branded {
                install(home, &app_binary, true).await;
                connect(home, &branded_host, BRANDED_ID, &branded, &standalone).await;
            } else {
                install(home, source, false).await;
                connect(home, STANDALONE_HOST, STANDALONE_ID, &standalone, &branded).await;
            }
        }
        connect(home, STANDALONE_HOST, STANDALONE_ID, &standalone, &branded).await;
        connect(home, &branded_host, BRANDED_ID, &branded, &standalone).await;
    }
}
