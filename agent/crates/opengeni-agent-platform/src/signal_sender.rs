//! Tells a stop signal one of the agent's own commands sent from one sent by
//! anyone else.
//!
//! A command runs as the agent's user, so it may signal the agent: `kill -1`
//! (every process the user owns), `pkill -f opengeni`, or a group signal aimed
//! at the wrong group. Each command already runs in its own process group, so
//! `kill 0` and `kill -<its group>` reach only that command; `kill -1` reaches
//! the agent too, and a signal does not say whether it was aimed at the agent
//! or broadcast. The sender does. The agent therefore stays up for a stop
//! signal one of its commands sent (the command itself still receives every
//! signal and nothing blocks it), and stops as before for one from anywhere
//! else: its service manager, its keeper, the desktop app or a person's
//! terminal.
//!
//! A sender is looked up after its signal arrived, and a short-lived one
//! (`/bin/kill`, `sh -c 'kill …'`, the last `kill` of a script) has often
//! exited and been reaped by then: [`Sender::Gone`]. The caller decides what
//! that means; the agent counts it as its command's while a command runs or
//! just ended.

use std::path::Path;

pub use opengeni_agent_linux_ffi::{
    queue_signal_from, relay_signals, wait_for_signal, SignalDelivery, SignalRelay,
};

/// Longest parent chain followed; real process trees are far shallower.
const MAX_DEPTH: usize = 4096;

/// The cgroup leaf the agent's own process occupies under operation isolation
/// (see the `cgroup` module); its siblings named `op-<n>` hold commands.
const SUPERVISOR_LEAF: &str = "/supervisor";

/// Who sent a signal, as far as `/proc` tells.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sender {
    /// One of the agent's commands, or a process one of them started.
    Command,
    /// Anyone else: a process that is not a command, the kernel (a terminal's
    /// Ctrl-C), or a process in an outer PID namespace.
    Outside(Option<i32>),
    /// A process that exited before it could be placed.
    Gone(i32),
}

/// Places the sender of a signal `agent` received.
#[must_use]
pub fn place(sender: Option<i32>, agent: i32) -> Sender {
    place_in(Path::new("/proc"), sender, agent, |pid| {
        // `ESRCH` only for a process that no longer exists; one `/proc` hides
        // (`hidepid`) still answers, with `EPERM` at most.
        matches!(
            nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None),
            Err(nix::errno::Errno::ESRCH)
        )
    })
}

/// `gone` tells whether a process no longer exists at all.
fn place_in(
    proc_root: &Path,
    sender: Option<i32>,
    agent: i32,
    gone: impl Fn(i32) -> bool,
) -> Sender {
    match sender {
        Some(pid) if pid > 0 && is_command_of_in(proc_root, pid, agent) => Sender::Command,
        // PID 1 never exits; it is init or a container's first process.
        Some(pid) if pid > 1 && exited(proc_root, pid, &gone) => Sender::Gone(pid),
        other => Sender::Outside(other),
    }
}

/// Whether `pid` exited: it is gone, or a zombie not reaped yet, whose parents
/// and groups no longer place it.
fn exited(proc_root: &Path, pid: i32, gone: &impl Fn(i32) -> bool) -> bool {
    gone(pid) || stat(proc_root, pid).is_some_and(|stat| stat.zombie)
}

#[derive(Debug, Clone, Copy)]
struct Stat {
    zombie: bool,
    parent: i32,
    group: i32,
    session: i32,
}

fn stat(proc_root: &Path, pid: i32) -> Option<Stat> {
    let text = std::fs::read_to_string(proc_root.join(pid.to_string()).join("stat")).ok()?;
    // The command name may hold spaces and parentheses; the fields after it
    // start behind the last `)`.
    let mut fields = text.get(text.rfind(')')? + 1..)?.split_whitespace();
    let zombie = fields.next()? == "Z";
    Some(Stat {
        zombie,
        parent: fields.next()?.parse().ok()?,
        group: fields.next()?.parse().ok()?,
        session: fields.next()?.parse().ok()?,
    })
}

/// Whether `pid` is a strict descendant of `ancestor`.
fn descends_from(proc_root: &Path, pid: i32, ancestor: i32) -> bool {
    if pid <= 1 || pid == ancestor {
        return false;
    }
    let mut current = pid;
    for _ in 0..MAX_DEPTH {
        let Some(stat) = stat(proc_root, current) else {
            return false;
        };
        if stat.parent == ancestor {
            return true;
        }
        if stat.parent <= 1 {
            return false;
        }
        current = stat.parent;
    }
    false
}

