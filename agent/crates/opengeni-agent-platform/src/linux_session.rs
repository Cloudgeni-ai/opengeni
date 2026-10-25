//! The graphical desktop session of the user this agent runs as.
//!
//! A per-user service (a lingering systemd user unit) can start before the
//! person's graphical login is usable and inherits no `DISPLAY` or
//! `XAUTHORITY`. Instead of trusting only its inherited environment, the agent
//! asks logind which graphical sessions its own user has, reads each session's
//! display and authority file from the environment of a process in that
//! session, and connects with that authority. An explicit `DISPLAY` (for
//! example the Xvfb `--virtual-desktop` starts) keeps priority.
//!
//! logind's session state is read the way sd-login reads it, from
//! `/run/systemd/users/<uid>`, `/run/systemd/sessions/<id>` and
//! `/run/systemd/seats/<seat>`, so no D-Bus round trip or extra dependency is
//! needed. A host without logind keeps the old behaviour: display `:0` with the
//! default authority.

use std::collections::BTreeMap;
use std::io::{BufRead as _, BufReader, Read};
use std::path::{Path, PathBuf};

use x11rb::errors::ConnectError;
use x11rb::reexports::x11rb_protocol::parse_display::parse_display;
use x11rb::reexports::x11rb_protocol::xauth::Family;
use x11rb::rust_connection::{DefaultStream, RustConnection};

/// One X11 display plus the authority file that admits this user to it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct X11Display {
    /// The display name, such as `:0`.
    pub name: String,
    /// The authority file to read the cookie from; `None` uses the X11
    /// default (`$XAUTHORITY`, then `~/.Xauthority`).
    pub authority: Option<PathBuf>,
}

impl X11Display {
    /// A display with the default authority.
    #[must_use]
    pub fn named(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            authority: None,
        }
    }

    /// Connects to this display, reading the cookie from its own authority
    /// file. The file is read on every connect, so a cookie the display manager
    /// rewrites at login is picked up by the next connection.
    ///
    /// # Errors
    ///
    /// The X11 connect failure, such as a refused cookie.
    pub fn connect(&self) -> Result<(RustConnection, usize), ConnectError> {
        let Some(authority) = &self.authority else {
            return x11rb::connect(Some(&self.name));
        };
        let parsed = parse_display(Some(&self.name))?;
        let screen = usize::from(parsed.screen);
        let mut error = None;
        for address in parsed.connect_instruction() {
            match DefaultStream::connect(&address) {
                Ok((stream, (family, peer))) => {
                    let (name, data) = authority_cookie(authority, family, &peer, parsed.display)
                        .unwrap_or_default();
                    let connection = RustConnection::connect_to_stream_with_auth_info(
                        stream, screen, name, data,
                    )?;
                    return Ok((connection, screen));
                }
                Err(failure) => error = Some(failure),
            }
        }
        Err(error.map_or(
            ConnectError::DisplayParsingError(x11rb::errors::DisplayParsingError::Unknown),
            ConnectError::IoError,
        ))
    }
}

const MIT_MAGIC_COOKIE_1: &[u8] = b"MIT-MAGIC-COOKIE-1";
const MAX_AUTHORITY_BYTES: u64 = 1 << 20;

/// The `MIT-MAGIC-COOKIE-1` entry of an authority file for one display, with
/// the same matching rules as the X11 default lookup.
fn authority_cookie(
    path: &Path,
    family: Family,
    address: &[u8],
    display: u16,
) -> Option<(Vec<u8>, Vec<u8>)> {
    let file = std::fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file.take(MAX_AUTHORITY_BYTES));
    let display = display.to_string();
    loop {
        let entry_family = Family::from(read_u16(&mut reader)?);
        let entry_address = read_counted(&mut reader)?;
        let number = read_counted(&mut reader)?;
        let name = read_counted(&mut reader)?;
        let data = read_counted(&mut reader)?;
        let address_matches = entry_family == Family::WILD
            || family == Family::WILD
            || (entry_family == family && entry_address == address);
        if address_matches
            && (number.is_empty() || number == display.as_bytes())
            && name == MIT_MAGIC_COOKIE_1
        {
            return Some((name, data));
        }
    }
}

