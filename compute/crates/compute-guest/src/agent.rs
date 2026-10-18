//! Opengeni's agent in the guest
//! ([`docs/agent-link.md`](../../../docs/agent-link.md) section 2): the file
//! it starts with, how it is started, and the activity it registers.
//!
//! The agent holds no credential. It reaches Opengeni through
//! `127.0.0.1:`[`NATS_PORT`], which the guest forwards to its host's agent
//! link on vsock port [`crate::AGENT_LINK_PORT`].

use serde::Serialize;

use crate::envd::AgentInit;

/// Where the agent's program is in an image that runs it.
pub const AGENT_PATH: &str = "/usr/local/bin/opengeni-agent";

/// The directory of [`LINK_FILE`], root's only.
pub const LINK_DIR: &str = "/run/compute/agent";

/// The file the agent is started with.
pub const LINK_FILE: &str = "/run/compute/agent/link.json";

/// Where the agent registers activity: files `<label>.<pid>`, each holding
/// a decimal count of what keeps the sandbox awake.
pub const ACTIVITY_DIR: &str = "/run/compute/activity";

/// The loopback port the agent's NATS client dials.
pub const NATS_PORT: u16 = 3958;

#[derive(Serialize)]
struct LinkFile<'a> {
    workspace_id: &'a str,
    agent_id: &'a str,
    workspace_root: &'a str,
    nats_url: String,
}

/// The contents of [`LINK_FILE`] for `agent`.
#[must_use]
pub fn link_file(agent: &AgentInit) -> String {
    serde_json::to_string(&LinkFile {
        workspace_id: &agent.workspace_id,
        agent_id: &agent.agent_id,
        workspace_root: &agent.workspace_root,
        nats_url: format!("nats://127.0.0.1:{NATS_PORT}"),
    })
    .unwrap_or_default()
}

/// The agent's arguments.
#[must_use]
pub fn args(agent: &AgentInit) -> Vec<&'static str> {
    let mut args = vec!["run", "--fabric", LINK_FILE];
    if agent.desktop {
        args.push("--virtual-desktop");
    }
    args
}

/// The process an activity file `name` counts for: `<label>.<pid>`, where
/// the label is not empty and the pid is a positive decimal.
#[must_use]
pub fn activity_pid(name: &str) -> Option<i32> {
    let (label, pid) = name.rsplit_once('.')?;
    if label.is_empty() || !pid.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    pid.parse().ok().filter(|pid| *pid > 0)
}

/// The count an activity file holds: a decimal, with surrounding blanks.
#[must_use]
pub fn activity_count(text: &str) -> Option<u32> {
    text.trim().parse().ok()
}

/// The guest's answer to the host's `activity` question.
#[must_use]
pub fn activity_answer(running: u32) -> String {
    format!("commands {running}\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(desktop: bool) -> AgentInit {
        AgentInit {
            workspace_id: "w1".into(),
            agent_id: "a1".into(),
            workspace_root: "/workspace".into(),
            desktop,
        }
    }

    #[test]
    fn the_link_file_names_the_agent_and_the_local_nats_port() {
        let file: serde_json::Value = serde_json::from_str(&link_file(&agent(false))).unwrap();
        assert_eq!(
            file,
            serde_json::json!({
                "workspace_id": "w1",
                "agent_id": "a1",
                "workspace_root": "/workspace",
                "nats_url": "nats://127.0.0.1:3958",
            })
        );
    }

    #[test]
    fn a_desktop_agent_starts_its_virtual_desktop() {
        assert_eq!(args(&agent(false)), ["run", "--fabric", LINK_FILE]);
        assert_eq!(
            args(&agent(true)),
            ["run", "--fabric", LINK_FILE, "--virtual-desktop"]
        );
    }

    #[test]
    fn activity_files_name_a_label_and_a_live_process() {
        assert_eq!(activity_pid("commands.42"), Some(42));
        assert_eq!(activity_pid("pty.sessions.7"), Some(7));
        for bad in [
            "42",
            ".42",
            "commands.",
            "commands.0",
            "commands.-3",
            "commands.4x",
            "c.+4",
        ] {
            assert_eq!(activity_pid(bad), None, "{bad}");
        }
        assert_eq!(activity_count(" 3\n"), Some(3));
        assert_eq!(activity_count(""), None);
        assert_eq!(activity_count("-1"), None);
        assert_eq!(activity_answer(2), "commands 2\n");
    }
}
