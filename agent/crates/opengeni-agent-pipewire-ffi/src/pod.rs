//! The few SPA pods a raw-video consumer needs, built and parsed in safe Rust.
//!
//! SPA pods are native-endian, 8-byte padded `{size, type, body}` records.

const SPA_TYPE_ID: u32 = 3;
const SPA_TYPE_RECTANGLE: u32 = 10;
const SPA_TYPE_FRACTION: u32 = 11;
const SPA_TYPE_OBJECT: u32 = 15;
const SPA_TYPE_CHOICE: u32 = 19;

const SPA_CHOICE_RANGE: u32 = 1;
const SPA_CHOICE_ENUM: u32 = 3;

const SPA_TYPE_OBJECT_FORMAT: u32 = 0x0004_0003;
/// `SPA_PARAM_EnumFormat`.
pub(crate) const SPA_PARAM_ENUM_FORMAT: u32 = 3;
/// `SPA_PARAM_Format`.
pub(crate) const SPA_PARAM_FORMAT: u32 = 4;

const SPA_FORMAT_MEDIA_TYPE: u32 = 1;
const SPA_FORMAT_MEDIA_SUBTYPE: u32 = 2;
const SPA_FORMAT_VIDEO_FORMAT: u32 = 0x0002_0001;
const SPA_FORMAT_VIDEO_SIZE: u32 = 0x0002_0003;
const SPA_FORMAT_VIDEO_MAX_FRAMERATE: u32 = 0x0002_0005;

const SPA_MEDIA_TYPE_VIDEO: u32 = 2;
const SPA_MEDIA_SUBTYPE_RAW: u32 = 1;

/// `SPA_VIDEO_FORMAT_*` values this consumer converts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PixelLayout {
    Rgbx,
    Bgrx,
    Rgba,
    Bgra,
}

impl PixelLayout {
    fn from_spa(format: u32) -> Option<Self> {
        match format {
            7 => Some(Self::Rgbx),
            8 => Some(Self::Bgrx),
            11 => Some(Self::Rgba),
            12 => Some(Self::Bgra),
            _ => None,
        }
    }

    /// Byte offsets of red, green and blue inside one 4-byte pixel.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub(crate) fn rgb_offsets(self) -> (usize, usize, usize) {
        match self {
            Self::Rgbx | Self::Rgba => (0, 1, 2),
            Self::Bgrx | Self::Bgra => (2, 1, 0),
        }
    }
}

/// The negotiated raw-video format.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct VideoFormat {
    pub(crate) layout: PixelLayout,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

struct PodWriter(Vec<u8>);

impl PodWriter {
    fn u32(&mut self, value: u32) {
        self.0.extend_from_slice(&value.to_ne_bytes());
    }

    fn pad(&mut self) {
        while self.0.len() % 8 != 0 {
            self.0.push(0);
        }
    }

    fn prop_id(&mut self, key: u32, value: u32) {
        self.u32(key);
        self.u32(0);
        self.u32(4);
        self.u32(SPA_TYPE_ID);
        self.u32(value);
        self.pad();
    }

    fn prop_choice(
        &mut self,
        key: u32,
        choice: u32,
        child_type: u32,
        child_size: u32,
        values: &[u32],
    ) {
        let value_bytes = u32::try_from(values.len() * 4).unwrap_or(0);
        self.u32(key);
        self.u32(0);
        self.u32(16 + value_bytes);
        self.u32(SPA_TYPE_CHOICE);
        self.u32(choice);
        self.u32(0);
        self.u32(child_size);
        self.u32(child_type);
        for &value in values {
            self.u32(value);
        }
        self.pad();
    }
}

/// The `EnumFormat` this consumer offers: raw 32-bit RGB video with at most
/// `max_fps` frames per second. Size and frame rate are left to the producer.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn enum_format(max_fps: u32) -> Vec<u64> {
    let mut body = PodWriter(Vec::with_capacity(160));
    body.u32(SPA_TYPE_OBJECT_FORMAT);
    body.u32(SPA_PARAM_ENUM_FORMAT);
    body.prop_id(SPA_FORMAT_MEDIA_TYPE, SPA_MEDIA_TYPE_VIDEO);
    body.prop_id(SPA_FORMAT_MEDIA_SUBTYPE, SPA_MEDIA_SUBTYPE_RAW);
    // Enum choices list the default first.
    body.prop_choice(
        SPA_FORMAT_VIDEO_FORMAT,
        SPA_CHOICE_ENUM,
        SPA_TYPE_ID,
        4,
        &[8, 8, 12, 7, 11],
    );
    body.prop_choice(
        SPA_FORMAT_VIDEO_MAX_FRAMERATE,
        SPA_CHOICE_RANGE,
        SPA_TYPE_FRACTION,
        8,
        &[max_fps, 1, 1, 1, max_fps, 1],
    );
    let mut pod = PodWriter(Vec::with_capacity(body.0.len() + 8));
    pod.u32(u32::try_from(body.0.len()).unwrap_or(0));
    pod.u32(SPA_TYPE_OBJECT);
    pod.0.extend_from_slice(&body.0);
    pod.pad();
    pod.0
        .chunks_exact(8)
        .map(|word| u64::from_ne_bytes(word.try_into().unwrap_or([0; 8])))
        .collect()
}

fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    let raw = bytes.get(offset..offset.checked_add(4)?)?;
    Some(u32::from_ne_bytes(raw.try_into().ok()?))
}

fn padded(size: usize) -> Option<usize> {
    size.checked_add(7).map(|value| value & !7)
}

/// The first value of a property: plain, or the default of a choice.
fn value(bytes: &[u8], offset: usize) -> Option<(u32, usize)> {
    let kind = read_u32(bytes, offset + 4)?;
    if kind == SPA_TYPE_CHOICE {
        // body: choice type, flags, child {size, type}, values...
        let child_type = read_u32(bytes, offset + 8 + 12)?;
        return Some((child_type, offset + 8 + 16));
    }
    Some((kind, offset + 8))
}

/// Parses a negotiated `Format` object into the layout and size this crate
/// converts. Unknown properties are skipped.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn parse_video_format(bytes: &[u8]) -> Option<VideoFormat> {
    let size = usize::try_from(read_u32(bytes, 0)?).ok()?;
    if read_u32(bytes, 4)? != SPA_TYPE_OBJECT || bytes.len() < size.checked_add(8)? {
        return None;
    }
    let end = 8 + size;
    let mut offset = 16; // pod header + object type + object id
    let mut layout = None;
    let mut dimensions = None;
    while offset + 16 <= end {
        let key = read_u32(bytes, offset)?;
        let pod_offset = offset + 8;
        let pod_size = usize::try_from(read_u32(bytes, pod_offset)?).ok()?;
        let (kind, value_offset) = value(bytes, pod_offset)?;
        match (key, kind) {
            (SPA_FORMAT_VIDEO_FORMAT, SPA_TYPE_ID) => {
                layout = PixelLayout::from_spa(read_u32(bytes, value_offset)?);
            }
            (SPA_FORMAT_VIDEO_SIZE, SPA_TYPE_RECTANGLE) => {
                dimensions = Some((
                    read_u32(bytes, value_offset)?,
                    read_u32(bytes, value_offset + 4)?,
                ));
            }
            _ => {}
        }
        offset = pod_offset + 8 + padded(pod_size)?;
    }
    let (width, height) = dimensions?;
    (width > 0 && height > 0).then_some(VideoFormat {
        layout: layout?,
        width,
        height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(words: &[u64]) -> Vec<u8> {
        words.iter().flat_map(|word| word.to_ne_bytes()).collect()
    }

    #[test]
    fn enum_format_is_a_well_formed_padded_object() {
        let pod = bytes(&enum_format(15));
        let size = read_u32(&pod, 0).unwrap() as usize;
        assert_eq!(read_u32(&pod, 4), Some(SPA_TYPE_OBJECT));
        assert_eq!(pod.len(), padded(size + 8).unwrap());
        assert_eq!(read_u32(&pod, 8), Some(SPA_TYPE_OBJECT_FORMAT));
        assert_eq!(read_u32(&pod, 12), Some(SPA_PARAM_ENUM_FORMAT));
        // mediaType = video
        assert_eq!(read_u32(&pod, 16), Some(SPA_FORMAT_MEDIA_TYPE));
        assert_eq!(read_u32(&pod, 28), Some(SPA_TYPE_ID));
        assert_eq!(read_u32(&pod, 32), Some(SPA_MEDIA_TYPE_VIDEO));
    }

    fn negotiated(format_value: &[u32], size_is_choice: bool) -> Vec<u8> {
        let mut body = PodWriter(Vec::new());
        body.u32(SPA_TYPE_OBJECT_FORMAT);
        body.u32(SPA_PARAM_FORMAT);
        body.prop_id(SPA_FORMAT_MEDIA_TYPE, SPA_MEDIA_TYPE_VIDEO);
        body.prop_choice(SPA_FORMAT_VIDEO_FORMAT, 0, SPA_TYPE_ID, 4, format_value);
        if size_is_choice {
            body.prop_choice(
                SPA_FORMAT_VIDEO_SIZE,
                0,
                SPA_TYPE_RECTANGLE,
                8,
                &[1280, 800],
            );
        } else {
            body.u32(SPA_FORMAT_VIDEO_SIZE);
            body.u32(0);
            body.u32(8);
            body.u32(SPA_TYPE_RECTANGLE);
            body.u32(1280);
            body.u32(800);
        }
        let mut pod = PodWriter(Vec::new());
        pod.u32(u32::try_from(body.0.len()).unwrap());
        pod.u32(SPA_TYPE_OBJECT);
        pod.0.extend_from_slice(&body.0);
        pod.0
    }

    #[test]
    fn parses_plain_and_choice_wrapped_format_values() {
        for choice in [false, true] {
            assert_eq!(
                parse_video_format(&negotiated(&[12], choice)),
                Some(VideoFormat {
                    layout: PixelLayout::Bgra,
                    width: 1280,
                    height: 800,
                })
            );
        }
    }

    #[test]
    fn rejects_unsupported_layouts_and_truncated_pods() {
        assert_eq!(parse_video_format(&negotiated(&[2], false)), None);
        let pod = negotiated(&[8], false);
        assert_eq!(parse_video_format(&pod[..pod.len() - 4]), None);
    }
}
