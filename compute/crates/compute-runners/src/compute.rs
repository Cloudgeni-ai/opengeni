//! Opengeni compute, through its E2B API (ADR 19): sandboxes, the
//! templates saved from them (ADR 22), and commands through each one's
//! envd, reached at the front door by the `E2b-Sandbox-Id` and
//! `E2b-Sandbox-Port` headers.
//!
//! The front door is the control service, which restarts with every
//! release while sandboxes and what runs in them carry on. So a command
//! outlives its stream: one cut short is followed again by its tag until
//! it ends, and how it ended is recorded in the guest, read back when it
//! ended while no one was following. A template's save cut short is asked
//! again, or found by its name when it was made after all.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::time::Duration;

use anyhow::{Context as _, Result, anyhow, bail};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use bytes::Bytes;
use futures::StreamExt as _;
use reqwest::{Method, StatusCode};
use serde::Deserialize;
use tokio::time::Instant;

/// envd's port in every sandbox.
const ENVD_PORT: u16 = 49983;
/// How long saving a sandbox as a template may take: the service allows
/// half an hour to store its disk.
const SNAPSHOT_WITHIN: Duration = Duration::from_secs(35 * 60);
/// How long creating a sandbox may take: a host without the template's
/// image fetches it first, and the service allows a create ten minutes
/// before it gives it up. Waiting less would drop a runner whose sandbox
/// still comes.
pub const CREATE_WITHIN: Duration = Duration::from_secs(10 * 60);
/// Where a command records that it started and then its exit code: a
/// memory file system our guest init mounts for every user, so the disk a
/// template keeps never holds it.
const RECORDS: &str = "/dev/shm";
/// What every command runs under, with `bash -c`: runs `$2` with `bash -l
/// -c`, recording in the file `$1` first that it started, then its exit
/// code, which outlive envd's memory of it.
pub const RECORDED: &str = "printf started > \"$1\" || exit 125\n\
                        /bin/bash -l -c \"$2\"\n\
                        code=$?\n\
                        printf '%s' \"$code\" > \"$1\"\n\
                        exit \"$code\"\n";
/// The first wait before reaching compute again.
const AGAIN_FIRST: Duration = Duration::from_secs(1);
/// The longest wait between attempts to reach compute again.
const AGAIN_MOST: Duration = Duration::from_secs(30);

/// The E2B API of a compute fleet.
#[derive(Clone, Debug)]
pub struct Compute {
    http: reqwest::Client,
    api: String,
    key: String,
}

/// A sandbox to create.
#[derive(Debug, Default)]
pub struct NewSandbox {
    pub template: String,
    /// Seconds it lives at most.
    pub timeout_s: u64,
    pub metadata: BTreeMap<String, String>,
    pub env: BTreeMap<String, String>,
}

/// A sandbox created.
#[derive(Clone, Debug, Deserialize)]
pub struct Created {
    #[serde(rename = "sandboxID")]
    pub id: String,
    #[serde(rename = "envdAccessToken", default)]
    pub envd_token: String,
}

/// A sandbox listed.
#[derive(Clone, Debug, Deserialize)]
pub struct Listed {
    #[serde(rename = "sandboxID")]
    pub id: String,
    #[serde(default)]
    pub metadata: BTreeMap<String, String>,
    #[serde(default)]
    pub state: String,
}

/// A template saved from a sandbox.
#[derive(Clone, Debug, Deserialize)]
pub struct Snapshot {
    #[serde(rename = "snapshotID")]
    pub id: String,
    #[serde(default)]
    pub names: Vec<String>,
}

/// How a command ended.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Ran {
    pub exit_code: i64,
    /// Its last lines of output, for a report.
    pub tail: String,
}

/// Whether `error` says compute could not be reached or cut its answer
/// short, as while its control service restarts, rather than refused or
/// answered what was asked.
#[must_use]
pub fn unreachable(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause.downcast_ref::<reqwest::Error>().is_some_and(|error| {
            error.is_connect() || error.is_request() || error.is_body() || error.is_timeout()
        })
    })
}

/// The waits between attempts to reach compute again: a second, doubling
/// to half a minute while it stays away.
#[derive(Debug)]
pub struct Again(Duration);

impl Default for Again {
    fn default() -> Self {
        Self(AGAIN_FIRST)
    }
}

