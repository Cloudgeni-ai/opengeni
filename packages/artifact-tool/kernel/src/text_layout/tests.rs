use std::collections::BTreeSet;
use std::sync::Arc;

use sha2::{Digest, Sha256};

use super::*;

const FONT_SIZE: LayoutUnit = LayoutUnit::from_raw(1_024);

#[test]
fn font_registry_is_content_addressed_bounded_and_explicit() {
    let limits = LayoutLimits::default();
    let mut registry = FontRegistry::new(limits);
    let font = test_font("Aa אב 漢 👩🚀", 600);
    let descriptor = FontDescriptor::new("Fixture Sans");
    let first = registry
        .register(font.clone(), 0, descriptor.clone())
        .expect("valid fixture font");
    let bytes = registry.total_bytes();
    let second = registry
        .register(font, 0, descriptor)
        .expect("identical registration");
    assert_eq!(first, second);
    assert_eq!(registry.len(), 1);
    assert_eq!(registry.total_bytes(), bytes);
    assert_eq!(first.asset_hash.to_hex().len(), 64);
    assert_eq!(first.id.to_hex().len(), 32);
    assert_eq!(
        first.asset_hash.to_hex(),
        "facbac1e197b4b4f3fb19bcb5cf40c22a98f7ea3c4ebaed0933865748806ab2b"
    );
    assert_eq!(first.id.to_hex(), "6a4d88558015563b3dfa063b5ed9ec63");
    assert_eq!(
        registry
            .resolve_retained_font(first.id, first.asset_hash)
            .expect("retained identity"),
        &first
    );
    assert!(matches!(
        registry.resolve_retained_font(first.id, FontAssetHash::from_bytes([7; 32])),
        Err(LayoutError::FontAssetMismatch(id)) if id == first.id
    ));

    let conflict = registry.register(
        test_font("Aa אב 漢 👩🚀", 600),
        0,
        FontDescriptor::new("Conflicting Alias"),
    );
    assert!(matches!(
        conflict,
        Err(LayoutError::FontIdentityConflict(_))
    ));
    assert!(matches!(
        registry.register(vec![0, 1, 2, 3], 0, FontDescriptor::new("Broken")),
        Err(LayoutError::InvalidFont(_))
    ));
}

#[test]
fn plain_and_rich_text_wrap_with_deterministic_fallback_diagnostics() {
    let limits = LayoutLimits::default();
    let mut registry = FontRegistry::new(limits);
    let primary = registry
        .register(
            test_font("Hello world ", 600),
            0,
            FontDescriptor::new("Primary"),
        )
        .expect("primary font");
    let fallback = registry
        .register(
            test_font("漢字👩🚀 ", 700),
            0,
            FontDescriptor::new("Fallback"),
        )
        .expect("fallback font");
    let mut style = TextStyle::new("Primary", FONT_SIZE);
    style.fallback_fonts.push(fallback.id);
    let paragraph = RichTextParagraph::plain("Hello 漢字 👩‍🚀 world", style);
    let mut engine = TextLayoutEngine::new(registry, limits);
    let layout = engine
        .layout(
            &paragraph,
            LayoutConstraints {
                max_width: Some(LayoutUnit::from_raw(4_000)),
            },
        )
        .expect("layout");
    assert!(layout.lines.len() >= 2);
    assert!(layout
        .glyph_runs
        .iter()
        .any(|run| run.font_id == primary.id));
    assert!(layout
        .glyph_runs
        .iter()
        .any(|run| run.font_id == fallback.id));
    assert!(layout.diagnostics.iter().any(|diagnostic| {
        diagnostic.reason == FontSubstitutionReason::GlyphCoverageFallback
            && diagnostic.resolved_font == fallback.id
    }));
    assert!(layout
        .glyph_runs
        .iter()
        .flat_map(|run| &run.glyphs)
        .all(|glyph| paragraph.text.is_char_boundary(glyph.cluster as usize)));
}

