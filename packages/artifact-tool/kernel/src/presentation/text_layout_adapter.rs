use core::fmt;
use std::collections::BTreeSet;
use std::sync::Arc;

use crate::text_layout::{
    FontStyle, LayoutConstraints, LayoutError, LayoutUnit, ParagraphLayout, ParagraphStyle,
    RichTextParagraph, TextAlignment, TextLayoutEngine, TextPaint, TextSpan,
    TextStyle as LayoutTextStyle,
};

use super::{
    HorizontalAlignment, PresentationError, PresentationTextStyle, Rect, RichText, Shape,
    TextParagraph, VerticalAlignment, EMU_PER_CSS_PIXEL,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PresentationParagraphPlacement {
    pub paragraph_index: usize,
    pub x: LayoutUnit,
    pub y: LayoutUnit,
    pub layout: Arc<ParagraphLayout>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PresentationTextFrameLayout {
    pub frame_x: LayoutUnit,
    pub frame_y: LayoutUnit,
    pub frame_width: LayoutUnit,
    pub frame_height: LayoutUnit,
    pub content_height: LayoutUnit,
    pub overflowed: bool,
    pub retained_layout_bytes: usize,
    pub paragraphs: Vec<PresentationParagraphPlacement>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PresentationTextFrameLimits {
    pub max_paragraphs: usize,
    pub max_retained_layout_bytes: usize,
}

impl Default for PresentationTextFrameLimits {
    fn default() -> Self {
        Self {
            max_paragraphs: 100_000,
            max_retained_layout_bytes: 256 * 1024 * 1024,
        }
    }
}

impl RichText {
    /// Converts and lays out one semantic presentation paragraph with the
    /// shared deterministic shaper. Font resolution remains explicit in the
    /// supplied engine; this adapter never consults platform fonts.
    pub fn layout_paragraph(
        &self,
        paragraph_index: usize,
        engine: &mut TextLayoutEngine,
        constraints: LayoutConstraints,
    ) -> Result<Arc<ParagraphLayout>, PresentationTextLayoutError> {
        let paragraph = self.layout_input(paragraph_index)?;
        engine
            .layout(&paragraph, constraints)
            .map_err(PresentationTextLayoutError::Layout)
    }

    /// Produces the exact shared-layout input, useful for deterministic
    /// conformance vectors without requiring a font registry.
    pub fn layout_input(
        &self,
        paragraph_index: usize,
    ) -> Result<RichTextParagraph, PresentationTextLayoutError> {
        let paragraph = self
            .paragraphs
            .get(paragraph_index)
            .ok_or(PresentationTextLayoutError::ParagraphOutOfRange)?;
        paragraph_to_layout(paragraph)
    }

    /// Lays out every paragraph into one fixed presentation frame. The model
    /// has no implicit text margins or auto-fit metadata, so this method uses
    /// the exact frame bounds and reports overflow rather than scaling text.
    pub fn layout_frame(
        &self,
        frame: Rect,
        engine: &mut TextLayoutEngine,
    ) -> Result<PresentationTextFrameLayout, PresentationTextLayoutError> {
        self.layout_frame_with_limits(frame, engine, PresentationTextFrameLimits::default())
    }

    pub fn layout_frame_with_limits(
        &self,
        frame: Rect,
        engine: &mut TextLayoutEngine,
        limits: PresentationTextFrameLimits,
    ) -> Result<PresentationTextFrameLayout, PresentationTextLayoutError> {
        if limits.max_paragraphs == 0 || limits.max_retained_layout_bytes == 0 {
            return Err(PresentationTextLayoutError::LimitExceeded(
                "text frame limits must be positive",
            ));
        }
        if self.paragraphs.len() > limits.max_paragraphs {
            return Err(PresentationTextLayoutError::LimitExceeded(
                "text frame paragraphs",
            ));
        }
        let frame_x = emu_to_layout(frame.x.raw())?;
        let frame_y = emu_to_layout(frame.y.raw())?;
        let frame_width = emu_to_layout(frame.width.raw())?;
        let frame_height = emu_to_layout(frame.height.raw())?;
        if frame_width.raw() <= 0 || frame_height.raw() <= 0 {
            return Err(PresentationError::InvalidGeometry(
                "text frame must have positive dimensions",
            )
            .into());
        }
        let mut layouts = Vec::with_capacity(self.paragraphs.len());
        let mut retained_layouts = BTreeSet::new();
        let mut retained_layout_bytes = 0usize;
        let mut content_height = LayoutUnit::ZERO;
        for index in 0..self.paragraphs.len() {
            let layout = self.layout_paragraph(
                index,
                engine,
                LayoutConstraints {
                    max_width: Some(frame_width),
                },
            )?;
            if retained_layouts.insert(layout.fingerprint) {
                retained_layout_bytes = retained_layout_bytes
                    .checked_add(layout.estimated_bytes())
                    .ok_or(PresentationTextLayoutError::LimitExceeded(
                        "retained text frame layout bytes",
                    ))?;
                if retained_layout_bytes > limits.max_retained_layout_bytes {
                    return Err(PresentationTextLayoutError::LimitExceeded(
                        "retained text frame layout bytes",
                    ));
                }
            }
            content_height = content_height.checked_add(layout.height)?;
            layouts.push(layout);
        }
        let overflowed = content_height.raw() > frame_height.raw();
        let remaining = LayoutUnit::from_raw(
            frame_height
                .raw()
                .saturating_sub(content_height.raw())
                .max(0),
        );
        let vertical_offset = if overflowed {
            LayoutUnit::ZERO
        } else {
            match self.vertical_alignment {
                VerticalAlignment::Top => LayoutUnit::ZERO,
                VerticalAlignment::Middle => LayoutUnit::from_raw(remaining.raw() / 2),
                VerticalAlignment::Bottom => remaining,
            }
        };
        let mut y = frame_y.checked_add(vertical_offset)?;
        let mut paragraphs = Vec::with_capacity(layouts.len());
        for (paragraph_index, layout) in layouts.into_iter().enumerate() {
            paragraphs.push(PresentationParagraphPlacement {
                paragraph_index,
                x: frame_x,
                y,
                layout: Arc::clone(&layout),
            });
            y = y.checked_add(layout.height)?;
        }
        Ok(PresentationTextFrameLayout {
            frame_x,
            frame_y,
            frame_width,
            frame_height,
            content_height,
            overflowed,
            retained_layout_bytes,
            paragraphs,
        })
    }
}

impl Shape {
    /// Returns `None` for a shape without text; otherwise lays out its text in
    /// the caller-supplied scene-node bounds.
    pub fn layout_text_frame(
        &self,
        frame: Rect,
        engine: &mut TextLayoutEngine,
    ) -> Result<Option<PresentationTextFrameLayout>, PresentationTextLayoutError> {
        self.text
            .as_ref()
            .map(|text| text.layout_frame(frame, engine))
            .transpose()
    }
}

fn emu_to_layout(value: i64) -> Result<LayoutUnit, PresentationTextLayoutError> {
    let numerator = value
        .checked_mul(64)
        .ok_or(PresentationError::InvalidGeometry(
            "text coordinate overflow",
        ))?;
    let half = EMU_PER_CSS_PIXEL / 2;
    let rounded = if numerator >= 0 {
        numerator
            .checked_add(half)
            .ok_or(PresentationError::InvalidGeometry(
                "text coordinate overflow",
            ))?
            / EMU_PER_CSS_PIXEL
    } else {
        numerator
            .checked_sub(half)
            .ok_or(PresentationError::InvalidGeometry(
                "text coordinate overflow",
            ))?
            / EMU_PER_CSS_PIXEL
    };
    Ok(LayoutUnit::from_raw(i32::try_from(rounded).map_err(
        |_| PresentationError::InvalidGeometry("text coordinate overflow"),
    )?))
}

fn paragraph_to_layout(
    paragraph: &TextParagraph,
) -> Result<RichTextParagraph, PresentationTextLayoutError> {
    let default_style = paragraph
        .runs
        .first()
        .map(|run| presentation_style_to_layout(&run.style))
        .transpose()?
        .unwrap_or_else(|| LayoutTextStyle::new("Arial", LayoutUnit::from_raw(1_536)));
    let mut text = String::new();
    let mut spans = Vec::new();
    for run in &paragraph.runs {
        let start = text.len();
        text.push_str(&run.text);
        let end = text.len();
        let style = presentation_style_to_layout(&run.style)?;
        if start != end && style != default_style {
            spans.push(TextSpan {
                range: start..end,
                style,
            });
        }
    }
    let alignment = match paragraph.alignment {
        HorizontalAlignment::Left => TextAlignment::Left,
        HorizontalAlignment::Center => TextAlignment::Center,
        HorizontalAlignment::Right => TextAlignment::Right,
        HorizontalAlignment::Justify => {
            return Err(PresentationTextLayoutError::Unsupported(
                "justified presentation text",
            ));
        }
    };
    Ok(RichTextParagraph {
        text,
        default_style,
        spans,
        paragraph_style: ParagraphStyle {
            alignment,
            ..ParagraphStyle::default()
        },
    })
}

fn presentation_style_to_layout(
    style: &PresentationTextStyle,
) -> Result<LayoutTextStyle, PresentationTextLayoutError> {
    // 1 point = 4/3 CSS pixels; layout uses 1/64 CSS pixel. The semantic
    // presentation model stores 1/100 point, so raw = centipoints * 256 / 300.
    let numerator = u64::from(style.font_size_centipoints)
        .checked_mul(256)
        .ok_or(PresentationError::InvalidStyle("font size overflow"))?;
    let rounded = numerator
        .checked_add(150)
        .ok_or(PresentationError::InvalidStyle("font size overflow"))?
        / 300;
    let raw = i32::try_from(rounded)
        .map_err(|_| PresentationError::InvalidStyle("font size overflow"))?;
    if raw <= 0 {
        return Err(PresentationError::InvalidStyle("font size").into());
    }
    let mut output = LayoutTextStyle::new(style.font_family.clone(), LayoutUnit::from_raw(raw));
    output.weight = if style.bold { 700 } else { 400 };
    output.font_style = if style.italic {
        FontStyle::Italic
    } else {
        FontStyle::Normal
    };
    output.language.clone_from(&style.language);
    output.paint = TextPaint {
        rgba: style.color.0,
        underline: style.underline,
        strike: false,
    };
    Ok(output)
}

#[derive(Debug)]
pub enum PresentationTextLayoutError {
    ParagraphOutOfRange,
    Unsupported(&'static str),
    LimitExceeded(&'static str),
    Presentation(PresentationError),
    Layout(LayoutError),
}

impl fmt::Display for PresentationTextLayoutError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ParagraphOutOfRange => {
                formatter.write_str("presentation paragraph is out of range")
            }
            Self::Unsupported(feature) => {
                write!(formatter, "unsupported presentation text layout: {feature}")
            }
            Self::LimitExceeded(limit) => {
                write!(formatter, "presentation text layout limit: {limit}")
            }
            Self::Presentation(error) => error.fmt(formatter),
            Self::Layout(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for PresentationTextLayoutError {}

impl From<PresentationError> for PresentationTextLayoutError {
    fn from(error: PresentationError) -> Self {
        Self::Presentation(error)
    }
}

impl From<LayoutError> for PresentationTextLayoutError {
    fn from(error: LayoutError) -> Self {
        Self::Layout(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::presentation::{Color, HorizontalAlignment, PresentationTextStyle, TextRun};
    use crate::text_layout::{tests::test_font, FontDescriptor, FontRegistry, LayoutLimits};

    #[test]
    fn rich_text_conversion_preserves_utf8_ranges_and_integral_units() {
        let regular = PresentationTextStyle::default();
        let mut bold = regular.clone();
        bold.bold = true;
        bold.color = Color(0x1234_56ff);
        let text = RichText {
            paragraphs: vec![TextParagraph {
                runs: vec![
                    TextRun {
                        text: "Hé".to_owned(),
                        style: regular,
                    },
                    TextRun {
                        text: "llo".to_owned(),
                        style: bold,
                    },
                ],
                alignment: HorizontalAlignment::Center,
            }],
            vertical_alignment: super::super::VerticalAlignment::Top,
        };
        let layout = text.layout_input(0).expect("layout input");
        assert_eq!(layout.text, "Héllo");
        assert_eq!(layout.spans[0].range, 3..6);
        assert_eq!(layout.spans[0].style.weight, 700);
        assert_eq!(layout.default_style.font_size.raw(), 1_536);
        assert_eq!(layout.paragraph_style.alignment, TextAlignment::Center);
    }

    #[test]
    fn unsupported_justification_fails_closed() {
        let text = RichText {
            paragraphs: vec![TextParagraph {
                runs: vec![],
                alignment: HorizontalAlignment::Justify,
            }],
            vertical_alignment: super::super::VerticalAlignment::Top,
        };
        assert!(matches!(
            text.layout_input(0),
            Err(PresentationTextLayoutError::Unsupported(_))
        ));
    }

    #[test]
    fn frame_layout_uses_shared_geometry_and_reports_overflow() {
        let text = RichText {
            paragraphs: vec![
                TextParagraph {
                    runs: vec![TextRun {
                        text: "first".into(),
                        style: PresentationTextStyle {
                            font_family: "Fixture".into(),
                            ..PresentationTextStyle::default()
                        },
                    }],
                    alignment: HorizontalAlignment::Left,
                },
                TextParagraph {
                    runs: vec![TextRun {
                        text: "second".into(),
                        style: PresentationTextStyle {
                            font_family: "Fixture".into(),
                            ..PresentationTextStyle::default()
                        },
                    }],
                    alignment: HorizontalAlignment::Left,
                },
            ],
            vertical_alignment: VerticalAlignment::Bottom,
        };
        let limits = LayoutLimits::default();
        let mut fonts = FontRegistry::new(limits);
        fonts
            .register(
                test_font("first second", 600),
                0,
                FontDescriptor::new("Fixture"),
            )
            .expect("font");
        let mut engine = TextLayoutEngine::new(fonts, limits);
        let roomy = text
            .layout_frame(
                Rect::new(9_525, 19_050, 952_500, 952_500).expect("frame"),
                &mut engine,
            )
            .expect("roomy layout");
        assert!(!roomy.overflowed);
        assert!(roomy.retained_layout_bytes > 0);
        assert_eq!(roomy.frame_x.raw(), 64);
        assert_eq!(roomy.frame_y.raw(), 128);
        assert!(roomy.paragraphs[0].y.raw() > roomy.frame_y.raw());
        assert_eq!(roomy.paragraphs[0].paragraph_index, 0);
        assert_eq!(roomy.paragraphs[1].paragraph_index, 1);
        assert!(matches!(
            text.layout_frame_with_limits(
                Rect::new(9_525, 19_050, 952_500, 952_500).expect("frame"),
                &mut engine,
                PresentationTextFrameLimits {
                    max_retained_layout_bytes: roomy.retained_layout_bytes - 1,
                    ..PresentationTextFrameLimits::default()
                },
            ),
            Err(PresentationTextLayoutError::LimitExceeded(
                "retained text frame layout bytes"
            ))
        ));

        let tight = text
            .layout_frame(Rect::new(0, 0, 952_500, 9_525).expect("frame"), &mut engine)
            .expect("tight layout");
        assert!(tight.overflowed);
        assert_eq!(tight.paragraphs[0].y, LayoutUnit::ZERO);
    }
}