impl Again {
    /// Waits before the next attempt, never past `deadline`, and says
    /// whether one is still due.
    pub async fn wait(&mut self, deadline: Instant) -> bool {
        let now = Instant::now();
        if now >= deadline {
            return false;
        }
        tokio::time::sleep_until((now + self.0).min(deadline)).await;
        self.0 = (self.0 * 2).min(AGAIN_MOST);
        Instant::now() < deadline
    }

    /// Compute answered: the next wait is the first again.
    pub fn answered(&mut self) {
        self.0 = AGAIN_FIRST;
    }
}

/// What is left until `deadline`.
fn left(deadline: Instant) -> Duration {
    deadline.saturating_duration_since(Instant::now())
}

/// How a stream of a command's events ended.
enum Streamed {
    /// With the command's end: its exit code.
    Ended(i64),
    /// Before the command ended: the stream was cut, or compute could not
    /// be reached.
    Cut(anyhow::Error),
    /// envd follows no such command (any more).
    Unknown,
}

/// What a command's record in the guest says.
enum Record {
    /// It ended with this exit code.
    Ended(i64),
    /// It started and has not recorded an end.
    Started,
    /// It never started.
    Missing,
}

impl Compute {
    #[must_use]
    pub fn new(http: reqwest::Client, api: &str, key: &str) -> Self {
        Self {
            http,
            api: api.trim_end_matches('/').into(),
            key: key.into(),
        }
    }

    fn request(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        self.http
            .request(method, format!("{}{path}", self.api))
            .header("x-api-key", &self.key)
    }

    /// Creates a sandbox.
    pub async fn create(&self, new: &NewSandbox) -> Result<Created> {
        let response = self
            .request(Method::POST, "/v2/sandboxes")
            .json(&serde_json::json!({
                "templateID": new.template,
                "timeout": new.timeout_s,
                "metadata": new.metadata,
                "envVars": new.env,
                "secure": true,
            }))
            .timeout(CREATE_WITHIN)
            .send()
            .await?;
        answer(
            response,
            &[StatusCode::CREATED, StatusCode::OK],
            "creating a sandbox",
        )
        .await
    }

    /// The running and paused sandboxes whose metadata holds `pairs`.
    pub async fn list(&self, pairs: &[(&str, &str)]) -> Result<Vec<Listed>> {
        let metadata: String = form_urlencoded::Serializer::new(String::new())
            .extend_pairs(pairs)
            .finish();
        let response = self
            .request(Method::GET, "/v2/sandboxes")
            .query(&[
                ("metadata", metadata.as_str()),
                ("state", "running"),
                ("state", "paused"),
            ])
            .send()
            .await?;
        answer(response, &[StatusCode::OK], "listing sandboxes").await
    }

    /// Kills sandbox `id`; one already gone is fine.
    pub async fn kill(&self, id: &str) -> Result<()> {
        let response = self
            .request(Method::DELETE, &format!("/sandboxes/{id}"))
            .send()
            .await?;
        match response.status() {
            StatusCode::NO_CONTENT | StatusCode::OK | StatusCode::NOT_FOUND => Ok(()),
            status => bail!(
                "killing sandbox {id}: {status} {}",
                response.text().await.unwrap_or_default()
            ),
        }
    }

    /// Saves sandbox `id`'s disk as the template `name`.
    /// A save cut short, as when the control service restarts during it,
    /// is found by its name if it was made after all, and asked again
    /// otherwise: a name is made once, so asking again never makes two.
    pub async fn snapshot(&self, id: &str, name: &str) -> Result<Snapshot> {
        let deadline = Instant::now() + SNAPSHOT_WITHIN;
        let mut again = Again::default();
        loop {
            let asked = async {
                let response = self
                    .request(Method::POST, &format!("/sandboxes/{id}/snapshots"))
                    .json(&serde_json::json!({"name": name, "memory": false}))
                    .timeout(left(deadline))
                    .send()
                    .await?;
                let status = response.status();
                Ok::<(StatusCode, Bytes), reqwest::Error>((status, response.bytes().await?))
            }
            .await;
            let cut = match asked {
                Ok((StatusCode::CREATED | StatusCode::OK, body)) => {
                    return serde_json::from_slice(&body)
                        .context("saving a template: not the answer expected");
                }
                Ok((status, body)) => {
                    // A save cut short may have made the name meanwhile.
                    if status == StatusCode::CONFLICT
                        && let Some(made) = self.named(name).await?
                    {
                        return Ok(made);
                    }
                    bail!(
                        "saving a template: {status} {}",
                        String::from_utf8_lossy(&body)
                    );
                }
                Err(error) => anyhow::Error::from(error),
            };
            match self.named(name).await {
                Ok(Some(made)) => return Ok(made),
                Ok(None) => {}
                Err(error) => tracing::warn!(
                    error = format!("{error:#}"),
                    "looking for a template whose save was cut short failed"
                ),
            }
            tracing::warn!(template = %name, error = format!("{cut:#}"), "saving a template was cut short; asking again");
            if !again.wait(deadline).await {
                return Err(cut.context("saving a template"));
            }
        }
    }