fn read_u16(reader: &mut impl Read) -> Option<u16> {
    let mut bytes = [0_u8; 2];
    reader.read_exact(&mut bytes).ok()?;
    Some(u16::from_be_bytes(bytes))
}

fn read_counted(reader: &mut impl Read) -> Option<Vec<u8>> {
    let length = read_u16(reader)?;
    let mut bytes = vec![0_u8; usize::from(length)];
    reader.read_exact(&mut bytes).ok()?;
    Some(bytes)
}

/// What the agent knows about itself for finding its desktop.
#[derive(Debug, Clone, Default)]
pub(crate) struct AgentIdentity {
    pub(crate) uid: u32,
    /// `$DISPLAY`, when set and not empty.
    pub(crate) display: Option<String>,
    /// `$XAUTHORITY`, when set and not empty.
    pub(crate) xauthority: Option<PathBuf>,
    /// `$XDG_RUNTIME_DIR`, else `/run/user/<uid>`.
    pub(crate) runtime_dir: Option<PathBuf>,
    /// The display of the agent's own virtual desktop, when it runs one.
    pub(crate) virtual_display: Option<String>,
}

impl AgentIdentity {
    pub(crate) fn current() -> Self {
        let uid = nix::unistd::getuid().as_raw();
        let set = |name: &str| std::env::var_os(name).filter(|value| !value.is_empty());
        Self {
            uid,
            display: set("DISPLAY").map(|value| value.to_string_lossy().into_owned()),
            xauthority: set("XAUTHORITY").map(PathBuf::from),
            runtime_dir: Some(
                set("XDG_RUNTIME_DIR")
                    .map_or_else(|| PathBuf::from(format!("/run/user/{uid}")), PathBuf::from),
            ),
            virtual_display: set(crate::virtual_desktop::VIRTUAL_DISPLAY_ENV)
                .map(|value| value.to_string_lossy().into_owned()),
        }
    }
}

/// Where logind's state and the process table live; tests point these at a
/// fixture tree.
#[derive(Debug, Clone)]
pub(crate) struct SessionRoots {
    pub(crate) logind: PathBuf,
    pub(crate) proc: PathBuf,
}

impl Default for SessionRoots {
    fn default() -> Self {
        Self {
            logind: PathBuf::from("/run/systemd"),
            proc: PathBuf::from("/proc"),
        }
    }
}

/// Why no display may be reachable, from the session state alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Absence {
    /// The user has a graphical session; a failure is the display's own.
    None,
    /// `DISPLAY` was set explicitly.
    Explicit,
    /// The user has no graphical login session.
    NoLogin,
    /// Another user is signed in to the machine's screen.
    OtherUser,
    /// The user's graphical session runs Wayland with no X11 display.
    Wayland,
    /// The host has no logind state to ask.
    NoLogind,
}

/// The displays to try, best first, and what the session state says when
/// none of them opens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DisplayCandidates {
    pub(crate) displays: Vec<X11Display>,
    pub(crate) absence: Absence,
}

/// One logind session, from its runtime state file.
#[derive(Debug, Clone, Default)]
struct LogindSession {
    id: String,
    uid: Option<u32>,
    kind: String,
    class: String,
    state: String,
    display: Option<String>,
    active: bool,
    remote: bool,
}

/// What a session's processes carry in their environment.
#[derive(Debug, Clone, Default)]
struct SessionEnvironment {
    display: Option<String>,
    authority: Option<PathBuf>,
}

/// Finds the displays this agent's user may use, best first.
pub(crate) fn display_candidates(agent: &AgentIdentity, roots: &SessionRoots) -> DisplayCandidates {
    let Some(name) = &agent.display else {
        return session_candidates(agent, roots);
    };
    let inherited = X11Display {
        name: name.clone(),
        authority: agent.xauthority.clone(),
    };
    // The agent's own virtual desktop is the only display it may use: falling
    // back to the person's screen would surprise them.
    if agent.virtual_display.as_ref() == Some(name) {
        return DisplayCandidates {
            displays: vec![inherited],
            absence: Absence::Explicit,
        };
    }
    // A display inherited from whatever started the agent (a terminal, or a
    // service manager that a past login exported it to) comes first but may be
    // stale, so the user's current session follows it.
    let session = session_candidates(agent, roots);
    match session.absence {
        Absence::NoLogind | Absence::Explicit => DisplayCandidates {
            displays: vec![inherited],
            absence: Absence::Explicit,
        },
        Absence::None => {
            let mut displays = vec![inherited];
            for display in session.displays {
                if !displays.contains(&display) {
                    displays.push(display);
                }
            }
            DisplayCandidates {
                displays,
                absence: Absence::None,
            }
        }
        absence => DisplayCandidates {
            displays: vec![inherited],
            absence,
        },
    }
}

