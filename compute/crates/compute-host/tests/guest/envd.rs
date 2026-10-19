//! A small client for envd through the guest's gateway port: HTTP/1.1 over
//! one agent `connect` stream per request, as the front door will do.

use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use bytes::Bytes;
use compute_host::client::Client;
use compute_host::protocol::{Id, PriorityName, Reply};
use http_body_util::{BodyExt as _, Full};
use hyper::{Method, Request, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};
use tokio::net::UnixStream;
use tokio::time::{Instant, sleep, timeout};

/// The guest's gateway port.
const GATEWAY: u32 = 57;
/// envd's TCP port in the guest.
const ENVD: u16 = 49983;

/// Opens a gateway stream into `sandbox`, sends `header` and returns the
/// guest's answer line (without its newline) and the stream.
pub async fn gateway(
    client: &Client,
    sandbox: Id,
    header: &str,
) -> Result<(String, BufReader<UnixStream>), String> {
    let (reply, mut stream) = client
        .connect(sandbox, None, GATEWAY, PriorityName::Interactive)
        .await
        .map_err(|error| error.to_string())?;
    if !matches!(reply, Reply::Connected { .. }) {
        return Err(format!("{reply:?}"));
    }
    stream
        .get_mut()
        .write_all(format!("{header}\n").as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    let mut line = String::new();
    timeout(Duration::from_secs(60), stream.read_line(&mut line))
        .await
        .map_err(|_| "no answer to the header".to_owned())?
        .map_err(|error| error.to_string())?;
    Ok((line.trim_end().to_owned(), stream))
}

/// Gives `sandbox` its environment and access token, as a create does.
pub async fn init(client: &Client, sandbox: Id, env: &[(&str, &str)], token: &str) {
    let data = serde_json::json!({
        "envVars": env.iter().copied().collect::<std::collections::BTreeMap<_, _>>(),
        "accessToken": token,
    });
    let (answer, _) = gateway(client, sandbox, &format!("init {data}"))
        .await
        .unwrap();
    assert_eq!(answer, "ok", "{sandbox}: init");
}

/// One envd of one sandbox, with the token and user its requests carry.
pub struct Envd<'a> {
    pub client: &'a Client,
    pub sandbox: Id,
    pub token: Option<String>,
    pub user: String,
}

/// What a process run returned.
#[derive(Debug, Default)]
pub struct Ran {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i64,
}

impl<'a> Envd<'a> {
    pub fn new(client: &'a Client, sandbox: Id) -> Self {
        Self {
            client,
            sandbox,
            token: None,
            user: "user".to_owned(),
        }
    }

    pub fn with_token(mut self, token: &str) -> Self {
        self.token = Some(token.to_owned());
        self
    }

    pub fn with_user(mut self, user: &str) -> Self {
        user.clone_into(&mut self.user);
        self
    }

    /// Sends one request to envd and returns its status and whole body.
    pub async fn send(
        &self,
        method: Method,
        path: &str,
        content_type: Option<&str>,
        body: Vec<u8>,
    ) -> Result<(StatusCode, Bytes), String> {
        let (answer, stream) = gateway(self.client, self.sandbox, &format!("tcp {ENVD}")).await?;
        if answer != "ok" {
            return Err(answer);
        }
        let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
            .await
            .map_err(|error| error.to_string())?;
        tokio::spawn(connection);
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("host", "localhost")
            .header(
                "authorization",
                format!("Basic {}", STANDARD.encode(format!("{}:", self.user))),
            );
        if let Some(token) = &self.token {
            request = request.header("x-access-token", token);
        }
        if let Some(content_type) = content_type {
            request = request.header("content-type", content_type);
        }
        let request = request.body(Full::new(Bytes::from(body))).unwrap();
        let response = timeout(Duration::from_secs(120), sender.send_request(request))
            .await
            .map_err(|_| format!("{path}: no response"))?
            .map_err(|error| error.to_string())?;
        let status = response.status();
        let body = timeout(Duration::from_secs(120), response.into_body().collect())
            .await
            .map_err(|_| format!("{path}: body timed out"))?
            .map_err(|error| error.to_string())?
            .to_bytes();
        Ok((status, body))
    }

    /// `GET /health` until it answers 204, for at most `within`.
    pub async fn wait_healthy(&self, within: Duration) -> Duration {
        let started = Instant::now();
        let mut last = String::new();
        while started.elapsed() < within {
            match self.send(Method::GET, "/health", None, Vec::new()).await {
                Ok((StatusCode::NO_CONTENT, _)) => return started.elapsed(),
                Ok((status, body)) => last = format!("{status} {body:?}"),
                Err(error) => last = error,
            }
            sleep(Duration::from_millis(20)).await;
        }
        panic!("{}: envd never became healthy: {last}", self.sandbox);
    }

    /// Runs `script` with `/bin/bash -l -c`, as the E2B SDK's commands do,
    /// to the end. Err is a status or error envd answered instead.
    pub async fn run(&self, script: &str) -> Result<Ran, String> {
        let message = serde_json::json!({
            "process": { "cmd": "/bin/bash", "args": ["-l", "-c", script], "envs": {} },
        })
        .to_string();
        let mut body = vec![0];
        body.extend_from_slice(&u32::try_from(message.len()).unwrap().to_be_bytes());
        body.extend_from_slice(message.as_bytes());
        let (status, bytes) = self
            .send(
                Method::POST,
                "/process.Process/Start",
                Some("application/connect+json"),
                body,
            )
            .await?;
        if status != StatusCode::OK {
            return Err(format!("{status} {}", String::from_utf8_lossy(&bytes)));
        }
        let mut ran = Ran::default();
        let mut rest = &bytes[..];
        while rest.len() >= 5 {
            let flags = rest[0];
            let len = u32::from_be_bytes(rest[1..5].try_into().unwrap()) as usize;
            let message: serde_json::Value = serde_json::from_slice(&rest[5..5 + len])
                .map_err(|error| format!("bad message: {error}"))?;
            rest = &rest[5 + len..];
            if flags & 2 != 0 {
                if let Some(error) = message.get("error") {
                    return Err(error.to_string());
                }
                continue;
            }
            let event = &message["event"];
            for (field, out) in [("stdout", &mut ran.stdout), ("stderr", &mut ran.stderr)] {
                if let Some(data) = event["data"][field].as_str() {
                    out.push_str(&String::from_utf8_lossy(&STANDARD.decode(data).unwrap()));
                }
            }
            if let Some(end) = event.get("end") {
                ran.exit_code = end["exitCode"].as_i64().unwrap_or(0);
            }
        }
        Ok(ran)
    }

    /// Writes `data` to `path` with a multipart upload.
    pub async fn upload(&self, path: &str, data: &[u8]) -> Result<StatusCode, String> {
        const BOUNDARY: &str = "compute-test-boundary";
        let mut body = format!(
            "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"f\"\r\n\
             Content-Type: application/octet-stream\r\n\r\n"
        )
        .into_bytes();
        body.extend_from_slice(data);
        body.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());
        let (status, _) = self
            .send(
                Method::POST,
                &format!("/files?path={path}&username={}", self.user),
                Some(&format!("multipart/form-data; boundary={BOUNDARY}")),
                body,
            )
            .await?;
        Ok(status)
    }

    /// Reads `path`.
    pub async fn download(&self, path: &str) -> Result<(StatusCode, Bytes), String> {
        self.send(
            Method::GET,
            &format!("/files?path={path}&username={}", self.user),
            None,
            Vec::new(),
        )
        .await
    }
}
