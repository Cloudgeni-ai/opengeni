//! Native, dependency-free Codemode client for Connected Machine commands.
//!
//! This is deliberately a thin client for the public attempt-scoped Codemode
//! API. It does not execute tools, hold a second catalog, or own authority: the
//! API's durable operation journal and the worker's exact attempt executor remain
//! the only execution path. The worker injects a short-lived bearer into each
//! child process; this module never persists or logs it.

use std::{fmt::Write as _, path::PathBuf, time::Duration};

use reqwest::{Client, Response, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use thiserror::Error;
use tokio::time::{sleep, Instant};
use uuid::Uuid;

use crate::cli::{CodemodeAction, CodemodeArgs, CodemodeCallArgs, CodemodeListArgs};
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
/// a different meaning on each host.
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

/// Run one native Codemode command. Discovery is compact text by default;
/// `list --json`, `list --full`, and `show` provide explicit JSON output.
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
        CodemodeAction::List(args) => {
            let catalog = client.catalog().await?;
            if args.full {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&catalog.list_projection())?
                );
            } else {
                print!("{}", catalog.compact_output(&args)?);
            }
        }
        CodemodeAction::Show(args) => {
            print!("{}", client.catalog().await?.show_output(&args.tool)?);
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
    fn compact_output(&self, args: &CodemodeListArgs) -> Result<String, CodemodeError> {
        let query = args.query.as_deref().unwrap_or("");
        let matches: Vec<_> = self
            .entries
            .iter()
            .filter(|entry| {
                entry.codemode_path.join(".").contains(query)
                    || normalized_description(entry).contains(query)
            })
            .collect();
        let offset = args.offset.unwrap_or(0);
        let tools: Vec<_> = matches
            .iter()
            .skip(offset)
            .take(args.limit.unwrap_or(usize::MAX))
            .map(|entry| {
                json!({
                    "path": entry.codemode_path.join("."),
                    "description": short_description(entry),
                })
            })
            .collect();
        let text_lines: Vec<String> = if args.json {
            Vec::new()
        } else {
            tools
                .iter()
                .map(|tool| {
                    let path = tool["path"].as_str().unwrap_or_default();
                    let description = tool["description"].as_str().unwrap_or_default();
                    if description.is_empty() {
                        format!("{path}\n")
                    } else {
                        let description = terminal_description(description);
                        format!("{path} — {description}\n")
                    }
                })
                .collect()
        };
        let next_offset = (offset + tools.len() < matches.len()).then_some(offset + tools.len());
        let output = if args.json {
            format!(
                "{}\n",
                serde_json::to_string(&json!({
                    "catalogDigest": self.digest,
                    "total": matches.len(),
                    "offset": offset,
                    "nextOffset": next_offset,
                    "tools": tools,
                }))?
            )
        } else {
            let mut output = text_lines.concat();
            let _ = writeln!(
                output,
                "# total: {}; offset: {offset}; nextOffset: {}",
                matches.len(),
                next_offset.map_or_else(|| "none".to_string(), |value| value.to_string())
            );
            if let Some(next) = next_offset {
                let _ = writeln!(
                    output,
                    "# Continue with --offset {next} (keep the same --query and --limit)."
                );
            }
            output
        };
        Ok(output)
    }

    fn show_output(&self, name: &str) -> Result<String, CodemodeError> {
        let entry = self.resolve(name)?;
        let single = Catalog {
            attempt_id: self.attempt_id.clone(),
            digest: self.digest.clone(),
            entries: vec![entry.clone()],
        };
        let output = serde_json::to_string_pretty(&single.list_projection()["tools"][0])?;
        if output.len() + 1 > 64 * 1024 {
            return Err(CodemodeError::InvalidArguments(
                "Tool details exceed 65536 bytes; use list --full".to_string(),
            ));
        }
        Ok(format!("{output}\n"))
    }

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

// Terminal-only presentation; catalog, query, and JSON content remain unchanged.
fn terminal_description(text: &str) -> String {
    let mut output = String::new();
    for character in text.chars() {
        if matches!(character, '\u{0000}'..='\u{001f}' | '\u{007f}'..='\u{009f}') {
            let _ = write!(output, "\\u{:04x}", u32::from(character));
        } else {
            output.push(character);
        }
    }
    output
}

fn normalized_description(entry: &CatalogEntry) -> String {
    entry
        .description
        .as_deref()
        .filter(|value| !value.is_empty())
        .or(entry.title.as_deref())
        .unwrap_or("")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn short_description(entry: &CatalogEntry) -> String {
    let text = normalized_description(entry);
    if text.chars().count() <= 160 {
        text
    } else {
        format!("{}…", text.chars().take(159).collect::<String>())
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
    fn compact_discovery_is_closed_and_unicode_safe() {
        let mut tool = entry("server", "tool", "server__tool", &["server", "tool"]);
        tool.title = Some("Fallback title".to_string());
        for (description, expected) in [
            (
                "  Search\n\t docs\u{2003}now  ".to_string(),
                "Search docs now".to_string(),
            ),
            ("😀".repeat(160), "😀".repeat(160)),
            ("界😀".repeat(81), format!("{}界…", "界😀".repeat(79))),
            (String::new(), "Fallback title".to_string()),
        ] {
            tool.description = Some(description);
            assert_eq!(short_description(&tool), expected);
            let catalog = catalog(vec![tool.clone()]);
            let output = catalog
                .compact_output(&CodemodeListArgs {
                    json: true,
                    ..Default::default()
                })
                .unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&output).unwrap(),
                json!({"catalogDigest": catalog.digest, "total": 1, "offset": 0, "nextOffset": null,
                    "tools": [{"path": "server.tool", "description": expected}]})
            );
            assert_eq!(
                catalog
                    .compact_output(&CodemodeListArgs::default())
                    .unwrap(),
                format!("server.tool — {expected}\n# total: 1; offset: 0; nextOffset: none\n")
            );
        }
        tool.description = None;
        tool.title = None;
        assert_eq!(
            catalog(vec![tool])
                .compact_output(&CodemodeListArgs::default())
                .unwrap(),
            "server.tool\n# total: 1; offset: 0; nextOffset: none\n"
        );
        assert_eq!(
            catalog(vec![])
                .compact_output(&CodemodeListArgs::default())
                .unwrap(),
            "# total: 0; offset: 0; nextOffset: none\n"
        );
    }

    #[test]
    fn terminal_controls_are_escaped_only_in_text_not_catalog_json_or_queries() {
        let controls: String = (0_u8..=31).chain(127..=159).map(char::from).collect();
        let payload = format!(
            "Search\u{1b}]52;c;VEVTVA==\u{7} CSI\u{1b}[2J Back\u{8} DEL\u{7f} C1\u{9b}{controls}"
        );
        for title_fallback in [false, true] {
            let mut tool = entry("docs", "tool", "docs__tool", &["docs", "tool"]);
            if title_fallback {
                tool.title = Some(payload.clone());
            } else {
                tool.description = Some(payload.clone());
            }
            let frozen = catalog(vec![tool]);
            let before = frozen.list_projection();
            let json_args = CodemodeListArgs {
                json: true,
                ..Default::default()
            };
            let json_before = frozen.compact_output(&json_args).unwrap();
            let output = frozen.compact_output(&CodemodeListArgs::default()).unwrap();
            assert!(output.chars().all(|character| character == '\n'
                || !matches!(character, '\u{0000}'..='\u{001f}' | '\u{007f}'..='\u{009f}')));
            assert!(output.contains("Search\\u001b]52;c;VEVTVA==\\u0007"));
            assert!(output.contains("CSI\\u001b[2J Back\\u0008 DEL\\u007f C1\\u009b"));
            for character in controls
                .chars()
                .filter(|character| !character.is_whitespace())
            {
                assert!(output.contains(&format!("\\u{:04x}", u32::from(character))));
            }
            assert_eq!(frozen.list_projection(), before);
            assert_eq!(frozen.compact_output(&json_args).unwrap(), json_before);
            for (query, total) in [("\u{1b}]52", 1), ("\\u001b]52", 0)] {
                let output = frozen
                    .compact_output(&CodemodeListArgs {
                        json: true,
                        query: Some(query.to_string()),
                        ..Default::default()
                    })
                    .unwrap();
                let page: Value = serde_json::from_str(&output).unwrap();
                assert_eq!(page["total"], total);
                if total == 1 {
                    assert_eq!(
                        page["tools"][0]["description"],
                        short_description(&frozen.entries[0])
                    );
                }
            }
        }
    }

    #[test]
    fn terminal_escape_expansion_does_not_drop_tools() {
        let frozen = catalog(
            (0..100)
                .map(|index| {
                    let name = format!("tool{index}");
                    let mut tool = entry("docs", &name, &name, &["docs", &name]);
                    tool.description = Some("\u{1b}".repeat(160));
                    tool
                })
                .collect(),
        );
        let output = frozen
            .compact_output(&CodemodeListArgs {
                limit: Some(100),
                ..Default::default()
            })
            .unwrap();
        assert!(output.len() > 16_384);
        assert!(!output.contains('\u{1b}'));
        let count = output
            .lines()
            .filter(|line| line.starts_with("docs."))
            .count();
        assert_eq!(count, 100);
        assert!(output.contains("nextOffset: none\n"));
        assert!(output.contains(&"\\u001b".repeat(160)));
        let next = frozen
            .compact_output(&CodemodeListArgs {
                offset: Some(count),
                ..Default::default()
            })
            .unwrap();
        assert!(!next.contains("docs.tool"));
    }

    #[test]
    fn compact_output_lists_all_4096_tools_with_maximum_paths_without_skips() {
        for extreme in [false, true] {
            let tools = (0..4096)
                .map(|index| {
                    let name = format!("tool{index}");
                    let mut tool = entry("docs", &name, &name, &["docs", &name]);
                    if extreme {
                        tool.codemode_path = vec!["x".repeat(128); 8];
                        tool.codemode_path[7] = format!("{name:x<128}");
                        tool.description =
                            Some(if index % 2 == 0 { "\0" } else { "😀" }.repeat(160));
                    }
                    tool
                })
                .collect();
            let frozen = catalog(tools);
            let expected: Vec<_> = frozen
                .entries
                .iter()
                .map(|tool| tool.codemode_path.join("."))
                .collect();
            for json in [false, true] {
                let mut seen = Vec::new();
                let mut offset = 0;
                loop {
                    let output = frozen
                        .compact_output(&CodemodeListArgs {
                            json,
                            offset: Some(offset),
                            ..Default::default()
                        })
                        .unwrap();
                    assert!(output.len() > 16_384);
                    let (paths, next): (Vec<String>, Option<usize>) = if json {
                        let page: Value = serde_json::from_str(&output).unwrap();
                        assert_eq!(page["total"], 4096);
                        assert_eq!(page["offset"], offset);
                        assert_eq!(page["catalogDigest"], frozen.digest);
                        (
                            page["tools"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .map(|tool| tool["path"].as_str().unwrap().to_string())
                                .collect(),
                            page["nextOffset"]
                                .as_u64()
                                .map(|value| usize::try_from(value).unwrap()),
                        )
                    } else {
                        assert!(output.chars().all(|character| character == '\n' || !matches!(character, '\u{0000}'..='\u{001f}' | '\u{007f}'..='\u{009f}')));
                        let paths = output
                            .lines()
                            .filter(|line| !line.starts_with('#'))
                            .map(|line| line.split(" — ").next().unwrap().to_string())
                            .collect();
                        let footer = output
                            .lines()
                            .find(|line| line.starts_with("# total:"))
                            .unwrap();
                        let next = footer.rsplit(": ").next().unwrap();
                        let next = if next == "none" {
                            None
                        } else {
                            Some(next.parse().unwrap())
                        };
                        if let Some(next) = next {
                            assert!(output.contains(&format!("# Continue with --offset {next}")));
                        }
                        (paths, next)
                    };
                    assert_eq!(paths.len(), 4096);
                    let count = paths.len();
                    seen.extend(paths);
                    match next {
                        Some(next) => {
                            assert_eq!(next, offset + count);
                            offset = next;
                        }
                        None => break,
                    }
                }
                assert_eq!(seen, expected);
            }
        }
    }

    #[test]
    fn compact_queries_and_offsets_are_literal_filtered_and_bounded() {
        let mut frozen = catalog(
            (0..101)
                .map(|index| {
                    let name = format!("tool{index}");
                    entry("docs", &name, &name, &["docs", &name])
                })
                .collect(),
        );
        frozen.entries[0].description = Some(format!("{} Needle\n\t界", "x".repeat(200)));
        frozen.entries[1].description = Some("Needle 界 and more".to_string());
        frozen.entries[2].title = Some("Fallback".to_string());
        for (query, expected) in [
            ("Needle 界", vec!["docs.tool0", "docs.tool1"]),
            ("docs.tool99", vec!["docs.tool99"]),
            ("Fallback", vec!["docs.tool2"]),
            ("needle", vec![]),
            (".*", vec![]),
        ] {
            let output = frozen
                .compact_output(&CodemodeListArgs {
                    json: true,
                    query: Some(query.to_string()),
                    ..Default::default()
                })
                .unwrap();
            let page: Value = serde_json::from_str(&output).unwrap();
            assert_eq!(page["total"], expected.len());
            assert_eq!(page["nextOffset"], Value::Null);
            assert_eq!(
                page["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|tool| tool["path"].as_str().unwrap())
                    .collect::<Vec<_>>(),
                expected
            );
        }
        let output = frozen
            .compact_output(&CodemodeListArgs {
                json: true,
                query: Some("Needle 界".to_string()),
                limit: Some(1),
                offset: Some(1),
                ..Default::default()
            })
            .unwrap();
        let page: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(page["total"], 2);
        assert_eq!(page["tools"][0]["path"], "docs.tool1");
        assert_eq!(page["nextOffset"], Value::Null);
        let maximum = frozen
            .compact_output(&CodemodeListArgs {
                json: true,
                limit: Some(100),
                ..Default::default()
            })
            .unwrap();
        let maximum: Value = serde_json::from_str(&maximum).unwrap();
        assert_eq!(maximum["tools"].as_array().unwrap().len(), 100);
        assert_eq!(maximum["nextOffset"], 100);
        for offset in [101, 102, 9_007_199_254_740_991] {
            let output = frozen
                .compact_output(&CodemodeListArgs {
                    json: true,
                    offset: Some(offset),
                    ..Default::default()
                })
                .unwrap();
            let page: Value = serde_json::from_str(&output).unwrap();
            assert_eq!(page["offset"], offset);
            assert_eq!(page["tools"], json!([]));
            assert_eq!(page["nextOffset"], Value::Null);
        }
        frozen.entries[0].codemode_path = vec!["x".repeat(20_000), "tool".to_string()];
        for json in [false, true] {
            assert!(frozen
                .compact_output(&CodemodeListArgs {
                    json,
                    ..Default::default()
                })
                .unwrap()
                .contains(&format!("{}.tool", "x".repeat(20_000))));
        }
    }

    #[test]
    fn show_is_single_tool_bounded_and_fails_closed() {
        let tool = entry("server", "tool", "server__tool", &["server", "tool"]);
        let mut catalog = catalog(vec![
            tool,
            entry("other", "tool", "other__tool", &["other", "tool"]),
        ]);
        for name in ["server.tool", "server__tool"] {
            let shown: Value = serde_json::from_str(&catalog.show_output(name).unwrap()).unwrap();
            assert_eq!(shown, catalog.list_projection()["tools"][0]);
        }
        assert!(catalog.show_output("missing").is_err());
        catalog
            .entries
            .push(entry("alias", "tool", "server.tool", &["alias", "tool"]));
        assert!(catalog
            .show_output("server.tool")
            .unwrap_err()
            .to_string()
            .contains("Ambiguous"));
        catalog.entries.pop();
        catalog.entries[0].input_schema = json!({"type": "object", "description": ""});
        let remaining = 65_536 - catalog.show_output("server.tool").unwrap().len();
        catalog.entries[0].input_schema["description"] = json!("x".repeat(remaining));
        assert_eq!(catalog.show_output("server.tool").unwrap().len(), 65_536);
        catalog.entries[0].input_schema["description"] = json!("x".repeat(remaining + 1));
        assert!(catalog.show_output("server.tool").is_err());
        catalog.entries[0].input_schema =
            json!({"type": "object", "description": "😀".repeat(17_000)});
        assert!(catalog
            .show_output("server.tool")
            .unwrap_err()
            .to_string()
            .contains("exceed 65536 bytes"));
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
    fn connected_machine_origin_is_not_projected_without_attempt_authority() {
        let mut exec = ExecRequest::default();
        exec.env.insert(
            URL_ENV.to_string(),
            "https://worker.example.test/codemode".to_string(),
        );
        let mut request = ControlRequest {
            op: Some(v1::control_request::Op::OpStart(v1::OpStart {
                op: Some(v1::op_start::Op::Exec(exec)),
                ..v1::OpStart::default()
            })),
            ..ControlRequest::default()
        };

        bind_connection_origin(&mut request, "https://machine.example.test", "workspace-1");

        let Some(v1::control_request::Op::OpStart(start)) = request.op else {
            panic!("op start request");
        };
        let Some(v1::op_start::Op::Exec(exec)) = start.op else {
            panic!("streamed exec request");
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
