//! When each shape was last used, so a template nobody uses is retired.
//!
//! A template and its ready sandboxes cost disk and memory whether or not
//! anyone creates sandboxes of their shape. A shape unused for a while
//! (a week by default) gives them up; its next create boots cold and builds
//! the template again. A create of a shape is its use. The time of the last
//! one is kept as the modification time of an empty file per shape, so it
//! outlives the agent: a restart neither keeps a rare shape alive nor
//! retires a busy one. The file is rewritten only once the time it holds
//! is an eighth of the retirement period old (at most an hour), so a busy
//! shape costs one write an hour, and a shape retires at most that early.
//!
//! ```text
//! <root>/templates/used/<shape>   modified at the shape's last use
//! ```

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use super::Shape;

/// The directory, under the templates directory, of the use marks.
pub(super) const USED: &str = "used";
/// The longest a use goes unwritten.
const WRITE_EVERY: Duration = Duration::from_secs(3600);

/// A use mark to write: the marks' directory and the mark.
pub(crate) type Mark = (PathBuf, PathBuf);

/// When each shape was last used, as far as its mark says.
#[derive(Debug)]
pub(crate) struct Uses {
    dir: PathBuf,
    /// How long a shape may go unused before its template retires.
    unused_after: Duration,
    last: HashMap<Shape, SystemTime>,
}

impl Uses {
    /// Reads the marks in `templates`, the templates directory. Each of
    /// `shapes` without one, newly kept, counts as used `now`. Blocks.
    pub fn load(
        templates: &Path,
        unused_after: Duration,
        shapes: impl IntoIterator<Item = Shape>,
        now: SystemTime,
    ) -> Self {
        let mut uses = Self {
            dir: templates.join(USED),
            unused_after,
            last: HashMap::new(),
        };
        for shape in shapes {
            let mark = uses.mark(shape);
            let last = fs::metadata(&mark)
                .and_then(|metadata| metadata.modified())
                .unwrap_or_else(|_| {
                    write_use((uses.dir.clone(), mark), now);
                    now
                });
            uses.last.insert(shape, last);
        }
        uses
    }

    fn mark(&self, shape: Shape) -> PathBuf {
        self.dir.join(shape.to_string())
    }

    /// Records that a sandbox of `shape` was created `now`. Returns the
    /// mark to rewrite with [`write_use`], if the one on disk is old
    /// enough.
    pub fn used(&mut self, shape: Shape, now: SystemTime) -> Option<Mark> {
        let every = (self.unused_after / 8).min(WRITE_EVERY);
        let old = self
            .last
            .get(&shape)
            .is_none_or(|last| now.duration_since(*last).is_ok_and(|since| since >= every));
        if !old {
            return None;
        }
        self.last.insert(shape, now);
        Some((self.dir.clone(), self.mark(shape)))
    }

    /// The shapes unused for the whole retirement period by `now`.
    pub fn unused(&self, now: SystemTime) -> Vec<Shape> {
        let mut unused: Vec<Shape> = self
            .last
            .iter()
            .filter(|(_, last)| {
                now.duration_since(**last)
                    .is_ok_and(|since| since >= self.unused_after)
            })
            .map(|(shape, _)| *shape)
            .collect();
        unused.sort();
        unused
    }
}

/// Writes a use mark at `now`. Blocks. A failure only makes the shape look
/// older after a restart, so it is logged and otherwise ignored.
pub(crate) fn write_use((dir, mark): Mark, now: SystemTime) {
    let written = fs::create_dir_all(&dir).and_then(|()| {
        fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&mark)?
            .set_modified(now)
    });
    if let Err(error) = written {
        tracing::warn!(%error, mark = %mark.display(), "could not mark a template's use");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: Duration = Duration::from_secs(86_400);
    const HALF_HOUR: Duration = Duration::from_secs(1800);
    const NONE: [Shape; 0] = [];

    #[test]
    fn a_shape_retires_after_going_unused_and_its_use_outlives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let shape = Shape {
            vcpus: 1,
            memory_mib: 512,
        };
        let start = SystemTime::now() - 30 * DAY;
        let mut uses = Uses::load(dir.path(), 7 * DAY, [shape], start);
        assert_eq!(uses.unused(start + 6 * DAY), NONE);
        assert_eq!(uses.unused(start + 7 * DAY), [shape]);

        let mark = uses.used(shape, start + DAY).expect("a day-old mark");
        write_use(mark, start + DAY);
        // A use soon after the last written one is not written again.
        assert_eq!(uses.used(shape, start + DAY + HALF_HOUR), None);
        assert_eq!(uses.unused(start + 7 * DAY), NONE);

        // A restarted agent reads the last written use.
        let restarted = Uses::load(dir.path(), 7 * DAY, [shape], start + 9 * DAY);
        assert_eq!(restarted.unused(start + 8 * DAY - HALF_HOUR), NONE);
        assert_eq!(restarted.unused(start + 8 * DAY), [shape]);
    }
}
