//! The graphical desktop session of the user this agent runs as.
//!
//! A per-user service (a lingering systemd user unit) can start before the
//! person's graphical login is usable and inherits no `DISPLAY` or
//! `XAUTHORITY`. Instead of trusting only its inherited environment, the agent
//! asks logind which graphical sessions its own user has, reads each session's
//! display and authority file from the environment of a process in that
//! session, and connects with that authority. The agent's own virtual desktop
//! (the Xvfb `--virtual-desktop` starts) is used alone.
//!
//! Only the user's own sessions that are active (in front on their seat) are
//! used: never another user's screen, the display manager's login screen, or
//! the user's own session while the screen shows another one. An inherited
//! `DISPLAY` is used when it names one of those sessions' displays, or when it
//! is an X server the user runs themselves that no login session claims (a
//! user-started Xvfb or VNC server).
//!
//! logind's session state is read the way sd-login reads it, from
//! `/run/systemd/users/<uid>`, `/run/systemd/sessions/<id>` and
//! `/run/systemd/seats/<seat>`, so no D-Bus round trip or extra dependency is
//! needed. A host without logind has no sessions to check against and keeps
//! the old behaviour: the inherited `DISPLAY`, else `:0`, with the default
//! authority.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead as _, BufReader, Read};
use std::path::{Path, PathBuf};

use x11rb::errors::ConnectError;
use x11rb::reexports::x11rb_protocol::parse_display::{
    parse_display, ConnectAddress, ParsedDisplay,
};
use x11rb::reexports::x11rb_protocol::xauth::{get_auth, Family};
use x11rb::rust_connection::{DefaultStream, RustConnection};

/// The address family and address of a connected X server, as x11rb reports
/// it for the authority lookup.
type PeerAddr = (Family, Vec<u8>);

/// Which user may run the X server of a local display. It is checked before
/// the connection setup, which carries the cookie, is sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum XServerCheck {
    /// The agent's own user: the agent's virtual desktop, an X server the
    /// user runs themselves, or Xwayland.
    AgentUser,
    /// The agent's user or root (a rootful X server): the screen of the
    /// user's own login session, or the display of a host without logind.
    #[default]
    AgentUserOrRoot,
}

/// One X11 display plus the authority file that admits this user to it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct X11Display {
    /// The display name, such as `:0`.
    pub name: String,
    /// The authority file to read the cookie from; `None` uses the X11
    /// default (`$XAUTHORITY`, then `~/.Xauthority`).
    pub authority: Option<PathBuf>,
    /// The logind session this display belongs to, when it was found through
    /// one. A desktop opened on it stops working once that session is no
    /// longer the one on the screen.
    pub session: Option<String>,
    /// Which X server may serve it.
    pub server: XServerCheck,
}

impl X11Display {
    /// A display with the default authority, served by the agent's user or
    /// root.
    #[must_use]
    pub fn named(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            authority: None,
            session: None,
            server: XServerCheck::AgentUserOrRoot,
        }
    }

    /// Connects to this display, reading the cookie from its own authority
    /// file. The file is read on every connect, so a cookie the display manager
    /// rewrites at login is picked up by the next connection.
    ///
    /// A local display (`:N`) is reached only through its socket file in
    /// `/tmp/.X11-unix`, never the abstract socket name or TCP, which any
    /// local user can claim, and the server's user is verified before the
    /// cookie is sent. A display on another host (`host:N`, as X forwarding
    /// or a remote X server names it) is reached over TCP only.
    ///
    /// # Errors
    ///
    /// The X11 connect failure, such as a refused cookie or a server run by
    /// another user.
    pub fn connect(&self) -> Result<(RustConnection, usize), ConnectError> {
        let parsed = parse_display(Some(&self.name))?;
        let (stream, (family, address)) = match display_number(&self.name) {
            Some(number) => self.local_stream(number)?,
            None => remote_stream(&parsed)?,
        };
        let (name, data) = match &self.authority {
            Some(authority) => authority_cookie(authority, family, &address, parsed.display),
            None => get_auth(family, &address, parsed.display).ok().flatten(),
        }
        .unwrap_or_default();
        RustConnection::connect_to_stream_with_auth_info(
            stream,
            usize::from(parsed.screen),
            name,
            data,
        )
        .map(|connection| (connection, usize::from(parsed.screen)))
    }

    /// The display's socket file, once its server is known to be run by a
    /// user this display allows.
    fn local_stream(&self, number: u16) -> Result<(DefaultStream, PeerAddr), ConnectError> {
        let path = SessionRoots::default()
            .x11_sockets
            .join(format!("X{number}"));
        let stream = std::os::unix::net::UnixStream::connect(&path)?;
        let server_uid = rustix::net::sockopt::socket_peercred(&stream)
            .map_err(std::io::Error::from)?
            .uid
            .as_raw();
        let allow_root = self.server == XServerCheck::AgentUserOrRoot;
        if !server_allowed(server_uid, nix::unistd::getuid().as_raw(), allow_root) {
            return Err(ConnectError::IoError(other_users_server(
                &self.name, server_uid,
            )));
        }
        Ok(DefaultStream::from_unix_stream(stream)?)
    }
}

