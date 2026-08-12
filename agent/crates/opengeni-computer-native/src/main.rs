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
    let app = app.to_path_buf();
    let arguments = std::env::args_os()
        .skip(1)
        .map(|argument| {
            argument.into_string().map_err(|_| {
                "background browser argument is not valid UTF-8".to_string()
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    tokio::task::spawn_blocking(move || {
        opengeni_agent_macos_ffi::run_background_application(&app, &arguments)
    })
    .await??;
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