    /// The template named `name`, if there is one.
    async fn named(&self, name: &str) -> Result<Option<Snapshot>> {
        Ok(self
            .snapshots()
            .await?
            .into_iter()
            .find(|snapshot| snapshot.names.iter().any(|named| named == name)))
    }

    /// Every template saved from a sandbox.
    pub async fn snapshots(&self) -> Result<Vec<Snapshot>> {
        let mut all = Vec::new();
        let mut after: Option<String> = None;
        loop {
            let mut request = self
                .request(Method::GET, "/snapshots")
                .query(&[("limit", "1000")]);
            if let Some(after) = &after {
                request = request.query(&[("nextToken", after)]);
            }
            let response = request.send().await?;
            let next = response
                .headers()
                .get("x-next-token")
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned);
            let page: Vec<Snapshot> =
                answer(response, &[StatusCode::OK], "listing templates").await?;
            all.extend(page);
            match next {
                Some(next) if Some(&next) != after.as_ref() => after = Some(next),
                _ => return Ok(all),
            }
        }
    }

    /// Deletes the template `id`; one already gone is fine.
    pub async fn delete_template(&self, id: &str) -> Result<()> {
        let response = self
            .request(Method::DELETE, &format!("/templates/{id}"))
            .send()
            .await?;
        match response.status() {
            StatusCode::NO_CONTENT | StatusCode::OK | StatusCode::NOT_FOUND => Ok(()),
            status => bail!(
                "deleting template {id}: {status} {}",
                response.text().await.unwrap_or_default()
            ),
        }
    }

    /// Runs `script` with `bash -l -c` as `user` in `sandbox`, to the end,
    /// with `env` given to it alone. Its output goes to the log, a line at
    /// a time. The command runs on when its stream is cut, as when the
    /// control service restarts: it is followed again by its tag, and
    /// when it ended while no one followed, its exit code is read from
    /// its record in the guest. It is started again only when it never
    /// started, and is an error once `within` has passed or when the
    /// guest lost it.
    pub async fn run(
        &self,
        sandbox: &Created,
        user: &str,
        script: &str,
        env: &BTreeMap<String, String>,
        within: Duration,
    ) -> Result<Ran> {
        let deadline = Instant::now() + within;
        let mut tag = [0u8; 12];
        getrandom::fill(&mut tag)?;
        let tag = tag
            .iter()
            .fold("compute-runners-".to_owned(), |mut tag, byte| {
                let _ = write!(tag, "{byte:02x}");
                tag
            });
        let record = format!("{RECORDS}/{tag}");
        let start = serde_json::json!({
            "process": {
                "cmd": "/bin/bash",
                "args": ["-c", RECORDED, "compute-runners", record, script],
                "envs": env,
            },
            "tag": tag,
            // Nothing writes to it, and it outlives every stream.
            "stdin": false,
        });
        let follow = serde_json::json!({"process": {"tag": tag}});
        let mut output = Output::logged();
        let mut again = Again::default();
        // Whether it was asked to start, and whether envd said it started.
        let mut asked = false;
        let mut started = false;
        loop {
            let streamed = if asked {
                self.events(sandbox, user, "Connect", &follow, deadline, &mut output)
                    .await?
            } else {
                asked = true;
                self.events(sandbox, user, "Start", &start, deadline, &mut output)
                    .await?
            };
            started |= output.started;
            let cut = match streamed {
                Streamed::Ended(exit_code) => {
                    return Ok(Ran {
                        exit_code,
                        tail: output.tail(),
                    });
                }
                Streamed::Cut(cut) => cut,
                Streamed::Unknown => match self.record(sandbox, user, &record, deadline).await? {
                    Ok(Record::Ended(exit_code)) => {
                        tracing::info!(exit_code, "the command ended while its stream was cut");
                        return Ok(Ran {
                            exit_code,
                            tail: output.tail(),
                        });
                    }
                    Ok(Record::Started) => bail!(
                        "the command is gone from the sandbox without an end; its last output:\n{}",
                        output.tail()
                    ),
                    Ok(Record::Missing) if started => {
                        bail!("the command and its record are gone from the sandbox")
                    }
                    Ok(Record::Missing) => {
                        asked = false;
                        anyhow!("the command never started")
                    }
                    Err(cut) => cut,
                },
            };
            output.flush();
            if output.answered {
                again.answered();
            }
            tracing::warn!(
                error = format!("{cut:#}"),
                "a command's stream was cut short; following it again"
            );
            if !again.wait(deadline).await {
                bail!(
                    "the command did not end within {within:?} ({cut:#}); its last output:\n{}",
                    output.tail()
                );
            }
        }
    }

    /// Reads a command's record at `path`; `Err` inside when compute could
    /// not be reached.
    async fn record(
        &self,
        sandbox: &Created,
        user: &str,
        path: &str,
        deadline: Instant,
    ) -> Result<Result<Record>> {
        let read = serde_json::json!({"process": {"cmd": "/bin/cat", "args": [path]}});
        let mut output = Output::default();
        Ok(
            match self
                .events(sandbox, user, "Start", &read, deadline, &mut output)
                .await?
            {
                Streamed::Ended(0) => {
                    let text = output.tail();
                    Ok(match text.trim() {
                        "started" => Record::Started,
                        code => Record::Ended(
                            code.parse()
                                .with_context(|| format!("a command's record says {code:?}"))?,
                        ),
                    })
                }
                Streamed::Ended(_) => Ok(Record::Missing),
                Streamed::Cut(cut) => Err(cut),
                Streamed::Unknown => Err(anyhow!("envd lost the command reading a record")),
            },
        )
    }

    /// Calls envd's `method` of `process.Process` with `message` and
    /// follows the events it streams into `output`, until the command
    /// ends, the stream is cut or `deadline`. `Err` when envd or the front
    /// door refused it.
    async fn events(
        &self,
        sandbox: &Created,
        user: &str,
        method: &str,
        message: &serde_json::Value,
        deadline: Instant,
        output: &mut Output,
    ) -> Result<Streamed> {
        let message = message.to_string();
        output.answered = false;
        let mut body = vec![0];
        body.extend_from_slice(&u32::try_from(message.len())?.to_be_bytes());
        body.extend_from_slice(message.as_bytes());
        let sent = self
            .http
            .post(format!("{}/process.Process/{method}", self.api))
            .header("e2b-sandbox-id", &sandbox.id)
            .header("e2b-sandbox-port", ENVD_PORT.to_string())
            .header("x-access-token", &sandbox.envd_token)
            .header(
                "authorization",
                format!("Basic {}", STANDARD.encode(format!("{user}:"))),
            )
            .header("content-type", "application/connect+json")
            .header("connect-protocol-version", "1")
            .body(body)
            .timeout(left(deadline))
            .send()
            .await;
        let response = match sent {
            Ok(response) => response,
            Err(error) => return Ok(Streamed::Cut(error.into())),
        };
        let status = response.status();
        if status != StatusCode::OK {
            let error = anyhow!(
                "{method} of a command: {status} {}",
                response.text().await.unwrap_or_default()
            );
            // The front door, or the host behind it, is away for now.
            return if status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS {
                Ok(Streamed::Cut(error))
            } else {
                Err(error)
            };
        }
        let mut stream = response.bytes_stream();
        let mut frames = Frames::default();
        while let Some(chunk) = stream.next().await {
            let chunk = match chunk {
                Ok(chunk) => chunk,
                Err(error) => {
                    return Ok(Streamed::Cut(
                        anyhow::Error::from(error).context("the command's stream"),
                    ));
                }
            };
            frames.push(&chunk);
            while let Some((flags, message)) = frames.next() {
                let message: serde_json::Value = serde_json::from_slice(&message)
                    .context("a message of the command's stream")?;
                if flags & 2 != 0 {
                    if let Some(error) = message.get("error") {
                        output.answered = true;
                        let ended = anyhow!("the command's stream ended with {error}");
                        return match error["code"].as_str() {
                            Some("not_found") if method == "Connect" => Ok(Streamed::Unknown),
                            Some(
                                "not_found" | "invalid_argument" | "permission_denied"
                                | "unauthenticated" | "unimplemented",
                            ) => Err(ended),
                            _ => Ok(Streamed::Cut(ended)),
                        };
                    }
                    continue;
                }
                output.answered = true;
                let event = &message["event"];
                if event.get("start").is_some() {
                    output.started = true;
                }
                for field in ["stdout", "stderr"] {
                    if let Some(data) = event["data"][field].as_str() {
                        output.add(&STANDARD.decode(data).unwrap_or_default());
                    }
                }
                if let Some(end) = event.get("end") {
                    output.flush();
                    return Ok(Streamed::Ended(end["exitCode"].as_i64().unwrap_or(0)));
                }
            }
        }
        Ok(Streamed::Cut(anyhow!(
            "the command's stream ended before it did"
        )))
    }
}

