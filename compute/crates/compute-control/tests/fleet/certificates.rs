//! The host endpoint's certificates: callers without one are refused by
//! every route but the one that issues them; a current certificate renews
//! for its own name; an expired one or another authority's gets no TLS.

use compute_protocol::fleet::{
    CERTIFICATE_PATH, CertificateAsked, HostCertificate, HostInfo, LINK_TOKENS_PATH,
    LinkTokensAsked, Proof, REGISTER_PATH, RENEW_PATH, REPORT_PATH, Register, Registered, Renew,
    Report,
};
use rcgen::{CertificateParams, KeyPair};
use rustls::pki_types::pem::PemObject as _;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use serde_json::Value;

use crate::support::{Fleet, Pki, SERVICE, roomy};

fn client(tls: rustls::ClientConfig) -> reqwest::Client {
    reqwest::Client::builder()
        .use_preconfigured_tls(tls)
        .build()
        .unwrap()
}

fn url(fleet: &Fleet, path: &str) -> String {
    format!("https://{}{path}", fleet.running.hosts)
}

fn register(name: &str) -> Register {
    Register {
        host: None,
        attempt: 1,
        info: HostInfo {
            name: name.into(),
            address: "127.0.0.1:1".into(),
            zone: "zone-a".into(),
            profile: "nested".into(),
            cpu_template: "none".into(),
            memory_mib: 1024,
            cpu_millis: None,
            disk_mib: 1024,
        },
        capacity: roomy(),
        held: Vec::new(),
    }
}

/// A key and a request for it that asks for `name`.
fn request(name: &str) -> (KeyPair, String) {
    let key = KeyPair::generate().unwrap();
    let csr = CertificateParams::new(vec![name.to_owned()])
        .unwrap()
        .serialize_request(&key)
        .unwrap()
        .pem()
        .unwrap();
    (key, csr)
}

#[tokio::test]
async fn a_caller_without_a_certificate_is_refused_by_every_route_but_the_certificate_one() {
    let fleet = Fleet::start().await;
    let anonymous = client(fleet.pki.anonymous_client());
    let bodies: [(&str, Value); 4] = [
        (
            REGISTER_PATH,
            serde_json::to_value(register("host-a.example")).unwrap(),
        ),
        (
            RENEW_PATH,
            serde_json::to_value(Renew {
                host: 1,
                epoch: 1,
                seq: 1,
                capacity: roomy(),
            })
            .unwrap(),
        ),
        (
            REPORT_PATH,
            serde_json::to_value(Report {
                host: 1,
                epoch: 1,
                capacity: roomy(),
            })
            .unwrap(),
        ),
        (
            LINK_TOKENS_PATH,
            serde_json::to_value(LinkTokensAsked {
                name: "host-a.example".into(),
                gateways: vec!["wss://gateway.example".into()],
            })
            .unwrap(),
        ),
    ];
    for (path, body) in &bodies {
        let response = anonymous
            .post(url(&fleet, path))
            .json(body)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 401, "{path}");
    }
    // The certificate route takes the caller, and refuses a renewal it
    // cannot make: there is no certificate to renew.
    let (_, csr) = request("host-a.example");
    let asked = CertificateAsked {
        csr,
        proof: Proof::Certificate,
    };
    let response = anonymous
        .post(url(&fleet, CERTIFICATE_PATH))
        .json(&asked)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    // This fleet takes no identity tokens.
    let asked = CertificateAsked {
        csr: asked.csr,
        proof: Proof::GceIdentity {
            token: "a.b.c".into(),
        },
    };
    let response = anonymous
        .post(url(&fleet, CERTIFICATE_PATH))
        .json(&asked)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
    // The same callers with a host certificate get past the check.
    let host = client(fleet.pki.host_client("host-a.example"));
    let response = host
        .post(url(&fleet, REGISTER_PATH))
        .json(&bodies[0].1)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
}

