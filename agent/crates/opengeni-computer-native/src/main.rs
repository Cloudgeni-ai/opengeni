//! Placement-local native ComputerSession helper process.

#[cfg(target_os = "macos")]
use std::path::{Path, PathBuf};

const BACKGROUND_BROWSER_EXECUTABLE_ENV: &str = "OPENGENI_BACKGROUND_BROWSER_EXECUTABLE";

#[tokio::main]
async fn main() {
    if std::env::var_os(BACKGROUND_BROWSER_EXECUTABLE_ENV).is_some() {
        if let Err(error) = run_background_browser().await {
            eprintln!("opengeni-browser-background-launcher: {error}");
            std::process::exit(1);
        }
        return;
    }
    if let Err(error) = opengeni_computer_native::run_native_rpc().await {
        eprintln!("opengeni-computer-native: {error}");
        std::process::exit(1);
    }
}

#[cfg(target_os = "macos")]
async fn run_background_browser() -> Result<(), Box<dyn std::error::Error>> {
    let executable = PathBuf::from(
        std::env::var_os(BACKGROUND_BROWSER_EXECUTABLE_ENV)
            .ok_or("background browser executable is absent")?,
    );
    let app = application_bundle(&executable)
        .ok_or("background browser executable is not inside a macOS application bundle")?;
    let status = tokio::process::Command::new("/usr/bin/open")
        // `-j` launches hidden, `-g` refuses foreground activation, and `-W`
        // keeps this exact helper alive for agent-browser's process/DevTools
        // lifecycle fence. A short-lived `open` wrapper makes agent-browser
        // correctly assume Chrome died and retry, producing the window storm.
        .args(["-g", "-j", "-n", "-W", "-a"])
        .arg(app)
        .arg("--args")
        .args(std::env::args_os().skip(1))
        .status()
        .await?;
    if !status.success() {
        return Err(format!("LaunchServices browser process exited with {status}").into());
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
#[allow(clippy::unused_async)] // Keep the cfg variants identical for the awaited main call.
async fn run_background_browser() -> Result<(), Box<dyn std::error::Error>> {
    Err("background browser launch is available only on macOS".into())
}

#[cfg(target_os = "macos")]
fn application_bundle(executable: &Path) -> Option<&Path> {
    executable.ancestors().find(|ancestor| {
        ancestor
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
    })
}
