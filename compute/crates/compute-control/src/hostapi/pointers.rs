//! Hosts read and write the fleet's pointers (ADR 25), with their
//! certificates and under the registration they hold.

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use compute_fleet::{OwnerEpoch, Stamp};
use compute_protocol::fleet::{
    KeptPointer, PointerFound, PointerRead, PointerWrite, PointerWritten,
};
use compute_storage::pointer_store::check_name;
use compute_storage::store::MAX_POINTER_BYTES;

use super::{HostApi, Peer, unavailable};
use crate::pointers::{Pointers, Unanswered};
use crate::store::Store;

type Refused = (StatusCode, String);

/// The service's pointers, if a host holding the registration of host
/// epoch `epoch` and named by its certificate may use them.
async fn pointers_for<'a, S: Store>(
    api: &'a HostApi<S>,
    peer: &Peer,
    epoch: u64,
    name: &str,
) -> Result<&'a Pointers<S>, Refused> {
    check_name(name).map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?;
    let Some(pointers) = api.0.pointers.as_deref() else {
        return Err(unavailable(
            "this service has no archive store, so it keeps no pointers",
        ));
    };
    if !api
        .0
        .store
        .registered(epoch, &peer.0)
        .await
        .map_err(unavailable)?
    {
        return Err((
            StatusCode::NOT_FOUND,
            "the service does not know this registration; register again".into(),
        ));
    }
    Ok(pointers)
}

fn unanswered(error: Unanswered) -> Refused {
    unavailable(error)
}

pub(super) async fn read<S: Store>(
    State(api): State<HostApi<S>>,
    peer: Peer,
    Json(read): Json<PointerRead>,
) -> Result<Json<PointerFound>, Refused> {
    let pointers = pointers_for(&api, &peer, read.epoch, &read.name).await?;
    let kept = pointers.read(&read.name).await.map_err(unanswered)?;
    Ok(Json(PointerFound {
        kept: kept.map(|row| KeptPointer {
            owner_epoch: row.owner.epoch.0,
            owner_save: row.owner.save,
            pointer: row.pointer,
            version: row.version,
        }),
    }))
}

pub(super) async fn write<S: Store>(
    State(api): State<HostApi<S>>,
    peer: Peer,
    Json(write): Json<PointerWrite>,
) -> Result<Json<PointerWritten>, Refused> {
    if write.pointer.len() > MAX_POINTER_BYTES {
        return Err((StatusCode::BAD_REQUEST, "the pointer is too large".into()));
    }
    let pointers = pointers_for(&api, &peer, write.epoch, &write.name).await?;
    let owner = Stamp {
        epoch: OwnerEpoch(write.owner_epoch),
        save: write.owner_save,
    };
    let version = pointers
        .write(&write.name, owner, &write.pointer, write.on)
        .await
        .map_err(unanswered)?;
    Ok(Json(PointerWritten { version }))
}
