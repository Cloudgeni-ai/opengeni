//! Native, dependency-free Codemode client for Connected Machine commands.
//!
//! This is deliberately a thin client for the public attempt-scoped Codemode
//! API. It does not execute tools, hold a second catalog, or own authority: the
//! API's durable operation journal and the worker's exact attempt executor remain
//! the only execution path. The worker injects a short-lived bearer into each
//! child process; this module never persists or logs it.

use std::{path::PathBuf, time::Duration};

use reqwest::{Client, Response, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use thiserror::Error;
use tokio::time::{sleep, Instant};
use uuid::Uuid;

use crate::cli::{CodemodeAction, CodemodeArgs, CodemodeCallArgs};
use opengeni_agent_proto::v1::{self, ControlRequest, ExecRequest};

const URL_ENV: &str = "OPENGENI_CODEMODE_URL";
const TOKEN_ENV: &str = "OPENGENI_CODEMODE_TOKEN";
const TOKEN_FILE_ENV: &str = "OPENGENI_CODEMODE_TOKEN_FILE";
/// Absolute installed binary path exposed only to an attempt-scoped child that
/// already carries Codemode authority. This avoids every PATH/runtime guess.
pub const NATIVE_CLIENT_ENV: &str = "OPENGENI_CODEMODE_NATIVE_CLIENT";
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const MAX_ERROR_BYTES: usize = 64 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const CALL_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const POLL_INTERVAL: Duration = Duration::from_millis(500);
const QUEUED_RENOTIFY_INTERVAL: Duration = Duration::from_secs(2);

/// Add the exact running agent binary to a Codemode-authorized child. The path
/// is non-secret and process-local; no stable machine manifest is changed.
pub fn expose_native_client(request: &mut ExecRequest) {
    if !request.env.contains_key(URL_ENV) || !request.env.contains_key(TOKEN_ENV) {
        return;
    }
    let Ok(executable) = std::env::current_exe() else {
        return;
    };
    let executable = executable.canonicalize().unwrap_or(executable);
    if let Some(executable) = executable.to_str() {
        request
            .env
            .insert(NATIVE_CLIENT_ENV.to_string(), executable.to_string());
    }
}

/// Bind an attempt-scoped Codemode exec to the deployment origin of the exact
/// Connected Machine link carrying it. The control plane cannot safely infer
/// this route: one runner may serve several deployments, while `localhost` has
/// a different meaning on each host. A legacy connection has no authoritative
/// origin and therefore never calls this function.
pub fn bind_connection_origin(
    request: &mut ControlRequest,
    api_base_url: &str,
    workspace_id: &str,
) {
    let Some(exec) = request_exec_mut(request) else {
        return;
    };
    if !exec.env.contains_key(TOKEN_ENV) {
        return;
    }
    let Ok(mut url) = Url::parse(api_base_url) else {
        return;
    };
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return;
    }
    let prefix = url.path().trim_end_matches('/');
    url.set_path(&format!("{prefix}/v1/workspaces/{workspace_id}/codemode"));
    url.set_query(None);
    url.set_fragment(None);
    exec.env.insert(URL_ENV.to_string(), url.to_string());
}

fn request_exec_mut(request: &mut ControlRequest) -> Option<&mut ExecRequest> {
    match request.op.as_mut()? {
        v1::control_request::Op::Exec(exec) => Some(exec),
        v1::control_request::Op::OpStart(start) => match start.op.as_mut()? {
            v1::op_start::Op::Exec(exec) => Some(exec),
            _ => None,
        },
        _ => None,
    }
}

#[derive(Debug, Error)]
pub enum CodemodeError {
    #[error("{0}")]
    Configuration(String),
    #[error("{0}")]
    InvalidArguments(String),
    #[error("Codemode request failed: {0}")]
    Transport(String),
    #[error("Codemode request failed with HTTP {status}: {message}")]
    Http { status: StatusCode, message: String },
    #[error("Codemode response was invalid: {0}")]
    InvalidResponse(String),
    #[error("Codemode operation {operation_id} did not settle before the client deadline")]
    Deadline { operation_id: String },
    #[error("Codemode operation outcome is unknown: {0}")]
    OutcomeUnknown(String),
    #[error("Codemode operation failed: {0}")]
    Operation(String),
}

