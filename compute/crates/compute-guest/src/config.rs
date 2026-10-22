//! What an image build leaves in the image for the guest: the files under
//! [`GUEST_DIR`] and the image's own config, as the OCI image config
//! gives it.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Where an image build puts the guest's files.
pub const GUEST_DIR: &str = "/opengeni";
/// This init. The build points `/sbin/init` at it.
pub const INIT_PATH: &str = "/opengeni/init";
/// envd.
pub const ENVD_PATH: &str = "/opengeni/envd";
/// The image's config, as [`ImageConfig`] in JSON.
pub const CONFIG_PATH: &str = "/opengeni/image.json";

/// `PATH` for a process whose image sets none, as container runtimes
/// give it.
pub const DEFAULT_PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/// E2B's default user, whom SDK commands run as unless they name another.
pub const DEFAULT_USER: &str = "user";

/// The parts of an OCI image config the guest uses.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageConfig {
    /// `USER`: a name or number, optionally `:group`. Empty means root.
    #[serde(default)]
    pub user: String,
    /// `WORKDIR`. Empty means `/`.
    #[serde(default)]
    pub working_dir: String,
    /// `ENV`, as `KEY=value`.
    #[serde(default)]
    pub env: Vec<String>,
    #[serde(default)]
    pub entrypoint: Vec<String>,
    #[serde(default)]
    pub cmd: Vec<String>,
}

impl ImageConfig {
    /// The image's command: its entrypoint followed by its command, as
    /// `docker run` starts it. Empty if the image has neither.
    #[must_use]
    pub fn command(&self) -> Vec<String> {
        self.entrypoint.iter().chain(&self.cmd).cloned().collect()
    }

    /// The image's environment by name; a later entry wins, and an entry
    /// without `=` or with an empty name is skipped.
    #[must_use]
    pub fn env_map(&self) -> BTreeMap<String, String> {
        self.env
            .iter()
            .filter_map(|entry| entry.split_once('='))
            .filter(|(name, _)| !name.is_empty())
            .map(|(name, value)| (name.to_owned(), value.to_owned()))
            .collect()
    }

    /// The environment the image's command runs with: the image's, plus
    /// `PATH` and `HOME` when it sets none.
    #[must_use]
    pub fn process_env(&self, home: &str) -> BTreeMap<String, String> {
        let mut env = self.env_map();
        env.entry("PATH".into())
            .or_insert_with(|| DEFAULT_PATH.into());
        env.entry("HOME".into()).or_insert_with(|| home.into());
        env
    }

    /// The directory the image's command starts in.
    #[must_use]
    pub fn working_dir(&self) -> &str {
        if self.working_dir.is_empty() {
            "/"
        } else {
            &self.working_dir
        }
    }

    /// The directory SDK commands start in by default, if the image names
    /// one; otherwise envd uses the user's home, as on E2B.
    #[must_use]
    pub fn default_workdir(&self) -> Option<&str> {
        match self.working_dir() {
            "/" => None,
            dir => Some(dir),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(json: &str) -> ImageConfig {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn reads_partial_configs_and_round_trips() {
        assert_eq!(config("{}"), ImageConfig::default());
        let full = config(
            r#"{"user":"1000:1000","workingDir":"/app","env":["A=1"],"entrypoint":["/x"],"cmd":["-y"],"later":true}"#,
        );
        assert_eq!(full.user, "1000:1000");
        let again = config(&serde_json::to_string(&full).unwrap());
        assert_eq!(again, full);
    }

    #[test]
    fn command_is_entrypoint_then_cmd() {
        let mut image = ImageConfig {
            entrypoint: vec!["/bin/tini".into(), "--".into()],
            cmd: vec!["node".into(), "server.js".into()],
            ..ImageConfig::default()
        };
        assert_eq!(image.command(), ["/bin/tini", "--", "node", "server.js"]);
        image.entrypoint.clear();
        assert_eq!(image.command(), ["node", "server.js"]);
        image.cmd.clear();
        assert_eq!(image.command(), Vec::<String>::new());
    }

    #[test]
    fn environment_later_entries_win_and_defaults_fill_gaps() {
        let image = ImageConfig {
            env: vec![
                "A=1".into(),
                "B=x=y".into(),
                "A=2".into(),
                "NOEQUALS".into(),
                "=empty".into(),
                "E=".into(),
            ],
            ..ImageConfig::default()
        };
        let env = image.process_env("/home/user");
        assert_eq!(env["A"], "2");
        assert_eq!(env["B"], "x=y");
        assert_eq!(env["E"], "");
        assert_eq!(env["PATH"], DEFAULT_PATH);
        assert_eq!(env["HOME"], "/home/user");
        assert_eq!(env.len(), 5);
        let own = ImageConfig {
            env: vec!["PATH=/bin".into(), "HOME=/root".into()],
            ..ImageConfig::default()
        };
        let env = own.process_env("/home/user");
        assert_eq!(
            (env["PATH"].as_str(), env["HOME"].as_str()),
            ("/bin", "/root")
        );
    }

    #[test]
    fn working_directories() {
        let mut image = ImageConfig::default();
        assert_eq!((image.working_dir(), image.default_workdir()), ("/", None));
        image.working_dir = "/workspace".into();
        assert_eq!(image.working_dir(), "/workspace");
        assert_eq!(image.default_workdir(), Some("/workspace"));
    }
}