/// Reads `response` as `T` when its status is one of `ok`.
async fn answer<T: serde::de::DeserializeOwned>(
    response: reqwest::Response,
    ok: &[StatusCode],
    what: &str,
) -> Result<T> {
    let status = response.status();
    let body = response.bytes().await?;
    if !ok.contains(&status) {
        bail!("{what}: {status} {}", String::from_utf8_lossy(&body));
    }
    serde_json::from_slice(&body).with_context(|| format!("{what}: not the answer expected"))
}

/// Connect's envelopes: a flags byte, a big-endian length, the message.
#[derive(Debug, Default)]
struct Frames(Vec<u8>);

impl Frames {
    fn push(&mut self, bytes: &[u8]) {
        self.0.extend_from_slice(bytes);
    }

    fn next(&mut self) -> Option<(u8, Vec<u8>)> {
        let header: [u8; 5] = self.0.get(..5)?.try_into().ok()?;
        let len = usize::try_from(u32::from_be_bytes(header[1..].try_into().ok()?)).ok()?;
        let message = self.0.get(5..5 + len)?.to_vec();
        self.0.drain(..5 + len);
        Some((header[0], message))
    }
}

/// A command's output: logged a line at a time, its last lines kept.
#[derive(Debug, Default)]
struct Output {
    partial: Vec<u8>,
    last: std::collections::VecDeque<String>,
    /// Whether its lines go to the log.
    logged: bool,
    /// Whether envd said the command started.
    started: bool,
    /// Whether envd answered the last call following it.
    answered: bool,
}

