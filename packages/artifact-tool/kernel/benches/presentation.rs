use std::hint::black_box;
use std::time::{Duration, Instant};

use opengeni_artifact_kernel::presentation::{
    decode_presentation_snapshot, encode_presentation_snapshot, Color, Emu, Fill, LineStyle,
    NewSceneNode, NodeKind, Presentation, PresentationBatch, PresentationCommand, Rect, SceneOwner,
    Shape, ShapeGeometry, SlideSize, Transform, EMU_PER_CSS_PIXEL,
};
use opengeni_artifact_kernel::StableId;

fn main() {
    let deep = environment_flag("OPENGENI_ARTIFACT_BENCH_DEEP");
    let pinned = environment_flag("OPENGENI_ARTIFACT_BENCH_PINNED");
    let node_count = if deep { 50_000 } else { 10_000 };
    let query_iterations = if deep { 2_000 } else { 500 };
    let edit_iterations = if deep { 500 } else { 100 };

    let namespace = 0x5052_4553;
    let slide_id = StableId::from_parts(namespace, 2);
    let mut deck = Presentation::new(namespace, SlideSize::widescreen()).expect("presentation");
    let mut commands = Vec::with_capacity(node_count + 1);
    commands.push(PresentationCommand::CreateSlide {
        id: slide_id,
        index: 0,
        title: "Benchmark".to_owned(),
        layout_id: None,
        background: Fill::Solid(Color::WHITE),
    });
    for index in 0..node_count {
        let column = i64::try_from(index % 100).expect("column");
        let row = i64::try_from(index / 100).expect("row");
        commands.push(PresentationCommand::InsertNode {
            owner: SceneOwner::Slide(slide_id),
            parent: None,
            index,
            node: NewSceneNode {
                id: StableId::from_parts(namespace, u64::try_from(index + 3).expect("id")),
                name: "Shape".to_owned(),
                bounds: rect(column * 13, row * 9, 12, 8),
                transform: Transform::default(),
                kind: NodeKind::Shape(Shape {
                    geometry: ShapeGeometry::Rectangle,
                    fill: Fill::Solid(Color(0x4f86_f7ff)),
                    line: LineStyle::default(),
                    text: None,
                    placeholder: None,
                }),
            },
        });
    }

    let started = Instant::now();
    deck.apply_batch(&PresentationBatch::from_commands(commands))
        .expect("seed presentation");
    let build = started.elapsed();

    let viewport = rect(0, 0, 1_280, 720);
    let viewport_samples = samples(query_iterations, || {
        black_box(
            deck.viewport_projection(SceneOwner::Slide(slide_id), viewport, 1_024)
                .expect("viewport"),
        );
    });
    let hit_x = Emu::new(640 * EMU_PER_CSS_PIXEL).expect("hit x");
    let hit_y = Emu::new(360 * EMU_PER_CSS_PIXEL).expect("hit y");
    let hit_samples = samples(query_iterations, || {
        black_box(
            deck.hit_test(SceneOwner::Slide(slide_id), hit_x, hit_y, 16)
                .expect("hit"),
        );
    });

    let mut edit_samples = Vec::with_capacity(edit_iterations);
    for iteration in 0..edit_iterations {
        let target = StableId::from_parts(
            namespace,
            u64::try_from(iteration % node_count + 3).expect("target"),
        );
        let started = Instant::now();
        deck.apply_batch(&PresentationBatch::from_commands(vec![
            PresentationCommand::SetNodeBounds {
                id: target,
                bounds: rect(
                    i64::try_from(iteration % 100).unwrap() * 13 + 1,
                    i64::try_from(iteration / 100).unwrap() * 9 + 1,
                    12,
                    8,
                ),
            },
        ]))
        .expect("edit");
        edit_samples.push(started.elapsed());
    }

    let started = Instant::now();
    let snapshot = encode_presentation_snapshot(&deck).expect("snapshot");
    let snapshot_encode = started.elapsed();
    let started = Instant::now();
    let reopened = decode_presentation_snapshot(&snapshot).expect("reopen");
    let snapshot_decode = started.elapsed();
    black_box(reopened);

    let viewport_p95 = percentile(&viewport_samples, 0.95);
    let hit_p95 = percentile(&hit_samples, 0.95);
    let edit_p95 = percentile(&edit_samples, 0.95);
    println!(
        "presentation nodes={node_count} build_ms={:.3} viewport_p95_us={:.3} hit_p95_us={:.3} edit_p95_ms={:.3} snapshot_bytes={} snapshot_encode_ms={:.3} snapshot_decode_ms={:.3}",
        build.as_secs_f64() * 1_000.0,
        viewport_p95.as_secs_f64() * 1_000_000.0,
        hit_p95.as_secs_f64() * 1_000_000.0,
        edit_p95.as_secs_f64() * 1_000.0,
        snapshot.len(),
        snapshot_encode.as_secs_f64() * 1_000.0,
        snapshot_decode.as_secs_f64() * 1_000.0,
    );

    if pinned {
        assert!(build <= Duration::from_secs(2), "presentation build budget");
        assert!(
            viewport_p95 <= Duration::from_millis(2),
            "viewport p95 budget"
        );
        assert!(hit_p95 <= Duration::from_millis(2), "hit-test p95 budget");
        assert!(edit_p95 <= Duration::from_millis(20), "edit p95 budget");
        assert!(
            snapshot_encode <= Duration::from_secs(1),
            "snapshot encode budget"
        );
        assert!(
            snapshot_decode <= Duration::from_secs(1),
            "snapshot decode budget"
        );
    }
}

fn rect(x: i64, y: i64, width: i64, height: i64) -> Rect {
    Rect::new(
        x * EMU_PER_CSS_PIXEL,
        y * EMU_PER_CSS_PIXEL,
        width * EMU_PER_CSS_PIXEL,
        height * EMU_PER_CSS_PIXEL,
    )
    .expect("benchmark rectangle")
}

fn samples(iterations: usize, mut operation: impl FnMut()) -> Vec<Duration> {
    let mut output = Vec::with_capacity(iterations);
    for _ in 0..iterations {
        let started = Instant::now();
        operation();
        output.push(started.elapsed());
    }
    output
}

fn percentile(values: &[Duration], quantile: f64) -> Duration {
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    let index = ((sorted.len() - 1) as f64 * quantile).round() as usize;
    sorted[index]
}

fn environment_flag(name: &str) -> bool {
    std::env::var(name).is_ok_and(|value| matches!(value.as_str(), "1" | "true" | "yes"))
}
