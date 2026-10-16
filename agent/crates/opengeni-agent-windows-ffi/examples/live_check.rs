//! Manual live check for an interactive Windows desktop session.
//!
//! Run it in a signed-in session (not over SSH, which is session 0):
//!
//! ```text
//! cargo run -p opengeni-agent-windows-ffi --example live_check -- out.bmp
//! ```
//!
//! It probes the display, captures it to a BMP, then opens Notepad, clicks into
//! it, types a line, selects it with a chord and scrolls, and captures again so
//! the second image shows the typed text.

use std::path::Path;
use std::time::Duration;

use opengeni_agent_windows_ffi::{
    blocked_reason, capture_rgba, inject, probe_display, InputEvent, KeyAction, PointerAction,
    PointerButton, RgbaFrame,
};

fn write_bmp(path: &Path, frame: &RgbaFrame) -> std::io::Result<()> {
    let pixel_bytes = frame.rgba.len();
    let mut out = Vec::with_capacity(54 + pixel_bytes);
    let file_size = u32::try_from(54 + pixel_bytes).unwrap_or(u32::MAX);
    out.extend_from_slice(b"BM");
    out.extend_from_slice(&file_size.to_le_bytes());
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(&54_u32.to_le_bytes());
    out.extend_from_slice(&40_u32.to_le_bytes());
    out.extend_from_slice(&i32::try_from(frame.width).unwrap_or(0).to_le_bytes());
    out.extend_from_slice(&(-i32::try_from(frame.height).unwrap_or(0)).to_le_bytes());
    out.extend_from_slice(&1_u16.to_le_bytes());
    out.extend_from_slice(&32_u16.to_le_bytes());
    out.extend_from_slice(&[0; 24]);
    for pixel in frame.rgba.chunks_exact(4) {
        out.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
    }
    std::fs::write(path, out)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let out = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "live_check.bmp".to_string());
    let display = probe_display().ok_or("no interactive display")?;
    println!("display: {display:?}");
    println!("blocked: {:?}", blocked_reason());

    let before = capture_rgba()?;
    write_bmp(Path::new(&format!("before-{out}")), &before)?;
    println!("captured {}x{}", before.width, before.height);

    std::process::Command::new("notepad.exe").spawn()?;
    std::thread::sleep(Duration::from_secs(2));
    let (cx, cy) = (
        i32::try_from(display.width / 2)?,
        i32::try_from(display.height / 2)?,
    );
    inject(&InputEvent::Pointer {
        x: cx,
        y: cy,
        button: PointerButton::Left,
        action: PointerAction::Click,
    })?;
    inject(&InputEvent::Text(
        "Hello from SendInput: æøå 🙂\nsecond line\t<tab>".into(),
    ))?;
    inject(&InputEvent::Key {
        chord: "shift+Home".into(),
        action: KeyAction::Press,
    })?;
    inject(&InputEvent::Scroll {
        x: cx,
        y: cy,
        dx: 0,
        dy: 2,
    })?;
    std::thread::sleep(Duration::from_millis(500));

    let after = capture_rgba()?;
    write_bmp(Path::new(&out), &after)?;
    let changed = before
        .rgba
        .chunks_exact(4)
        .zip(after.rgba.chunks_exact(4))
        .filter(|(a, b)| a != b)
        .count();
    println!("captured again; {changed} pixels changed");
    Ok(())
}