#[test]
fn combining_graphemes_fallback_atomically_and_missing_glyphs_are_diagnosed() {
    let limits = LayoutLimits::default();
    let mut registry = FontRegistry::new(limits);
    let primary = registry
        .register(test_font("a ", 600), 0, FontDescriptor::new("Primary"))
        .expect("primary font");
    let fallback = registry
        .register(
            test_font("a\u{0301} ", 600),
            0,
            FontDescriptor::new("Fallback"),
        )
        .expect("fallback font");
    let mut style = TextStyle::new("Primary", FONT_SIZE);
    style.fallback_fonts.push(fallback.id);
    let mut engine = TextLayoutEngine::new(registry, limits);

    let combining = engine
        .layout(
            &RichTextParagraph::plain("a\u{0301}", style.clone()),
            LayoutConstraints::UNBOUNDED,
        )
        .expect("combining grapheme");
    assert!(combining
        .glyph_runs
        .iter()
        .all(|run| run.font_id == fallback.id));
    assert!(combining.diagnostics.iter().any(|diagnostic| {
        diagnostic.text_range == (0..3)
            && diagnostic.reason == FontSubstitutionReason::GlyphCoverageFallback
    }));

    let missing = engine
        .layout(
            &RichTextParagraph::plain("aΩ", style),
            LayoutConstraints::UNBOUNDED,
        )
        .expect("missing glyph layout");
    assert!(missing.diagnostics.iter().any(|diagnostic| {
        diagnostic.text_range == (1..3)
            && diagnostic.resolved_font == primary.id
            && diagnostic.reason == FontSubstitutionReason::MissingGlyph
    }));
}

#[test]
fn rtl_cjk_and_emoji_keep_visual_runs_and_grapheme_boundaries() {
    let text = "ABC אבג العربية 漢字 👩‍🚀 XYZ";
    let limits = LayoutLimits::default();
    let mut registry = FontRegistry::new(limits);
    let registered = registry
        .register(
            test_font(text, 600),
            0,
            FontDescriptor::new("Universal Fixture"),
        )
        .expect("universal font");
    let mut style = TextStyle::new("Universal Fixture", FONT_SIZE);
    style.fallback_fonts.push(registered.id);
    let paragraph = RichTextParagraph::plain(text, style);
    let mut engine = TextLayoutEngine::new(registry, limits);
    let layout = engine
        .layout(
            &paragraph,
            LayoutConstraints {
                max_width: Some(LayoutUnit::from_raw(5_000)),
            },
        )
        .expect("mixed-direction layout");
    assert!(layout.lines.len() >= 2);
    assert!(layout
        .glyph_runs
        .iter()
        .any(|run| run.direction == GlyphDirection::LeftToRight));
    assert!(layout
        .glyph_runs
        .iter()
        .any(|run| run.direction == GlyphDirection::RightToLeft));
    let emoji_start = text.find('👩').expect("emoji");
    let emoji_end = emoji_start + "👩‍🚀".len();
    assert!(!layout.lines.iter().any(|line| {
        line.text_range.start > emoji_start && line.text_range.start < emoji_end
            || line.text_range.end > emoji_start && line.text_range.end < emoji_end
    }));
}

#[test]
fn rich_spans_preserve_style_and_bidi_boundaries() {
    let text = "left שלום right";
    let limits = LayoutLimits::default();
    let mut registry = FontRegistry::new(limits);
    registry
        .register(test_font(text, 600), 0, FontDescriptor::new("Fixture"))
        .expect("font");
    let normal = TextStyle::new("Fixture", FONT_SIZE);
    let mut emphasized = normal.clone();
    emphasized.paint.rgba = 0xff00_00ff;
    emphasized.paint.underline = true;
    let start = text.find('ש').expect("Hebrew start");
    let end = start + "שלום".len();
    let paragraph = RichTextParagraph {
        text: text.into(),
        default_style: normal,
        spans: vec![TextSpan {
            range: start..end,
            style: emphasized,
        }],
        paragraph_style: ParagraphStyle::default(),
    };
    let mut engine = TextLayoutEngine::new(registry, limits);
    let layout = engine
        .layout(&paragraph, LayoutConstraints::UNBOUNDED)
        .expect("rich layout");
    assert!(layout.glyph_runs.iter().any(|run| {
        run.text_range == (start..end)
            && run.direction == GlyphDirection::RightToLeft
            && run.paint.underline
    }));
}

#[test]
fn explicit_line_breaks_and_trailing_break_preserve_empty_lines() {
    let text = "a\n\nb\n";
    let limits = LayoutLimits::default();
    let mut registry = FontRegistry::new(limits);
    registry
        .register(test_font(text, 600), 0, FontDescriptor::new("Fixture"))
        .expect("font");
    let paragraph = RichTextParagraph::plain(text, TextStyle::new("Fixture", FONT_SIZE));
    let mut engine = TextLayoutEngine::new(registry, limits);
    let layout = engine
        .layout(&paragraph, LayoutConstraints::UNBOUNDED)
        .expect("line layout");
    assert_eq!(
        layout
            .lines
            .iter()
            .map(|line| line.text_range.clone())
            .collect::<Vec<_>>(),
        vec![0..1, 2..2, 3..4, 5..5]
    );
}