fn unified_cgroup(proc_root: &Path, pid: i32) -> Option<String> {
    std::fs::read_to_string(proc_root.join(pid.to_string()).join("cgroup"))
        .ok()?
        .lines()
        .find_map(|line| line.strip_prefix("0::"))
        .map(str::to_owned)
}

/// Whether `pid` sits in one of `agent`'s operation cgroups. Commands are
/// moved there before they run, so this holds even for a command that left
/// its process group and whose parents already ended.
fn in_operation_cgroup(proc_root: &Path, pid: i32, agent: i32) -> bool {
    let Some(agent_cgroup) = unified_cgroup(proc_root, agent) else {
        return false;
    };
    let Some(service) = agent_cgroup.strip_suffix(SUPERVISOR_LEAF) else {
        return false;
    };
    unified_cgroup(proc_root, pid).is_some_and(|cgroup| {
        cgroup
            .strip_prefix(service)
            .and_then(|rest| rest.strip_prefix("/op-"))
            .is_some()
    })
}

/// Whether `sender` is one of the commands `agent` runs, or a process one of
/// them started: it descends from `agent`, its process group or session was
/// started by one that does (a command's group survives its parent shell),
/// or it sits in one of `agent`'s operation cgroups.
///
/// `false` for `agent` itself, for its parent and every other ancestor, and
/// whenever the sender cannot be placed (it already exited, or `/proc` is
/// unavailable); [`place`] tells those apart.
#[must_use]
pub fn is_command_of(sender: i32, agent: i32) -> bool {
    is_command_of_in(Path::new("/proc"), sender, agent)
}

