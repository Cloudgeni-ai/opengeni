//! A host in a fleet keeps the pointers to its stored copies in the
//! control service (ADR 25), which it reaches over mutual TLS under the
//! registration it holds. Until it holds one, and while the service cannot
//! answer yet, every read and write fails as a transfer does, and is tried
//! again.

use std::time::Duration;

use bytes::Bytes;
use compute_fleet::Stamp;
use compute_protocol::fleet::{
    POINTER_READ_PATH, POINTER_WRITE_PATH, PointerFound, PointerRead, PointerWrite, PointerWritten,
};
use compute_storage::Error;
use compute_storage::pointer_store::{Kept, PointerStore, Version};
use futures::future::BoxFuture;
use serde::Serialize;
use serde::de::DeserializeOwned;

use super::gate::LeaseGate;

/// How long one pointer request may take.
const TIMEOUT: Duration = Duration::from_secs(15);

/// The service's pointers, as this host reaches them.
#[derive(Clone)]
pub struct ControlPointers {
    http: reqwest::Client,
    /// The service's base URL.
    control: String,
    /// Holds the registration the host's requests are made under.
    gate: LeaseGate,
}

impl std::fmt::Debug for ControlPointers {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ControlPointers")
            .field("control", &self.control)
            .finish_non_exhaustive()
    }
}

impl ControlPointers {
    /// Pointers kept by the service at `control` (its base URL), reached
    /// with `http` under the registration `gate` holds.
    #[must_use]
    pub fn new(http: reqwest::Client, control: &str, gate: LeaseGate) -> Self {
        Self {
            http,
            control: control.trim_end_matches('/').to_owned(),
            gate,
        }
    }

    /// The host epoch of the registration held, if any.
    fn epoch(&self) -> Result<u64, Error> {
        self.gate
            .answered()
            .host_epoch
            .ok_or_else(|| Error::Transfer("the host has not registered yet".into()))
    }

    async fn post<B: Serialize + Sync, A: DeserializeOwned>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<A, Error> {
        let response = self
            .http
            .post(format!("{}{path}", self.control))
            .timeout(TIMEOUT)
            .json(body)
            .send()
            .await
            .map_err(|error| Error::Transfer(format!("the control service: {error}")))?;
        let status = response.status();
        if status == reqwest::StatusCode::BAD_REQUEST {
            return Err(Error::Invalid(
                "the control service refused a pointer request as malformed",
            ));
        }
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(Error::Transfer(format!(
                "the control service answered {status}: {text}"
            )));
        }
        response
            .json()
            .await
            .map_err(|error| Error::Transfer(format!("the control service's answer: {error}")))
    }
}

impl PointerStore for ControlPointers {
    fn read<'a>(&'a self, name: &'a str) -> BoxFuture<'a, compute_storage::Result<Option<Kept>>> {
        Box::pin(async move {
            let read = PointerRead {
                epoch: self.epoch()?,
                name: name.to_owned(),
            };
            let found: PointerFound = self.post(POINTER_READ_PATH, &read).await?;
            Ok(found.kept.map(|kept| Kept {
                owner: Stamp {
                    epoch: compute_fleet::OwnerEpoch(kept.owner_epoch),
                    save: kept.owner_save,
                },
                pointer: Bytes::from(kept.pointer),
                version: Version::Row(kept.version),
            }))
        })
    }

    fn write<'a>(
        &'a self,
        name: &'a str,
        owner: Stamp,
        pointer: Bytes,
        on: Option<&'a Version>,
    ) -> BoxFuture<'a, compute_storage::Result<Option<Version>>> {
        Box::pin(async move {
            let on = match on {
                None => None,
                Some(Version::Row(version)) => Some(*version),
                Some(Version::Object { .. }) => {
                    return Err(Error::Invalid(
                        "an object's version names no pointer the service keeps",
                    ));
                }
            };
            let write = PointerWrite {
                epoch: self.epoch()?,
                name: name.to_owned(),
                owner_epoch: owner.epoch.0,
                owner_save: owner.save,
                pointer: pointer.to_vec(),
                on,
            };
            let written: PointerWritten = self.post(POINTER_WRITE_PATH, &write).await?;
            Ok(written.version.map(Version::Row))
        })
    }

    fn names(&self) -> BoxFuture<'_, compute_storage::Result<Vec<String>>> {
        Box::pin(async {
            Err(Error::Unsupported(
                "a host in a fleet does not list pointers: the control service sweeps",
            ))
        })
    }
}