/// The displays of the user's login sessions, or the default display and why
/// the session state suggests it may not open.
fn session_candidates(agent: &AgentIdentity, roots: &SessionRoots) -> DisplayCandidates {
    let fallback = X11Display {
        name: ":0".to_string(),
        authority: agent.xauthority.clone(),
    };
    if !roots.logind.join("sessions").is_dir() {
        return DisplayCandidates {
            displays: vec![fallback],
            absence: Absence::NoLogind,
        };
    }
    let sessions = user_sessions(agent.uid, &roots.logind);
    let environments = if sessions.is_empty() {
        BTreeMap::new()
    } else {
        session_environments(&roots.proc, agent.uid)
    };
    let default_authority = agent.xauthority.clone().or_else(|| {
        agent
            .runtime_dir
            .as_ref()
            .map(|dir| dir.join("gdm").join("Xauthority"))
            .filter(|path| path.is_file())
    });
    let mut displays: Vec<X11Display> = Vec::new();
    let mut wayland = false;
    let graphical = |session: &&LogindSession| matches!(session.kind.as_str(), "x11" | "wayland");
    // Graphical sessions, then text sessions that started an X server
    // themselves (startx from a console login).
    for session in sessions
        .iter()
        .filter(graphical)
        .chain(sessions.iter().filter(|session| !graphical(session)))
    {
        let environment = environments.get(&session.id);
        let name = environment
            .and_then(|environment| environment.display.clone())
            .or_else(|| {
                (session.kind == "x11")
                    .then(|| session.display.clone())
                    .flatten()
                    .filter(|display| is_local_display(display))
            });
        let Some(name) = name else {
            wayland |= session.kind == "wayland";
            continue;
        };
        let display = X11Display {
            name,
            authority: environment
                .and_then(|environment| environment.authority.clone())
                .or_else(|| default_authority.clone()),
        };
        if !displays.contains(&display) {
            displays.push(display);
        }
    }
    if !displays.is_empty() {
        return DisplayCandidates {
            displays,
            absence: Absence::None,
        };
    }
    let absence = if wayland {
        Absence::Wayland
    } else if seat_user(&roots.logind, "seat0").is_some_and(|uid| uid != agent.uid) {
        Absence::OtherUser
    } else {
        Absence::NoLogin
    };
    // An X server that logind does not know about (started outside any login
    // session) still opens as before.
    DisplayCandidates {
        displays: vec![X11Display {
            authority: default_authority.or(fallback.authority),
            ..fallback
        }],
        absence,
    }
}