#[tokio::test]
async fn a_current_certificate_renews_for_its_own_name_and_the_new_one_works() {
    let fleet = Fleet::start().await;
    let host = client(fleet.pki.host_client("host-b.example"));
    // The request asks for another host's name; the certificate is for the
    // name the caller's own certificate holds.
    let (key, csr) = request("host-a.example");
    let response = host
        .post(url(&fleet, CERTIFICATE_PATH))
        .json(&CertificateAsked {
            csr,
            proof: Proof::Certificate,
        })
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let issued: HostCertificate = response.json().await.unwrap();
    assert_eq!(issued.name, "host-b.example");
    assert!(issued.authorities.contains("BEGIN CERTIFICATE"));
    let now_ms = u64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap();
    let week_ms = 7 * 24 * 3600 * 1000;
    assert!(
        issued.not_after_ms > now_ms + week_ms - 60_000 && issued.not_after_ms <= now_ms + week_ms
    );

    // The host trusts the service by the authorities it was handed.
    let mut roots = rustls::RootCertStore::empty();
    for certificate in CertificateDer::pem_slice_iter(issued.authorities.as_bytes()) {
        roots.add(certificate.unwrap()).unwrap();
    }
    let renewed = Pki::client_of(
        &(issued.certificate.clone(), key.serialize_pem()),
        roots.into(),
    );
    let renewed = client(renewed);
    let response = renewed
        .post(url(&fleet, REGISTER_PATH))
        .json(&register("host-b.example"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let registered: Registered = response.json().await.unwrap();
    assert!(matches!(registered, Registered::Registered { .. }));
    // It names that host alone.
    let response = renewed
        .post(url(&fleet, REGISTER_PATH))
        .json(&register("host-a.example"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
    let _ = PrivateKeyDer::from_pem_slice(key.serialize_pem().as_bytes()).unwrap();
}

#[tokio::test]
async fn an_expired_or_foreign_certificate_gets_no_tls_and_so_no_renewal() {
    let fleet = Fleet::start().await;
    let (_, csr) = request("host-a.example");
    let asked = CertificateAsked {
        csr,
        proof: Proof::Certificate,
    };
    let expired = client(fleet.pki.expired_host_client("host-a.example"));
    assert!(
        expired
            .post(url(&fleet, CERTIFICATE_PATH))
            .json(&asked)
            .send()
            .await
            .is_err()
    );
    // Another authority's certificate, from a client that trusts this one.
    let other = Pki::new();
    let foreign = Pki::client_of(&other.issue_pem("host-a.example"), fleet.pki.trusted());
    assert!(
        client(foreign)
            .post(url(&fleet, CERTIFICATE_PATH))
            .json(&asked)
            .send()
            .await
            .is_err()
    );
}

#[tokio::test]
async fn a_host_never_gets_the_services_name_and_bodies_are_bounded() {
    let fleet = Fleet::start().await;
    let host = client(fleet.pki.host_client(SERVICE));
    let (_, csr) = request(SERVICE);
    let response = host
        .post(url(&fleet, CERTIFICATE_PATH))
        .json(&CertificateAsked {
            csr,
            proof: Proof::Certificate,
        })
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
    // A request that is not signed by its key.
    let host = client(fleet.pki.host_client("host-a.example"));
    let (_, csr) = request("host-a.example");
    let mut der = rustls::pki_types::CertificateSigningRequestDer::from_pem_slice(csr.as_bytes())
        .unwrap()
        .as_ref()
        .to_vec();
    let last = der.len() - 1;
    der[last] ^= 1;
    let tampered = pem::encode(&pem::Pem::new("CERTIFICATE REQUEST", der));
    let response = host
        .post(url(&fleet, CERTIFICATE_PATH))
        .json(&CertificateAsked {
            csr: tampered,
            proof: Proof::Certificate,
        })
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 400);
    let huge = CertificateAsked {
        csr: "x".repeat(32 << 10),
        proof: Proof::Certificate,
    };
    let response = host
        .post(url(&fleet, CERTIFICATE_PATH))
        .json(&huge)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 413);
}