/// Run one native Codemode command. Output is JSON so shell/Bun/Python callers
/// can consume it without parsing prose.
pub async fn run(args: CodemodeArgs) -> Result<(), CodemodeError> {
    if matches!(args.action, CodemodeAction::Doctor) {
        let report = doctor_report();
        println!("{}", serde_json::to_string_pretty(&report)?);
        return if report.get("ok").and_then(Value::as_bool) == Some(true) {
            Ok(())
        } else {
            Err(CodemodeError::Configuration(
                "Codemode environment is not ready".to_string(),
            ))
        };
    }

    let client = CodemodeClient::from_environment()?;
    match args.action {
        CodemodeAction::List => {
            let catalog = client.catalog().await?;
            println!(
                "{}",
                serde_json::to_string_pretty(&catalog.list_projection())?
            );
        }
        CodemodeAction::Call(args) => {
            let result = client.call(args).await?;
            println!("{}", serde_json::to_string_pretty(&result)?);
        }
        CodemodeAction::Doctor => unreachable!("doctor returned before client construction"),
    }
    Ok(())
}

impl From<serde_json::Error> for CodemodeError {
    fn from(error: serde_json::Error) -> Self {
        Self::InvalidResponse(error.to_string())
    }
}

struct CodemodeClient {
    base_url: Url,
    token: String,
    http: Client,
}

impl CodemodeClient {
    fn from_environment() -> Result<Self, CodemodeError> {
        let base_url = environment_value(URL_ENV)
            .ok_or_else(|| CodemodeError::Configuration(format!("{URL_ENV} is required")))?;
        let token = configured_token()?;
        Self::new(&base_url, token)
    }

    fn new(base_url: &str, token: String) -> Result<Self, CodemodeError> {
        let normalized = format!("{}/", base_url.trim().trim_end_matches('/'));
        let parsed = Url::parse(&normalized).map_err(|_| {
            CodemodeError::Configuration(format!("{URL_ENV} must be an absolute HTTP(S) URL"))
        })?;
        if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
            return Err(CodemodeError::Configuration(format!(
                "{URL_ENV} must be an absolute HTTP(S) URL"
            )));
        }
        if token.trim().is_empty() {
            return Err(CodemodeError::Configuration(format!(
                "{TOKEN_ENV} is empty"
            )));
        }
        let http = Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .user_agent(concat!("opengeni-agent/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| CodemodeError::Transport(error.to_string()))?;
        Ok(Self {
            base_url: parsed,
            token,
            http,
        })
    }

    async fn catalog(&self) -> Result<Catalog, CodemodeError> {
        let response = self
            .http
            .get(self.url("catalog")?)
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|error| transport_error(&error))?;
        decode_json_response(response).await
    }

    async fn call(&self, args: CodemodeCallArgs) -> Result<Value, CodemodeError> {
        let arguments = parse_arguments(&args.arguments)?;
        let catalog = self.catalog().await?;
        let entry = catalog.resolve(&args.tool)?;
        let operation_id = Uuid::new_v4().to_string();
        let request = CallRequest {
            operation_id: operation_id.clone(),
            catalog_digest: catalog.digest.clone(),
            identity: entry.identity.clone(),
            arguments,
        };
        let deadline = Instant::now() + CALL_TIMEOUT;
        let mut submitted = false;
        let mut operation: Option<Operation> = None;
        let mut next_notify_at = Instant::now();

        loop {
            if Instant::now() >= deadline {
                return Err(CodemodeError::Deadline {
                    operation_id: operation_id.clone(),
                });
            }
            let should_notify = !submitted
                || operation
                    .as_ref()
                    .is_some_and(|value| value.state == OperationState::Queued)
                    && Instant::now() >= next_notify_at;
            let next = if should_notify {
                submitted = true;
                next_notify_at = Instant::now() + QUEUED_RENOTIFY_INTERVAL;
                match self.submit(&request).await {
                    Ok(value) => value,
                    Err(submit_error) => match self.read(&operation_id).await {
                        Ok(value) => value,
                        Err(_) => return Err(submit_error),
                    },
                }
            } else {
                self.read(&operation_id).await?
            };

            match next.state {
                OperationState::Completed => {
                    return next.result.ok_or_else(|| {
                        CodemodeError::InvalidResponse(
                            "completed operation omitted its result".to_string(),
                        )
                    });
                }
                OperationState::Failed | OperationState::Cancelled => {
                    return Err(CodemodeError::Operation(next.error_summary()));
                }
                OperationState::OutcomeUnknown => {
                    return Err(CodemodeError::OutcomeUnknown(next.error_summary()));
                }
                OperationState::Queued | OperationState::Running => operation = Some(next),
            }
            sleep(POLL_INTERVAL).await;
        }
    }

