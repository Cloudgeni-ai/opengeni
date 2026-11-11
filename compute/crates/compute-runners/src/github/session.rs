//! A scale set's message session: the long-polled queue GitHub tells its
//! listener about jobs through. GitHub allows one session per scale set.

use std::time::Duration;

use anyhow::Result;
use reqwest::{Method, StatusCode};

use super::wire::{List, Message, RawMessage, Session};
use super::{Github, Refused, USER_AGENT, expect};

/// How long one poll may stay open; GitHub answers within about a minute.
const POLL_WITHIN: Duration = Duration::from_secs(120);

/// Why a session was not had.
#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    /// Another listener holds the scale set's session.
    #[error("another listener holds the scale set's session")]
    Taken,
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

/// What a poll found.
#[derive(Debug)]
pub enum Polled {
    Nothing,
    Message(Message),
}

impl Github {
    /// Opens the scale set's session, as `owner`.
    pub async fn open_session(&self, set: u64, owner: &str) -> Result<Session, SessionError> {
        let request = self
            .actions(
                Method::POST,
                &format!("_apis/runtime/runnerscalesets/{set}/sessions"),
                &[],
            )
            .await?
            .json(&serde_json::json!({"ownerName": owner}));
        let response = self.send_admin(request).await?;
        if response.status() == StatusCode::CONFLICT {
            return Err(SessionError::Taken);
        }
        Ok(expect(response, StatusCode::OK, "a message session").await?)
    }

    /// A new token for `session`, whose token expired.
    pub async fn refresh_session(&self, set: u64, session: &Session) -> Result<Session> {
        let request = self
            .actions(
                Method::PATCH,
                &format!(
                    "_apis/runtime/runnerscalesets/{set}/sessions/{}",
                    session.session_id
                ),
                &[],
            )
            .await?;
        let response = self.send_admin(request).await?;
        expect(response, StatusCode::OK, "a refreshed message session").await
    }

    /// Ends `session`, so another listener may open one at once.
    pub async fn close_session(&self, set: u64, session: &Session) -> Result<()> {
        let request = self
            .actions(
                Method::DELETE,
                &format!(
                    "_apis/runtime/runnerscalesets/{set}/sessions/{}",
                    session.session_id
                ),
                &[],
            )
            .await?;
        let response = self.send_admin(request).await?;
        match response.status() {
            StatusCode::NO_CONTENT | StatusCode::OK | StatusCode::NOT_FOUND => Ok(()),
            status => Err(Refused {
                what: "closing the message session".into(),
                status,
                body: response.text().await.unwrap_or_default(),
            }
            .into()),
        }
    }

    /// Waits for the next message after `last`, telling GitHub the pool
    /// takes at most `capacity` jobs. `Ok(None)` when the session's token
    /// expired: refresh it and poll again.
    pub async fn poll(
        &self,
        session: &Session,
        last: Option<u64>,
        capacity: u32,
    ) -> Result<Option<Polled>> {
        let mut request = self
            .http
            .get(&session.message_queue_url)
            .bearer_auth(&session.message_queue_access_token)
            .header("accept", "application/json; api-version=6.0-preview")
            .header("user-agent", USER_AGENT)
            .header("x-scalesetmaxcapacity", capacity.to_string())
            .timeout(POLL_WITHIN);
        if let Some(last) = last {
            request = request.query(&[("lastMessageId", last)]);
        }
        let response = request.send().await?;
        match response.status() {
            StatusCode::ACCEPTED => Ok(Some(Polled::Nothing)),
            StatusCode::UNAUTHORIZED => Ok(None),
            _ => {
                let raw: RawMessage = expect(response, StatusCode::OK, "a message").await?;
                Ok(Some(Polled::Message(
                    Message::decode(&raw).map_err(anyhow::Error::msg)?,
                )))
            }
        }
    }

    /// Deletes message `id`, once handled. `Ok(false)` when the session's
    /// token expired.
    pub async fn delete_message(&self, session: &Session, id: u64) -> Result<bool> {
        let url = format!(
            "{}/{id}",
            session
                .message_queue_url
                .split('?')
                .next()
                .unwrap_or_default()
        );
        let query: Vec<(String, String)> = reqwest::Url::parse(&session.message_queue_url)?
            .query_pairs()
            .map(|(name, value)| (name.into_owned(), value.into_owned()))
            .collect();
        let response = self
            .http
            .delete(url)
            .query(&query)
            .bearer_auth(&session.message_queue_access_token)
            .header("user-agent", USER_AGENT)
            .send()
            .await?;
        match response.status() {
            StatusCode::NO_CONTENT | StatusCode::OK | StatusCode::NOT_FOUND => Ok(true),
            StatusCode::UNAUTHORIZED => Ok(false),
            status => Err(Refused {
                what: format!("deleting message {id}"),
                status,
                body: response.text().await.unwrap_or_default(),
            }
            .into()),
        }
    }

    /// Takes the jobs `requests` offered the scale set; GitHub answers
    /// those it gave. `Ok(None)` when the session's token expired.
    pub async fn acquire(
        &self,
        set: u64,
        session: &Session,
        requests: &[i64],
    ) -> Result<Option<Vec<i64>>> {
        let admin = self.admin().await?;
        let response = self
            .actions_with(
                &admin.url,
                Method::POST,
                &format!("_apis/runtime/runnerscalesets/{set}/acquirejobs"),
                &[],
            )
            .bearer_auth(&session.message_queue_access_token)
            .json(requests)
            .send()
            .await?;
        if response.status() == StatusCode::UNAUTHORIZED {
            return Ok(None);
        }
        let acquired: List<i64> = expect(response, StatusCode::OK, "acquiring jobs").await?;
        Ok(Some(acquired.value))
    }
}
