//! Read-only evidence gathered immediately before command-scope teardown.
//! Never infer a descendant from shell syntax or count the private group anchor.

#[cfg(target_os = "linux")]
pub(crate) fn group_has_live_children(group_id: i32) -> std::io::Result<bool> {
    for entry in std::fs::read_dir("/proc")? {
        let entry = entry?;
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<i32>().ok())
        else {
            continue;
        };
        if pid == group_id {
            continue;
        }
        // Processes outside this command may disappear or be unreadable.
        let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        if live_group(&stat) == Some(group_id) {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(target_os = "linux")]
fn live_group(stat: &str) -> Option<i32> {
    // comm may contain spaces and parentheses; fields after its final ')' are
    // state, ppid, pgrp. Zombies have no work left for cleanup to stop.
    let (_, fields) = stat.rsplit_once(')')?;
    let mut fields = fields.split_whitespace();
    if matches!(fields.next()?, "Z" | "X" | "x") {
        return None;
    }
    fields.next()?;
    fields.next()?.parse().ok()
}

#[cfg(target_os = "macos")]
pub(crate) fn group_has_live_children(pgid: i32) -> std::io::Result<bool> {
    opengeni_agent_linux_ffi::process_group_has_live_children(pgid)
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn group_parser_ignores_zombies_and_handles_command_parentheses() {
        assert_eq!(live_group("42 (a tricky ) name) S 1 123 123 0"), Some(123));
        assert_eq!(live_group("42 (finished) Z 1 123 123 0"), None);
        assert_eq!(live_group("42 (dead) X 1 123 123 0"), None);
    }
}
