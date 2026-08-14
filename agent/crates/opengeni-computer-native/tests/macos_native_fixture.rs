//! Live deterministic matrix for the macOS AX/ScreenCaptureKit adapter.

#![cfg(target_os = "macos")]

use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

use opengeni_computer_native::{
    open_native_adapter, ComputerAdapter, NativeAction, NativeActionCommand, NativeActionValue,
    NativeAdapterErrorCode, NativeCaptureOptions, NativeFrameFormat, NativeKeyboardAction,
    NativeLocator, NativeNodeValue, NativeObservation, NativeSemanticAction, NativeSemanticNode,
    NativeTarget, NativeTargetKind,
};

static LIVE_FIXTURES: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct FixtureProcess {
    process_id: u32,
    executable: std::path::PathBuf,
    _directory: tempfile::TempDir,
}

struct ChromiumProcess {
    process_id: u32,
    profile: tempfile::TempDir,
    _launcher_directory: tempfile::TempDir,
}

struct FrontmostRestore {
    process_id: Option<u32>,
}

impl Drop for ChromiumProcess {
    fn drop(&mut self) {
        let profile = self.profile.path().to_string_lossy();
        let mut process_ids = matching_processes(&profile);
        if !process_ids.contains(&self.process_id) {
            process_ids.push(self.process_id);
        }
        signal_processes(&process_ids, "-TERM");
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline && !matching_processes(&profile).is_empty() {
            std::thread::sleep(Duration::from_millis(50));
        }
        signal_processes(&matching_processes(&profile), "-KILL");
    }
}

impl Drop for FixtureProcess {
    fn drop(&mut self) {
        let executable = self.executable.to_string_lossy();
        if process_matches(self.process_id, &executable) {
            signal_processes(&[self.process_id], "-TERM");
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline && process_matches(self.process_id, &executable) {
                std::thread::sleep(Duration::from_millis(25));
            }
            if process_matches(self.process_id, &executable) {
                signal_processes(&[self.process_id], "-KILL");
            }
        }
    }
}

impl FrontmostRestore {
    fn capture() -> Self {
        let script = "tell application \"System Events\" to get unix id of first application process whose frontmost is true";
        let process_id = Command::new("osascript")
            .args(["-e", script])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .and_then(|output| {
                String::from_utf8_lossy(&output.stdout)
                    .trim()
                    .parse::<u32>()
                    .ok()
            });
        Self { process_id }
    }

    fn restore_now(&self) {
        let Some(process_id) = self.process_id else {
            return;
        };
        let script = format!(
            "tell application \"System Events\" to set frontmost of first application process whose unix id is {process_id} to true"
        );
        let _ = Command::new("osascript").args(["-e", &script]).output();
    }
}

impl Drop for FrontmostRestore {
    fn drop(&mut self) {
        self.restore_now();
    }
}

