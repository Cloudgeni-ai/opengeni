use std::collections::VecDeque;
use std::time::{Duration, Instant};

const MAX_FRAME_AGE: Duration = Duration::from_secs(2);
const MAX_FRAMES_PER_TARGET: usize = 32;
const MAX_FRAMES: usize = 512;

struct CapturedFrame<T> {
    target_id: String,
    frame_id: String,
    superseded_at: Option<Instant>,
    value: T,
}

/// Metadata for recently painted frames. New captures do not invalidate a
/// viewer's pending gesture; callers still validate the exact live target,
/// generation and geometry before input. Latest still frames keep their
/// existing authority; only superseded metadata expires. No image bytes are
/// retained here.
pub(crate) struct CapturedFrames<T> {
    frames: VecDeque<CapturedFrame<T>>,
}

impl<T> CapturedFrames<T> {
    pub(crate) fn new() -> Self {
        Self {
            frames: VecDeque::new(),
        }
    }

    pub(crate) fn insert(&mut self, target_id: String, frame_id: String, value: T) {
        self.insert_at(target_id, frame_id, value, Instant::now());
    }

    fn insert_at(&mut self, target_id: String, frame_id: String, value: T, now: Instant) {
        self.frames.retain(|frame| {
            frame
                .superseded_at
                .is_none_or(|at| now.saturating_duration_since(at) <= MAX_FRAME_AGE)
        });
        if let Some(latest) = self
            .frames
            .iter_mut()
            .rev()
            .find(|frame| frame.target_id == target_id)
        {
            latest.superseded_at = Some(now);
        }
        while self
            .frames
            .iter()
            .filter(|frame| frame.target_id == target_id)
            .count()
            >= MAX_FRAMES_PER_TARGET
        {
            if let Some(index) = self
                .frames
                .iter()
                .position(|frame| frame.target_id == target_id)
            {
                self.frames.remove(index);
            }
        }
        self.frames.push_back(CapturedFrame {
            target_id,
            frame_id,
            superseded_at: None,
            value,
        });
        while self.frames.len() > MAX_FRAMES {
            // Keep still observations while any superseded metadata can be
            // evicted. Only a new target beyond the global limit evicts a
            // latest frame, matching the previous target-cache bound.
            let oldest = self
                .frames
                .iter()
                .position(|frame| frame.superseded_at.is_some())
                .unwrap_or(0);
            self.frames.remove(oldest);
        }
    }

    pub(crate) fn get(&self, target_id: &str, frame_id: &str) -> Option<&T> {
        self.get_at(target_id, frame_id, Instant::now())
    }

    fn get_at(&self, target_id: &str, frame_id: &str, now: Instant) -> Option<&T> {
        self.frames
            .iter()
            .rev()
            .find(|frame| {
                frame.target_id == target_id
                    && frame.frame_id == frame_id
                    && frame
                        .superseded_at
                        .is_none_or(|at| now.saturating_duration_since(at) <= MAX_FRAME_AGE)
            })
            .map(|frame| &frame.value)
    }

    pub(crate) fn latest(&self, target_id: &str) -> Option<&T> {
        self.frames
            .iter()
            .rev()
            .find(|frame| frame.target_id == target_id && frame.superseded_at.is_none())
            .map(|frame| &frame.value)
    }

    pub(crate) fn clear(&mut self) {
        self.frames.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn painted_frame_survives_new_captures_with_its_original_dimensions() {
        let now = Instant::now();
        let mut frames = CapturedFrames::new();
        frames.insert_at("window".into(), "painted".into(), (720, 450), now);
        for index in 1..=3 {
            frames.insert_at(
                "window".into(),
                format!("new-{index}"),
                (1440, 900),
                now + Duration::from_millis(index * 100),
            );
        }
        assert_eq!(
            frames.get_at("window", "painted", now + Duration::from_millis(380)),
            Some(&(720, 450))
        );
        assert_eq!(frames.get_at("other-window", "painted", now), None);
        assert_eq!(frames.get_at("window", "unknown-frame", now), None);
        assert_eq!(
            frames.get_at(
                "window",
                "painted",
                now + Duration::from_millis(100) + MAX_FRAME_AGE + Duration::from_nanos(1)
            ),
            None
        );
    }

    #[test]
    fn latest_still_frame_keeps_authority_through_model_planning() {
        let now = Instant::now();
        let mut frames = CapturedFrames::new();
        frames.insert_at("window".into(), "still".into(), (720, 450), now);
        assert_eq!(
            frames.get_at("window", "still", now + Duration::from_secs(60)),
            Some(&(720, 450))
        );
        let resumed = now + Duration::from_secs(60);
        frames.insert_at("window".into(), "stream".into(), (1440, 900), resumed);
        assert_eq!(
            frames.get_at("window", "still", resumed + Duration::from_millis(280)),
            Some(&(720, 450))
        );
        assert_eq!(
            frames.get_at(
                "window",
                "still",
                resumed + MAX_FRAME_AGE + Duration::from_nanos(1)
            ),
            None
        );
        assert_eq!(
            frames.get_at("window", "stream", resumed + Duration::from_secs(60)),
            Some(&(1440, 900))
        );
    }

    #[test]
    fn target_and_global_retention_are_bounded_and_mutations_invalidate_history() {
        let now = Instant::now();
        let mut frames = CapturedFrames::new();
        for index in 0..=MAX_FRAMES_PER_TARGET {
            frames.insert_at("window".into(), index.to_string(), index, now);
        }
        assert_eq!(frames.frames.len(), MAX_FRAMES_PER_TARGET);
        assert_eq!(frames.get_at("window", "0", now), None);
        frames.clear();
        assert_eq!(frames.get_at("window", "32", now), None);
        for index in 0..=MAX_FRAMES {
            frames.insert_at(index.to_string(), "frame".into(), index, now);
        }
        assert_eq!(frames.frames.len(), MAX_FRAMES);
        assert_eq!(frames.get_at("0", "frame", now), None);
        frames.insert_at("1".into(), "new-frame".into(), 1, now);
        assert_eq!(frames.get_at("1", "frame", now), None);
        assert_eq!(
            frames.get_at("2", "frame", now + Duration::from_secs(60)),
            Some(&2)
        );
        assert_eq!(
            frames.get_at("1", "new-frame", now + Duration::from_secs(60)),
            Some(&1)
        );
        frames.clear();
        assert!(frames.frames.is_empty());
    }
}
