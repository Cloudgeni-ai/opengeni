//! A real command started through `NativePlatform` finds the agent's own
//! ripgrep and jq only after everything on its `PATH`: a system copy wins,
//! and the agent's copy fills the gap. Its own test binary, because the tools
//! directory is process-wide.

#[cfg(unix)]
mod unix {
    use std::os::unix::fs::PermissionsExt as _;
    use std::path::Path;

    use opengeni_agent_platform::{set_shell_tools_directory, NativePlatform, Platform};
    use opengeni_agent_proto::v1::ExecRequest;

    fn tool(directory: &Path, name: &str, says: &str) {
        let path = directory.join(name);
        std::fs::write(&path, format!("#!/bin/sh\necho {says}\n")).expect("tool");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("mode");
    }

    #[tokio::test]
    async fn the_agent_tools_come_last_and_a_system_copy_wins() {
        let root = tempfile::tempdir().expect("root");
        let agent_tools = root.path().join("agent-tools");
        let system = root.path().join("system-bin");
        std::fs::create_dir_all(&agent_tools).expect("agent tools");
        std::fs::create_dir_all(&system).expect("system");
        tool(&agent_tools, "rg", "agent-rg");
        tool(&agent_tools, "jq", "agent-jq");
        tool(&system, "jq", "system-jq");
        set_shell_tools_directory(agent_tools.clone());

        let platform = NativePlatform::with_root(root.path());
        let request_path = format!("{}:/usr/bin:/bin", system.display());
        let response = platform
            .exec(&ExecRequest {
                command: vec!["rg; jq; printf '%s\\n' \"$PATH\"".into()],
                shell: true,
                timeout_ms: 10_000,
                env: std::collections::HashMap::from([("PATH".into(), request_path.clone())]),
                ..Default::default()
            })
            .await
            .expect("command");
        let stdout = String::from_utf8(response.stdout.to_vec()).expect("utf-8");
        assert_eq!(
            stdout,
            format!(
                "agent-rg\nsystem-jq\n{request_path}:{}\n",
                agent_tools.display()
            )
        );

        // A command whose PATH already names the directory keeps it as is.
        let explicit = format!("{}:/usr/bin:/bin", agent_tools.display());
        let response = platform
            .exec(&ExecRequest {
                command: vec!["printf '%s\\n' \"$PATH\"".into()],
                shell: true,
                timeout_ms: 10_000,
                env: std::collections::HashMap::from([("PATH".into(), explicit.clone())]),
                ..Default::default()
            })
            .await
            .expect("command");
        assert_eq!(
            String::from_utf8(response.stdout.to_vec()).expect("utf-8"),
            format!("{explicit}\n")
        );
    }
}
