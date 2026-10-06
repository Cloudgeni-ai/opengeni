//! Per-invocation disk journal. Reuses the image's existing native subreaper;
//! no enrollment, bus connection, resident global daemon, or numeric PID signal.
//!
//! At-most-once launch requires intact authoritative disk history. The control
//! plane retains dispatch/lineage authority; a missing claim after rollback is
//! not permission to start an old operation on a replacement machine.

pub mod model;

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read as _, Seek as _, Write as _};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use rand::RngCore as _;
use serde::Serialize;
use sha2::{Digest as _, Sha256};

use model::{
    CancellationClaim, Claim, InputAction, InputClaim, InputObservation, InputRequest, InputStatus,
    NativeInputReply, NativeReply, Observation, OutputPage, QuiescenceReceipt, StartRequest, State,
    Terminal,
};

/// Maximum response page diameter, not an execution/output lifetime limit.
pub const MAX_PAGE_BYTES: usize = 1024 * 1024;
/// Linux PIPE_BUF-sized input actions; larger input uses ordered chunks.
pub const MAX_INPUT_BYTES: usize = 4096;

fn error(message: &str) -> io::Error {
    io::Error::other(message)
}
fn json_error(_error: serde_json::Error) -> io::Error {
    error("Invalid journal protocol data")
}
fn canonical_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}
fn validate_id(value: &str) -> io::Result<()> {
    if canonical_uuid(value) {
        Ok(())
    } else {
        Err(error("Operation ID must be a canonical UUID"))
    }
}
fn validate_request(request: &StartRequest) -> io::Result<()> {
    validate_id(&request.operation_id)?;
    if !canonical_uuid(&request.disk_lineage)
        || request.boot_id.len() != 64
        || !request.boot_id.bytes().all(|byte| byte.is_ascii_hexdigit())
        || !Path::new(&request.program).is_absolute()
        || !Path::new(&request.cwd).is_absolute()
        || request.pty.as_ref().is_some_and(|pty| {
            !request.stdin
                || pty.columns == 0
                || pty.rows == 0
                || pty.columns > 5000
                || pty.rows > 5000
        })
        || [&request.program, &request.cwd]
            .into_iter()
            .chain(request.args.iter())
            .any(|v| v.contains('\0'))
        || request
            .environment
            .iter()
            .any(|(key, value)| key.is_empty() || key.contains(['=', '\0']) || value.contains('\0'))
    {
        return Err(error("Invalid command specification"));
    }
    Ok(())
}

fn create_private_directory(path: &Path) -> io::Result<bool> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt as _;
        builder.mode(0o700);
    }
    match builder.create(path) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(e),
    }
}

fn input_parts(action: &InputAction) -> io::Result<(&str, u16, u16, &str)> {
    match action {
        InputAction::Data { base64 } => {
            let data = STANDARD
                .decode(base64)
                .map_err(|_| error("Invalid input encoding"))?;
            if data.is_empty() || data.len() > MAX_INPUT_BYTES || STANDARD.encode(&data) != *base64
            {
                return Err(error("Invalid input byte chunk"));
            }
            Ok(("data", 0, 0, base64.as_str()))
        }
        InputAction::Close => Ok(("close", 0, 0, "-")),
        InputAction::Resize { columns, rows }
            if *columns > 0 && *rows > 0 && *columns <= 5000 && *rows <= 5000 =>
        {
            Ok(("resize", *columns, *rows, "-"))
        }
        InputAction::Resize { .. } => Err(error("Invalid terminal dimensions")),
    }
}
fn private_directory(path: &Path) -> io::Result<()> {
    create_private_directory(path)?;
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() {
        return Err(error("Journal directory is not a real directory"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(error("Journal directory must be private"));
        }
    }
    Ok(())
}
fn file_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    options
}
fn sync_directory(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}
fn remove_payload(claim: &Claim) -> io::Result<()> {
    let path = Path::new("/dev/shm/opengeni-run-launch").join(format!("{}.json", claim.nonce));
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

struct PendingPublication(PathBuf);
impl Drop for PendingPublication {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
fn write_once<T: Serialize>(path: &Path, value: &T) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| error("Missing journal parent"))?;
    let temporary = parent.join(format!(".{}.partial", uuid::Uuid::new_v4()));
    let mut file = file_options()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    let cleanup = PendingPublication(temporary.clone());
    file.write_all(&serde_json::to_vec(value).map_err(json_error)?)?;
    file.sync_all()?;
    // Hard link publishes a complete immutable file without overwriting a peer.
    let published = fs::hard_link(&temporary, path);
    fs::remove_file(temporary)?;
    drop(cleanup);
    match published {
        Ok(()) => sync_directory(parent),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => sync_directory(parent),
        Err(e) => Err(e),
    }
}
fn write_payload(path: &Path, request: &StartRequest) -> io::Result<()> {
    // No helper exists yet, so this exact nonce path needs no anonymous atomic
    // publication. Even a crash mid-write leaves only a claim-bound file that
    // cancellation can erase, never an unidentifiable secret partial.
    let bytes = serde_json::to_vec(request).map_err(json_error)?;
    let mut file = file_options().write(true).create_new(true).open(path)?;
    let result = file.write_all(&bytes).and_then(|()| file.sync_all());
    if result.is_err() {
        let _ = fs::remove_file(path);
    }
    result
}
fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> io::Result<T> {
    serde_json::from_reader(File::open(path)?).map_err(json_error)
}

