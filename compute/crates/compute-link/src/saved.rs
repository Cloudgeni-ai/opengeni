//! What the host keeps of a sandbox's session on disk, so that after the
//! host agent restarts it opens the session again, with its subscriptions,
//! before the sandbox's guest runs.

use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// A session as kept on disk.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Saved {
    /// The agent's connection instance.
    pub instance: String,
    /// Its subscriptions, by the host's sid.
    pub subs: Vec<SavedSub>,
    /// The next sid the host gives.
    pub next_sid: u32,
}

/// One subscription of a [`Saved`] session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SavedSub {
    pub sid: u32,
    pub subject: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue: Option<String>,
}

impl Saved {
    /// Reads the session kept at `path`, if one is. A file that does not
    /// parse is treated as none: the session then opens when the agent
    /// next connects, as for a new sandbox.
    ///
    /// # Errors
    ///
    /// When the file exists but cannot be read.
    pub fn load(path: &Path) -> io::Result<Option<Self>> {
        match std::fs::read(path) {
            Ok(bytes) => Ok(match serde_json::from_slice(&bytes) {
                Ok(saved) => Some(saved),
                Err(error) => {
                    tracing::warn!(path = %path.display(), %error, "ignoring an unreadable agent-link session");
                    None
                }
            }),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// Keeps `saved` at `path`, replacing what was there at once, or
    /// removes it for `None`.
    ///
    /// # Errors
    ///
    /// When the file cannot be written or removed.
    pub async fn store(path: &Path, saved: Option<&Self>) -> io::Result<()> {
        let Some(saved) = saved else {
            return match tokio::fs::remove_file(path).await {
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
                result => result,
            };
        };
        let mut temporary = path.as_os_str().to_owned();
        temporary.push(".new");
        let bytes = serde_json::to_vec(saved).map_err(io::Error::other)?;
        tokio::fs::write(&temporary, bytes).await?;
        tokio::fs::rename(&temporary, path).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_session_is_kept_replaced_and_removed() {
        let dir = std::env::temp_dir().join(format!("compute-link-saved-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("link.json");
        assert_eq!(Saved::load(&path).unwrap(), None);
        let saved = Saved {
            instance: "i1".into(),
            subs: vec![SavedSub {
                sid: 1,
                subject: "agent.w.a.connection.i1.rpc".into(),
                queue: None,
            }],
            next_sid: 2,
        };
        Saved::store(&path, Some(&saved)).await.unwrap();
        assert_eq!(Saved::load(&path).unwrap(), Some(saved));
        std::fs::write(&path, b"{").unwrap();
        assert_eq!(Saved::load(&path).unwrap(), None, "a torn file is none");
        Saved::store(&path, None).await.unwrap();
        Saved::store(&path, None).await.unwrap();
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(dir);
    }
}
