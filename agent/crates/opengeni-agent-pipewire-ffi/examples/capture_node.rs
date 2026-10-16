//! Manual check: `capture_node <node-id> [out.ppm]` grabs one frame from a
//! running compositor screen-cast node and reports timings.

use std::io::Write as _;
use std::time::{Duration, Instant};

use opengeni_agent_pipewire_ffi::{FrameWait, ScreenCastStream};

fn main() {
    let mut args = std::env::args().skip(1);
    let node: u32 = args
        .next()
        .and_then(|value| value.parse().ok())
        .expect("usage: capture_node <node-id> [out.ppm]");
    let output = args.next();
    let started = Instant::now();
    let stream = ScreenCastStream::connect(node, 15).expect("connect");
    println!("connected in {:?}", started.elapsed());
    let frame = stream
        .frame(1, FrameWait::first(Duration::from_secs(3)))
        .expect("first frame");
    println!(
        "first frame {}x{} seq {} after {:?}",
        frame.width,
        frame.height,
        frame.sequence,
        started.elapsed()
    );
    let again = Instant::now();
    let next = stream
        .frame(
            frame.sequence + 1,
            FrameWait::first(Duration::from_millis(200)),
        )
        .expect("second frame");
    println!("second read seq {} in {:?}", next.sequence, again.elapsed());
    if std::env::var_os("WATCH").is_some() {
        for _ in 0..30 {
            std::thread::sleep(Duration::from_millis(100));
            println!("t={:?} seq {}", started.elapsed(), stream.latest_sequence());
        }
    }
    if let Some(path) = output {
        let mut file = std::fs::File::create(path).expect("create output");
        write!(file, "P6\n{} {}\n255\n", frame.width, frame.height).expect("header");
        let rgb: Vec<u8> = frame
            .rgba
            .chunks_exact(4)
            .flat_map(|pixel| [pixel[0], pixel[1], pixel[2]])
            .collect();
        file.write_all(&rgb).expect("pixels");
    }
}