/// Kernel boot plus PID-1 start time, hashed to a portable process-survival marker.
/// A disk-resident marker by itself cannot prove memory survival.
///
/// # Errors
/// Fails closed where Linux procfs identity is unavailable.
pub fn boot_identity() -> io::Result<String> {
    let boot = fs::read_to_string("/proc/sys/kernel/random/boot_id")?;
    let stat = fs::read_to_string("/proc/1/stat")?;
    let (_, fields) = stat
        .rsplit_once(") ")
        .ok_or_else(|| error("Invalid PID-1 identity"))?;
    // Fields start at kernel stat field 3 (state); starttime is field 22.
    let started = fields
        .split_whitespace()
        .nth(19)
        .ok_or_else(|| error("Missing PID-1 start time"))?;
    Ok(hex::encode(Sha256::digest(
        format!("{}:{started}", boot.trim()).as_bytes(),
    )))
}

/// Configured journal directory and exact native helper executable.
pub struct Journal {
    root: PathBuf,
    supervisor: PathBuf,
}
impl Journal {
    /// Opens a private existing parent directory. Do not place control credentials
    /// or journal roots in a publicly served workspace path.
    ///
    /// # Errors
    /// Invalid paths, permissions or filesystem errors.
    pub fn open(root: PathBuf, supervisor: PathBuf) -> io::Result<Self> {
        if !root.is_absolute() || !supervisor.is_absolute() {
            return Err(error("Journal paths must be absolute"));
        }
        private_directory(&root)?;
        Ok(Self { root, supervisor })
    }

    /// Probes the existing native helper's real kernel prerequisites.
    ///
    /// # Errors
    /// Unsupported kernel/image or malformed helper result.
    pub fn capabilities(&self) -> io::Result<String> {
        let output = Command::new(&self.supervisor)
            .arg("journal-capabilities")
            .env_clear()
            .output()?;
        if !output.status.success() || output.stdout != b"native-journal-v1" {
            return Err(error("Native command supervision is unavailable"));
        }
        boot_identity()
    }

    /// Probe native pipe and PTY primitives without launching user code.
    ///
    /// # Errors
    /// Unsupported helper or terminal/kernel primitives.
    pub fn io_capabilities(&self) -> io::Result<()> {
        let output = Command::new(&self.supervisor)
            .arg("capabilities-io")
            .env_clear()
            .output()?;
        if !output.status.success() || output.stdout != b"native-subreaper-io-v1" {
            return Err(error("Native command I/O is unavailable"));
        }
        Ok(())
    }

    fn operation(&self, id: &str) -> io::Result<PathBuf> {
        validate_id(id)?;
        Ok(self.root.join(id))
    }
    fn claim(directory: &Path) -> io::Result<Claim> {
        let claim: Claim = read_json(&directory.join("claim.json"))?;
        if claim.version != 1
            || !canonical_uuid(&claim.operation_id)
            || claim.nonce.len() != 64
            || !claim.nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
            || !canonical_uuid(&claim.disk_lineage)
            || claim.pty.as_ref().is_some_and(|pty| {
                !claim.stdin
                    || pty.columns == 0
                    || pty.rows == 0
                    || pty.columns > 5000
                    || pty.rows > 5000
            })
            || claim.control_path
                != format!("/dev/shm/opengeni-run-control/{}.sock", claim.operation_id)
        {
            return Err(error("Invalid journal claim"));
        }
        Ok(claim)
    }
    fn control_command(&self, claim: &Claim, action: &str, receipt: Option<&str>) -> Command {
        let mut command = Command::new(&self.supervisor);
        command.env_clear().args([
            "control",
            "--invocation",
            &claim.operation_id,
            "--nonce",
            &claim.nonce,
            "--socket",
            &claim.control_path,
            "--action",
            action,
        ]);
        if let Some(receipt) = receipt {
            command.args(["--receipt", receipt]);
        }
        command
    }

    fn control(
        &self,
        claim: &Claim,
        action: &str,
        receipt: Option<&str>,
    ) -> io::Result<NativeReply> {
        let mut command = self.control_command(claim, action, receipt);
        let output = command.output()?;
        if !output.status.success() || output.stdout.len() > 4096 {
            return Err(error("Native command observation unavailable"));
        }
        serde_json::from_slice(&output.stdout).map_err(json_error)
    }

