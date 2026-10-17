//! E2B's REST API, as the JS SDK 2.56.0 calls it, for a team's
//! `X-API-Key`:
//!
//! - `POST /v2/sandboxes` creates one from a template (201).
//! - `GET /v2/sandboxes`, and `GET /sandboxes`, list a team's, filtered by
//!   `metadata` (one query value holding encoded `key=value` pairs) and by
//!   `state`.
//! - `GET` and `DELETE /sandboxes/{id}`.
//! - `POST /sandboxes/{id}/pause` (204, or 409 when paused already).
//! - `POST /v2/sandboxes/{id}/connect`: 200 for a running one, 201 for one
//!   it resumed. The older `POST /sandboxes/{id}/resume` answers 201, or
//!   409 for one that runs.
//! - `POST /sandboxes/{id}/timeout` (204).
//! - `GET /templates`.
//!
//! Failures answer E2B's JSON, `{"code": <status>, "message": ...}`.

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::Router;
use axum::extract::rejection::JsonRejection;
use axum::extract::{Json, Path, RawQuery, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use compute_protocol::host::Id;

use super::lifecycle::{self, OnTimeout, Record, State as Stage};
use super::ops::{self, Connected, Created};
use super::wire::{
    ConnectSandbox, Lifecycle, ListedSandbox, NetworkView, NewSandbox, Pause, Sandbox,
    SandboxDetail, SetTimeout, Template, rfc3339,
};
use super::{Front, Refused};
use crate::service::Failure;
use crate::store::{LifecycleRow, SandboxRow, Store};

/// The client id answers carry: E2B's names the cluster.
const CLIENT_ID: &str = "compute";

type Shared<S> = State<Arc<Front<S>>>;

/// The team whose key `headers` carry.
async fn team<S: Store>(front: &Front<S>, headers: &HeaderMap) -> Result<String, Refused> {
    front
        .keys
        .team(front.store(), headers)
        .await?
        .ok_or_else(|| Refused::new(401, "Invalid API key"))
}

fn parse_id(id: &str) -> Result<Id, Refused> {
    id.parse()
        .map_err(|_| Refused::new(404, format!("sandbox {id} not found")))
}

/// A JSON body, or E2B's 400 for one that does not parse; an empty body
/// is the default.
fn body<T: Default>(body: Result<Json<T>, JsonRejection>) -> Result<T, Refused> {
    match body {
        Ok(Json(body)) => Ok(body),
        Err(JsonRejection::MissingJsonContentType(_)) => Ok(T::default()),
        Err(rejection) => Err(Refused::invalid(rejection.body_text())),
    }
}

fn on_timeout(record: &Record) -> String {
    match record.on_timeout {
        OnTimeout::Kill => "kill".into(),
        OnTimeout::Pause => "pause".into(),
    }
}

impl<S: Store> Front<S> {
    fn sandbox(&self, id: Id, record: &Record) -> Sandbox {
        Sandbox {
            template_id: record.template.clone(),
            sandbox_id: id.to_string(),
            client_id: CLIENT_ID.into(),
            envd_version: self.settings.envd_version.clone(),
            envd_access_token: record.envd_token.clone(),
            traffic_access_token: record.traffic_token.clone(),
            domain: Some(self.settings.domain.clone()),
        }
    }

    fn disk_mib(&self, record: &Record) -> u64 {
        self.settings
            .templates
            .get(&record.template)
            .map_or(0, |template| template.disk_mib)
    }

    fn detail(
        &self,
        id: Id,
        record: &Record,
        metadata: BTreeMap<String, String>,
    ) -> Option<SandboxDetail> {
        let state = record.visible()?;
        Some(SandboxDetail {
            template_id: record.template.clone(),
            sandbox_id: id.to_string(),
            client_id: CLIENT_ID.into(),
            started_at: rfc3339(record.started_ms),
            end_at: rfc3339(record.end_ms),
            envd_version: self.settings.envd_version.clone(),
            envd_access_token: record.envd_token.clone(),
            allow_internet_access: true,
            domain: Some(self.settings.domain.clone()),
            cpu_count: record.cpu_count,
            memory_mb: record.memory_mb,
            disk_size_mb: self.disk_mib(record),
            metadata,
            state: state.into(),
            network: NetworkView {
                allow_public_traffic: record.traffic_token.is_none(),
            },
            lifecycle: Lifecycle {
                auto_resume: record.auto_resume,
                on_timeout: on_timeout(record),
            },
            pause_mode: (record.state == Stage::Paused).then(|| "full".into()),
            volume_mounts: Vec::new(),
        })
    }

    fn listed(
        &self,
        id: Id,
        record: &Record,
        metadata: BTreeMap<String, String>,
    ) -> Option<ListedSandbox> {
        let state = record.visible()?;
        Some(ListedSandbox {
            template_id: record.template.clone(),
            sandbox_id: id.to_string(),
            client_id: CLIENT_ID.into(),
            started_at: rfc3339(record.started_ms),
            end_at: rfc3339(record.end_ms),
            cpu_count: record.cpu_count,
            memory_mb: record.memory_mb,
            disk_size_mb: self.disk_mib(record),
            metadata,
            state: state.into(),
            envd_version: self.settings.envd_version.clone(),
            volume_mounts: Vec::new(),
        })
    }
}

async fn create<S: Store>(
    State(front): Shared<S>,
    headers: HeaderMap,
    new: Result<Json<NewSandbox>, JsonRejection>,
) -> Result<Response, Refused> {
    let team = team(&front, &headers).await?;
    let new = match new {
        Ok(Json(new)) => new,
        Err(rejection) => return Err(Refused::invalid(rejection.body_text())),
    };
    let Created { id, record } = ops::create(&front, &team, new).await?;
    Ok((StatusCode::CREATED, Json(front.sandbox(id, &record))).into_response())
}

/// The filters of a list: metadata pairs and states.
#[derive(Debug, Default, PartialEq, Eq)]
struct Filter {
    metadata: BTreeMap<String, String>,
    states: Vec<String>,
}

/// Decodes one more level of percent-encoding.
fn unescape(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let hex = bytes
            .get(at + 1..at + 3)
            .and_then(|pair| std::str::from_utf8(pair).ok())
            .and_then(|pair| u8::from_str_radix(pair, 16).ok());
        match (bytes[at], hex) {
            (b'%', Some(byte)) => {
                out.push(byte);
                at += 3;
            }
            (byte, _) => {
                out.push(byte);
                at += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Reads a list's query. The SDK sends `metadata` as one value holding
/// `key=value` pairs joined by `&`, each key and value percent-encoded
/// before the pairs are, and `state` once per state.
fn filter(query: Option<&str>) -> Filter {
    let mut filter = Filter::default();
    for (name, value) in form_urlencoded::parse(query.unwrap_or_default().as_bytes()) {
        match &*name {
            "metadata" => {
                for (key, value) in form_urlencoded::parse(value.as_bytes()) {
                    filter.metadata.insert(unescape(&key), unescape(&value));
                }
            }
            "state" => filter.states.extend(value.split(',').map(str::to_owned)),
            _ => {}
        }
    }
    filter
}

async fn list<S: Store>(
    State(front): Shared<S>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Result<Json<Vec<ListedSandbox>>, Refused> {
    let team = team(&front, &headers).await?;
    let filter = filter(query.as_deref());
    let rows: BTreeMap<Id, SandboxRow> = front
        .service
        .list(&team, &filter.metadata)
        .await?
        .into_iter()
        .map(|row| (row.id, row))
        .collect();
    let records: Vec<LifecycleRow> = front.store().lifecycles(&team).await?;
    let mut listed: Vec<ListedSandbox> = records
        .into_iter()
        .filter_map(|row| {
            let metadata = rows.get(&row.id)?.metadata.clone();
            front.listed(row.id, &row.record, metadata)
        })
        .filter(|sandbox| filter.states.is_empty() || filter.states.contains(&sandbox.state))
        .collect();
    listed.sort_by(|a, b| {
        a.started_at
            .cmp(&b.started_at)
            .then(a.sandbox_id.cmp(&b.sandbox_id))
    });
    Ok(Json(listed))
}

async fn detail<S: Store>(
    State(front): Shared<S>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<SandboxDetail>, Refused> {
    let team = team(&front, &headers).await?;
    let id = parse_id(&id)?;
    let row = front
        .store()
        .lifecycle(id)
        .await?
        .filter(|row| row.team == team)
        .ok_or_else(|| Refused::not_found(id))?;
    let metadata = match front.service.get(&team, id).await {
        Ok(sandbox) => sandbox.metadata,
        Err(Failure::NotFound) => return Err(Refused::not_found(id)),
        Err(failure) => return Err(failure.into()),
    };
    front
        .detail(id, &row.record, metadata)
        .map(Json)
        .ok_or_else(|| Refused::not_found(id))
}

async fn kill<S: Store>(
    State(front): Shared<S>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<StatusCode, Refused> {
    let team = team(&front, &headers).await?;
    let id = parse_id(&id)?;
    let gone = front
        .store()
        .lifecycle(id)
        .await?
        .is_none_or(|row| row.team != team || row.record.state == Stage::Killing);
    if gone {
        return Err(Refused::not_found(id));
    }
    ops::kill(&front, &team, id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn pause<S: Store>(
    State(front): Shared<S>,
    headers: HeaderMap,
    Path(id): Path<String>,
    asked: Result<Json<Pause>, JsonRejection>,
) -> Result<StatusCode, Refused> {
    let team = team(&front, &headers).await?;
    let id = parse_id(&id)?;
    if body(asked)?.memory == Some(false) {
        return Err(Refused::invalid(
            "not offered here: a pause without memory (filesystem only)",
        ));
    }
    ops::pause(&front, &team, id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn connect<S: Store>(
    State(front): Shared<S>,
    headers: HeaderMap,
    Path(id): Path<String>,
    asked: Result<Json<ConnectSandbox>, JsonRejection>,
) -> Result<Response, Refused> {
    let team = team(&front, &headers).await?;
    let id = parse_id(&id)?;
    let asked = body(asked)?;
    if asked.memory == Some(false) {
        return Err(Refused::invalid(
            "not offered here: resuming without memory (a reboot)",
        ));
    }
    let timeout_ms = match asked.timeout {
        None => None,
        seconds => Some(lifecycle::timeout_ms(seconds).map_err(Refused::invalid)?),
    };
    let Connected { record, resumed } = ops::connect(&front, &team, id, timeout_ms).await?;
    let status = if resumed {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((status, Json(front.sandbox(id, &record))).into_response())
}

async fn resume<S: Store>(
    State(front): Shared<S>,
    headers: HeaderMap,
    Path(id): Path<String>,
    asked: Result<Json<ConnectSandbox>, JsonRejection>,
) -> Result<Response, Refused> {
    let team = team(&front, &headers).await?;
    let id = parse_id(&id)?;
    let asked = body(asked)?;
    let row = front
        .store()
        .lifecycle(id)
        .await?
        .filter(|row| row.team == team)
        .ok_or_else(|| Refused::not_found(id))?;
    if row.record.state == Stage::Running {
        return Err(Refused::new(
            409,
            format!("sandbox {id} is already running"),
        ));
    }
    let timeout_ms = match asked.timeout {
        None => None,
        seconds => Some(lifecycle::timeout_ms(seconds).map_err(Refused::invalid)?),
    };
    let Connected { record, .. } = ops::connect(&front, &team, id, timeout_ms).await?;
    Ok((StatusCode::CREATED, Json(front.sandbox(id, &record))).into_response())
}

async fn set_timeout<S: Store>(
    State(front): Shared<S>,
    headers: HeaderMap,
    Path(id): Path<String>,
    asked: Result<Json<SetTimeout>, JsonRejection>,
) -> Result<StatusCode, Refused> {
    let team = team(&front, &headers).await?;
    let id = parse_id(&id)?;
    let Json(asked) = asked.map_err(|rejection| Refused::invalid(rejection.body_text()))?;
    let timeout_ms = lifecycle::timeout_ms(Some(asked.timeout)).map_err(Refused::invalid)?;
    ops::set_timeout(&front, &team, id, timeout_ms).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn templates<S: Store>(
    State(front): Shared<S>,
    headers: HeaderMap,
) -> Result<Json<Vec<Template>>, Refused> {
    team(&front, &headers).await?;
    Ok(Json(
        front
            .settings
            .templates
            .iter()
            .map(|(id, template)| Template {
                template_id: id.clone(),
                build_id: template.image.clone(),
                cpu_count: u32::from(template.vcpus),
                memory_mb: template.memory_mib,
                disk_size_mb: template.disk_mib,
                public: false,
                aliases: vec![id.clone()],
                names: vec![id.clone()],
                envd_version: front.settings.envd_version.clone(),
                build_status: "ready".into(),
            })
            .collect(),
    ))
}

/// The REST API's routes.
pub fn router<S: Store>(front: Arc<Front<S>>) -> Router {
    Router::new()
        .route("/v2/sandboxes", post(create::<S>).get(list::<S>))
        .route("/sandboxes", get(list::<S>))
        .route("/sandboxes/{id}", get(detail::<S>).delete(kill::<S>))
        .route("/sandboxes/{id}/pause", post(pause::<S>))
        .route("/sandboxes/{id}/resume", post(resume::<S>))
        .route("/v2/sandboxes/{id}/connect", post(connect::<S>))
        .route("/sandboxes/{id}/timeout", post(set_timeout::<S>))
        .route("/templates", get(templates::<S>))
        .fallback(|| async { Refused::new(404, "not found here").into_response() })
        .with_state(front)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_list_reads_metadata_as_the_sdk_encodes_it() {
        // What the SDK sends for {"user": "a b", "k=1": "x&y"}.
        let query = "metadata=user%3Da%252520b%26k%25253D1%3Dx%252526y&state=running&state=paused";
        let found = filter(Some(query));
        assert_eq!(
            found.metadata,
            BTreeMap::from([
                ("user".to_owned(), "a b".to_owned()),
                ("k=1".to_owned(), "x&y".to_owned()),
            ])
        );
        assert_eq!(found.states, ["running", "paused"]);
        assert_eq!(filter(None), Filter::default());
    }
}
