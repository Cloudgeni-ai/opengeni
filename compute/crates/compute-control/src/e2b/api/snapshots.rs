//! E2B's snapshots, as templates saved from sandboxes
//! ([ADR 22](../../../../../docs/adr/0022-templates-saved-from-sandboxes.md)):
//!
//! - `POST /sandboxes/{id}/snapshots` (201) captures a sandbox's disk. Only
//!   filesystem snapshots (`memory: false`) are offered: one with memory
//!   is refused, never quietly made without it. A running sandbox is
//!   paused for it and resumed after.
//! - `GET /snapshots`, by `sandboxID` and `name`, in the order of their
//!   ids, `limit` at a time after the id `nextToken`, the next token in
//!   `x-next-token`.
//! - `DELETE /templates/{id or name}` deletes one (204); the fleet's own
//!   templates are not deleted.
//!
//! A create names one as its `templateID`, by id or name, and starts from
//! its disk with its shape, booted afresh.

use axum::extract::rejection::JsonRejection;
use axum::extract::{Json, Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};

use super::{Shared, body, parse_id, team};
use crate::e2b::Refused;
use crate::e2b::lifecycle::State as Stage;
use crate::e2b::ops;
use crate::e2b::wire::{ListSnapshots, NewSnapshot, Snapshot};
use crate::store::{Store, TemplateRow};

/// How many snapshots a list answers when it does not say.
const LIST_LIMIT: usize = 100;
/// The most a list answers at once.
const LIST_MOST: usize = 1000;

fn snapshot(template: TemplateRow) -> Snapshot {
    Snapshot {
        snapshot_id: template.id,
        names: template.name.into_iter().collect(),
    }
}

pub(super) async fn create<S: Store>(
    State(front): Shared<S>,
    headers: HeaderMap,
    Path(id): Path<String>,
    asked: Result<Json<NewSnapshot>, JsonRejection>,
) -> Result<(StatusCode, Json<Snapshot>), Refused> {
    let team = team(&front, &headers).await?;
    let id = parse_id(&id)?;
    let asked = body(asked)?;
    if asked.memory != Some(false) {
        return Err(Refused::invalid(
            "not offered here: a snapshot with memory; ask for a filesystem snapshot",
        ));
    }
    let row = front
        .store()
        .lifecycle(id)
        .await?
        .filter(|row| row.team == team && row.record.state != Stage::Killing)
        .ok_or_else(|| Refused::not_found(id))?;
    let paused = row.record.state == Stage::Paused;
    if !paused {
        ops::pause(&front, &team, id).await?;
    }
    let captured = front.service.capture(&team, id, asked.name).await;
    if !paused && let Err(refused) = ops::connect(&front, &team, id, None).await {
        tracing::warn!(%id, error = %refused.message, "resuming a sandbox after its snapshot");
    }
    Ok((StatusCode::CREATED, Json(snapshot(captured?))))
}

pub(super) async fn list<S: Store>(
    State(front): Shared<S>,
    headers: HeaderMap,
    Query(asked): Query<ListSnapshots>,
) -> Result<Response, Refused> {
    let team = team(&front, &headers).await?;
    let limit = asked.limit.unwrap_or(LIST_LIMIT).clamp(1, LIST_MOST);
    let mut templates = front.service.templates(&team).await?;
    // Pages follow the ids, which a token names, so a template made or
    // deleted between pages moves no other across a page's end.
    templates.sort_by(|a, b| a.id.cmp(&b.id));
    let mut found = templates
        .into_iter()
        .filter(|template| {
            asked
                .sandbox_id
                .as_ref()
                .is_none_or(|sandbox| template.source.to_string() == *sandbox)
                && asked
                    .name
                    .as_ref()
                    .is_none_or(|name| template.name.as_ref() == Some(name))
        })
        .skip_while(|template| {
            asked
                .next_token
                .as_ref()
                .is_some_and(|after| template.id <= *after)
        })
        .take(limit + 1)
        .collect::<Vec<_>>();
    let next = (found.len() > limit).then(|| {
        found.truncate(limit);
        found.last().map(|template| template.id.clone())
    });
    let snapshots: Vec<Snapshot> = found.into_iter().map(snapshot).collect();
    let mut response = Json(snapshots).into_response();
    if let Some(Some(next)) = next
        && let Ok(value) = HeaderValue::from_str(&next)
    {
        response.headers_mut().insert("x-next-token", value);
    }
    Ok(response)
}

pub(super) async fn delete<S: Store>(
    State(front): Shared<S>,
    headers: HeaderMap,
    Path(key): Path<String>,
) -> Result<StatusCode, Refused> {
    let team = team(&front, &headers).await?;
    if front.settings.templates.contains_key(&key) {
        return Err(Refused::invalid(format!(
            "template '{key}' is one of the fleet's own and is not deleted"
        )));
    }
    if front.service.delete_template(&team, &key).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(Refused::new(404, format!("template '{key}' not found")))
    }
}