#[test]
fn tabs_and_soft_hyphens_have_explicit_platform_neutral_semantics() {
    let limits = LayoutLimits::default();
    let mut registry = FontRegistry::new(limits);
    registry
        .register(
            test_font("abcde fghijklmnopqrstuvwxyz-", 600),
            0,
            FontDescriptor::new("Fixture"),
        )
        .expect("font");
    let style = TextStyle::new("Fixture", FONT_SIZE);
    let mut engine = TextLayoutEngine::new(registry, limits);

    let tab = RichTextParagraph::plain("a\tb", style.clone());
    let spaces = RichTextParagraph::plain("a    b", style.clone());
    let tab_layout = engine
        .layout(&tab, LayoutConstraints::UNBOUNDED)
        .expect("tab layout");
    let spaces_layout = engine
        .layout(&spaces, LayoutConstraints::UNBOUNDED)
        .expect("space layout");
    assert_eq!(tab_layout.lines[0].advance, spaces_layout.lines[0].advance);
    let tab_clusters = tab_layout
        .glyph_runs
        .iter()
        .flat_map(|run| run.glyphs.iter())
        .filter(|glyph| glyph.cluster == 1)
        .count();
    assert_eq!(tab_clusters, 4, "tab expands to four shaped spaces");

    let plain = engine
        .layout(
            &RichTextParagraph::plain("cooperate", style.clone()),
            LayoutConstraints::UNBOUNDED,
        )
        .expect("plain layout");
    let soft = RichTextParagraph::plain("co\u{00ad}operate", style);
    let unbroken = engine
        .layout(&soft, LayoutConstraints::UNBOUNDED)
        .expect("unbroken soft hyphen");
    assert_eq!(unbroken.lines[0].advance, plain.lines[0].advance);
    assert!(unbroken
        .glyph_runs
        .iter()
        .flat_map(|run| run.glyphs.iter())
        .all(|glyph| glyph.cluster != 2));

    let broken = engine
        .layout(
            &soft,
            LayoutConstraints {
                max_width: Some(LayoutUnit::from_raw(1_842)),
            },
        )
        .expect("soft-hyphen line break");
    assert_eq!(broken.lines[0].text_range, 0..4);
    assert_eq!(broken.lines[0].advance, LayoutUnit::from_raw(1_842));
    assert!(broken.glyph_runs[broken.lines[0].glyph_runs.clone()]
        .iter()
        .flat_map(|run| run.glyphs.iter())
        .any(|glyph| glyph.cluster == 2));
}

#[test]
fn tab_and_visible_soft_hyphen_resolve_the_glyph_they_actually_shape() {
    let limits = LayoutLimits::default();
    let mut registry = FontRegistry::new(limits);
    let primary = registry
        .register(
            test_font("abcooperate", 600),
            0,
            FontDescriptor::new("Primary"),
        )
        .expect("primary font");
    let fallback = registry
        .register(test_font(" -", 700), 0, FontDescriptor::new("Fallback"))
        .expect("fallback font");
    let mut style = TextStyle::new("Primary", FONT_SIZE);
    style.fallback_fonts.push(fallback.id);
    let mut engine = TextLayoutEngine::new(registry, limits);

    let tab = engine
        .layout(
            &RichTextParagraph::plain("a\tb", style.clone()),
            LayoutConstraints::UNBOUNDED,
        )
        .expect("tab layout");
    assert!(tab.glyph_runs.iter().any(|run| {
        run.font_id == fallback.id && run.glyphs.iter().any(|glyph| glyph.cluster == 1)
    }));

    let soft = engine
        .layout(
            &RichTextParagraph::plain("co\u{00ad}operate", style),
            LayoutConstraints {
                max_width: Some(LayoutUnit::from_raw(2_000)),
            },
        )
        .expect("soft-hyphen layout");
    assert!(soft.glyph_runs[soft.lines[0].glyph_runs.clone()]
        .iter()
        .any(|run| {
            run.font_id == fallback.id && run.glyphs.iter().any(|glyph| glyph.cluster == 2)
        }));
    assert!(soft.diagnostics.iter().any(|diagnostic| {
        diagnostic.text_range == (2..4)
            && diagnostic.resolved_font == fallback.id
            && diagnostic.reason == FontSubstitutionReason::GlyphCoverageFallback
    }));
    assert_ne!(primary.id, fallback.id);
}

