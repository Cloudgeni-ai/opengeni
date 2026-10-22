//! A producer-selected owner, not ingress affinity or a distributed registry.
//!
//! The route is authenticated metadata, never permission to open a stream. Both
//! edges still verify the normal stream token. Binding the complete channel key
//! prevents reusing a route for another channel; the random process incarnation
//! prevents a recycled pod IP accepting a dead owner's route.

use std::net::SocketAddr;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use opengeni_agent_stream::ChannelKey;
use serde::{Deserialize, Serialize};
use sha2::Sha256;

const DOMAIN: &[u8] = b"opengeni-relay-owner-v1\0";

#[derive(Serialize, Deserialize)]
pub(crate) struct Owner {
    pub addr: SocketAddr,
    pub incarnation: String,
    scope: (String, String, u32, String),
}

pub(crate) struct Routing {
    pub addr: SocketAddr,
    pub incarnation: String,
}

impl Routing {
    pub fn new(addr: SocketAddr) -> Self {
        Self {
            addr,
            incarnation: uuid::Uuid::new_v4().to_string(),
        }
    }

    pub fn owns(&self, owner: &Owner) -> bool {
        owner.addr == self.addr && owner.incarnation == self.incarnation
    }

    pub fn mint(&self, key: &ChannelKey, secret: &str) -> Result<String, ()> {
        let owner = Owner {
            addr: self.addr,
            incarnation: self.incarnation.clone(),
            scope: scope(key),
        };
        let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&owner).map_err(|_| ())?);
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).map_err(|_| ())?;
        mac.update(DOMAIN);
        mac.update(body.as_bytes());
        Ok(format!(
            "{body}.{}",
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        ))
    }
}

pub(crate) fn verify(route: &str, key: &ChannelKey, secret: &str) -> Result<Owner, ()> {
    let (body, signature) = route.split_once('.').ok_or(())?;
    let signature = URL_SAFE_NO_PAD.decode(signature).map_err(|_| ())?;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).map_err(|_| ())?;
    mac.update(DOMAIN);
    mac.update(body.as_bytes());
    mac.verify_slice(&signature).map_err(|_| ())?;
    let owner: Owner =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(body).map_err(|_| ())?).map_err(|_| ())?;
    if owner.scope != scope(key) || owner.addr.ip().is_unspecified() || owner.addr.port() == 0 {
        return Err(());
    }
    Ok(owner)
}

fn scope(key: &ChannelKey) -> (String, String, u32, String) {
    (
        key.workspace_id.clone(),
        key.agent_id.clone(),
        key.port,
        key.channel_id.clone(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_is_channel_bound_authenticated_and_incarnation_scoped() {
        let key = ChannelKey {
            workspace_id: "w".into(),
            agent_id: "a".into(),
            port: 7681,
            channel_id: "c".into(),
        };
        let routing = Routing::new("127.0.0.1:8443".parse().unwrap());
        let route = routing.mint(&key, "secret").unwrap();
        let owner = verify(&route, &key, "secret").unwrap();
        assert!(routing.owns(&owner));
        assert!(!Routing::new(routing.addr).owns(&owner));
        assert!(verify(&route, &key, "other").is_err());
        for changed in [
            ChannelKey {
                workspace_id: "other".into(),
                ..key.clone()
            },
            ChannelKey {
                agent_id: "other".into(),
                ..key.clone()
            },
            ChannelKey {
                port: 6080,
                ..key.clone()
            },
            ChannelKey {
                channel_id: "other".into(),
                ..key.clone()
            },
        ] {
            assert!(verify(&route, &changed, "secret").is_err());
        }
        assert!(verify(&format!("{route}x"), &key, "secret").is_err());
    }
}