/// The user's open, non-greeter logind sessions: active local ones first,
/// logind's own pick for the user's display first among equals.
fn user_sessions(uid: u32, logind: &Path) -> Vec<LogindSession> {
    let user = key_values(&logind.join("users").join(uid.to_string()));
    let primary = user.get("DISPLAY").cloned().unwrap_or_default();
    let mut sessions: Vec<LogindSession> = user
        .get("SESSIONS")
        .map(|ids| {
            ids.split_whitespace()
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
        .into_iter()
        .chain((!primary.is_empty()).then(|| primary.clone()))
        .filter(|id| is_session_id(id))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .map(|id| read_session(logind, &id))
        .filter(|session| {
            session.uid == Some(uid) && session.state != "closing" && session.class != "greeter"
        })
        .collect();
    sessions.sort_by_key(|session| (!session.active, session.remote, session.id != primary));
    sessions
}

/// The plain reason no desktop is available, from what the session state
/// says and why the last display tried did not open.
pub(crate) fn unavailable_reason(
    candidates: &DisplayCandidates,
    display: &str,
    error: &str,
) -> String {
    match candidates.absence {
        Absence::Explicit => format!(
            "The display this agent was started with (DISPLAY={display}) could not be opened: {error}."
        ),
        Absence::None => format!(
            "The desktop on display {display} could not be opened: {error}. While someone is \
             signing in this clears within seconds; the agent checks again on its own."
        ),
        Absence::NoLogin => "No one is signed in to a desktop on this machine as the user the \
                             agent runs as. It works once that user signs in to an X11 desktop \
                             session on the machine's screen."
            .to_string(),
        Absence::OtherUser => "Another user is signed in to this machine's screen. The agent can \
                               only use the desktop of the user it runs as, so it works once \
                               that user signs in."
            .to_string(),
        Absence::Wayland => "The signed-in desktop session uses Wayland without an X11 display, \
                             which the agent needs to see the screen. It works in an X11 (Xorg) \
                             desktop session."
            .to_string(),
        Absence::NoLogind => {
            format!("No graphical desktop is reachable: display {display} could not be opened ({error}).")
        }
    }
}

fn is_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// A display on this machine (`:0`, `:1.0`, `unix:0`), not a forwarded one
/// such as an SSH session's `localhost:10`.
fn is_local_display(display: &str) -> bool {
    display.starts_with(':') || display.starts_with("unix:") || display.starts_with('/')
}

/// A logind state file's `KEY=VALUE` lines.
fn key_values(path: &Path) -> BTreeMap<String, String> {
    let Ok(file) = std::fs::File::open(path) else {
        return BTreeMap::new();
    };
    BufReader::new(file.take(64 * 1024))
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| {
            let (key, value) = line.split_once('=')?;
            Some((key.to_string(), value.to_string()))
        })
        .collect()
}

fn read_session(logind: &Path, id: &str) -> LogindSession {
    let values = key_values(&logind.join("sessions").join(id));
    let text = |key: &str| values.get(key).cloned().unwrap_or_default();
    LogindSession {
        id: id.to_string(),
        uid: values.get("UID").and_then(|uid| uid.parse().ok()),
        kind: text("TYPE"),
        class: text("CLASS"),
        state: text("STATE"),
        display: values
            .get("DISPLAY")
            .filter(|value| !value.is_empty())
            .cloned(),
        active: text("ACTIVE") == "1",
        remote: text("REMOTE") == "1",
    }
}

/// The user whose session is in front on a seat.
/// The user signed in on `seat`'s screen. `None` when nobody is, which
/// includes the display manager's login screen: its greeter session runs as
/// a system user but is no one's desktop.
fn seat_user(logind: &Path, seat: &str) -> Option<u32> {
    let seat = key_values(&logind.join("seats").join(seat));
    if seat
        .get("ACTIVE")
        .filter(|id| is_session_id(id))
        .is_some_and(|id| read_session(logind, id).class == "greeter")
    {
        return None;
    }
    seat.get("ACTIVE_UID").and_then(|uid| uid.parse().ok())
}

const MAX_PROCESSES: usize = 65_536;
const MAX_ENVIRON_BYTES: u64 = 256 * 1024;

/// The display and authority each of the user's login sessions carries in its
/// processes' environment. Only processes inside a login session's scope count,
/// so an Xvfb or a headless browser the agent itself started is never taken for
/// the person's desktop.
fn session_environments(proc: &Path, uid: u32) -> BTreeMap<String, SessionEnvironment> {
    use std::os::unix::fs::MetadataExt as _;
    let mut environments: BTreeMap<String, SessionEnvironment> = BTreeMap::new();
    let Ok(entries) = std::fs::read_dir(proc) else {
        return environments;
    };
    for entry in entries.flatten().take(MAX_PROCESSES) {
        let name = entry.file_name();
        if !name
            .to_str()
            .is_some_and(|pid| pid.bytes().all(|byte| byte.is_ascii_digit()))
        {
            continue;
        }
        let path = entry.path();
        if !std::fs::metadata(&path).is_ok_and(|metadata| metadata.uid() == uid) {
            continue;
        }
        let Some(session) = std::fs::read_to_string(path.join("cgroup"))
            .ok()
            .and_then(|cgroup| login_session_of(&cgroup))
        else {
            continue;
        };
        if environments
            .get(&session)
            .is_some_and(|known| known.display.is_some() && known.authority.is_some())
        {
            continue;
        }
        let Some(found) = process_environment(&path.join("environ")) else {
            continue;
        };
        let known = environments.entry(session).or_default();
        if known.display.is_none() {
            known.display = found.display;
        }
        if known.authority.is_none() {
            known.authority = found.authority;
        }
    }
    environments
}

/// The logind session a process's cgroup places it in (`session-<id>.scope`).
fn login_session_of(cgroup: &str) -> Option<String> {
    cgroup.lines().find_map(|line| {
        line.rsplit('/').find_map(|part| {
            part.strip_prefix("session-")
                .and_then(|rest| rest.strip_suffix(".scope"))
                .filter(|id| is_session_id(id))
                .map(str::to_string)
        })
    })
}

fn process_environment(path: &Path) -> Option<SessionEnvironment> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(MAX_ENVIRON_BYTES)
        .read_to_end(&mut bytes)
        .ok()?;
    let mut found = SessionEnvironment::default();
    for variable in bytes.split(|&byte| byte == 0) {
        let variable = String::from_utf8_lossy(variable);
        if let Some(display) = variable.strip_prefix("DISPLAY=") {
            if is_local_display(display) {
                found.display = Some(display.to_string());
            }
        } else if let Some(authority) = variable.strip_prefix("XAUTHORITY=") {
            if !authority.is_empty() {
                found.authority = Some(PathBuf::from(authority));
            }
        }
    }
    (found.display.is_some() || found.authority.is_some()).then_some(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        root: tempfile::TempDir,
    }

    impl Fixture {
        fn new() -> Self {
            let root = tempfile::tempdir().expect("fixture root");
            std::fs::create_dir_all(root.path().join("run/sessions")).unwrap();
            std::fs::create_dir_all(root.path().join("run/users")).unwrap();
            std::fs::create_dir_all(root.path().join("run/seats")).unwrap();
            std::fs::create_dir_all(root.path().join("proc")).unwrap();
            Self { root }
        }

        fn roots(&self) -> SessionRoots {
            SessionRoots {
                logind: self.root.path().join("run"),
                proc: self.root.path().join("proc"),
            }
        }

        fn write(&self, path: &str, body: &str) {
            let path = self.root.path().join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, body).unwrap();
        }

        fn user(&self, uid: u32, display: &str, sessions: &str) {
            self.write(
                &format!("run/users/{uid}"),
                &format!("NAME=person\nSTATE=active\nDISPLAY={display}\nSESSIONS={sessions}\n"),
            );
        }

        fn session(&self, id: &str, uid: u32, fields: &str) {
            self.write(
                &format!("run/sessions/{id}"),
                &format!("UID={uid}\nSTATE=active\n{fields}"),
            );
        }

        /// A process of the agent's own user in `session`'s scope.
        fn process(&self, pid: u32, session: &str, environ: &[&str]) {
            self.write(
                &format!("proc/{pid}/cgroup"),
                &format!("0::/user.slice/user-1000.slice/session-{session}.scope\n"),
            );
            self.write(&format!("proc/{pid}/environ"), &environ.join("\0"));
        }
    }

    fn agent() -> AgentIdentity {
        AgentIdentity {
            uid: nix::unistd::getuid().as_raw(),
            ..AgentIdentity::default()
        }
    }

    #[test]
    fn an_inherited_display_comes_first_and_a_virtual_desktop_is_used_alone() {
        let fixture = Fixture::new();
        let agent = AgentIdentity {
            display: Some(":99".into()),
            ..agent()
        };
        fixture.user(agent.uid, "c1", "c1");
        fixture.session("c1", agent.uid, "TYPE=x11\nDISPLAY=:0\nACTIVE=1\n");
        // The agent's own virtual desktop is used alone.
        let virtual_desktop = AgentIdentity {
            virtual_display: Some(":99".into()),
            ..agent.clone()
        };
        let found = display_candidates(&virtual_desktop, &fixture.roots());
        assert_eq!(found.displays, vec![X11Display::named(":99")]);
        assert_eq!(found.absence, Absence::Explicit);
        // An inherited display comes first, and the current session follows in
        // case it is stale (left behind by an earlier login).
        let found = display_candidates(&agent, &fixture.roots());
        assert_eq!(
            found.displays,
            vec![X11Display::named(":99"), X11Display::named(":0")]
        );
        assert_eq!(found.absence, Absence::None);
        // With nobody signed in, the reason says so rather than blaming the
        // inherited display.
        let empty = Fixture::new();
        let found = display_candidates(&agent, &empty.roots());
        assert_eq!(found.displays, vec![X11Display::named(":99")]);
        assert_eq!(found.absence, Absence::NoLogin);
        // Without logind there is nothing else to try.
        let no_logind = SessionRoots {
            logind: empty.root.path().join("absent"),
            proc: empty.root.path().join("proc"),
        };
        let found = display_candidates(&agent, &no_logind);
        assert_eq!(found.absence, Absence::Explicit);
    }

    #[test]
    fn finds_the_users_x11_session_with_its_authority() {
        let fixture = Fixture::new();
        let agent = agent();
        fixture.user(agent.uid, "c1", "9 c1");
        // An SSH login with X forwarding is not the person's screen.
        fixture.session("9", agent.uid, "TYPE=tty\nREMOTE=1\nACTIVE=1\n");
        fixture.process(
            400,
            "9",
            &["DISPLAY=localhost:10.0", "XAUTHORITY=/tmp/ssh-auth"],
        );
        fixture.session(
            "c1",
            agent.uid,
            "TYPE=x11\nDISPLAY=:0\nACTIVE=1\nSEAT=seat0\n",
        );
        fixture.process(
            500,
            "c1",
            &[
                "HOME=/home/user",
                "XAUTHORITY=/home/user/.Xauthority",
                "DISPLAY=:0",
            ],
        );
        let found = display_candidates(&agent, &fixture.roots());
        assert_eq!(found.absence, Absence::None);
        assert_eq!(
            found.displays,
            vec![X11Display {
                name: ":0".into(),
                authority: Some("/home/user/.Xauthority".into()),
            }]
        );
    }

    #[test]
    fn a_session_whose_processes_cannot_be_read_uses_logind_display_and_the_runtime_authority() {
        let fixture = Fixture::new();
        let runtime = fixture.root.path().join("runtime");
        std::fs::create_dir_all(runtime.join("gdm")).unwrap();
        std::fs::write(runtime.join("gdm/Xauthority"), b"").unwrap();
        let agent = AgentIdentity {
            runtime_dir: Some(runtime.clone()),
            ..agent()
        };
        fixture.user(agent.uid, "2", "2");
        fixture.session("2", agent.uid, "TYPE=x11\nDISPLAY=:1\nACTIVE=1\n");
        let found = display_candidates(&agent, &fixture.roots());
        assert_eq!(
            found.displays,
            vec![X11Display {
                name: ":1".into(),
                authority: Some(runtime.join("gdm/Xauthority")),
            }]
        );
    }

    #[test]
    fn no_graphical_login_says_so_and_still_tries_the_default_display() {
        let fixture = Fixture::new();
        let agent = agent();
        fixture.user(agent.uid, "", "9");
        fixture.session("9", agent.uid, "TYPE=tty\nREMOTE=1\nACTIVE=1\n");
        let found = display_candidates(&agent, &fixture.roots());
        assert_eq!(found.absence, Absence::NoLogin);
        assert_eq!(found.displays, vec![X11Display::named(":0")]);
        // A lingering user with no session at all is the same.
        std::fs::remove_file(fixture.root.path().join(format!("run/users/{}", agent.uid))).unwrap();
        assert_eq!(
            display_candidates(&agent, &fixture.roots()).absence,
            Absence::NoLogin
        );
        // So is the login screen, which belongs to the display manager.
        fixture.user(agent.uid, "c3", "c3");
        fixture.session(
            "c3",
            agent.uid,
            "TYPE=x11\nCLASS=greeter\nDISPLAY=:0\nACTIVE=1\n",
        );
        assert_eq!(
            display_candidates(&agent, &fixture.roots()).absence,
            Absence::NoLogin
        );
    }

    #[test]
    fn another_users_screen_and_wayland_have_their_own_reasons() {
        let fixture = Fixture::new();
        let agent = agent();
        fixture.write(
            "run/seats/seat0",
            &format!("ACTIVE=c7\nACTIVE_UID={}\n", agent.uid + 1),
        );
        assert_eq!(
            display_candidates(&agent, &fixture.roots()).absence,
            Absence::OtherUser
        );
        // The display manager's login screen after a sign-out is nobody's
        // desktop, not another user's.
        fixture.write(
            "run/seats/seat0",
            &format!("ACTIVE=c2\nACTIVE_UID={}\n", agent.uid + 1),
        );
        fixture.session("c2", agent.uid + 1, "TYPE=x11\nCLASS=greeter\nACTIVE=1\n");
        assert_eq!(
            display_candidates(&agent, &fixture.roots()).absence,
            Absence::NoLogin
        );
        fixture.user(agent.uid, "4", "4");
        fixture.session("4", agent.uid, "TYPE=wayland\nACTIVE=1\n");
        assert_eq!(
            display_candidates(&agent, &fixture.roots()).absence,
            Absence::Wayland
        );
        // A Wayland session with Xwayland names its X11 display.
        fixture.process(600, "4", &["WAYLAND_DISPLAY=wayland-0", "DISPLAY=:0"]);
        let found = display_candidates(&agent, &fixture.roots());
        assert_eq!(found.absence, Absence::None);
        assert_eq!(found.displays, vec![X11Display::named(":0")]);
    }

    #[test]
    fn a_closing_session_does_not_count_and_the_active_one_comes_first() {
        let fixture = Fixture::new();
        let agent = agent();
        fixture.user(agent.uid, "5", "5 6 7");
        fixture.session("5", agent.uid, "TYPE=x11\nDISPLAY=:0\nSTATE=closing\n");
        fixture.session("6", agent.uid, "TYPE=x11\nDISPLAY=:1\nACTIVE=0\n");
        fixture.session("7", agent.uid, "TYPE=x11\nDISPLAY=:2\nACTIVE=1\n");
        let names: Vec<String> = display_candidates(&agent, &fixture.roots())
            .displays
            .into_iter()
            .map(|display| display.name)
            .collect();
        assert_eq!(names, vec![":2", ":1"]);
    }

    #[test]
    fn a_host_without_logind_tries_the_default_display() {
        let fixture = Fixture::new();
        std::fs::remove_dir_all(fixture.root.path().join("run/sessions")).unwrap();
        let found = display_candidates(&agent(), &fixture.roots());
        assert_eq!(found.absence, Absence::NoLogind);
        assert_eq!(found.displays, vec![X11Display::named(":0")]);
    }

    #[test]
    fn reads_the_cookie_for_one_display_from_an_authority_file() {
        fn entry(family: u16, address: &[u8], number: &[u8], name: &[u8], data: &[u8]) -> Vec<u8> {
            let mut bytes = family.to_be_bytes().to_vec();
            for field in [address, number, name, data] {
                bytes.extend(u16::try_from(field.len()).unwrap().to_be_bytes());
                bytes.extend(field);
            }
            bytes
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Xauthority");
        let mut file = entry(256, b"host", b"1", MIT_MAGIC_COOKIE_1, b"one");
        file.extend(entry(
            256,
            b"other",
            b"0",
            MIT_MAGIC_COOKIE_1,
            b"other-host",
        ));
        file.extend(entry(256, b"host", b"0", b"XDM-AUTHORIZATION-1", b"xdm"));
        file.extend(entry(256, b"host", b"0", MIT_MAGIC_COOKIE_1, b"zero"));
        std::fs::write(&path, file).unwrap();
        let cookie = |display| authority_cookie(&path, Family::LOCAL, b"host", display);
        assert_eq!(cookie(0).map(|(_, data)| data), Some(b"zero".to_vec()));
        assert_eq!(cookie(1).map(|(_, data)| data), Some(b"one".to_vec()));
        assert_eq!(cookie(2), None);
        assert_eq!(
            authority_cookie(&dir.path().join("missing"), Family::LOCAL, b"host", 0),
            None
        );
    }
}
