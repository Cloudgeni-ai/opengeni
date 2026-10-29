//! The pointers to a fleet's stored copies, which the control service
//! keeps ([ADR 25](../../../docs/adr/0025-pointers-in-the-control-service-and-objects-by-day.md)).
//! A host reads one ([`PointerRead`]) and replaces one only on condition
//! of the version it read ([`PointerWrite`]), under the registration it
//! holds and with its certificate. What a write may do is decided by the
//! host from the owner stamp of the version it read, as when pointers
//! were kept in the store.
//!
//! The service answers a host whose registration it does not know (given
//! up on, or of an earlier registration) with 404, and with 503 while it
//! cannot answer yet, as before the fleet's pointers were moved into it.

use serde::{Deserialize, Serialize};

/// Where a host reads a pointer ([`PointerRead`]), under
/// [`super::REGISTER_PATH`]'s API.
pub const POINTER_READ_PATH: &str = "/v1/hosts/pointers/read";
/// Where a host writes a pointer on condition ([`PointerWrite`]).
pub const POINTER_WRITE_PATH: &str = "/v1/hosts/pointers/write";

/// A host reads pointer `name`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PointerRead {
    /// The registration it holds, by its host epoch, which no other
    /// registration is given.
    pub epoch: u64,
    pub name: String,
}

/// A pointer as the service keeps it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KeptPointer {
    /// Its owner stamp: the owner epoch it was written under and the
    /// writer's number for the change.
    pub owner_epoch: u64,
    pub owner_save: u64,
    /// What it holds, in base64: empty for the pointer an archive in
    /// flight keeps and for a tombstone.
    #[serde(with = "base64_bytes")]
    pub pointer: Vec<u8>,
    /// The version it is kept as, which a write replacing it names. No
    /// two writes are ever given the same version.
    pub version: i64,
}

/// The answer to a [`PointerRead`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PointerFound {
    /// The pointer, or `None` when there is none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kept: Option<KeptPointer>,
}

/// A host keeps `pointer` under the owner stamp it gives as `name`, only if
/// the pointer is still version `on` (with `None`, only if there is none).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PointerWrite {
    /// The registration it holds, as in [`PointerRead`].
    pub epoch: u64,
    pub name: String,
    pub owner_epoch: u64,
    pub owner_save: u64,
    /// What to keep, in base64.
    #[serde(with = "base64_bytes")]
    pub pointer: Vec<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on: Option<i64>,
}

/// The answer to a [`PointerWrite`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PointerWritten {
    /// The version kept, or `None` when the pointer changed or appeared
    /// since the version the write named, and nothing was written.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<i64>,
}

mod base64_bytes {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&STANDARD.encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        let text = String::deserialize(deserializer)?;
        STANDARD.decode(text).map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_forms_are_stable() {
        let write = PointerWrite {
            epoch: 2,
            name: "image-a".into(),
            owner_epoch: 3,
            owner_save: 4,
            pointer: b"20755/abc".to_vec(),
            on: None,
        };
        let text = serde_json::to_string(&write).unwrap();
        assert_eq!(
            text,
            r#"{"epoch":2,"name":"image-a","owner_epoch":3,"owner_save":4,"pointer":"MjA3NTUvYWJj"}"#
        );
        assert_eq!(serde_json::from_str::<PointerWrite>(&text).unwrap(), write);
        let found: PointerFound = serde_json::from_str(
            r#"{"kept":{"owner_epoch":3,"owner_save":4,"pointer":"","version":9}}"#,
        )
        .unwrap();
        assert_eq!(found.kept.unwrap().pointer, Vec::<u8>::new());
        assert_eq!(
            serde_json::to_string(&PointerFound { kept: None }).unwrap(),
            "{}"
        );
        assert_eq!(
            serde_json::to_string(&PointerWritten { version: None }).unwrap(),
            "{}",
            "a write that did not land"
        );
        assert!(
            serde_json::from_str::<PointerFound>(
                r#"{"kept":{"owner_epoch":3,"owner_save":4,"pointer":"*","version":9}}"#
            )
            .is_err(),
            "contents are base64"
        );
    }
}