impl Output {
    const KEPT: usize = 40;

    fn logged() -> Self {
        Self {
            logged: true,
            ..Self::default()
        }
    }

    fn add(&mut self, bytes: &[u8]) {
        self.partial.extend_from_slice(bytes);
        while let Some(end) = self.partial.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.partial.drain(..=end).collect();
            self.line(String::from_utf8_lossy(&line[..end]).trim_end().to_owned());
        }
    }

    fn flush(&mut self) {
        if !self.partial.is_empty() {
            let line = String::from_utf8_lossy(&std::mem::take(&mut self.partial)).into_owned();
            self.line(line);
        }
    }

    fn line(&mut self, line: String) {
        if self.logged {
            tracing::info!(target: "compute_runners::command", "{line}");
        }
        if self.last.len() == Self::KEPT {
            self.last.pop_front();
        }
        self.last.push_back(line);
    }

    fn tail(&self) -> String {
        self.last.iter().cloned().collect::<Vec<_>>().join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelopes_are_read_across_chunks() {
        let mut frames = Frames::default();
        let message = br#"{"event":{"start":{"pid":7}}}"#;
        let mut bytes = vec![0];
        bytes.extend_from_slice(&u32::try_from(message.len()).unwrap().to_be_bytes());
        bytes.extend_from_slice(message);
        bytes.extend_from_slice(&[2, 0, 0, 0, 2, b'{', b'}']);
        frames.push(&bytes[..3]);
        assert!(frames.next().is_none());
        frames.push(&bytes[3..10]);
        assert!(frames.next().is_none());
        frames.push(&bytes[10..]);
        assert_eq!(frames.next(), Some((0, message.to_vec())));
        assert_eq!(frames.next(), Some((2, b"{}".to_vec())));
        assert!(frames.next().is_none());
    }

    #[test]
    fn output_keeps_its_last_lines() {
        let mut output = Output::default();
        for at in 0..50 {
            output.add(format!("line {at}\n").as_bytes());
        }
        output.add(b"no newline");
        output.flush();
        let tail = output.tail();
        assert!(tail.starts_with("line 11\n"), "{tail}");
        assert!(tail.ends_with("line 49\nno newline"), "{tail}");
    }
}