    async fn submit(&self, request: &CallRequest) -> Result<Operation, CodemodeError> {
        let response = self
            .http
            .post(self.url("calls")?)
            .bearer_auth(&self.token)
            .json(request)
            .send()
            .await
            .map_err(|error| transport_error(&error))?;
        let submission: Submission = decode_json_response(response).await?;
        Ok(submission.operation)
    }

    async fn read(&self, operation_id: &str) -> Result<Operation, CodemodeError> {
        let response = self
            .http
            .get(self.url(&format!("calls/{operation_id}"))?)
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|error| transport_error(&error))?;
        decode_json_response(response).await
    }

    fn url(&self, path: &str) -> Result<Url, CodemodeError> {
        self.base_url
            .join(path)
            .map_err(|error| CodemodeError::Configuration(error.to_string()))
    }
}

fn configured_token() -> Result<String, CodemodeError> {
    // Presence, not truthiness, selects the direct attempt bearer. A stale file
    // pointer can remain in inherited process state without overriding renewal.
    if std::env::var_os(TOKEN_ENV).is_some() {
        return environment_value(TOKEN_ENV)
            .ok_or_else(|| CodemodeError::Configuration(format!("{TOKEN_ENV} is empty")));
    }
    let token_file = environment_value(TOKEN_FILE_ENV).ok_or_else(|| {
        CodemodeError::Configuration(format!("{TOKEN_ENV} or {TOKEN_FILE_ENV} is required"))
    })?;
    let token = std::fs::read_to_string(&token_file)
        .map_err(|_| CodemodeError::Configuration(format!("{TOKEN_FILE_ENV} is not readable")))?;
    nonempty(&token)
        .ok_or_else(|| CodemodeError::Configuration(format!("{TOKEN_FILE_ENV} is empty")))
}

fn environment_value(name: &str) -> Option<String> {
    std::env::var(name).ok().and_then(|value| nonempty(&value))
}

fn nonempty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn parse_arguments(raw: &str) -> Result<Map<String, Value>, CodemodeError> {
    match serde_json::from_str(raw) {
        Ok(Value::Object(value)) => Ok(value),
        Ok(_) => Err(CodemodeError::InvalidArguments(
            "tool arguments must be a JSON object".to_string(),
        )),
        Err(_) => Err(CodemodeError::InvalidArguments(
            "tool arguments must be valid JSON".to_string(),
        )),
    }
}

fn transport_error(error: &reqwest::Error) -> CodemodeError {
    // reqwest's display omits Authorization headers. The URL is non-secret; the
    // attempt bearer never becomes part of it.
    CodemodeError::Transport(error.to_string())
}

