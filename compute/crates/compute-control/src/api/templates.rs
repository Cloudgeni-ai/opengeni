//! Templates saved from sandboxes
//! ([ADR 22](../../../../docs/adr/0022-templates-saved-from-sandboxes.md)):
//!
//! - `POST /v1/sandboxes/{id}/templates`, with an optional `name`, captures
//!   the sandbox's disk as a new template. A running sandbox is saved for
//!   it and woken again after; one asleep stays asleep.
//! - `GET /v1/templates` lists the team's; `GET` and `DELETE
//!   /v1/templates/{id or name}`.
//!
//! A create names one with `template`, by id or name.

use axum::extract::{Json, Path, State};
use axum::http::{HeaderMap, StatusCode};
use compute_protocol::host::{Id, ImageId, LevelName, PriorityName};
use serde::{Deserialize, Serialize};

use super::{Api, ApiError, parse_id};
use crate::service::Depth;
use crate::store::{Store, TemplateRow};

/// A capture.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CaptureBody {
    /// What creates may name it by instead of its id: unique in the team.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// A template as callers see it.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct TemplateView {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The stored image it starts sandboxes from.
    pub image: ImageId,
    /// The sandbox it was captured from.
    pub source: Id,
    pub vcpus: u8,
    pub memory_mib: u32,
    /// Its disk's length, which sandboxes from it start with at least.
    pub disk_mib: u64,
    pub created_ms: u64,
}

impl From<TemplateRow> for TemplateView {
    fn from(row: TemplateRow) -> Self {
        Self {
            id: row.id,
            name: row.name,
            image: row.image,
            source: row.source,
            vcpus: row.vcpus,
            memory_mib: row.memory_mib,
            disk_mib: row.disk_mib,
            created_ms: row.created_ms,
        }
    }
}

fn no_template(key: &str) -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "not_found",
        format!("no such template: {key}"),
    )
}

pub(super) async fn capture<S: Store>(
    State(api): State<Api<S>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Option<Json<CaptureBody>>,
) -> Result<(StatusCode, Json<TemplateView>), ApiError> {
    let team = api.team(&headers).await?;
    let service = &api.0.service;
    let id = parse_id(&id)?;
    let name = body.and_then(|Json(body)| body.name);
    let running = matches!(
        service.depth(&team, id).await,
        Ok(Depth::At {
            level: LevelName::Running,
            ..
        })
    );
    let captured = service.capture(&team, id, name).await;
    // A running sandbox runs again whatever the capture came to.
    if running && let Err(failure) = service.wake(&team, id, PriorityName::Interactive).await {
        tracing::warn!(sandbox = %id, %failure, "waking a sandbox again after its capture");
    }
    Ok((StatusCode::CREATED, Json(captured?.into())))
}

pub(super) async fn list<S: Store>(
    State(api): State<Api<S>>,
    headers: HeaderMap,
) -> Result<Json<Vec<TemplateView>>, ApiError> {
    let team = api.team(&headers).await?;
    let templates = api.0.service.templates(&team).await?;
    Ok(Json(templates.into_iter().map(Into::into).collect()))
}

pub(super) async fn one<S: Store>(
    State(api): State<Api<S>>,
    headers: HeaderMap,
    Path(key): Path<String>,
) -> Result<Json<TemplateView>, ApiError> {
    let team = api.team(&headers).await?;
    let template = api.0.service.template(&team, &key).await?;
    template
        .map(|template| Json(template.into()))
        .ok_or_else(|| no_template(&key))
}

pub(super) async fn delete<S: Store>(
    State(api): State<Api<S>>,
    headers: HeaderMap,
    Path(key): Path<String>,
) -> Result<StatusCode, ApiError> {
    let team = api.team(&headers).await?;
    if api.0.service.delete_template(&team, &key).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(no_template(&key))
    }
}
