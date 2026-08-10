mod support;

use std::hint::black_box;
use std::time::{Duration, Instant};

use opengeni_artifact_kernel::text_layout::{
    FontDescriptor, FontRegistry, LayoutConstraints, LayoutLimits, LayoutUnit, RenderSceneId,
    RenderTileKey, RetainedRenderLimits, RetainedRenderScene, RichTextParagraph, TextLayoutEngine,
    TextStyle,
};

const TARGET_BYTES: usize = 100_000;
const TARGET_P95_MS: f64 = 150.0;

fn main() {
    let pinned = std::env::var("OPENGENI_ARTIFACT_BENCH_PINNED").is_ok_and(|value| value == "1");
    let samples = if pinned { 20 } else { 8 };
    let seed = "OpenGeni native/Wasm layout العربية שלום 漢字 👩‍🚀 — ";
    let text = seed
        .repeat(TARGET_BYTES.div_ceil(seed.len()))
        .chars()
        .take(TARGET_BYTES)
        .collect::<String>();
    let limits = LayoutLimits::default();
    let mut fonts = FontRegistry::new(limits);
    fonts
        .register(
            support::test_font(&text, 600),
            0,
            FontDescriptor::new("Benchmark Fixture"),
        )
        .expect("benchmark font");
    let paragraph = RichTextParagraph::plain(
        text,
        TextStyle::new("Benchmark Fixture", LayoutUnit::from_raw(1_024)),
    );
    let constraints = LayoutConstraints {
        max_width: Some(LayoutUnit::from_raw(48_000)),
    };
    let mut engine = TextLayoutEngine::new(fonts, limits);
    let mut timings = Vec::with_capacity(samples);
    let mut retained_bytes = 0;
    let mut glyphs = 0;
    for _ in 0..samples {
        engine.clear_cache();
        let started = Instant::now();
        let layout = engine
            .layout(black_box(&paragraph), constraints)
            .expect("layout");
        timings.push(started.elapsed());
        retained_bytes = layout.estimated_bytes();
        glyphs = layout.glyph_runs.iter().map(|run| run.glyphs.len()).sum();
        black_box(layout);
    }
    timings.sort_unstable();
    let p95_ms = percentile(&timings, 0.95).as_secs_f64() * 1_000.0;

    let hot_started = Instant::now();
    for _ in 0..1_000 {
        black_box(
            engine
                .layout(&paragraph, constraints)
                .expect("cached layout"),
        );
    }
    let hot_average_us = hot_started.elapsed().as_secs_f64() * 1_000.0;
    let passed = p95_ms < TARGET_P95_MS;
    println!(
        "{{\"benchmark\":\"text_layout_100k_mixed_unicode\",\"input_bytes\":{},\"glyphs\":{},\"retained_bytes\":{},\"samples\":{},\"cold_p95_ms\":{:.3},\"hot_average_us\":{:.3},\"target_ms\":{:.1},\"passed\":{}}}",
        paragraph.text.len(),
        glyphs,
        retained_bytes,
        samples,
        p95_ms,
        hot_average_us,
        TARGET_P95_MS,
        passed,
    );

    let scene_limits = RetainedRenderLimits::default();
    let scene_started = Instant::now();
    let scene = RetainedRenderScene::from_paragraph(
        RenderSceneId::from_bytes(*b"text-bench-scene"),
        1,
        LayoutUnit::ZERO,
        LayoutUnit::ZERO,
        &engine
            .layout(&paragraph, constraints)
            .expect("cached scene layout"),
        LayoutUnit::from_raw(32_768),
        scene_limits,
    )
    .expect("retained scene");
    let scene_ms = scene_started.elapsed().as_secs_f64() * 1_000.0;

    let mut changed_text = paragraph.text.clone();
    changed_text.replace_range(0..1, "G");
    let changed = RichTextParagraph::plain(changed_text, paragraph.default_style.clone());
    let changed_layout = engine
        .layout(&changed, constraints)
        .expect("changed layout");
    let changed_scene = RetainedRenderScene::from_paragraph(
        RenderSceneId::from_bytes(*b"text-bench-scene"),
        2,
        LayoutUnit::ZERO,
        LayoutUnit::ZERO,
        &changed_layout,
        LayoutUnit::from_raw(32_768),
        scene_limits,
    )
    .expect("changed retained scene");
    let diff_started = Instant::now();
    let mut changed_commands = 0;
    let mut invalidated_tiles = 0;
    for _ in 0..100 {
        let patch = scene.diff(&changed_scene).expect("retained diff");
        changed_commands = patch.removed.len() + patch.upserted.len();
        invalidated_tiles = patch.invalidated_tiles.len();
        black_box(patch);
    }
    let diff_average_us = diff_started.elapsed().as_secs_f64() * 10_000.0;
    let tile_started = Instant::now();
    let mut tile_commands = 0;
    for _ in 0..1_000 {
        let tile = scene
            .tile(RenderTileKey { x: 0, y: 0 })
            .expect("visible tile");
        tile_commands = tile.commands.len();
        black_box(tile);
    }
    let tile_average_us = tile_started.elapsed().as_secs_f64() * 1_000.0;
    println!(
        "{{\"benchmark\":\"retained_text_scene_100k\",\"commands\":{},\"tiles\":{},\"scene_build_ms\":{:.3},\"diff_average_us\":{:.3},\"changed_commands\":{},\"invalidated_tiles\":{},\"visible_tile_commands\":{},\"tile_clone_average_us\":{:.3}}}",
        scene.command_count(),
        scene.tile_count(),
        scene_ms,
        diff_average_us,
        changed_commands,
        invalidated_tiles,
        tile_commands,
        tile_average_us,
    );
    if pinned {
        assert!(
            passed,
            "100k mixed-Unicode text layout p95 {p95_ms:.3}ms exceeded {TARGET_P95_MS:.1}ms"
        );
    }
}

fn percentile(values: &[Duration], percentile: f64) -> Duration {
    let index = ((values.len() - 1) as f64 * percentile).ceil() as usize;
    values[index]
}