#[test]
fn style_boundaries_inside_a_grapheme_are_not_silently_dropped() {
    let text = "a\u{0301}";
    let limits = LayoutLimits::default();
    let mut registry = FontRegistry::new(limits);
    registry
        .register(test_font(text, 600), 0, FontDescriptor::new("Fixture"))
        .expect("font");
    let normal = TextStyle::new("Fixture", FONT_SIZE);
    let mut accent = normal.clone();
    accent.paint.rgba = 0xff00_00ff;
    let paragraph = RichTextParagraph {
        text: text.into(),
        default_style: normal,
        spans: vec![TextSpan {
            range: 1..3,
            style: accent,
        }],
        paragraph_style: ParagraphStyle::default(),
    };
    let mut engine = TextLayoutEngine::new(registry, limits);
    let layout = engine
        .layout(&paragraph, LayoutConstraints::UNBOUNDED)
        .expect("grapheme style layout");
    assert!(layout
        .glyph_runs
        .iter()
        .any(|run| run.text_range == (1..3) && run.paint.rgba == 0xff00_00ff));
}

#[test]
fn cache_is_byte_and_entry_bounded() {
    let limits = LayoutLimits {
        max_layout_cache_entries: 2,
        max_layout_cache_bytes: 1_000_000,
        ..LayoutLimits::default()
    };
    let mut registry = FontRegistry::new(limits);
    registry
        .register(
            test_font("one two three", 600),
            0,
            FontDescriptor::new("Fixture"),
        )
        .expect("font");
    let style = TextStyle::new("Fixture", FONT_SIZE);
    let mut engine = TextLayoutEngine::new(registry, limits);
    let one = RichTextParagraph::plain("one", style.clone());
    let first = engine
        .layout(&one, LayoutConstraints::UNBOUNDED)
        .expect("first");
    let cached = engine
        .layout(&one, LayoutConstraints::UNBOUNDED)
        .expect("cached");
    assert!(Arc::ptr_eq(&first, &cached));
    engine
        .layout(
            &RichTextParagraph::plain("two", style.clone()),
            LayoutConstraints::UNBOUNDED,
        )
        .expect("second");
    engine
        .layout(
            &RichTextParagraph::plain("three", style),
            LayoutConstraints::UNBOUNDED,
        )
        .expect("third");
    let stats = engine.cache_stats();
    assert_eq!(stats.entries, 2);
    assert!(stats.estimated_bytes <= limits.max_layout_cache_bytes);
    assert_eq!(stats.hits, 1);
    assert!(stats.evictions >= 1);
}

#[test]
fn tab_width_is_part_of_the_layout_cache_identity() {
    let limits = LayoutLimits::default();
    let mut registry = FontRegistry::new(limits);
    registry
        .register(test_font("a b", 600), 0, FontDescriptor::new("Fixture"))
        .expect("font");
    let style = TextStyle::new("Fixture", FONT_SIZE);
    let mut four = RichTextParagraph::plain("a\tb", style.clone());
    four.paragraph_style.tab_width_spaces = 4;
    let mut eight = RichTextParagraph::plain("a\tb", style);
    eight.paragraph_style.tab_width_spaces = 8;
    let mut engine = TextLayoutEngine::new(registry, limits);
    let four = engine
        .layout(&four, LayoutConstraints::UNBOUNDED)
        .expect("four-space tab");
    let eight = engine
        .layout(&eight, LayoutConstraints::UNBOUNDED)
        .expect("eight-space tab");
    assert_ne!(four.fingerprint, eight.fingerprint);
    assert!(eight.lines[0].advance.raw() > four.lines[0].advance.raw());
    assert_eq!(engine.cache_stats().misses, 2);
}