fn compile_and_launch_fixture() -> FixtureProcess {
    let directory = tempfile::tempdir().expect("create fixture directory");
    let bundle = directory.path().join("OpenGeniNativeFixture.app");
    let contents = bundle.join("Contents");
    let macos = contents.join("MacOS");
    std::fs::create_dir_all(&macos).expect("create fixture app bundle");
    let executable = macos.join("OpenGeniNativeFixture");
    let ready = directory.path().join("ready");
    let fixture_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/macos");
    let source = fixture_root.join("OpenGeniNativeFixture.swift");
    let launcher = compile_launcher(directory.path(), &fixture_root);
    std::fs::copy(fixture_root.join("Info.plist"), contents.join("Info.plist"))
        .expect("copy fixture Info.plist");
    let output = Command::new("xcrun")
        .args(["swiftc", "-framework", "AppKit", "-framework", "SwiftUI"])
        .arg(&source)
        .arg("-o")
        .arg(&executable)
        .output()
        .expect("run swiftc");
    assert!(
        output.status.success(),
        "swift fixture compilation failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let process_id = launch_bundle(&launcher, &bundle, &[ready.to_string_lossy().to_string()]);
    wait_for_path(&ready, Duration::from_secs(5));
    FixtureProcess {
        process_id,
        executable,
        _directory: directory,
    }
}

fn compile_launcher(directory: &Path, fixture_root: &Path) -> std::path::PathBuf {
    let launcher = directory.join("LaunchFixture");
    let output = Command::new("xcrun")
        .args(["swiftc", "-framework", "AppKit"])
        .arg(fixture_root.join("LaunchFixture.swift"))
        .arg("-o")
        .arg(&launcher)
        .output()
        .expect("compile LaunchServices fixture launcher");
    assert!(
        output.status.success(),
        "Swift launcher compilation failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    launcher
}

fn launch_bundle(launcher: &Path, bundle: &Path, arguments: &[String]) -> u32 {
    let output = Command::new(launcher)
        .arg(bundle)
        .args(arguments)
        .output()
        .expect("run LaunchServices fixture launcher");
    assert!(
        output.status.success(),
        "fixture launch failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<u32>()
        .expect("fixture launcher returned a process id")
}

fn matching_processes(fragment: &str) -> Vec<u32> {
    Command::new("pgrep")
        .args(["-f", fragment])
        .output()
        .ok()
        .into_iter()
        .flat_map(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter_map(|value| value.parse::<u32>().ok())
                .collect::<Vec<_>>()
        })
        .collect()
}

fn process_matches(process_id: u32, fragment: &str) -> bool {
    Command::new("ps")
        .args(["-p", &process_id.to_string(), "-o", "command="])
        .output()
        .is_ok_and(|output| {
            output.status.success() && String::from_utf8_lossy(&output.stdout).contains(fragment)
        })
}

fn signal_processes(process_ids: &[u32], signal: &str) {
    for process_id in process_ids {
        let _ = Command::new("kill")
            .args([signal, &process_id.to_string()])
            .output();
    }
}

fn wait_for_path(path: &Path, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while !path.exists() {
        assert!(Instant::now() < deadline, "fixture did not become ready");
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn launch_chromium_fixture() -> ChromiumProcess {
    let bundle = Path::new("/Applications/Google Chrome.app");
    let executable = bundle.join("Contents/MacOS/Google Chrome");
    assert!(
        executable.is_file(),
        "Google Chrome fixture binary is absent"
    );
    let profile = tempfile::tempdir().expect("create isolated Chromium profile");
    let launcher_directory = tempfile::tempdir().expect("create Chromium launcher directory");
    let fixture_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/macos");
    let launcher = compile_launcher(launcher_directory.path(), &fixture_root);
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/macos/chromium.html")
        .canonicalize()
        .expect("resolve Chromium fixture");
    let arguments = vec![
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        "--disable-background-mode".to_string(),
        "--disable-default-apps".to_string(),
        "--disable-sync".to_string(),
        "--force-renderer-accessibility".to_string(),
        format!("--user-data-dir={}", profile.path().display()),
        format!("--app=file://{}", fixture.display()),
    ];
    let process_id = launch_bundle(&launcher, bundle, &arguments);
    ChromiumProcess {
        process_id,
        profile,
        _launcher_directory: launcher_directory,
    }
}

async fn fixture_targets(adapter: &dyn ComputerAdapter) -> (NativeTarget, NativeTarget) {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut previous: Option<(NativeTarget, NativeTarget)> = None;
    loop {
        let targets = adapter.targets().await.expect("discover native targets");
        if let Some(window) = targets.iter().find(|target| {
            target.kind == NativeTargetKind::Window && target.title == "OpenGeni Native Fixture"
        }) {
            if let Some(application) = targets
                .iter()
                .find(|target| {
                    target.kind == NativeTargetKind::App
                        && target.process_id.is_some()
                        && target.process_id == window.process_id
                })
                .cloned()
            {
                let current = (application, window.clone());
                if previous.as_ref().is_some_and(|prior| {
                    same_target_generation(&prior.0, &current.0)
                        && same_target_generation(&prior.1, &current.1)
                }) {
                    return current;
                }
                previous = Some(current);
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        }
        previous = None;
        assert!(
            Instant::now() < deadline,
            "fixture target was not discovered; targets: {targets:#?}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn chromium_targets(adapter: &dyn ComputerAdapter) -> (NativeTarget, NativeTarget) {
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut previous: Option<(NativeTarget, NativeTarget)> = None;
    loop {
        let targets = adapter.targets().await.expect("discover Chromium targets");
        if let Some(window) = targets.iter().find(|target| {
            target.kind == NativeTargetKind::Window
                && target.title.contains("OpenGeni Chromium AX Fixture")
        }) {
            let application = targets
                .iter()
                .find(|target| {
                    target.kind == NativeTargetKind::App
                        && target.process_id == window.process_id
                        && target.application_id.as_deref() == Some("com.google.Chrome")
                })
                .cloned();
            let Some(application) = application else {
                assert!(
                    Instant::now() < deadline,
                    "isolated Chromium window never gained an application target; targets: {targets:#?}"
                );
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            };
            let current = (application, window.clone());
            if previous.as_ref().is_some_and(|prior| {
                same_target_generation(&prior.0, &current.0)
                    && same_target_generation(&prior.1, &current.1)
            }) {
                return current;
            }
            previous = Some(current);
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        }
        previous = None;
        assert!(
            Instant::now() < deadline,
            "isolated Chromium target was not discovered; Chrome targets: {:#?}",
            targets
                .iter()
                .filter(|target| target.application_id.as_deref() == Some("com.google.Chrome"))
                .collect::<Vec<_>>()
        );
        tokio::time::sleep(Duration::from_millis(75)).await;
    }
}

fn same_target_generation(left: &NativeTarget, right: &NativeTarget) -> bool {
    left.id == right.id && left.target_generation == right.target_generation
}

fn nodes<'a>(roots: &'a [NativeSemanticNode], output: &mut Vec<&'a NativeSemanticNode>) {
    for node in roots {
        output.push(node);
        nodes(&node.children, output);
    }
}

fn find_identifier<'a>(
    observation: &'a NativeObservation,
    identifier: &str,
) -> &'a NativeSemanticNode {
    let mut flattened = Vec::new();
    nodes(&observation.roots, &mut flattened);
    flattened
        .into_iter()
        .find(|node| node.identifier.as_deref() == Some(identifier))
        .unwrap_or_else(|| panic!("missing AX identifier {identifier}"))
}

fn has_text(observation: &NativeObservation, expected: &str) -> bool {
    let mut flattened = Vec::new();
    nodes(&observation.roots, &mut flattened);
    flattened.into_iter().any(|node| {
        node.name.as_deref() == Some(expected)
            || node.description.as_deref() == Some(expected)
            || matches!(&node.value, Some(NativeNodeValue::Text(value)) if value == expected)
    })
}

fn observation_summary(observation: &NativeObservation) -> Vec<String> {
    let mut flattened = Vec::new();
    nodes(&observation.roots, &mut flattened);
    flattened
        .into_iter()
        .filter_map(|node| {
            let value = match &node.value {
                Some(NativeNodeValue::Text(value)) => Some(value.as_str()),
                _ => None,
            };
            (node.identifier.is_some() || node.name.is_some() || value.is_some()).then(|| {
                format!(
                    "{} id={:?} name={:?} value={value:?}",
                    node.role, node.identifier, node.name
                )
            })
        })
        .collect()
}

fn semantic_command(
    observation: &NativeObservation,
    reference: &str,
    action: NativeSemanticAction,
    value: Option<NativeActionValue>,
) -> NativeActionCommand {
    NativeActionCommand {
        target_id: observation.target.id.clone(),
        expected_target_generation: observation.target.target_generation.clone(),
        expected_observation_id: Some(observation.observation_id.clone()),
        expected_frame_id: None,
        action: NativeAction::Semantic {
            locator: NativeLocator::Ref {
                r#ref: reference.to_string(),
            },
            action,
            value,
        },
    }
}

fn assert_canvas_pixels(png: &[u8]) {
    let image = image::load_from_memory(png)
        .expect("decode fixture capture")
        .to_rgb8();
    let visual_pixels = image.pixels().filter(|pixel| {
        let [red, green, blue] = pixel.0;
        (red > 200 && green < 90 && blue > 90) || (red < 80 && green > 150 && blue > 170)
    });
    assert!(
        visual_pixels.take(1_000).count() >= 1_000,
        "custom canvas was not present in the independent window capture"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires local macOS GUI plus Screen Recording, Accessibility, and Input Monitoring grants"]
#[allow(clippy::too_many_lines)]
async fn appkit_swiftui_modal_canvas_hang_and_background_are_causal() {
    let _fixture_guard = LIVE_FIXTURES.lock().await;
    let _frontmost = FrontmostRestore::capture();
    let _fixture = compile_and_launch_fixture();
    let adapter = open_native_adapter().await.expect("open macOS adapter");
    let (application, window) = fixture_targets(adapter.as_ref()).await;

    let frame = adapter
        .capture(&window.id)
        .await
        .expect("capture fixture window");
    assert_eq!(frame.target_id, window.id);
    assert_canvas_pixels(&frame.bytes);

    let targets = adapter.targets().await.expect("refresh fixture targets");
    let background_application = targets
        .iter()
        .find(|target| target.id == application.id)
        .expect("fixture application still present");
    assert!(
        !background_application.focused,
        "fixture should be in the background"
    );

    let mut observation = adapter
        .observe(&application.id)
        .await
        .expect("observe AppKit fixture");
    let input_ref = find_identifier(&observation, "fixture-appkit-input")
        .r#ref
        .clone();
    observation = adapter
        .dispatch(&semantic_command(
            &observation,
            &input_ref,
            NativeSemanticAction::SetValue,
            Some(NativeActionValue::String("appkit-value".to_string())),
        ))
        .await
        .expect("set AppKit value in background")
        .expect("AppKit target remains observable after set-value");
    let apply_ref = find_identifier(&observation, "fixture-appkit-apply")
        .r#ref
        .clone();
    observation = adapter
        .dispatch(&semantic_command(
            &observation,
            &apply_ref,
            NativeSemanticAction::Invoke,
            None,
        ))
        .await
        .expect("invoke AppKit button in background")
        .expect("AppKit target remains observable after invoke");
    assert!(has_text(&observation, "AppKit applied: appkit-value"));
    let refreshed = adapter.targets().await.expect("refresh background state");
    assert!(
        !refreshed
            .iter()
            .find(|target| target.id == application.id)
            .expect("fixture application")
            .focused,
        "semantic background action must not steal focus"
    );

    let swift_input_ref = find_identifier(&observation, "fixture-swiftui-input")
        .r#ref
        .clone();
    observation = adapter
        .dispatch(&semantic_command(
            &observation,
            &swift_input_ref,
            NativeSemanticAction::SetValue,
            Some(NativeActionValue::String("swiftui-value".to_string())),
        ))
        .await
        .expect("set SwiftUI value")
        .expect("SwiftUI target remains observable after set-value");
    assert!(matches!(
        &find_identifier(&observation, "fixture-swiftui-input").value,
        Some(NativeNodeValue::Text(value)) if value == "swiftui-value"
    ));
    let swift_apply_ref = find_identifier(&observation, "fixture-swiftui-apply")
        .r#ref
        .clone();
    observation = adapter
        .dispatch(&semantic_command(
            &observation,
            &swift_apply_ref,
            NativeSemanticAction::Invoke,
            None,
        ))
        .await
        .expect("invoke SwiftUI button")
        .expect("SwiftUI target remains observable after invoke");
    assert!(
        has_text(&observation, "SwiftUI button invoked"),
        "SwiftUI action did not project expected state: {:#?}",
        observation_summary(&observation)
    );

    let modal_ref = find_identifier(&observation, "fixture-open-modal")
        .r#ref
        .clone();
    observation = adapter
        .dispatch(&semantic_command(
            &observation,
            &modal_ref,
            NativeSemanticAction::Invoke,
            None,
        ))
        .await
        .expect("open modal sheet")
        .expect("fixture target remains observable after opening modal");
    if !has_text(&observation, "Fixture modal question") {
        observation = adapter
            .observe(&application.id)
            .await
            .expect("observe modal sheet");
    }
    assert!(has_text(&observation, "Fixture modal question"));
    let close_ref = find_identifier(&observation, "fixture-close-modal")
        .r#ref
        .clone();
    observation = adapter
        .dispatch(&semantic_command(
            &observation,
            &close_ref,
            NativeSemanticAction::Invoke,
            None,
        ))
        .await
        .expect("close modal sheet")
        .expect("fixture target remains observable after closing modal");
    assert!(!has_text(&observation, "Fixture modal question"));

    let mut hang_observation = observation;
    let mut hung = None;
    for attempt in 0..3 {
        let hang_ref = find_identifier(&hang_observation, "fixture-hang")
            .r#ref
            .clone();
        let result = adapter
            .dispatch(&semantic_command(
                &hang_observation,
                &hang_ref,
                NativeSemanticAction::Invoke,
                None,
            ))
            .await;
        if attempt < 2
            && result.as_ref().err().is_some_and(|error| {
                error.code == NativeAdapterErrorCode::ObservationStale
                    && error.retryable
                    && !error.dispatched
            })
        {
            hang_observation = adapter
                .observe(&application.id)
                .await
                .expect("refresh fixture before hang action");
            continue;
        }
        hung = Some(result);
        break;
    }
    let hung = hung.expect("bounded hang action attempt");
    if let Err(error) = hung {
        assert_eq!(error.code, NativeAdapterErrorCode::OutcomeUnknown);
        assert!(error.dispatched);
    }
    tokio::time::sleep(Duration::from_millis(2_200)).await;
    let recovered = adapter
        .observe(&application.id)
        .await
        .expect("observe recovered fixture");
    assert!(has_text(&recovered, "AppKit recovered"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires installed Google Chrome plus local macOS Screen Recording and Accessibility grants"]
#[allow(clippy::too_many_lines)]
async fn chromium_accessibility_and_window_capture_are_causal() {
    let _fixture_guard = LIVE_FIXTURES.lock().await;
    let frontmost = FrontmostRestore::capture();
    let _chromium = launch_chromium_fixture();
    let adapter = open_native_adapter().await.expect("open macOS adapter");
    let (_application, window) = chromium_targets(adapter.as_ref()).await;
    let initial_frame = adapter
        .capture(&window.id)
        .await
        .expect("capture initial Chromium window");
    let live_options = NativeCaptureOptions {
        format: NativeFrameFormat::Jpeg,
        quality: 72,
        max_width: 1_280,
        max_height: 720,
    };
    adapter
        .start_capture_stream(&window.id, live_options)
        .await
        .expect("start isolated Chromium live stream");
    let initial_live_frame = adapter
        .capture_stream(&window.id, live_options)
        .await
        .expect("capture first isolated Chromium live frame");
    let mut observation = adapter
        .observe(&window.id)
        .await
        .expect("observe isolated Chromium window");
    let input_ref = observation
        .roots
        .iter()
        .flat_map(|root| {
            let mut flattened = Vec::new();
            nodes(std::slice::from_ref(root), &mut flattened);
            flattened
        })
        .find(|node| {
            node.identifier.as_deref() == Some("chromium-input")
                || node.name.as_deref() == Some("Chromium input")
                || (node.role == "text_field"
                    && node.description.as_deref() == Some("Chromium input"))
        })
        .unwrap_or_else(|| {
            panic!(
                "Chromium text field absent from native AX observation: {:#?}",
                observation_summary(&observation)
            )
        })
        .r#ref
        .clone();
    observation = adapter
        .dispatch(&semantic_command(
            &observation,
            &input_ref,
            NativeSemanticAction::SetValue,
            Some(NativeActionValue::String("chromium-value".to_string())),
        ))
        .await
        .expect("set Chromium field through native AX")
        .expect("Chromium target remains observable after set-value");
    let mut flattened = Vec::new();
    nodes(&observation.roots, &mut flattened);
    let apply_ref = flattened
        .into_iter()
        .find(|node| node.name.as_deref() == Some("Apply Chromium"))
        .expect("Chromium apply button")
        .r#ref
        .clone();
    observation = adapter
        .dispatch(&semantic_command(
            &observation,
            &apply_ref,
            NativeSemanticAction::Invoke,
            None,
        ))
        .await
        .expect("invoke Chromium button through native AX")
        .expect("Chromium target remains observable after invoke");
    assert!(has_text(&observation, "Chromium applied: chromium-value"));

    let frame = adapter
        .capture(&window.id)
        .await
        .expect("capture isolated Chromium window");
    assert_ne!(
        initial_frame.sha256, frame.sha256,
        "independent Chromium capture did not reflect the semantic mutation"
    );
    assert_canvas_pixels(&frame.bytes);

    let focus_command = NativeActionCommand {
        target_id: observation.target.id.clone(),
        expected_target_generation: observation.target.target_generation.clone(),
        expected_observation_id: Some(observation.observation_id.clone()),
        expected_frame_id: None,
        action: NativeAction::Focus {
            target_id: observation.target.id.clone(),
        },
    };
    observation = adapter
        .dispatch(&focus_command)
        .await
        .expect("focus exact isolated Chromium window")
        .expect("Chromium remains observable after focus");
    let refreshed_input_ref = observation
        .roots
        .iter()
        .flat_map(|root| {
            let mut flattened = Vec::new();
            nodes(std::slice::from_ref(root), &mut flattened);
            flattened
        })
        .find(|node| {
            node.identifier.as_deref() == Some("chromium-input")
                || node.name.as_deref() == Some("Chromium input")
                || (node.role == "text_field"
                    && node.description.as_deref() == Some("Chromium input"))
        })
        .expect("Chromium input after focus")
        .r#ref
        .clone();
    observation = adapter
        .dispatch(&semantic_command(
            &observation,
            &refreshed_input_ref,
            NativeSemanticAction::Focus,
            None,
        ))
        .await
        .expect("focus isolated Chromium input")
        .expect("Chromium remains observable after input focus");
    // Model the user's ordinary app reclaiming the physical seat between two
    // remote requests. Raw input must validate, focus this exact Chromium PID
    // and inject without yielding to caller code.
    frontmost.restore_now();
    tokio::time::sleep(Duration::from_millis(250)).await;
    let keyboard_marker = "native-keyboard-value";
    let keyboard_command = NativeActionCommand {
        target_id: observation.target.id.clone(),
        expected_target_generation: observation.target.target_generation.clone(),
        expected_observation_id: None,
        expected_frame_id: None,
        action: NativeAction::Keyboard {
            action: NativeKeyboardAction::Type,
            value: keyboard_marker.to_string(),
        },
    };
    let mut keyboard_result = None;
    let mut successful_keyboard_elapsed = None;
    for attempt in 0..10 {
        let attempt_started = Instant::now();
        let result = adapter.dispatch(&keyboard_command).await;
        let should_retry = result
            .as_ref()
            .err()
            .is_some_and(|error| error.retryable && !error.dispatched && attempt < 9);
        if result.is_ok() {
            successful_keyboard_elapsed = Some(attempt_started.elapsed());
        }
        keyboard_result = Some(result);
        if !should_retry {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25 * (attempt + 1))).await;
    }
    let keyboard_observation = keyboard_result
        .expect("keyboard attempt")
        .expect("type into exact isolated Chromium window");
    assert!(
        keyboard_observation.is_none(),
        "raw keyboard receipt must not synchronously rebuild the AX tree"
    );
    let keyboard_elapsed = successful_keyboard_elapsed.expect("successful keyboard timing");
    assert!(
        keyboard_elapsed <= Duration::from_millis(750),
        "exact Chromium keyboard dispatch exceeded the connected-machine budget: {keyboard_elapsed:?}"
    );
    let observation_after_keyboard = adapter
        .observe(&window.id)
        .await
        .expect("observe Chromium after keyboard input");
    let mut keyboard_nodes = Vec::new();
    nodes(&observation_after_keyboard.roots, &mut keyboard_nodes);
    assert!(
        keyboard_nodes.into_iter().any(|node| {
            matches!(&node.value, Some(NativeNodeValue::Text(value)) if value.contains(keyboard_marker))
        }),
        "raw keyboard input did not reach the isolated Chromium field: {:#?}",
        observation_summary(&observation_after_keyboard)
    );
    let live_deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let current = adapter
            .capture_stream(&window.id, live_options)
            .await
            .expect("capture changed isolated Chromium live frame");
        if current.sha256 != initial_live_frame.sha256 {
            break;
        }
        assert!(
            Instant::now() < live_deadline,
            "ScreenCaptureKit live stream did not reflect the Chromium mutation"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    adapter
        .stop_capture_stream(&window.id)
        .await
        .expect("stop isolated Chromium live stream");
}