/// The first TCP address of a display on another host that answers.
fn remote_stream(parsed: &ParsedDisplay) -> Result<(DefaultStream, PeerAddr), ConnectError> {
    let mut error = None;
    for address in parsed
        .connect_instruction()
        .filter(|address| matches!(address, ConnectAddress::Hostname(..)))
    {
        match DefaultStream::connect(&address) {
            Ok(connected) => return Ok(connected),
            Err(failure) => error = Some(failure),
        }
    }
    Err(error.map_or(
        ConnectError::DisplayParsingError(x11rb::errors::DisplayParsingError::Unknown),
        ConnectError::IoError,
    ))
}

/// The refusal of a display whose X server runs as a user it may not, with
/// what makes it work.
fn other_users_server(display: &str, server_uid: u32) -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::PermissionDenied,
        format!(
            "the X server of display {display} runs as another user (uid {server_uid}); run the \
             agent as that user, or start it with --virtual-desktop"
        ),
    )
}

/// Whether an X server run by `server_uid` may receive this agent's cookie.
fn server_allowed(server_uid: u32, agent_uid: u32, allow_root: bool) -> bool {
    server_uid == agent_uid || (allow_root && server_uid == 0)
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
    /// Where local X servers put their sockets (`X<number>`).
    pub(crate) x11_sockets: PathBuf,
}