#[test]
fn retained_tile_protocol_is_canonical_bounded_and_corruption_detecting() {
    let text = "Native ⇄ Wasm שלום 漢字 👩‍🚀";
    let limits = LayoutLimits::default();
    let mut registry = FontRegistry::new(limits);
    registry
        .register(test_font(text, 600), 0, FontDescriptor::new("Fixture"))
        .expect("font");
    let paragraph = RichTextParagraph::plain(text, TextStyle::new("Fixture", FONT_SIZE));
    let mut engine = TextLayoutEngine::new(registry, limits);
    let layout = engine
        .layout(&paragraph, LayoutConstraints::UNBOUNDED)
        .expect("layout");
    let scene = RetainedRenderScene::from_paragraph(
        RenderSceneId::from_bytes(*b"layout-vector-01"),
        7,
        LayoutUnit::ZERO,
        LayoutUnit::ZERO,
        &layout,
        LayoutUnit::from_raw(32_768),
        RetainedRenderLimits::default(),
    )
    .expect("retained scene");
    assert!(scene.command_count() > 0);
    let tile = scene.tile(RenderTileKey { x: 0, y: 0 }).expect("tile");
    let encoded = encode_render_tile(&tile, RetainedRenderLimits::default()).expect("encode");
    let decoded = decode_render_tile(&encoded, RetainedRenderLimits::default()).expect("decode");
    assert_eq!(decoded, tile);
    assert_eq!(
        hex(&Sha256::digest(&encoded)),
        "870df895ca539e921e921d1416bd42835e7c04b95024f97db5469658c5b2ec5d"
    );
    assert_eq!(
        encode_render_tile(
            &tile,
            RetainedRenderLimits {
                max_encoded_tile_bytes: encoded.len(),
                ..RetainedRenderLimits::default()
            },
        )
        .expect("exact encoded tile limit"),
        encoded
    );
    assert_eq!(
        encode_render_tile(
            &tile,
            RetainedRenderLimits {
                max_encoded_tile_bytes: encoded.len() - 1,
                ..RetainedRenderLimits::default()
            },
        ),
        Err(RenderSceneError::LimitExceeded("encoded tile bytes"))
    );
    let mut invalid_glyph = tile.clone();
    let RenderCommand::GlyphRun { glyphs, .. } = &mut invalid_glyph.commands[0] else {
        panic!("glyph command")
    };
    glyphs[0].glyph_id = u32::MAX;
    assert_eq!(
        encode_render_tile(&invalid_glyph, RetainedRenderLimits::default()),
        Err(RenderSceneError::Invalid("glyph metrics or cluster range"))
    );

    let mut overflowed_layout = (*layout).clone();
    overflowed_layout.glyph_runs[0].glyphs[0].x = LayoutUnit::from_raw(i32::MAX);
    overflowed_layout.glyph_runs[0].glyphs[0].ink_bounds.x_max = LayoutUnit::from_raw(1);
    assert!(matches!(
        RetainedRenderScene::from_paragraph(
            RenderSceneId::from_bytes(*b"overflow-vector!"),
            8,
            LayoutUnit::ZERO,
            LayoutUnit::ZERO,
            &overflowed_layout,
            LayoutUnit::from_raw(32_768),
            RetainedRenderLimits::default(),
        ),
        Err(RenderSceneError::CoordinateOverflow)
    ));

    let mut corrupted = encoded;
    let index = corrupted.len() / 2;
    corrupted[index] ^= 1;
    assert_eq!(
        decode_render_tile(&corrupted, RetainedRenderLimits::default()),
        Err(RenderSceneError::ChecksumMismatch)
    );
}

#[test]
fn retained_scene_diff_invalidates_only_changed_tiles() {
    let limits = LayoutLimits::default();
    let mut registry = FontRegistry::new(limits);
    registry
        .register(
            test_font("before after", 600),
            0,
            FontDescriptor::new("Fixture"),
        )
        .expect("font");
    let style = TextStyle::new("Fixture", FONT_SIZE);
    let mut engine = TextLayoutEngine::new(registry, limits);
    let before = engine
        .layout(
            &RichTextParagraph::plain("before", style.clone()),
            LayoutConstraints::UNBOUNDED,
        )
        .expect("before");
    let after = engine
        .layout(
            &RichTextParagraph::plain("after", style),
            LayoutConstraints::UNBOUNDED,
        )
        .expect("after");
    let scene_id = RenderSceneId::from_bytes(*b"diff-scene-id-01");
    let old = RetainedRenderScene::from_paragraph(
        scene_id,
        10,
        LayoutUnit::ZERO,
        LayoutUnit::ZERO,
        &before,
        LayoutUnit::from_raw(32_768),
        RetainedRenderLimits::default(),
    )
    .expect("old scene");
    let new = RetainedRenderScene::from_paragraph(
        scene_id,
        11,
        LayoutUnit::ZERO,
        LayoutUnit::ZERO,
        &after,
        LayoutUnit::from_raw(32_768),
        RetainedRenderLimits::default(),
    )
    .expect("new scene");
    let patch = old.diff(&new).expect("diff");
    assert_eq!(patch.base_revision, 10);
    assert_eq!(patch.revision, 11);
    assert!(!patch.removed.is_empty());
    assert!(!patch.upserted.is_empty());
    assert_eq!(patch.invalidated_tiles, vec![RenderTileKey { x: 0, y: 0 }]);
    let encoded = encode_render_patch(&patch, RetainedRenderLimits::default()).expect("encode");
    let decoded = decode_render_patch(&encoded, RetainedRenderLimits::default()).expect("decode");
    assert_eq!(decoded, patch);
    assert_eq!(
        hex(&Sha256::digest(&encoded)),
        "4806c194077308734fc2f5d302bbe631b588d247cd6857a7c8840bb2b1c71c1c"
    );
    assert_eq!(
        encode_render_patch(
            &patch,
            RetainedRenderLimits {
                max_encoded_patch_bytes: encoded.len(),
                ..RetainedRenderLimits::default()
            },
        )
        .expect("exact encoded patch limit"),
        encoded
    );
    assert_eq!(
        encode_render_patch(
            &patch,
            RetainedRenderLimits {
                max_encoded_patch_bytes: encoded.len() - 1,
                ..RetainedRenderLimits::default()
            },
        ),
        Err(RenderSceneError::LimitExceeded("encoded patch bytes"))
    );

    let mut corrupted = encoded;
    let index = corrupted.len() / 2;
    corrupted[index] ^= 1;
    assert_eq!(
        decode_render_patch(&corrupted, RetainedRenderLimits::default()),
        Err(RenderSceneError::ChecksumMismatch)
    );
}