    fn launch_claim(
        &self,
        directory: &Path,
        request: &StartRequest,
        digest: &str,
    ) -> io::Result<()> {
        sync_directory(&self.root)?;
        let mut nonce = [0_u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut nonce);
        let claim = Claim {
            version: 1,
            operation_id: request.operation_id.clone(),
            disk_lineage: request.disk_lineage.clone(),
            boot_id: request.boot_id.clone(),
            specification_digest: digest.to_owned(),
            nonce: hex::encode(nonce),
            control_path: format!(
                "/dev/shm/opengeni-run-control/{}.sock",
                request.operation_id
            ),
            stdin: request.stdin,
            pty: request.pty.clone(),
        };
        write_once(&directory.join("claim.json"), &claim)?;
        // Secrets exist only in a private tmpfs handoff. The native supervisor
        // itself never inherits the child's LD_PRELOAD or other environment.
        let volatile_root = PathBuf::from("/dev/shm/opengeni-run-launch");
        private_directory(&volatile_root)?;
        let volatile = volatile_root.join(format!("{}.json", claim.nonce));
        let stdout = file_options()
            .append(true)
            .create_new(true)
            .open(directory.join("stdout"))?;
        let stderr = file_options()
            .append(true)
            .create_new(true)
            .open(directory.join("stderr"))?;
        stdout.sync_all()?;
        stderr.sync_all()?;
        sync_directory(directory)?;
        let mut command = Command::new(&self.supervisor);
        command.env_clear().args([
            "launch",
            "--capture-output",
            "--invocation",
            &claim.operation_id,
            "--nonce",
            &claim.nonce,
            "--socket",
            &claim.control_path,
        ]);
        if request.stdin {
            command.args(["--io", if request.pty.is_some() { "pty" } else { "pipe" }]);
        }
        if let Some(pty) = &request.pty {
            command.args([
                "--cols",
                &pty.columns.to_string(),
                "--rows",
                &pty.rows.to_string(),
            ]);
        }
        command
            .arg("--")
            .arg(std::env::current_exe()?)
            .args(["__exec", "--payload"])
            .arg(&volatile)
            .args(["--digest", digest])
            .stdin(Stdio::null())
            .stdout(stdout)
            .stderr(stderr);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt as _;
            command.process_group(0);
        }
        // No waiting handle owns the invocation: the native per-op subreaper
        // survives the ordinary provider exec and retains proof until ACK.
        write_payload(&volatile, request)?;
        if directory.join("cancel.json").exists() {
            remove_payload(&claim)?;
            write_once(
                &directory.join("no-launch.json"),
                &CancellationClaim {
                    operation_id: request.operation_id.clone(),
                    boot_id: request.boot_id.clone(),
                    disk_lineage: request.disk_lineage.clone(),
                },
            )?;
            return Ok(());
        }
        match command.spawn() {
            Ok(child) => drop(child),
            Err(failure) => {
                remove_payload(&claim)?;
                write_once(
                    &directory.join("no-launch.json"),
                    &CancellationClaim {
                        operation_id: request.operation_id.clone(),
                        boot_id: request.boot_id.clone(),
                        disk_lineage: request.disk_lineage.clone(),
                    },
                )?;
                return Err(failure);
            }
        }
        Ok(())
    }

    /// Claims once, then launches the existing idle native supervisor. Identical
    /// retries release only that authenticated supervisor, which deduplicates
    /// release itself. An incomplete claim/socket never starts a replacement.
    ///
    /// # Errors
    /// Conflict, stale physical identity, invalid input or filesystem failure.
    pub fn start(&self, request: &StartRequest) -> io::Result<Observation> {
        validate_request(request)?;
        if request.boot_id != self.capabilities()? {
            return Err(error("Stale machine boot identity"));
        }
        if request.stdin {
            self.io_capabilities()?;
        }
        let digest = request.digest().map_err(json_error)?;
        let directory = self.operation(&request.operation_id)?;
        let elected = create_private_directory(&directory)?;
        if elected {
            self.launch_claim(&directory, request, &digest)?;
        }
        if directory.join("no-launch.json").exists() {
            let cancellation: CancellationClaim = read_json(&directory.join("no-launch.json"))?;
            if cancellation.operation_id != request.operation_id
                || cancellation.boot_id != request.boot_id
                || cancellation.disk_lineage != request.disk_lineage
            {
                return Err(error("Pre-launch cancellation provenance changed"));
            }
            return self.read_bound(
                &request.operation_id,
                0,
                0,
                MAX_PAGE_BYTES,
                &request.boot_id,
                &request.disk_lineage,
            );
        }
        let Ok(claim) = Self::claim(&directory) else {
            return self.read_bound(
                &request.operation_id,
                0,
                0,
                MAX_PAGE_BYTES,
                &request.boot_id,
                &request.disk_lineage,
            );
        };
        if claim.specification_digest != digest || claim.disk_lineage != request.disk_lineage {
            return Err(error(
                "Operation ID was reused with a different specification",
            ));
        }
        if directory.join("terminal.json").exists() {
            return self.read_bound(
                &request.operation_id,
                0,
                0,
                MAX_PAGE_BYTES,
                &request.boot_id,
                &request.disk_lineage,
            );
        }
        // Poll only our just-spawned helper's socket. A retry never spawns again.
        for _ in 0..100 {
            match self.control(&claim, "status", None) {
                Ok(NativeReply::Idle) => {
                    let action = if directory.join("cancel.json").exists() {
                        "cancel"
                    } else {
                        "release"
                    };
                    let _ = self.control(&claim, action, None);
                    break;
                }
                Ok(NativeReply::Running | NativeReply::Quiescent { .. }) => break,
                Err(_) => {}
            }
            if !elected {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        self.read_bound(
            &request.operation_id,
            0,
            0,
            MAX_PAGE_BYTES,
            &request.boot_id,
            &request.disk_lineage,
        )
    }

    /// Persists monotonic cancellation, then addresses the exact native owner.
    /// Missing control is unknown, not proof that writers are stopped.
    ///
    /// # Errors
    /// Invalid identity/incarnation, conflicting lineage or filesystem failure.
    pub fn cancel(&self, id: &str, boot_id: &str, disk_lineage: &str) -> io::Result<Observation> {
        let directory = self.operation(id)?;
        if boot_id.len() != 64
            || !boot_id.bytes().all(|byte| byte.is_ascii_hexdigit())
            || !canonical_uuid(disk_lineage)
            || boot_identity()? != boot_id
        {
            // An old dispatch may have run on disk history lost at reboot.
            // A new empty gate is not evidence that it never launched.
            return Err(error("Cancellation incarnation changed"));
        }
        if directory.join("no-launch.json").exists() {
            let claim: CancellationClaim = read_json(&directory.join("no-launch.json"))?;
            if claim.operation_id != id
                || claim.boot_id != boot_id
                || claim.disk_lineage != disk_lineage
            {
                return Err(error("Cancellation gate provenance changed"));
            }
        }
        if let Ok(claim) = Self::claim(&directory) {
            if claim.operation_id != id
                || claim.boot_id != boot_id
                || claim.disk_lineage != disk_lineage
            {
                return Err(error("Cancellation command provenance changed"));
            }
        }
        if create_private_directory(&directory)? {
            sync_directory(&self.root)?;
            // Winning this same immutable gate proves no Start elected a
            // launcher. Later Start calls cannot create a supervisor here.
            write_once(
                &directory.join("no-launch.json"),
                &CancellationClaim {
                    operation_id: id.to_owned(),
                    boot_id: boot_id.to_owned(),
                    disk_lineage: disk_lineage.to_owned(),
                },
            )?;
        }
        if let Ok(claim) = Self::claim(&directory) {
            if claim.operation_id != id
                || claim.boot_id != boot_id
                || claim.disk_lineage != disk_lineage
            {
                return Err(error("Cancellation command provenance changed"));
            }
            // Revocation may prevent a still-pending shim from consuming its
            // credentials even when the command outcome cannot yet be proved.
            remove_payload(&claim)?;
        } else if !directory.join("no-launch.json").exists() {
            // Start may own an incomplete claim publication. Never mutate a
            // different specification before its provenance can be checked.
            return self.read_bound(id, 0, 0, MAX_PAGE_BYTES, boot_id, disk_lineage);
        }
        write_once(&directory.join("cancel.json"), &true)?;
        self.read_bound(id, 0, 0, MAX_PAGE_BYTES, boot_id, disk_lineage)
    }

    fn input_control(&self, claim: &Claim, payload: Option<&str>) -> io::Result<NativeInputReply> {
        let mut command = self.control_command(
            claim,
            if payload.is_some() {
                "input"
            } else {
                "input-status"
            },
            None,
        );
        command.stdout(Stdio::piped()).stderr(Stdio::null());
        let output = if let Some(payload) = payload {
            command.stdin(Stdio::piped());
            let mut child = command.spawn()?;
            child
                .stdin
                .take()
                .ok_or_else(|| error("Missing native input channel"))?
                .write_all(payload.as_bytes())?;
            child.wait_with_output()?
        } else {
            command.stdin(Stdio::null()).output()?
        };
        if !output.status.success() || output.stdout.len() > 4096 {
            return Err(error("Native input acceptance unavailable"));
        }
        let reply: NativeInputReply = serde_json::from_slice(&output.stdout).map_err(json_error)?;
        if reply.state != "input"
            || (reply.pending_sequence != 0
                && reply.accepted_through.checked_add(1) != Some(reply.pending_sequence))
        {
            return Err(error("Invalid native input proof"));
        }
        Ok(reply)
    }

    /// Send one immutable, ordered input action to its surviving native owner.
    /// A lost reply retries this same sequence. Missing history or supervision
    /// stays unknown; no replacement owner or numeric PID is used.
    ///
    /// # Errors
    /// Invalid identity/data, unsupported I/O mode or conflicting sequence reuse.
    pub fn input(&self, request: &InputRequest) -> io::Result<InputObservation> {
        validate_id(&request.operation_id)?;
        if request.sequence == 0 {
            return Err(error("Input sequence starts at one"));
        }
        let digest = hex::encode(Sha256::digest(
            serde_json::to_vec(request).map_err(json_error)?,
        ));
        let (kind, columns, rows, bytes) = input_parts(&request.input)?;
        let result = |status, accepted_through, reason: &str| InputObservation {
            operation_id: request.operation_id.clone(),
            sequence: request.sequence,
            status,
            accepted_through,
            reason: reason.to_owned(),
        };
        let directory = self.operation(&request.operation_id)?;
        let Ok(claim) = Self::claim(&directory) else {
            return Ok(result(InputStatus::Unknown, None, "unavailable"));
        };
        if claim.operation_id != request.operation_id
            || !claim.stdin
            || (kind == "close" && claim.pty.is_some())
            || (kind == "resize" && claim.pty.is_none())
        {
            return Err(error("Input is not supported by this exact command"));
        }
        let path = directory.join(format!("input-{}.json", request.sequence));
        let existing = if path.exists() {
            Some(read_json::<InputClaim>(&path)?)
        } else {
            None
        };
        if existing
            .as_ref()
            .is_some_and(|input| input.sequence != request.sequence || input.digest != digest)
        {
            return Err(error("Input sequence was reused with different data"));
        }
        if let Some(terminal) = Self::terminal(&directory, &claim)? {
            let accepted = terminal.receipt.accepted_input_sequence;
            let status = if existing.is_none()
                && accepted.is_some_and(|sequence| sequence >= request.sequence)
            {
                InputStatus::Unknown
            } else if accepted.is_some_and(|sequence| sequence >= request.sequence) {
                InputStatus::Accepted
            } else if terminal.receipt.incomplete_input_sequence == Some(request.sequence) {
                InputStatus::Unknown
            } else {
                InputStatus::Rejected
            };
            return Ok(result(status, accepted, "terminal"));
        }
        if boot_identity()? != claim.boot_id {
            return Ok(result(InputStatus::Unknown, None, "lost"));
        }
        let Ok(counter) = self.input_control(&claim, None) else {
            return Ok(result(InputStatus::Unknown, None, "unavailable"));
        };
        if counter.sequence != 0 || counter.status != InputStatus::Accepted {
            return Err(error("Invalid native input counter"));
        }
        if existing.is_none()
            && (request.sequence <= counter.accepted_through
                || request.sequence == counter.pending_sequence)
        {
            return Ok(result(
                InputStatus::Unknown,
                Some(counter.accepted_through),
                "missing_history",
            ));
        }
        write_once(
            &path,
            &InputClaim {
                sequence: request.sequence,
                digest: digest.clone(),
            },
        )?;
        let committed: InputClaim = read_json(&path)?;
        if committed.sequence != request.sequence || committed.digest != digest {
            return Err(error("Input sequence was reused with different data"));
        }
        let payload = format!(
            "{}:{kind}:{digest}:{columns}:{rows}:{bytes}",
            request.sequence
        );
        let Ok(reply) = self.input_control(&claim, Some(&payload)) else {
            return Ok(result(InputStatus::Unknown, None, "unavailable"));
        };
        if reply.sequence != request.sequence
            || (reply.status == InputStatus::Accepted && reply.accepted_through < request.sequence)
        {
            return Err(error("Invalid native input acknowledgement"));
        }
        Ok(result(
            reply.status,
            Some(reply.accepted_through),
            &reply.reason,
        ))
    }

    fn terminal(directory: &Path, claim: &Claim) -> io::Result<Option<Terminal>> {
        let path = directory.join("terminal.json");
        if !path.exists() {
            return Ok(None);
        }
        let terminal: Terminal = read_json(&path)?;
        if terminal.specification_digest != claim.specification_digest
            || terminal.disk_lineage != claim.disk_lineage
            || terminal.receipt.invocation_id != claim.operation_id
            || terminal.receipt.protocol != "native-subreaper-v1"
            || !canonical_uuid(&terminal.receipt.receipt_id)
            || !Self::valid_input_receipt(claim, &terminal.receipt)
        {
            return Err(error("Invalid terminal journal receipt"));
        }
        // Another reader may observe the hard-link before its publisher syncs
        // the directory. Any reader retiring the native receipt must first make
        // that complete immutable terminal entry durable itself.
        File::open(path)?.sync_all()?;
        sync_directory(directory)?;
        Ok(Some(terminal))
    }

    fn valid_input_receipt(claim: &Claim, receipt: &QuiescenceReceipt) -> bool {
        if receipt.accepted_input_sequence.is_some() != claim.stdin {
            return false;
        }
        receipt.incomplete_input_sequence.is_none_or(|incomplete| {
            claim.pty.is_some()
                && receipt
                    .accepted_input_sequence
                    .and_then(|sequence| sequence.checked_add(1))
                    == Some(incomplete)
        })
    }
    fn store_terminal(
        &self,
        directory: &Path,
        claim: &Claim,
        receipt: QuiescenceReceipt,
    ) -> io::Result<Terminal> {
        if receipt.invocation_id != claim.operation_id
            || receipt.protocol != "native-subreaper-v1"
            || !canonical_uuid(&receipt.receipt_id)
            || !Self::valid_input_receipt(claim, &receipt)
        {
            return Err(error("Invalid native quiescence receipt"));
        }
        // Native ECHILD means all owned writers closed their descriptors. Sync
        // both streams before committing/ACKing the immutable terminal proof.
        for name in ["stdout", "stderr"] {
            File::open(directory.join(name))?.sync_all()?;
        }
        write_once(
            &directory.join("terminal.json"),
            &Terminal {
                specification_digest: claim.specification_digest.clone(),
                disk_lineage: claim.disk_lineage.clone(),
                receipt,
            },
        )?;
        let terminal = Self::terminal(directory, claim)?
            .ok_or_else(|| error("Missing durable terminal receipt"))?;
        remove_payload(claim)?;
        let _ = self.control(claim, "ack", Some(&terminal.receipt.receipt_id));
        Ok(terminal)
    }
    fn page(
        directory: &Path,
        name: &str,
        offset: u64,
        limit: usize,
        terminal: bool,
    ) -> io::Result<OutputPage> {
        let path = directory.join(name);
        let mut file = match File::open(path) {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::NotFound && !terminal && offset == 0 => {
                return Ok(OutputPage {
                    offset,
                    next_offset: offset,
                    data: String::new(),
                    eof: false,
                })
            }
            Err(e) => return Err(e),
        };
        let size = file.metadata()?.len();
        if offset > size {
            return Err(error("Output cursor exceeds retained bytes"));
        }
        file.seek(io::SeekFrom::Start(offset))?;
        let mut bytes = Vec::new();
        // Writers may append concurrently. Return only the sampled range, then
        // sync the bytes actually read before allowing an external cursor commit.
        let length = u64::try_from(limit)
            .map_err(|_| error("Invalid output page size"))?
            .min(size - offset);
        (&mut file).take(length).read_to_end(&mut bytes)?;
        file.sync_all()?;
        let next_offset =
            offset + u64::try_from(bytes.len()).map_err(|_| error("Invalid output length"))?;
        Ok(OutputPage {
            offset,
            next_offset,
            data: STANDARD.encode(bytes),
            eof: terminal && next_offset == size,
        })
    }

    /// Observes an operation and durably captures output before returning bytes.
    /// Does not release/start an idle invocation. Previously requested cancellation
    /// may be retried against its exact native owner.
    ///
    /// # Errors
    /// Invalid identity/cursor, unreadable terminal proof or filesystem failure.
    pub fn read(
        &self,
        id: &str,
        stdout: u64,
        stderr: u64,
        limit: usize,
    ) -> io::Result<Observation> {
        self.read_observation(id, stdout, stderr, limit, None)
    }

    /// Read for a retained dispatch, including pre-launch cancellation proof.
    /// An unbound read cannot establish a never-started outcome.
    ///
    /// # Errors
    /// Invalid retained provenance, cursor or journal data.
    pub fn read_bound(
        &self,
        id: &str,
        stdout: u64,
        stderr: u64,
        limit: usize,
        boot_id: &str,
        disk_lineage: &str,
    ) -> io::Result<Observation> {
        if boot_id.len() != 64
            || !boot_id.bytes().all(|byte| byte.is_ascii_hexdigit())
            || !canonical_uuid(disk_lineage)
        {
            return Err(error("Invalid retained read provenance"));
        }
        self.read_observation(id, stdout, stderr, limit, Some((boot_id, disk_lineage)))
    }

    fn read_observation(
        &self,
        id: &str,
        stdout: u64,
        stderr: u64,
        limit: usize,
        binding: Option<(&str, &str)>,
    ) -> io::Result<Observation> {
        if limit == 0 || limit > MAX_PAGE_BYTES {
            return Err(error("Invalid output page size"));
        }
        let directory = self.operation(id)?;
        if directory.join("no-launch.json").exists() {
            let raw: serde_json::Value = read_json(&directory.join("no-launch.json"))?;
            if let Some(legacy_id) = raw.as_str() {
                if legacy_id != id || stdout != 0 || stderr != 0 {
                    return Err(error("Invalid unbound cancellation observation"));
                }
                let empty = || OutputPage {
                    offset: 0,
                    next_offset: 0,
                    data: String::new(),
                    eof: false,
                };
                return Ok(Observation {
                    operation_id: id.to_owned(),
                    state: State::Unknown,
                    specification_digest: None,
                    receipt: None,
                    stdout: empty(),
                    stderr: empty(),
                });
            }
            let claim: CancellationClaim = serde_json::from_value(raw).map_err(json_error)?;
            if claim.operation_id != id
                || !canonical_uuid(&claim.disk_lineage)
                || claim.boot_id.len() != 64
                || !claim.boot_id.bytes().all(|byte| byte.is_ascii_hexdigit())
                || stdout != 0
                || stderr != 0
            {
                return Err(error("Invalid pre-launch cancellation observation"));
            }
            File::open(directory.join("no-launch.json"))?.sync_all()?;
            sync_directory(&directory)?;
            let original_boot = binding.is_some_and(|(boot, lineage)| {
                claim.boot_id == boot && claim.disk_lineage == lineage
            }) && claim.boot_id == boot_identity()?;
            let empty = || OutputPage {
                offset: 0,
                next_offset: 0,
                data: String::new(),
                eof: original_boot,
            };
            return Ok(Observation {
                operation_id: id.to_owned(),
                state: if original_boot {
                    State::Cancelled
                } else {
                    State::Unknown
                },
                specification_digest: None,
                receipt: None,
                stdout: empty(),
                stderr: empty(),
            });
        }
        let mut state = if directory.exists() {
            State::Unknown
        } else {
            State::NotFound
        };
        let mut receipt = None;
        let mut specification_digest = None;
        if let Ok(claim) = Self::claim(&directory) {
            if claim.operation_id != id
                || binding.is_some_and(|(boot, lineage)| {
                    claim.boot_id != boot || claim.disk_lineage != lineage
                })
            {
                return Err(error("Journal operation identity mismatch"));
            }
            specification_digest = Some(claim.specification_digest.clone());
            if directory.join("cancel.json").exists() {
                remove_payload(&claim)?;
            }
            if let Some(terminal) = Self::terminal(&directory, &claim)? {
                // A failed/lost ACK may have left the old helper holding its
                // immutable receipt. Repeating ACK never launches user code.
                remove_payload(&claim)?;
                let _ = self.control(&claim, "ack", Some(&terminal.receipt.receipt_id));
                state = State::Exited;
                receipt = Some(terminal.receipt);
            } else if boot_identity()? != claim.boot_id {
                state = State::Lost;
            } else {
                let action = if directory.join("cancel.json").exists() {
                    "cancel"
                } else {
                    "status"
                };
                match self.control(&claim, action, None) {
                    Ok(NativeReply::Idle) => state = State::Prepared,
                    Ok(NativeReply::Running) => state = State::Running,
                    Ok(NativeReply::Quiescent { receipt: proof }) => {
                        let terminal = self.store_terminal(&directory, &claim, proof)?;
                        state = State::Exited;
                        receipt = Some(terminal.receipt);
                    }
                    Err(_) => state = State::Unknown,
                }
            }
        }
        Ok(Observation {
            operation_id: id.to_string(),
            state,
            specification_digest,
            receipt,
            stdout: Self::page(&directory, "stdout", stdout, limit, state == State::Exited)?,
            stderr: Self::page(&directory, "stderr", stderr, limit, state == State::Exited)?,
        })
    }
}

/// Native supervisor child shim: consumes volatile launch material then execs the
/// user's exact argv/environment. No credentials are passed in the argument vector.
///
/// # Errors
/// Invalid/stale launch material or exec failure. Never creates another invocation.
pub fn execute_payload(path: &Path, digest: &str) -> io::Result<()> {
    let request: StartRequest = read_json(path)?;
    fs::remove_file(path)?;
    validate_request(&request)?;
    if request.digest().map_err(json_error)? != digest || request.boot_id != boot_identity()? {
        return Err(error("Stale or conflicting launch payload"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        let failure = Command::new(&request.program)
            .args(&request.args)
            .current_dir(&request.cwd)
            .env_clear()
            .envs(&request.environment)
            .exec();
        Err(failure)
    }
    #[cfg(not(unix))]
    {
        Err(error("Native journal execution requires Linux"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operation_id_cannot_escape_the_root() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("journal");
        let journal = Journal::open(root, PathBuf::from("/missing-helper")).unwrap();
        for id in [
            "../escape",
            "",
            "00000000-0000-0000-0000-000000000000/extra",
        ] {
            assert!(journal.read(id, 0, 0, 10).is_err());
        }
    }
    #[test]
    fn incomplete_claim_is_unknown_and_never_recreated() {
        let temporary = tempfile::tempdir().unwrap();
        let journal = Journal::open(
            temporary.path().join("journal"),
            PathBuf::from("/missing-helper"),
        )
        .unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        fs::create_dir(journal.operation(&id).unwrap()).unwrap();
        assert_eq!(journal.read(&id, 0, 0, 10).unwrap().state, State::Unknown);
    }
    #[test]
    fn pages_replay_exact_binary_bytes_and_reject_missing_history() {
        let temporary = tempfile::tempdir().unwrap();
        let bytes = [0, 0xff, 0xf0, 0x9f, 0x98, 0x80, 7];
        fs::write(temporary.path().join("stdout"), bytes).unwrap();
        let first = Journal::page(temporary.path(), "stdout", 1, 3, true).unwrap();
        assert_eq!(STANDARD.decode(first.data).unwrap(), bytes[1..4]);
        assert_eq!(first.next_offset, 4);
        assert!(!first.eof);
        assert!(Journal::page(temporary.path(), "stdout", 8, 10, true).is_err());
        assert!(Journal::page(temporary.path(), "missing", 0, 10, true).is_err());
    }
    #[test]
    fn immutable_publication_never_replaces_a_receipt() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("receipt.json");
        write_once(&path, &"first").unwrap();
        write_once(&path, &"second").unwrap();
        assert_eq!(read_json::<String>(&path).unwrap(), "first");
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn cancellation_claims_the_gate_before_a_delayed_start() {
        let temporary = tempfile::tempdir().unwrap();
        let journal = Journal::open(
            temporary.path().join("journal"),
            PathBuf::from("/missing-helper"),
        )
        .unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let boot = boot_identity().unwrap();
        let lineage = uuid::Uuid::new_v4().to_string();
        assert_eq!(
            journal.cancel(&id, &boot, &lineage).unwrap().state,
            State::Cancelled
        );
        assert_eq!(journal.read(&id, 0, 0, 10).unwrap().state, State::Unknown);
        assert_eq!(
            journal
                .read_bound(&id, 0, 0, 10, &boot, &lineage)
                .unwrap()
                .state,
            State::Cancelled
        );
        assert!(!journal.operation(&id).unwrap().join("claim.json").exists());
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn stale_boot_cannot_manufacture_a_prelaunch_cancellation() {
        let temporary = tempfile::tempdir().unwrap();
        let journal = Journal::open(
            temporary.path().join("journal"),
            PathBuf::from("/missing-helper"),
        )
        .unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let lineage = uuid::Uuid::new_v4().to_string();
        let boot = boot_identity().unwrap();
        let wrong = if boot.starts_with('0') {
            "1".repeat(64)
        } else {
            "0".repeat(64)
        };
        assert!(journal.cancel(&id, &wrong, &lineage).is_err());
        assert!(!journal.operation(&id).unwrap().exists());
        assert_eq!(journal.read(&id, 0, 0, 10).unwrap().state, State::NotFound);
        assert!(journal.cancel(&id, &boot, "invalid").is_err());
        assert!(!journal.operation(&id).unwrap().exists());
        assert_eq!(
            journal.cancel(&id, &boot, &lineage).unwrap().state,
            State::Cancelled
        );
        assert!(journal
            .cancel(&id, &boot, &uuid::Uuid::new_v4().to_string())
            .is_err());
        assert_eq!(
            journal
                .read_bound(&id, 0, 0, 10, &boot, &lineage)
                .unwrap()
                .state,
            State::Cancelled
        );
        assert_eq!(
            journal
                .read_bound(&id, 0, 0, 10, &wrong, &lineage)
                .unwrap()
                .state,
            State::Unknown
        );
        assert_eq!(
            journal
                .read_bound(&id, 0, 0, 10, &boot, &uuid::Uuid::new_v4().to_string())
                .unwrap()
                .state,
            State::Unknown
        );
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn cancellation_before_supervisor_spawn_retains_typed_provenance() {
        let temporary = tempfile::tempdir().unwrap();
        let journal = Journal::open(
            temporary.path().join("journal"),
            PathBuf::from("/missing-helper"),
        )
        .unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let directory = journal.operation(&id).unwrap();
        fs::create_dir(&directory).unwrap();
        write_once(&directory.join("cancel.json"), &true).unwrap();
        let request = StartRequest {
            operation_id: id.clone(),
            disk_lineage: uuid::Uuid::new_v4().to_string(),
            boot_id: boot_identity().unwrap(),
            program: "/bin/sh".to_owned(),
            args: vec![],
            cwd: temporary.path().to_string_lossy().to_string(),
            environment: Default::default(),
            stdin: false,
            pty: None,
        };
        journal
            .launch_claim(&directory, &request, &request.digest().unwrap())
            .unwrap();
        let cancellation: CancellationClaim = read_json(&directory.join("no-launch.json")).unwrap();
        assert_eq!(cancellation.boot_id, request.boot_id);
        assert_eq!(cancellation.disk_lineage, request.disk_lineage);
        assert_eq!(
            journal
                .read_bound(&id, 0, 0, 10, &request.boot_id, &request.disk_lineage)
                .unwrap()
                .state,
            State::Cancelled
        );
    }
    #[test]
    fn an_untyped_cancellation_gate_never_supplies_terminal_proof() {
        let temporary = tempfile::tempdir().unwrap();
        let journal = Journal::open(
            temporary.path().join("journal"),
            PathBuf::from("/missing-helper"),
        )
        .unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        fs::create_dir(journal.operation(&id).unwrap()).unwrap();
        write_once(&journal.operation(&id).unwrap().join("no-launch.json"), &id).unwrap();
        let page = journal.read(&id, 0, 0, 10).unwrap();
        assert_eq!(page.state, State::Unknown);
        assert!(!page.stdout.eof && !page.stderr.eof);
    }
}