fn is_command_of_in(proc_root: &Path, sender: i32, agent: i32) -> bool {
    if sender <= 1 || sender == agent {
        return false;
    }
    if descends_from(proc_root, sender, agent) || in_operation_cgroup(proc_root, sender, agent) {
        return true;
    }
    let Some(stat) = stat(proc_root, sender) else {
        return false;
    };
    [stat.group, stat.session]
        .into_iter()
        .filter(|&leader| leader != sender)
        .any(|leader| descends_from(proc_root, leader, agent))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fake `/proc` with `pid → (parent, group, session, cgroup)`.
    fn fake_proc(processes: &[(i32, i32, i32, i32, &str)]) -> tempfile::TempDir {
        let root = tempfile::tempdir().expect("fake /proc");
        for &(pid, parent, group, session, cgroup) in processes {
            let dir = root.path().join(pid.to_string());
            std::fs::create_dir_all(&dir).expect("process dir");
            std::fs::write(
                dir.join("stat"),
                format!("{pid} (a (odd) name) S {parent} {group} {session} 0 -1 4194560 0"),
            )
            .expect("stat");
            std::fs::write(dir.join("cgroup"), format!("0::{cgroup}\n")).expect("cgroup");
        }
        root
    }

    const AGENT: i32 = 100;
    const KEEPER: i32 = 90;

    #[test]
    fn commands_and_their_descendants_are_commands() {
        let proc_root = fake_proc(&[
            (KEEPER, 50, KEEPER, 40, "/user.slice/session-1.scope"),
            (AGENT, KEEPER, KEEPER, 40, "/user.slice/session-1.scope"),
            // A command (in its anchor's group 200) and its grandchild.
            (200, AGENT, 200, 40, "/user.slice/session-1.scope"),
            (201, AGENT, 200, 40, "/user.slice/session-1.scope"),
            (202, 201, 200, 40, "/user.slice/session-1.scope"),
            // A process of that command whose parents already ended.
            (203, 1, 200, 40, "/user.slice/session-1.scope"),
            // A PTY shell (its own session) and an orphaned job of it.
            (300, AGENT, 300, 300, "/user.slice/session-1.scope"),
            (302, 1, 302, 300, "/user.slice/session-1.scope"),
            // A process that started its own session, then lost its parents.
            (301, 1, 301, 301, "/user.slice/session-1.scope"),
        ]);
        for sender in [201, 202, 203, 300, 302] {
            assert!(
                is_command_of_in(proc_root.path(), sender, AGENT),
                "{sender} is a command"
            );
        }
        // 301 left every trace of the agent: it cannot be placed.
        assert!(!is_command_of_in(proc_root.path(), 301, AGENT));
    }

    #[test]
    fn the_agent_its_ancestors_and_strangers_are_not_commands() {
        let proc_root = fake_proc(&[
            (40, 1, 40, 40, "/user.slice/session-1.scope"),
            (KEEPER, 40, KEEPER, 40, "/user.slice/session-1.scope"),
            (AGENT, KEEPER, KEEPER, 40, "/user.slice/session-1.scope"),
            // `opengeni-agent run | tee log`: tee shares the agent's group.
            (95, 40, KEEPER, 40, "/user.slice/session-1.scope"),
            // A person's `kill` in another terminal.
            (500, 40, 500, 40, "/user.slice/session-1.scope"),
        ]);
        for sender in [AGENT, KEEPER, 40, 95, 500, 1, 0, -1, 777] {
            assert!(
                !is_command_of_in(proc_root.path(), sender, AGENT),
                "{sender} is not a command"
            );
        }
    }

    #[test]
    fn an_operation_cgroup_places_a_command_with_no_other_trace() {
        let service =
            "/user.slice/user-1000.slice/user@1000.service/app.slice/opengeni-agent.service";
        let proc_root = fake_proc(&[
            (AGENT, 1, AGENT, AGENT, &format!("{service}/supervisor")),
            (600, 1, 600, 600, &format!("{service}/op-7")),
            (601, 1, 601, 601, &format!("{service}-other/op-7")),
            (
                602,
                1,
                602,
                602,
                "/user.slice/user-1000.slice/session-2.scope",
            ),
        ]);
        assert!(is_command_of_in(proc_root.path(), 600, AGENT));
        assert!(!is_command_of_in(proc_root.path(), 601, AGENT));
        assert!(!is_command_of_in(proc_root.path(), 602, AGENT));
    }

    #[test]
    fn a_real_child_is_a_command_of_this_process() {
        let mut child = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg("sleep 30")
            .spawn()
            .expect("start a child");
        let pid = i32::try_from(child.id()).expect("pid fits");
        let this = i32::try_from(std::process::id()).expect("pid fits");
        assert!(is_command_of(pid, this));
        assert!(!is_command_of(this, pid));
        assert!(!is_command_of(this, this));
        let _ = child.kill();
        let _ = child.wait();
    }

    /// `kill -1` also ends the command's shell, so its orphaned `/bin/kill`
    /// may still be an unreaped zombie whose parents and groups say nothing.
    #[test]
    fn an_exited_sender_not_yet_reaped_is_gone() {
        let proc_root = fake_proc(&[
            (AGENT, KEEPER, KEEPER, 40, "/user.slice/session-1.scope"),
            (700, 1, 0, 0, "/user.slice/session-1.scope"),
        ]);
        let stat = proc_root.path().join("700").join("stat");
        let text = std::fs::read_to_string(&stat).expect("stat");
        std::fs::write(&stat, text.replace(") S ", ") Z ")).expect("zombie stat");
        assert_eq!(
            place_in(proc_root.path(), Some(700), AGENT, |_| false),
            Sender::Gone(700)
        );
    }

    #[test]
    fn a_sender_that_is_gone_is_neither_a_command_nor_outside() {
        let proc_root = fake_proc(&[
            (KEEPER, 50, KEEPER, 40, "/user.slice/session-1.scope"),
            (AGENT, KEEPER, KEEPER, 40, "/user.slice/session-1.scope"),
            (200, AGENT, 200, 40, "/user.slice/session-1.scope"),
        ]);
        // 777 no longer exists; 778 exists but `/proc` hides it (`hidepid`).
        let place = |sender| place_in(proc_root.path(), sender, AGENT, |pid| pid == 777);
        assert_eq!(place(Some(200)), Sender::Command);
        assert_eq!(place(Some(KEEPER)), Sender::Outside(Some(KEEPER)));
        assert_eq!(place(Some(777)), Sender::Gone(777));
        assert_eq!(place(Some(778)), Sender::Outside(Some(778)));
        // The kernel, a sender in an outer PID namespace, and init.
        assert_eq!(place(None), Sender::Outside(None));
        assert_eq!(place(Some(0)), Sender::Outside(Some(0)));
        assert_eq!(
            place_in(proc_root.path(), Some(1), AGENT, |_| true),
            Sender::Outside(Some(1))
        );
    }
}