#[test]
fn retained_scene_diff_invalidates_same_identity_command_updates() {
    let limits = LayoutLimits::default();
    let mut registry = FontRegistry::new(limits);
    registry
        .register(test_font("AB", 600), 0, FontDescriptor::new("Fixture"))
        .expect("font");
    let style = TextStyle::new("Fixture", FONT_SIZE);
    let mut engine = TextLayoutEngine::new(registry, limits);
    let before = engine
        .layout(
            &RichTextParagraph::plain("A", style.clone()),
            LayoutConstraints::UNBOUNDED,
        )
        .expect("before");
    let after = engine
        .layout(
            &RichTextParagraph::plain("B", style),
            LayoutConstraints::UNBOUNDED,
        )
        .expect("after");
    let scene_id = RenderSceneId::from_bytes(*b"stable-node-id01");
    let old = RetainedRenderScene::from_paragraph(
        scene_id,
        1,
        LayoutUnit::ZERO,
        LayoutUnit::ZERO,
        &before,
        LayoutUnit::from_raw(32_768),
        RetainedRenderLimits::default(),
    )
    .expect("old scene");
    let new = RetainedRenderScene::from_paragraph(
        scene_id,
        2,
        LayoutUnit::ZERO,
        LayoutUnit::ZERO,
        &after,
        LayoutUnit::from_raw(32_768),
        RetainedRenderLimits::default(),
    )
    .expect("new scene");
    let patch = old.diff(&new).expect("diff");
    assert!(patch.removed.is_empty());
    assert_eq!(patch.upserted.len(), 1);
    assert_eq!(patch.invalidated_tiles, vec![RenderTileKey { x: 0, y: 0 }]);
}

#[test]
fn retained_patch_rejects_noncanonical_and_over_budget_collections() {
    let id = RenderCommandId::new(7).expect("id");
    let duplicate = RenderPatch {
        base_revision: 1,
        revision: 2,
        removed: vec![id, id],
        upserted: Vec::new(),
        invalidated_tiles: Vec::new(),
    };
    assert!(matches!(
        encode_render_patch(&duplicate, RetainedRenderLimits::default()),
        Err(RenderSceneError::NonCanonical(_))
    ));

    let over_budget = RenderPatch {
        base_revision: 1,
        revision: 2,
        removed: vec![id],
        upserted: Vec::new(),
        invalidated_tiles: vec![RenderTileKey { x: 0, y: 0 }],
    };
    let limits = RetainedRenderLimits {
        max_tile_memberships: 0,
        ..RetainedRenderLimits::default()
    };
    assert_eq!(
        encode_render_patch(&over_budget, limits),
        Err(RenderSceneError::LimitExceeded("tile memberships"))
    );

    let backwards = RenderPatch {
        base_revision: 2,
        revision: 2,
        removed: Vec::new(),
        upserted: Vec::new(),
        invalidated_tiles: Vec::new(),
    };
    assert!(matches!(
        encode_render_patch(&backwards, RetainedRenderLimits::default()),
        Err(RenderSceneError::Invalid(_))
    ));
}

#[test]
fn validates_utf8_spans_and_resource_limits_before_shaping() {
    let limits = LayoutLimits {
        max_font_asset_bytes: 16,
        ..LayoutLimits::default()
    };
    let mut registry = FontRegistry::new(limits);
    assert!(matches!(
        registry.register(test_font("A", 600), 0, FontDescriptor::new("Too Large")),
        Err(LayoutError::LimitExceeded("font asset bytes"))
    ));

    let limits = LayoutLimits::default();
    let mut registry = FontRegistry::new(limits);
    registry
        .register(test_font("é", 600), 0, FontDescriptor::new("Fixture"))
        .expect("font");
    let style = TextStyle::new("Fixture", FONT_SIZE);
    let paragraph = RichTextParagraph {
        text: "é".into(),
        default_style: style.clone(),
        spans: vec![TextSpan { range: 1..2, style }],
        paragraph_style: ParagraphStyle::default(),
    };
    let mut engine = TextLayoutEngine::new(registry, limits);
    assert!(matches!(
        engine.layout(&paragraph, LayoutConstraints::UNBOUNDED),
        Err(LayoutError::InvalidSpan(_))
    ));
}