impl Default for SessionRoots {
    fn default() -> Self {
        Self {
            logind: PathBuf::from("/run/systemd"),
            proc: PathBuf::from("/proc"),
            x11_sockets: PathBuf::from("/tmp/.X11-unix"),
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
    /// The user's desktop session exists but another session or console is
    /// on the screen.
    Inactive,
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
    /// An inherited `DISPLAY` that was not tried because it is neither the
    /// screen of the user's login session nor an X server the user runs.
    pub(crate) skipped: Option<String>,
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
    seat: Option<String>,
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
    let inherited = agent.display.as_ref().map(|name| X11Display {
        name: name.clone(),
        authority: agent.xauthority.clone(),
        session: None,
        server: XServerCheck::AgentUserOrRoot,
    });
    // The agent's own virtual desktop is the only display it may use: falling
    // back to the person's screen would surprise them. The agent started its
    // X server itself, so it runs as the agent's user.
    if let Some(inherited) = inherited
        .as_ref()
        .filter(|inherited| agent.virtual_display.as_ref() == Some(&inherited.name))
    {
        return DisplayCandidates {
            displays: vec![X11Display {
                server: XServerCheck::AgentUser,
                ..inherited.clone()
            }],
            absence: Absence::Explicit,
            skipped: None,
        };
    }
    if !roots.logind.join("sessions").is_dir() {
        // Without logind there is no session to check a display against.
        return match inherited {
            Some(inherited) => DisplayCandidates {
                displays: vec![inherited],
                absence: Absence::Explicit,
                skipped: None,
            },
            None => DisplayCandidates {
                displays: vec![X11Display {
                    authority: agent.xauthority.clone(),
                    ..X11Display::named(":0")
                }],
                absence: Absence::NoLogind,
                skipped: None,
            },
        };
    }
    let sessions = session_displays(agent, roots);
    let mut absence = sessions.absence;
    let mut displays: Vec<X11Display> = Vec::new();
    let mut skipped = None;
    if let Some(inherited) = inherited {
        let number = display_number(&inherited.name);
        let claimed = number.is_some_and(|number| {
            sessions.named.contains(&number) || logind_names_display(&roots.logind, number)
        });
        if let Some(session) = sessions
            .active
            .iter()
            .find(|display| number.is_some() && display_number(&display.name) == number)
        {
            // A display inherited from whatever started the agent (a terminal,
            // or a service manager a past login exported it to) names the
            // session's display; its authority is tried first, and the
            // session's own follows in case it is stale.
            displays.push(X11Display {
                session: session.session.clone(),
                server: session.server,
                ..inherited
            });
        } else if !claimed
            && number.is_some_and(|number| {
                x11_socket_owner(&roots.x11_sockets, number) == Some(agent.uid)
            })
        {
            // An X server the user runs themselves (an Xvfb or VNC server)
            // that is no login session's screen.
            displays.push(X11Display {
                server: XServerCheck::AgentUser,
                ..inherited
            });
            if sessions.active.is_empty() {
                absence = Absence::Explicit;
            }
        } else if !claimed {
            // Not a login session's screen (another user's, the login screen
            // or one a past login left behind are claimed and need no word),
            // and not the user's own X server: say why it was not used.
            skipped = Some(inherited.name);
        }
    }
    for display in sessions.active {
        if !displays.contains(&display) {
            displays.push(display);
        }
    }
    DisplayCandidates {
        displays,
        absence,
        skipped,
    }
}

/// The displays of the user's active login sessions, the display numbers any
/// of the user's sessions use, and why the session state suggests there is no
/// desktop when no session is active.
struct SessionDisplays {
    active: Vec<X11Display>,
    named: BTreeSet<u16>,
    absence: Absence,
}

fn session_displays(agent: &AgentIdentity, roots: &SessionRoots) -> SessionDisplays {
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
    let mut active: Vec<X11Display> = Vec::new();
    let mut named = BTreeSet::new();
    let mut wayland = false;
    let mut inactive = false;
    let graphical = |session: &&LogindSession| matches!(session.kind.as_str(), "x11" | "wayland");
    // Graphical sessions, then text sessions on the machine's own seat that
    // started an X server themselves (startx from a console login). A remote
    // text login (SSH) is never the person's screen, whatever it exports.
    for session in sessions.iter().filter(graphical).chain(
        sessions
            .iter()
            .filter(|session| !graphical(session) && session.seat.is_some() && !session.remote),
    ) {
        let environment = environments.get(&session.id);
        let name = environment
            .and_then(|environment| environment.display.clone())
            .or_else(|| {
                (session.kind == "x11")
                    .then(|| session.display.clone())
                    .flatten()
                    .filter(|display| is_local_display(display))
            });
        if let Some(number) = name.as_deref().and_then(display_number) {
            named.insert(number);
        }
        // The user's own session while the screen shows another session or a
        // console: driving it would type into a desktop nobody sees.
        if !session.active {
            inactive |= name.is_some() || graphical(&session);
            continue;
        }
        let Some(name) = name else {
            wayland |= session.kind == "wayland";
            continue;
        };
        let display = X11Display {
            name,
            authority: environment
                .and_then(|environment| environment.authority.clone())
                .or_else(|| default_authority.clone()),
            session: Some(session.id.clone()),
            server: XServerCheck::AgentUserOrRoot,
        };
        if !active.contains(&display) {
            active.push(display);
        }
    }
    let absence = if !active.is_empty() {
        Absence::None
    } else if wayland {
        Absence::Wayland
    } else if inactive {
        Absence::Inactive
    } else if seat_user(&roots.logind, "seat0").is_some_and(|uid| uid != agent.uid) {
        Absence::OtherUser
    } else {
        Absence::NoLogin
    };
    SessionDisplays {
        active,
        named,
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
        .collect::<BTreeSet<_>>()
        .into_iter()
        .map(|id| read_session(logind, &id))
        .filter(|session| {
            session.uid == Some(uid) && session.state != "closing" && session.class != "greeter"
        })
        .collect();
    sessions.sort_by_key(|session| (!session.active, session.remote, session.id != primary));
    sessions
}

const MAX_SESSIONS: usize = 4_096;

/// Whether any logind session, of any user, names display `number` as its
/// screen.
fn logind_names_display(logind: &Path, number: u16) -> bool {
    let Ok(entries) = std::fs::read_dir(logind.join("sessions")) else {
        return false;
    };
    entries.flatten().take(MAX_SESSIONS).any(|entry| {
        let name = entry.file_name();
        // Skip the `<id>.ref` FIFOs next to the state files: opening one
        // would block.
        name.to_str().is_some_and(is_session_id)
            && entry.file_type().is_ok_and(|kind| kind.is_file())
            && read_session(logind, &name.to_string_lossy())
                .display
                .as_deref()
                .and_then(display_number)
                == Some(number)
    })
}

/// The user that owns local X server `number`'s socket, which is the user the
/// server runs as.
fn x11_socket_owner(sockets: &Path, number: u16) -> Option<u32> {
    use std::os::unix::fs::{FileTypeExt as _, MetadataExt as _};
    std::fs::symlink_metadata(sockets.join(format!("X{number}")))
        .ok()
        .filter(|metadata| metadata.file_type().is_socket())
        .map(|metadata| metadata.uid())
}

/// The display number of a local display name (`:0`, `:1.0`, `unix:2`).
fn display_number(name: &str) -> Option<u16> {
    name.strip_prefix("unix")
        .unwrap_or(name)
        .strip_prefix(':')?
        .split('.')
        .next()?
        .parse()
        .ok()
}

/// Whether a logind session is still the one on the screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SessionState {
    Current,
    /// Another session or a console is on the screen.
    Inactive,
    /// The session ended or is closing.
    Ended,
}

pub(crate) fn session_state(logind: &Path, uid: u32, id: &str) -> SessionState {
    if !is_session_id(id) {
        return SessionState::Ended;
    }
    let session = read_session(logind, id);
    if session.uid != Some(uid) || session.state == "closing" {
        SessionState::Ended
    } else if session.active {
        SessionState::Current
    } else {
        SessionState::Inactive
    }
}

const INACTIVE_REASON: &str = "The desktop session of the user the agent runs as is not the one \
                               on this machine's screen right now (the screen was switched to \
                               another session or console). It works once that session is back \
                               on the screen.";

const ENDED_REASON: &str = "The desktop session the agent was using has ended (its user signed \
                            out). It works again once they sign in.";

/// Why a desktop opened on `session` may no longer be used, or `Ok` while it
/// is still the session on the screen.
///
/// # Errors
///
/// The plain reason when the session is no longer on the screen or ended.
pub(crate) fn require_current_session(session: &str) -> Result<(), String> {
    match session_state(
        &SessionRoots::default().logind,
        nix::unistd::getuid().as_raw(),
        session,
    ) {
        SessionState::Current => Ok(()),
        SessionState::Inactive => Err(INACTIVE_REASON.to_string()),
        SessionState::Ended => Err(ENDED_REASON.to_string()),
    }
}

/// The plain reason no desktop is available, from what the session state
/// says and why the last display tried did not open.
pub(crate) fn unavailable_reason(
    candidates: &DisplayCandidates,
    display: &str,
    error: &str,
) -> String {
    let reason = match candidates.absence {
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
        Absence::Inactive => INACTIVE_REASON.to_string(),
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
    };
    match &candidates.skipped {
        Some(skipped) => format!(
            "{reason} The inherited DISPLAY={skipped} was not used: it is not the screen of the \
             agent user's own login session or an X server run by that user. Run that X server \
             as the agent's user, or start the agent with --virtual-desktop."
        ),
        None => reason,
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
        seat: values
            .get("SEAT")
            .filter(|value| !value.is_empty())
            .cloned(),
        active: text("ACTIVE") == "1",
        remote: text("REMOTE") == "1",
    }
}

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
        // DISPLAY and XAUTHORITY come from one process, so a cookie is never
        // paired with another process's display: the first that names a
        // display, preferring one that also names its authority.
        let rank = |environment: &SessionEnvironment| {
            (
                environment.display.is_some(),
                environment.authority.is_some(),
            )
        };
        if environments
            .get(&session)
            .is_some_and(|known| rank(known) == (true, true))
        {
            continue;
        }
        let Some(found) = process_environment(&path.join("environ")) else {
            continue;
        };
        let known = environments.entry(session).or_default();
        if rank(&found) > rank(known) {
            *known = found;
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
            for dir in ["run/sessions", "run/users", "run/seats", "proc", "x11"] {
                std::fs::create_dir_all(root.path().join(dir)).unwrap();
            }
            Self { root }
        }

        fn roots(&self) -> SessionRoots {
            SessionRoots {
                logind: self.root.path().join("run"),
                proc: self.root.path().join("proc"),
                x11_sockets: self.root.path().join("x11"),
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

        /// The socket of a local X server run by the agent's own user.
        fn own_x_server(&self, number: u16) {
            std::os::unix::net::UnixListener::bind(
                self.root.path().join("x11").join(format!("X{number}")),
            )
            .unwrap();
        }
    }

    fn agent() -> AgentIdentity {
        AgentIdentity {
            uid: nix::unistd::getuid().as_raw(),
            ..AgentIdentity::default()
        }
    }

    fn in_session(name: &str, session: &str) -> X11Display {
        X11Display {
            session: Some(session.into()),
            server: XServerCheck::AgentUserOrRoot,
            ..X11Display::named(name)
        }
    }

    /// A display served by an X server the agent's user runs.
    fn own(name: &str) -> X11Display {
        X11Display {
            server: XServerCheck::AgentUser,
            ..X11Display::named(name)
        }
    }

    #[test]
    fn a_virtual_desktop_is_used_alone_and_an_inherited_display_only_for_the_users_screen() {
        let fixture = Fixture::new();
        let agent = agent();
        fixture.user(agent.uid, "c1", "c1");
        fixture.session("c1", agent.uid, "TYPE=x11\nDISPLAY=:0\nACTIVE=1\n");
        fixture.process(500, "c1", &["DISPLAY=:0", "XAUTHORITY=/tmp/session"]);
        // The agent's own virtual desktop is used alone.
        let virtual_desktop = AgentIdentity {
            display: Some(":99".into()),
            virtual_display: Some(":99".into()),
            ..agent.clone()
        };
        let found = display_candidates(&virtual_desktop, &fixture.roots());
        assert_eq!(found.displays, vec![own(":99")]);
        assert_eq!(found.absence, Absence::Explicit);
        // An inherited display naming the session's screen comes first with its
        // own authority, and the session's follows in case that one is stale.
        let inherited = AgentIdentity {
            display: Some(":0".into()),
            xauthority: Some("/tmp/stale".into()),
            ..agent.clone()
        };
        let found = display_candidates(&inherited, &fixture.roots());
        let session = X11Display {
            authority: Some("/tmp/session".into()),
            ..in_session(":0", "c1")
        };
        assert_eq!(
            found.displays,
            vec![
                X11Display {
                    authority: Some("/tmp/stale".into()),
                    ..in_session(":0", "c1")
                },
                session.clone(),
            ]
        );
        assert_eq!(found.absence, Absence::None);
        // Any other inherited display is not the user's screen and is not tried
        // unless the user runs that X server themselves.
        let other = AgentIdentity {
            display: Some(":5".into()),
            ..agent.clone()
        };
        let found = display_candidates(&other, &fixture.roots());
        assert_eq!(found.displays, vec![session.clone()]);
        fixture.own_x_server(5);
        let found = display_candidates(&other, &fixture.roots());
        assert_eq!(found.displays, vec![own(":5"), session]);
        // With nobody signed in, a display a past login left in the service
        // manager's environment is not tried at all.
        let empty = Fixture::new();
        let stale = AgentIdentity {
            display: Some(":0".into()),
            ..agent.clone()
        };
        let found = display_candidates(&stale, &empty.roots());
        assert!(found.displays.is_empty());
        assert_eq!(found.absence, Absence::NoLogin);
        // A user-run X server still opens, and the reason names it.
        empty.own_x_server(5);
        let found = display_candidates(&other, &empty.roots());
        assert_eq!(found.displays, vec![own(":5")]);
        assert_eq!(found.absence, Absence::Explicit);
        // Without logind there is nothing to check against.
        let no_logind = SessionRoots {
            logind: empty.root.path().join("absent"),
            ..empty.roots()
        };
        let found = display_candidates(&stale, &no_logind);
        assert_eq!(found.displays, vec![X11Display::named(":0")]);
        assert_eq!(found.absence, Absence::Explicit);
    }

    #[test]
    fn a_user_run_x_server_that_a_login_session_claims_is_not_taken_for_a_spare_one() {
        let fixture = Fixture::new();
        let agent = AgentIdentity {
            display: Some(":1".into()),
            ..agent()
        };
        fixture.own_x_server(1);
        // The user's own startx session on :1, while the screen shows a console.
        fixture.user(agent.uid, "3", "3");
        fixture.session("3", agent.uid, "TYPE=tty\nSEAT=seat0\nACTIVE=0\n");
        fixture.process(700, "3", &["DISPLAY=:1"]);
        let found = display_candidates(&agent, &fixture.roots());
        assert!(found.displays.is_empty());
        assert_eq!(found.absence, Absence::Inactive);
        // Another user's session naming it in logind is the same.
        let other = Fixture::new();
        other.own_x_server(1);
        other.session("c9", agent.uid + 1, "TYPE=x11\nDISPLAY=:1\nACTIVE=1\n");
        assert!(display_candidates(&agent, &other.roots())
            .displays
            .is_empty());
    }

    #[test]
    fn finds_the_users_x11_session_with_its_authority() {
        let fixture = Fixture::new();
        let agent = agent();
        fixture.user(agent.uid, "c1", "9 c1");
        // An SSH login with X forwarding is not the person's screen, nor is one
        // that exports the seat's display itself.
        fixture.session("9", agent.uid, "TYPE=tty\nREMOTE=1\nACTIVE=1\n");
        fixture.process(
            400,
            "9",
            &["DISPLAY=localhost:10.0", "XAUTHORITY=/tmp/ssh-auth"],
        );
        fixture.process(401, "9", &["DISPLAY=:1", "XAUTHORITY=/tmp/ssh-auth"]);
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
                authority: Some("/home/user/.Xauthority".into()),
                ..in_session(":0", "c1")
            }]
        );
    }

    #[test]
    fn display_and_authority_come_from_the_same_process() {
        let fixture = Fixture::new();
        let agent = agent();
        fixture.user(agent.uid, "c1", "c1");
        fixture.session("c1", agent.uid, "TYPE=x11\nDISPLAY=:0\nACTIVE=1\n");
        // An authority alone, a display alone, then a process with both.
        fixture.process(800, "c1", &["XAUTHORITY=/tmp/other"]);
        fixture.process(801, "c1", &["DISPLAY=:0"]);
        fixture.process(802, "c1", &["DISPLAY=:0", "XAUTHORITY=/tmp/session"]);
        let found = display_candidates(&agent, &fixture.roots());
        assert_eq!(
            found.displays,
            vec![X11Display {
                authority: Some("/tmp/session".into()),
                ..in_session(":0", "c1")
            }]
        );
        // A display alone is never given another process's authority.
        std::fs::remove_dir_all(fixture.root.path().join("proc/802")).unwrap();
        let found = display_candidates(&agent, &fixture.roots());
        assert_eq!(found.displays, vec![in_session(":0", "c1")]);
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
                authority: Some(runtime.join("gdm/Xauthority")),
                ..in_session(":1", "2")
            }]
        );
    }

    #[test]
    fn no_graphical_login_says_so_and_tries_nothing() {
        let fixture = Fixture::new();
        let agent = agent();
        fixture.user(agent.uid, "", "9");
        fixture.session("9", agent.uid, "TYPE=tty\nREMOTE=1\nACTIVE=1\n");
        let found = display_candidates(&agent, &fixture.roots());
        assert_eq!(found.absence, Absence::NoLogin);
        assert!(found.displays.is_empty());
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
        let found = display_candidates(&agent, &fixture.roots());
        assert_eq!(found.absence, Absence::NoLogin);
        assert!(found.displays.is_empty());
    }

    #[test]
    fn another_users_screen_and_wayland_have_their_own_reasons() {
        let fixture = Fixture::new();
        // The agent inherited the seat's display, which belongs to someone else.
        let agent = AgentIdentity {
            display: Some(":0".into()),
            ..agent()
        };
        fixture.write(
            "run/seats/seat0",
            &format!("ACTIVE=c7\nACTIVE_UID={}\n", agent.uid + 1),
        );
        fixture.session("c7", agent.uid + 1, "TYPE=x11\nDISPLAY=:0\nACTIVE=1\n");
        let found = display_candidates(&agent, &fixture.roots());
        assert_eq!(found.absence, Absence::OtherUser);
        assert!(found.displays.is_empty());
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
        fixture.process(600, "4", &["WAYLAND_DISPLAY=wayland-0", "DISPLAY=:1"]);
        let found = display_candidates(&agent, &fixture.roots());
        assert_eq!(found.absence, Absence::None);
        assert_eq!(found.displays, vec![in_session(":1", "4")]);
    }

    #[test]
    fn only_active_sessions_count_and_an_inactive_one_says_so() {
        let fixture = Fixture::new();
        let agent = agent();
        fixture.user(agent.uid, "5", "5 6 7");
        fixture.session("5", agent.uid, "TYPE=x11\nDISPLAY=:0\nSTATE=closing\n");
        fixture.session("6", agent.uid, "TYPE=x11\nDISPLAY=:1\nACTIVE=0\n");
        fixture.session("7", agent.uid, "TYPE=x11\nDISPLAY=:2\nACTIVE=1\n");
        let found = display_candidates(&agent, &fixture.roots());
        assert_eq!(found.displays, vec![in_session(":2", "7")]);
        // Fast user switching moves the screen to another session.
        fixture.session("7", agent.uid, "TYPE=x11\nDISPLAY=:2\nACTIVE=0\n");
        let found = display_candidates(&agent, &fixture.roots());
        assert!(found.displays.is_empty());
        assert_eq!(found.absence, Absence::Inactive);
        assert_eq!(unavailable_reason(&found, ":0", ""), INACTIVE_REASON);
    }

    #[test]
    fn an_open_desktop_follows_its_sessions_state() {
        let fixture = Fixture::new();
        let uid = agent().uid;
        let logind = fixture.roots().logind;
        fixture.session("c1", uid, "TYPE=x11\nACTIVE=1\n");
        assert_eq!(session_state(&logind, uid, "c1"), SessionState::Current);
        fixture.session("c1", uid, "TYPE=x11\nACTIVE=0\n");
        assert_eq!(session_state(&logind, uid, "c1"), SessionState::Inactive);
        fixture.session("c1", uid, "TYPE=x11\nSTATE=closing\nACTIVE=1\n");
        assert_eq!(session_state(&logind, uid, "c1"), SessionState::Ended);
        assert_eq!(session_state(&logind, uid, "c2"), SessionState::Ended);
        assert_eq!(session_state(&logind, uid + 1, "c1"), SessionState::Ended);
        assert_eq!(session_state(&logind, uid, "../c1"), SessionState::Ended);
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
    fn display_numbers_of_local_names() {
        assert_eq!(display_number(":0"), Some(0));
        assert_eq!(display_number(":1.0"), Some(1));
        assert_eq!(display_number("unix:2"), Some(2));
        assert_eq!(display_number("localhost:10.0"), None);
        assert_eq!(display_number("/tmp/launch-abc/org.x:0"), None);
    }

    fn entry(family: u16, address: &[u8], number: &[u8], name: &[u8], data: &[u8]) -> Vec<u8> {
        let mut bytes = family.to_be_bytes().to_vec();
        for field in [address, number, name, data] {
            bytes.extend(u16::try_from(field.len()).unwrap().to_be_bytes());
            bytes.extend(field);
        }
        bytes
    }

    #[test]
    fn reads_the_cookie_for_one_display_from_an_authority_file() {
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

    #[test]
    fn a_server_run_by_another_user_says_what_makes_it_work() {
        let fixture = Fixture::new();
        std::fs::remove_dir_all(fixture.root.path().join("run/sessions")).unwrap();
        let found = display_candidates(&agent(), &fixture.roots());
        let error = other_users_server(":0", 1234).to_string();
        assert_eq!(
            unavailable_reason(&found, ":0", &error),
            "No graphical desktop is reachable: display :0 could not be opened (the X server of \
             display :0 runs as another user (uid 1234); run the agent as that user, or start it \
             with --virtual-desktop)."
        );
    }

    #[test]
    fn only_the_agents_user_or_root_for_its_own_session_may_serve_a_checked_display() {
        assert!(server_allowed(1000, 1000, false));
        assert!(server_allowed(1000, 1000, true));
        assert!(server_allowed(0, 1000, true));
        assert!(!server_allowed(0, 1000, false));
        assert!(!server_allowed(1001, 1000, true));
        assert!(!server_allowed(1001, 1000, false));
    }

    #[test]
    fn a_skipped_inherited_display_is_named_in_the_reason() {
        let fixture = Fixture::new();
        // Inherited :7 has no socket the user owns and nobody is signed in.
        let agent = AgentIdentity {
            display: Some(":7".into()),
            ..agent()
        };
        let found = display_candidates(&agent, &fixture.roots());
        assert!(found.displays.is_empty());
        assert_eq!(found.skipped.as_deref(), Some(":7"));
        let reason = unavailable_reason(&found, ":0", "");
        assert!(
            reason.contains("The inherited DISPLAY=:7 was not used"),
            "{reason}"
        );
        assert!(reason.contains("--virtual-desktop"), "{reason}");
        // A display some login session names needs no extra word.
        fixture.session("c9", agent.uid + 1, "TYPE=x11\nDISPLAY=:7\nACTIVE=1\n");
        assert_eq!(display_candidates(&agent, &fixture.roots()).skipped, None);
    }

    struct RemoveOnDrop(PathBuf);

    impl Drop for RemoveOnDrop {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    fn assert_no_client(listener: &std::os::unix::net::UnixListener, what: impl std::fmt::Display) {
        assert_eq!(
            listener.accept().map(|_| ()).unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock,
            "{what}"
        );
    }

    /// What `listener` receives from a client that connects to the socket
    /// `path` in X11's default order and sends `cookie` in its setup.
    fn default_order_sends(
        listener: &std::os::unix::net::UnixListener,
        path: &Path,
        cookie: &'static [u8],
    ) -> Vec<u8> {
        let address = ConnectAddress::Socket(path.to_string_lossy().into_owned());
        let client = std::thread::spawn(move || {
            let (stream, _) = DefaultStream::connect(&address).unwrap();
            RustConnection::connect_to_stream_with_auth_info(
                stream,
                0,
                MIT_MAGIC_COOKIE_1.to_vec(),
                cookie.to_vec(),
            )
            .is_ok()
        });
        let received = first_client_bytes(listener, cookie);
        assert!(!client.join().unwrap());
        received
    }

    /// What the first client to reach `listener` sends, up to `needle`.
    fn first_client_bytes(listener: &std::os::unix::net::UnixListener, needle: &[u8]) -> Vec<u8> {
        use std::io::Read as _;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut received = Vec::new();
        loop {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    stream.set_nonblocking(false).unwrap();
                    stream
                        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                        .unwrap();
                    let mut chunk = [0_u8; 256];
                    while received
                        .windows(needle.len())
                        .all(|window| window != needle)
                    {
                        match stream.read(&mut chunk) {
                            Ok(0) | Err(_) => break,
                            Ok(read) => received.extend_from_slice(&chunk[..read]),
                        }
                    }
                    return received;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(std::time::Instant::now() < deadline, "no client connected");
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(error) => panic!("accept: {error}"),
            }
        }
    }

    /// The abstract socket name and the TCP port of a display can be claimed
    /// by any local user, and a socket file of the user's own can be stale.
    /// A checked display must never hand its cookie to such a listener.
    #[test]
    fn a_squatted_abstract_x11_socket_never_receives_the_cookie() {
        use std::os::linux::net::SocketAddrExt as _;
        use std::os::unix::net::{SocketAddr, UnixListener};

        let sockets = PathBuf::from("/tmp/.X11-unix");
        let number = 4700 + std::process::id() % 1000;
        let path = sockets.join(format!("X{number}"));
        if !sockets.is_dir() || path.exists() {
            eprintln!(
                "SKIP: {} is missing or {} is taken",
                sockets.display(),
                path.display()
            );
            return;
        }
        // A stale socket file of the user's own: nothing listens on it.
        match UnixListener::bind(&path) {
            Ok(listener) => drop(listener),
            Err(error) => {
                eprintln!("SKIP: cannot create {}: {error}", path.display());
                return;
            }
        }
        let _remove = RemoveOnDrop(path.clone());
        // Someone else's listener on the display's abstract name.
        let squatter = match SocketAddr::from_abstract_name(path.as_os_str().as_encoded_bytes())
            .and_then(|address| UnixListener::bind_addr(&address))
        {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("SKIP: abstract name taken: {error}");
                return;
            }
        };
        squatter.set_nonblocking(true).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let authority = dir.path().join("Xauthority");
        let cookie = b"cookie-of-the-real-desktop";
        std::fs::write(
            &authority,
            entry(65535, b"", b"", MIT_MAGIC_COOKIE_1, cookie),
        )
        .unwrap();

        // With nobody signed in, the inherited display is taken for an X
        // server the user runs, because the user owns its socket file.
        let fixture = Fixture::new();
        let agent = AgentIdentity {
            display: Some(format!(":{number}")),
            xauthority: Some(authority.clone()),
            ..agent()
        };
        let roots = SessionRoots {
            x11_sockets: sockets,
            ..fixture.roots()
        };
        let found = display_candidates(&agent, &roots);
        let display = X11Display {
            authority: Some(authority.clone()),
            ..own(&format!(":{number}"))
        };
        assert_eq!(found.displays, vec![display.clone()]);
        // The checked connect, with and without an authority file, goes to the
        // socket file only and is refused there.
        for display in [
            display.clone(),
            X11Display {
                authority: None,
                ..display.clone()
            },
        ] {
            assert!(display.connect().is_err());
            assert_no_client(
                &squatter,
                format!("{display:?} reached the abstract listener"),
            );
        }
        // So is the display of a host without logind, which root may serve.
        let no_logind = SessionRoots {
            logind: fixture.root.path().join("absent"),
            ..roots
        };
        let found = display_candidates(&agent, &no_logind);
        assert_eq!(found.displays[0].server, XServerCheck::AgentUserOrRoot);
        assert!(found.displays[0].connect().is_err());
        assert_no_client(
            &squatter,
            "the display of a host without logind reached the abstract listener",
        );
        // Typing's keymap lookup on a layout display (Xwayland) is checked the
        // same way and falls back to unchecked keysyms.
        assert_eq!(
            crate::linux::linux_layout_text_keysyms(Some(&format!(":{number}")), "a").unwrap(),
            vec![0x61]
        );
        assert_no_client(&squatter, "the keymap lookup reached the abstract listener");
        // X11's default order (abstract name first) would have handed the
        // cookie to the listener.
        let received = default_order_sends(&squatter, &path, cookie);
        assert!(received
            .windows(cookie.len())
            .any(|window| window == cookie));
    }
}