async fn decode_json_response<T: for<'de> Deserialize<'de>>(
    mut response: Response,
) -> Result<T, CodemodeError> {
    let status = response.status();
    let limit = if status.is_success() {
        MAX_RESPONSE_BYTES
    } else {
        MAX_ERROR_BYTES
    };
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| transport_error(&error))?
    {
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(CodemodeError::InvalidResponse(format!(
                "response exceeded {limit} bytes"
            )));
        }
        bytes.extend_from_slice(&chunk);
    }
    if !status.is_success() {
        let message = serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|value| {
                value
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
            })
            .unwrap_or_else(|| "request rejected".to_string());
        return Err(CodemodeError::Http { status, message });
    }
    serde_json::from_slice(&bytes)
        .map_err(|error| CodemodeError::InvalidResponse(error.to_string()))
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ToolIdentity {
    server_id: String,
    tool_name: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogEntry {
    identity: ToolIdentity,
    model_name: String,
    codemode_path: Vec<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    description: Option<String>,
    input_schema: Value,
    #[serde(default)]
    output_schema: Option<Value>,
    #[serde(default)]
    annotations: Option<Value>,
    source: String,
    approval: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Catalog {
    attempt_id: String,
    digest: String,
    entries: Vec<CatalogEntry>,
}

impl Catalog {
    fn resolve(&self, name: &str) -> Result<&CatalogEntry, CodemodeError> {
        let matches: Vec<_> = self
            .entries
            .iter()
            .filter(|entry| {
                entry.model_name == name
                    || entry.codemode_path.join(".") == name
                    || format!("{}.{}", entry.identity.server_id, entry.identity.tool_name) == name
            })
            .collect();
        match matches.as_slice() {
            [entry] => Ok(entry),
            [] => Err(CodemodeError::InvalidArguments(format!(
                "Unknown Codemode tool: {name}"
            ))),
            _ => Err(CodemodeError::InvalidArguments(format!(
                "Ambiguous Codemode tool: {name}"
            ))),
        }
    }

    fn list_projection(&self) -> Value {
        let tools: Vec<_> = self
            .entries
            .iter()
            .map(|entry| {
                let mut value = Map::from_iter([
                    ("name".to_string(), json!(entry.model_name)),
                    ("path".to_string(), json!(entry.codemode_path.join("."))),
                    ("identity".to_string(), json!(entry.identity)),
                    ("inputSchema".to_string(), entry.input_schema.clone()),
                    ("approval".to_string(), json!(entry.approval)),
                    ("source".to_string(), json!(entry.source)),
                ]);
                for (key, optional) in [
                    ("title", entry.title.as_ref().map(|value| json!(value))),
                    (
                        "description",
                        entry.description.as_ref().map(|value| json!(value)),
                    ),
                    ("outputSchema", entry.output_schema.clone()),
                    ("annotations", entry.annotations.clone()),
                ] {
                    if let Some(optional) = optional {
                        value.insert(key.to_string(), optional);
                    }
                }
                Value::Object(value)
            })
            .collect();
        json!({
            "catalogDigest": self.digest,
            "attemptId": self.attempt_id,
            "tools": tools,
        })
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CallRequest {
    operation_id: String,
    catalog_digest: String,
    identity: ToolIdentity,
    arguments: Map<String, Value>,
}

#[derive(Debug, Deserialize)]
struct Submission {
    operation: Operation,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum OperationState {
    Queued,
    Running,
    Completed,
    Failed,
    OutcomeUnknown,
    Cancelled,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Operation {
    state: OperationState,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error_code: Option<String>,
    #[serde(default)]
    error_message: Option<String>,
}

impl Operation {
    fn error_summary(&self) -> String {
        self.error_message
            .clone()
            .or_else(|| self.error_code.clone())
            .unwrap_or_else(|| format!("operation {:?}", self.state))
    }
}

fn doctor_report() -> Value {
    let raw_url = std::env::var(URL_ENV).ok();
    let url_valid = raw_url.as_deref().is_some_and(|raw| {
        Url::parse(raw)
            .is_ok_and(|url| matches!(url.scheme(), "http" | "https") && url.host_str().is_some())
    });
    let direct_raw = std::env::var(TOKEN_ENV).ok();
    let direct_token_configured = std::env::var_os(TOKEN_ENV).is_some();
    let direct_token_nonempty = direct_raw
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty());
    let token_file = environment_value(TOKEN_FILE_ENV).map(PathBuf::from);
    let token_file_configured = std::env::var_os(TOKEN_FILE_ENV).is_some();
    let file_contents = token_file
        .as_ref()
        .and_then(|path| std::fs::read_to_string(path).ok());
    let token_file_readable = file_contents.is_some();
    let token_file_nonempty = file_contents
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty());
    let token_ready = if direct_token_configured {
        direct_token_nonempty
    } else {
        token_file_nonempty
    };
    json!({
        "ok": url_valid && token_ready,
        "urlConfigured": raw_url.is_some(),
        "urlValid": url_valid,
        "tokenMode": if direct_token_configured {
            Some("environment")
        } else if token_file_configured {
            Some("file")
        } else {
            None
        },
        "directTokenConfigured": direct_token_configured,
        "directTokenNonempty": direct_token_nonempty,
        "tokenFileConfigured": token_file_configured,
        "tokenFileReadable": token_file_readable,
        "tokenFileNonempty": token_file_nonempty,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::net::{TcpListener, TcpStream};

    fn catalog(entries: Vec<CatalogEntry>) -> Catalog {
        Catalog {
            attempt_id: "11111111-1111-4111-8111-111111111111".to_string(),
            digest: "a".repeat(64),
            entries,
        }
    }

    fn entry(server: &str, tool: &str, model: &str, path: &[&str]) -> CatalogEntry {
        CatalogEntry {
            identity: ToolIdentity {
                server_id: server.to_string(),
                tool_name: tool.to_string(),
            },
            model_name: model.to_string(),
            codemode_path: path.iter().map(|value| (*value).to_string()).collect(),
            title: None,
            description: None,
            input_schema: json!({"type": "object"}),
            output_schema: None,
            annotations: None,
            source: "mcp".to_string(),
            approval: "none".to_string(),
        }
    }

    #[test]
    fn resolves_each_public_name_without_parsing_authority() {
        let catalog = catalog(vec![entry(
            "server",
            "tool-name",
            "server__tool_name",
            &["server", "tool_name"],
        )]);
        for name in ["server__tool_name", "server.tool_name", "server.tool-name"] {
            assert_eq!(
                catalog.resolve(name).expect("resolve").identity.tool_name,
                "tool-name"
            );
        }
    }

    #[test]
    fn rejects_non_object_arguments() {
        assert!(matches!(
            parse_arguments("[]"),
            Err(CodemodeError::InvalidArguments(_))
        ));
        assert_eq!(parse_arguments(r#"{"x":1}"#).expect("object")["x"], 1);
    }

    #[test]
    fn list_projection_matches_the_public_cli_shape() {
        let projection = catalog(vec![entry(
            "server",
            "tool",
            "server__tool",
            &["server", "tool"],
        )])
        .list_projection();
        assert_eq!(projection["catalogDigest"], "a".repeat(64));
        assert_eq!(projection["tools"][0]["path"], "server.tool");
        assert_eq!(projection["tools"][0]["identity"]["serverId"], "server");
    }

    #[test]
    fn operation_error_never_includes_client_credentials() {
        let operation = Operation {
            state: OperationState::Failed,
            result: None,
            error_code: Some("tool_failed".to_string()),
            error_message: None,
        };
        assert_eq!(operation.error_summary(), "tool_failed");
    }

    #[test]
    fn native_client_path_is_only_added_to_attempt_scoped_execs() {
        let mut ordinary = ExecRequest::default();
        expose_native_client(&mut ordinary);
        assert!(!ordinary.env.contains_key(NATIVE_CLIENT_ENV));

        ordinary.env.insert(
            URL_ENV.to_string(),
            "https://example.test/codemode".to_string(),
        );
        ordinary
            .env
            .insert(TOKEN_ENV.to_string(), "attempt-secret".to_string());
        expose_native_client(&mut ordinary);
        let executable = ordinary.env.get(NATIVE_CLIENT_ENV).expect("native client");
        assert!(std::path::Path::new(executable).is_absolute());
        assert!(!executable.contains("attempt-secret"));
    }

    #[test]
    fn connected_machine_exec_uses_the_exact_link_origin() {
        let mut exec = ExecRequest::default();
        exec.env.insert(
            URL_ENV.to_string(),
            "http://127.0.0.1:8000/stale".to_string(),
        );
        exec.env
            .insert(TOKEN_ENV.to_string(), "attempt-secret".to_string());
        let mut request = ControlRequest {
            op: Some(v1::control_request::Op::Exec(exec)),
            ..ControlRequest::default()
        };

        bind_connection_origin(
            &mut request,
            "https://machine.example.test/opengeni/",
            "workspace-1",
        );

        let Some(v1::control_request::Op::Exec(exec)) = request.op else {
            panic!("exec request");
        };
        assert_eq!(
            exec.env.get(URL_ENV).map(String::as_str),
            Some("https://machine.example.test/opengeni/v1/workspaces/workspace-1/codemode")
        );
    }

    #[test]
    fn connected_machine_origin_is_not_projected_without_attempt_authority() {
        let mut exec = ExecRequest::default();
        exec.env.insert(
            URL_ENV.to_string(),
            "https://worker.example.test/codemode".to_string(),
        );
        let mut request = ControlRequest {
            op: Some(v1::control_request::Op::Exec(exec)),
            ..ControlRequest::default()
        };

        bind_connection_origin(&mut request, "https://machine.example.test", "workspace-1");

        let Some(v1::control_request::Op::Exec(exec)) = request.op else {
            panic!("exec request");
        };
        assert_eq!(
            exec.env.get(URL_ENV).map(String::as_str),
            Some("https://worker.example.test/codemode")
        );
    }

    #[test]
    fn connected_machine_streamed_exec_uses_the_exact_link_origin() {
        let mut exec = ExecRequest::default();
        exec.env
            .insert(TOKEN_ENV.to_string(), "attempt-secret".to_string());
        let mut request = ControlRequest {
            op: Some(v1::control_request::Op::OpStart(v1::OpStart {
                op: Some(v1::op_start::Op::Exec(exec)),
                ..v1::OpStart::default()
            })),
            ..ControlRequest::default()
        };

        bind_connection_origin(
            &mut request,
            "https://machine.example.test/opengeni",
            "workspace-1",
        );

        let Some(v1::control_request::Op::OpStart(start)) = request.op else {
            panic!("op start request");
        };
        let Some(v1::op_start::Op::Exec(exec)) = start.op else {
            panic!("streamed exec request");
        };
        assert_eq!(
            exec.env.get(URL_ENV).map(String::as_str),
            Some("https://machine.example.test/opengeni/v1/workspaces/workspace-1/codemode")
        );
    }

    #[tokio::test]
    async fn native_client_calls_the_public_attempt_journal_once() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listen");
        let address = listener.local_addr().expect("address");
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for response in [
                json!({
                    "attemptId": "11111111-1111-4111-8111-111111111111",
                    "digest": "a".repeat(64),
                    "entries": [{
                        "identity": { "serverId": "demo", "toolName": "lookup" },
                        "modelName": "demo__lookup",
                        "codemodePath": ["demo", "lookup"],
                        "inputSchema": { "type": "object" },
                        "source": "mcp",
                        "approval": "none"
                    }]
                }),
                json!({
                    "dispatch": "terminal",
                    "operation": {
                        "state": "completed",
                        "result": {
                            "content": [{ "type": "text", "text": "found" }],
                            "_meta": {}
                        }
                    }
                }),
            ] {
                let (mut stream, _) = listener.accept().await.expect("accept");
                requests.push(read_request(&mut stream).await);
                write_response(&mut stream, &response).await;
            }
            requests
        });

        let client = CodemodeClient::new(
            &format!("http://{address}/v1/workspaces/ws/codemode"),
            "attempt-bearer".to_string(),
        )
        .expect("client");
        let result = client
            .call(CodemodeCallArgs {
                tool: "demo.lookup".to_string(),
                arguments: r#"{"query":"hello"}"#.to_string(),
            })
            .await
            .expect("call");
        assert_eq!(result["content"][0]["text"], "found");

        let requests = server.await.expect("server");
        assert_eq!(requests.len(), 2);
        assert!(requests[0].starts_with("GET /v1/workspaces/ws/codemode/catalog "));
        assert!(requests[1].starts_with("POST /v1/workspaces/ws/codemode/calls "));
        for request in &requests {
            assert!(request.contains("authorization: Bearer attempt-bearer"));
        }
        let body = requests[1].split("\r\n\r\n").nth(1).expect("request body");
        let body: Value = serde_json::from_str(body).expect("json request");
        assert_eq!(body["catalogDigest"], "a".repeat(64));
        assert_eq!(body["identity"]["serverId"], "demo");
        assert_eq!(body["arguments"]["query"], "hello");
        assert!(Uuid::parse_str(body["operationId"].as_str().expect("operation id")).is_ok());
    }

    #[tokio::test]
    async fn native_client_recovers_a_committed_post_by_operation_id() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listen");
        let address = listener.local_addr().expect("address");
        let server = tokio::spawn(async move {
            let (mut catalog_stream, _) = listener.accept().await.expect("catalog accept");
            let catalog_request = read_request(&mut catalog_stream).await;
            write_response(
                &mut catalog_stream,
                &json!({
                    "attemptId": "11111111-1111-4111-8111-111111111111",
                    "digest": "b".repeat(64),
                    "entries": [{
                        "identity": { "serverId": "demo", "toolName": "mutate" },
                        "modelName": "demo__mutate",
                        "codemodePath": ["demo", "mutate"],
                        "inputSchema": { "type": "object" },
                        "source": "mcp",
                        "approval": "none"
                    }]
                }),
            )
            .await;

            // Simulate the classic ambiguous transport boundary: the server has
            // committed the POST but its response disappears.
            let (mut post_stream, _) = listener.accept().await.expect("post accept");
            let post_request = read_request(&mut post_stream).await;
            post_stream.shutdown().await.expect("drop post response");

            let (mut read_stream, _) = listener.accept().await.expect("read accept");
            let read_request_value = read_request(&mut read_stream).await;
            write_response(
                &mut read_stream,
                &json!({
                    "state": "completed",
                    "result": {
                        "content": [{ "type": "text", "text": "recovered" }],
                        "_meta": {}
                    }
                }),
            )
            .await;
            [catalog_request, post_request, read_request_value]
        });

        let client = CodemodeClient::new(
            &format!("http://{address}/v1/workspaces/ws/codemode"),
            "attempt-bearer".to_string(),
        )
        .expect("client");
        let result = client
            .call(CodemodeCallArgs {
                tool: "demo.mutate".to_string(),
                arguments: "{}".to_string(),
            })
            .await
            .expect("recovered call");
        assert_eq!(result["content"][0]["text"], "recovered");

        let requests = server.await.expect("server");
        assert!(requests[1].starts_with("POST /v1/workspaces/ws/codemode/calls "));
        let operation_id =
            serde_json::from_str::<Value>(requests[1].split("\r\n\r\n").nth(1).expect("post body"))
                .expect("post json")["operationId"]
                .as_str()
                .expect("operation id")
                .to_string();
        assert!(requests[2].starts_with(&format!(
            "GET /v1/workspaces/ws/codemode/calls/{operation_id} "
        )));
    }

    async fn read_request(stream: &mut TcpStream) -> String {
        let mut bytes = Vec::new();
        let mut buffer = [0_u8; 4096];
        let mut expected = None;
        loop {
            let count = stream.read(&mut buffer).await.expect("read request");
            assert!(count > 0, "request closed before completion");
            bytes.extend_from_slice(&buffer[..count]);
            if expected.is_none() {
                if let Some(header_end) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..header_end]);
                    let content_length = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())
                                .flatten()
                        })
                        .unwrap_or(0);
                    expected = Some(header_end + 4 + content_length);
                }
            }
            if expected.is_some_and(|length| bytes.len() >= length) {
                return String::from_utf8(bytes).expect("utf8 request");
            }
        }
    }

    async fn write_response(stream: &mut TcpStream, body: &Value) {
        let body = serde_json::to_vec(body).expect("response json");
        let headers = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            body.len()
        );
        stream
            .write_all(headers.as_bytes())
            .await
            .expect("write headers");
        stream.write_all(&body).await.expect("write body");
        stream.shutdown().await.expect("close response");
    }
}