#[test]
fn failed_layout_is_atomic_and_deterministic_work_is_bounded() {
    let limits = LayoutLimits {
        max_work_units: 30,
        ..LayoutLimits::default()
    };
    let mut registry = FontRegistry::new(limits);
    registry
        .register(test_font("abc", 600), 0, FontDescriptor::new("Fixture"))
        .expect("font");
    let mut engine = TextLayoutEngine::new(registry, limits);
    let before_cache = engine.cache_stats();
    let before_coverage = engine.fonts().coverage_entry_count();
    assert_eq!(
        engine.layout(
            &RichTextParagraph::plain("abc", TextStyle::new("Fixture", FONT_SIZE)),
            LayoutConstraints::UNBOUNDED,
        ),
        Err(LayoutError::LimitExceeded("layout work units"))
    );
    assert_eq!(engine.cache_stats(), before_cache);
    assert_eq!(engine.fonts().coverage_entry_count(), before_coverage);

    let limits = LayoutLimits {
        max_graphemes: 2,
        ..LayoutLimits::default()
    };
    let mut registry = FontRegistry::new(limits);
    registry
        .register(
            test_font("a\u{301}b", 600),
            0,
            FontDescriptor::new("Fixture"),
        )
        .expect("font");
    let mut engine = TextLayoutEngine::new(registry, limits);
    let style = TextStyle::new("Fixture", FONT_SIZE);
    let at_limit = engine
        .layout(
            &RichTextParagraph::plain("a\u{301}b", style.clone()),
            LayoutConstraints::UNBOUNDED,
        )
        .expect("two graphemes");
    assert_eq!(at_limit.work.graphemes, 2);
    assert_eq!(
        engine.layout(
            &RichTextParagraph::plain("a\u{301}bc", style),
            LayoutConstraints::UNBOUNDED,
        ),
        Err(LayoutError::LimitExceeded("text graphemes"))
    );

    let limits = LayoutLimits {
        max_lines: 1,
        ..LayoutLimits::default()
    };
    let mut registry = FontRegistry::new(limits);
    registry
        .register(test_font("ab", 600), 0, FontDescriptor::new("Fixture"))
        .expect("font");
    let mut engine = TextLayoutEngine::new(registry, limits);
    let style = TextStyle::new("Fixture", FONT_SIZE);
    engine
        .layout(
            &RichTextParagraph::plain("a", style.clone()),
            LayoutConstraints::UNBOUNDED,
        )
        .expect("one line");
    let before = engine.cache_stats();
    assert_eq!(
        engine.layout(
            &RichTextParagraph::plain("a\nb", style),
            LayoutConstraints::UNBOUNDED,
        ),
        Err(LayoutError::LimitExceeded("layout lines"))
    );
    assert_eq!(engine.cache_stats(), before);
}

#[test]
fn large_layout_has_linear_retained_memory_and_cache_reuse() {
    let text = "OpenGeni layout 漢字 العربية 👩‍🚀 ".repeat(1_000);
    let limits = LayoutLimits::default();
    let mut registry = FontRegistry::new(limits);
    registry
        .register(test_font(&text, 600), 0, FontDescriptor::new("Fixture"))
        .expect("font");
    let paragraph = RichTextParagraph::plain(text.clone(), TextStyle::new("Fixture", FONT_SIZE));
    let mut engine = TextLayoutEngine::new(registry, limits);
    let layout = engine
        .layout(
            &paragraph,
            LayoutConstraints {
                max_width: Some(LayoutUnit::from_raw(48_000)),
            },
        )
        .expect("large layout");
    let glyphs = layout
        .glyph_runs
        .iter()
        .map(|run| run.glyphs.len())
        .sum::<usize>();
    assert!(glyphs <= text.chars().count() * 2);
    assert!(layout.estimated_bytes() < 32 * 1024 * 1024);
    let again = engine
        .layout(
            &paragraph,
            LayoutConstraints {
                max_width: Some(LayoutUnit::from_raw(48_000)),
            },
        )
        .expect("cache reuse");
    assert!(Arc::ptr_eq(&layout, &again));
    assert_eq!(engine.cache_stats().hits, 1);
}

