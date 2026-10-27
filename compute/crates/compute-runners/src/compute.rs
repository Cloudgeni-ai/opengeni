//! Opengeni compute, through its E2B API (ADR 19): sandboxes, the
//! templates saved from them (ADR 22), and commands through each one's
//! envd, reached at the front door by the `E2b-Sandbox-Id` and
//! `E2b-Sandbox-Port` headers.

use std::collections::BTreeMap;
use std::time::Duration;

use anyhow::{Context as _, Result, bail};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use futures::StreamExt as _;
use reqwest::{Method, StatusCode};
use serde::Deserialize;

/// envd's port in every sandbox.
const ENVD_PORT: u16 = 49983;
/// How long saving a sandbox as a template may take: the service allows
/// half an hour to store its disk.
const SNAPSHOT_WITHIN: Duration = Duration::from_secs(35 * 60);

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
    pub async fn snapshot(&self, id: &str, name: &str) -> Result<Snapshot> {
        let response = self
            .request(Method::POST, &format!("/sandboxes/{id}/snapshots"))
            .json(&serde_json::json!({"name": name, "memory": false}))
            .timeout(SNAPSHOT_WITHIN)
            .send()
            .await?;
        answer(
            response,
            &[StatusCode::CREATED, StatusCode::OK],
            "saving a template",
        )
        .await
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
    /// a time; a stream that ends without an exit is an error.
    pub async fn run(
        &self,
        sandbox: &Created,
        user: &str,
        script: &str,
        env: &BTreeMap<String, String>,
        within: Duration,
    ) -> Result<Ran> {
        let message = serde_json::json!({
            "process": {"cmd": "/bin/bash", "args": ["-l", "-c", script], "envs": env},
        })
        .to_string();
        let mut body = vec![0];
        body.extend_from_slice(&u32::try_from(message.len())?.to_be_bytes());
        body.extend_from_slice(message.as_bytes());
        let response = self
            .http
            .post(format!("{}/process.Process/Start", self.api))
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
            .timeout(within)
            .send()
            .await?;
        if response.status() != StatusCode::OK {
            bail!(
                "starting a command: {} {}",
                response.status(),
                response.text().await.unwrap_or_default()
            );
        }
        let mut stream = response.bytes_stream();
        let mut frames = Frames::default();
        let mut output = Output::default();
        while let Some(chunk) = stream.next().await {
            frames.push(&chunk.context("the command's stream")?);
            while let Some((flags, message)) = frames.next() {
                let message: serde_json::Value = serde_json::from_slice(&message)
                    .context("a message of the command's stream")?;
                if flags & 2 != 0 {
                    if let Some(error) = message.get("error") {
                        bail!("the command's stream ended with {error}");
                    }
                    continue;
                }
                let event = &message["event"];
                for field in ["stdout", "stderr"] {
                    if let Some(data) = event["data"][field].as_str() {
                        output.add(&STANDARD.decode(data).unwrap_or_default());
                    }
                }
                if let Some(end) = event.get("end") {
                    output.flush();
                    return Ok(Ran {
                        exit_code: end["exitCode"].as_i64().unwrap_or(0),
                        tail: output.tail(),
                    });
                }
            }
        }
        output.flush();
        bail!(
            "the command's stream ended before it did; its last output:\n{}",
            output.tail()
        )
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
}

impl Output {
    const KEPT: usize = 40;

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
        tracing::info!(target: "compute_runners::command", "{line}");
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