pub(crate) fn test_font(characters: &str, advance: u16) -> Vec<u8> {
    let codepoints = characters
        .chars()
        .filter(|character| !matches!(character, '\n' | '\r' | '\u{200d}'))
        .map(u32::from)
        .collect::<BTreeSet<_>>();
    let glyph_count = u16::try_from(codepoints.len() + 1).expect("fixture glyph count");

    let mut cmap = Vec::new();
    be_u16(&mut cmap, 0);
    be_u16(&mut cmap, 1);
    be_u16(&mut cmap, 3);
    be_u16(&mut cmap, 10);
    be_u32(&mut cmap, 12);
    be_u16(&mut cmap, 12);
    be_u16(&mut cmap, 0);
    let cmap_length = 16 + codepoints.len() * 12;
    be_u32(&mut cmap, cmap_length as u32);
    be_u32(&mut cmap, 0);
    be_u32(&mut cmap, codepoints.len() as u32);
    for (index, codepoint) in codepoints.iter().copied().enumerate() {
        be_u32(&mut cmap, codepoint);
        be_u32(&mut cmap, codepoint);
        be_u32(&mut cmap, (index + 1) as u32);
    }

    let mut head = vec![0u8; 54];
    put_u32(&mut head, 0, 0x0001_0000);
    put_u32(&mut head, 4, 0x0001_0000);
    put_u32(&mut head, 12, 0x5f0f_3cf5);
    put_u16(&mut head, 18, 1_000);
    put_i16(&mut head, 36, 0);
    put_i16(&mut head, 38, -200);
    put_i16(&mut head, 40, advance as i16);
    put_i16(&mut head, 42, 800);
    put_u16(&mut head, 46, 8);
    put_i16(&mut head, 48, 2);

    let mut hhea = vec![0u8; 36];
    put_u32(&mut hhea, 0, 0x0001_0000);
    put_i16(&mut hhea, 4, 800);
    put_i16(&mut hhea, 6, -200);
    put_i16(&mut hhea, 8, 200);
    put_u16(&mut hhea, 10, advance);
    put_i16(&mut hhea, 16, advance as i16);
    put_i16(&mut hhea, 18, 1);
    put_u16(&mut hhea, 34, glyph_count);

    let mut hmtx = Vec::with_capacity(glyph_count as usize * 4);
    for _ in 0..glyph_count {
        be_u16(&mut hmtx, advance);
        be_i16(&mut hmtx, 0);
    }
    let mut maxp = Vec::with_capacity(6);
    be_u32(&mut maxp, 0x0000_5000);
    be_u16(&mut maxp, glyph_count);

    let tables = vec![
        (*b"cmap", cmap),
        (*b"head", head),
        (*b"hhea", hhea),
        (*b"hmtx", hmtx),
        (*b"maxp", maxp),
    ];
    let table_count = tables.len() as u16;
    let mut font = Vec::new();
    be_u32(&mut font, 0x0001_0000);
    be_u16(&mut font, table_count);
    be_u16(&mut font, 64);
    be_u16(&mut font, 2);
    be_u16(&mut font, table_count * 16 - 64);
    let directory_start = font.len();
    font.resize(directory_start + tables.len() * 16, 0);
    let mut offset = font.len();
    for (index, (tag, table)) in tables.into_iter().enumerate() {
        while offset % 4 != 0 {
            font.push(0);
            offset += 1;
        }
        let entry = directory_start + index * 16;
        font[entry..entry + 4].copy_from_slice(&tag);
        put_u32(&mut font, entry + 4, checksum(&table));
        put_u32(&mut font, entry + 8, offset as u32);
        put_u32(&mut font, entry + 12, table.len() as u32);
        font.extend_from_slice(&table);
        offset += table.len();
    }
    font
}

fn checksum(bytes: &[u8]) -> u32 {
    bytes.chunks(4).fold(0u32, |sum, chunk| {
        let mut word = [0u8; 4];
        word[..chunk.len()].copy_from_slice(chunk);
        sum.wrapping_add(u32::from_be_bytes(word))
    })
}

fn be_u16(output: &mut Vec<u8>, value: u16) {
    output.extend_from_slice(&value.to_be_bytes());
}

fn be_i16(output: &mut Vec<u8>, value: i16) {
    output.extend_from_slice(&value.to_be_bytes());
}

fn be_u32(output: &mut Vec<u8>, value: u32) {
    output.extend_from_slice(&value.to_be_bytes());
}

fn put_u16(output: &mut [u8], offset: usize, value: u16) {
    output[offset..offset + 2].copy_from_slice(&value.to_be_bytes());
}

fn put_i16(output: &mut [u8], offset: usize, value: i16) {
    output[offset..offset + 2].copy_from_slice(&value.to_be_bytes());
}

fn put_u32(output: &mut [u8], offset: usize, value: u32) {
    output[offset..offset + 4].copy_from_slice(&value.to_be_bytes());
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(char::from(DIGITS[(byte >> 4) as usize]));
        output.push(char::from(DIGITS[(byte & 0x0f) as usize]));
    }
    output
}
