//! The hosts' certificate authority, which the service holds and issues
//! every certificate of the host endpoint with: its own, for the names hosts
//! dial, and each host's, for the one name the host proved
//! ([`hostapi`](crate::hostapi)).
//!
//! The authority is a long-lived self-signed key and certificate given to
//! the service (`ca.key`, `ca.crt`), never kept in its database. `ca.crt`
//! may hold more certificates after the authority's own: other authorities
//! the service also trusts for hosts and hands hosts to trust it by, while
//! one authority replaces another (operations.md, Keys and certificates).
//! Certificates it issues are short-lived and name only what the service
//! decided, whatever a request asked for.

use std::net::IpAddr;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::Context as _;
use rcgen::{
    BasicConstraints, CertificateParams, CertificateSigningRequestParams, DnType,
    ExtendedKeyUsagePurpose, IsCa, KeyPair, KeyUsagePurpose, PublicKeyData, SanType, SerialNumber,
};
use rustls::RootCertStore;
use rustls::pki_types::pem::PemObject as _;
use rustls::pki_types::{CertificateDer, DnsName, ServerName, UnixTime};

/// The authority's certificate, and the further authorities trusted beside
/// it, PEM, in the authority's directory.
pub const CERTIFICATE_FILE: &str = "ca.crt";
/// The authority's key, PKCS#8 PEM, in the authority's directory.
pub const KEY_FILE: &str = "ca.key";

/// How long a certificate the authority issues is valid.
pub const ISSUED_FOR: Duration = Duration::from_secs(7 * 24 * 60 * 60);
/// How long a new authority is valid.
const AUTHORITY_FOR: Duration = Duration::from_secs(10 * 365 * 24 * 60 * 60);
/// How long before its issue a certificate starts to be valid, for clocks
/// a little behind.
const BACKDATE: Duration = Duration::from_secs(5 * 60);

/// How a host certificate's name was proven, which decides how it may be
/// renewed. The authority records it as the certificate's organizational
/// unit (`OU`) so the service reads it back from a certificate a caller
/// presents.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Proven {
    /// By a Google Compute Engine instance identity token. Such a
    /// certificate is renewed only with a fresh token, never by presenting
    /// it: once the instance is gone, so is the way to its next one.
    GceIdentity,
    /// By a current certificate, or offline where the authority's key is
    /// (`compute-control issue-host-certificate`): renewed by presenting it.
    Certificate,
}

impl Proven {
    /// The organizational unit that records it.
    #[must_use]
    pub const fn unit(self) -> &'static str {
        match self {
            Self::GceIdentity => "proven by gce-identity",
            Self::Certificate => "proven by certificate",
        }
    }

    /// How `certificate`'s name was proven, as its organizational unit
    /// records; `None` when it records neither.
    #[must_use]
    pub fn of(certificate: &CertificateDer<'_>) -> Option<Self> {
        let params = CertificateParams::from_ca_cert_der(certificate).ok()?;
        let unit = match params
            .distinguished_name
            .get(&DnType::OrganizationalUnitName)?
        {
            rcgen::DnValue::Utf8String(unit) => unit.as_str(),
            rcgen::DnValue::PrintableString(unit) => unit.as_str(),
            _ => return None,
        };
        [Self::GceIdentity, Self::Certificate]
            .into_iter()
            .find(|proven| proven.unit() == unit)
    }
}

/// A certificate the authority issued.
#[derive(Clone, Debug)]
pub struct Issued {
    pub der: CertificateDer<'static>,
    pub pem: String,
    /// When it stops being valid.
    pub not_after: SystemTime,
    /// Its serial number in hexadecimal, as `openssl x509 -serial` prints
    /// it: what tells two certificates of one host apart.
    pub serial: String,
}

/// The hosts' authority, as the service holds it.
pub struct Authority {
    /// The authority's certificate as rcgen signs with it.
    signer: rcgen::Certificate,
    key: KeyPair,
    /// Every authority trusted for hosts, the signing one first.
    trusted: Vec<CertificateDer<'static>>,
    /// The same, PEM, as hosts are given them.
    pem: String,
}

impl std::fmt::Debug for Authority {
    /// Never shows the key.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Authority")
            .field("trusted", &self.trusted.len())
            .finish_non_exhaustive()
    }
}

fn unix(time: SystemTime) -> anyhow::Result<time::OffsetDateTime> {
    let seconds = time
        .duration_since(UNIX_EPOCH)
        .context("a time before 1970")?
        .as_secs();
    Ok(time::OffsetDateTime::from_unix_timestamp(
        i64::try_from(seconds).context("a time too far ahead")?,
    )?)
}

fn serial() -> anyhow::Result<SerialNumber> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).context("random bytes")?;
    // Positive, and never shortened by a leading zero.
    bytes[0] = (bytes[0] & 0x7f) | 0x40;
    Ok(SerialNumber::from_slice(&bytes))
}

/// A serial number in uppercase hexadecimal, as `openssl x509 -serial`
/// prints it.
pub(crate) fn serial_hex(serial: &SerialNumber) -> String {
    use std::fmt::Write as _;
    serial.as_ref().iter().fold(String::new(), |mut hex, byte| {
        let _ = write!(hex, "{byte:02X}");
        hex
    })
}

/// What a certificate may be valid for: a DNS name, or an IP address.
fn subject_name(name: &str) -> anyhow::Result<SanType> {
    if let Ok(ip) = name.parse::<IpAddr>() {
        return Ok(SanType::IpAddress(ip));
    }
    // A name with its root's dot is another name to a client checking it
    // ("host." is not "host"), so certificates name neither form.
    anyhow::ensure!(
        !name.ends_with('.'),
        "{name:?}: certificates name no names ending in a dot"
    );
    let dns = DnsName::try_from(name.to_owned())
        .map_err(|_| anyhow::anyhow!("{name:?} is not a DNS name or an IP address"))?;
    anyhow::ensure!(
        !dns.as_ref().contains('*'),
        "{name:?}: certificates name no wildcards"
    );
    Ok(SanType::DnsName(dns.as_ref().try_into()?))
}

/// A new authority, valid for ten years: its certificate and its key, PEM.
pub fn generate(common_name: &str) -> anyhow::Result<(String, String)> {
    let key = KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256)?;
    let mut params = CertificateParams::default();
    params.distinguished_name = rcgen::DistinguishedName::new();
    params
        .distinguished_name
        .push(DnType::OrganizationName, "Opengeni compute");
    params
        .distinguished_name
        .push(DnType::CommonName, common_name);
    params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
    params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    let now = SystemTime::now();
    params.not_before = unix(now - BACKDATE)?;
    params.not_after = unix(now + AUTHORITY_FOR)?;
    params.serial_number = Some(serial()?);
    let certificate = params.self_signed(&key)?;
    Ok((certificate.pem(), key.serialize_pem()))
}

/// The public key of the certificate request `csr` (PEM), once its
/// signature shows the requester holds the key. Nothing else in it is
/// used.
pub fn requested_key(csr: &str) -> anyhow::Result<rcgen::PublicKey> {
    let request = CertificateSigningRequestParams::from_pem(csr)
        .map_err(|error| anyhow::anyhow!("not a certificate request signed by its key: {error}"))?;
    Ok(request.public_key)
}

impl Authority {
    /// The authority in `dir`: [`CERTIFICATE_FILE`] and [`KEY_FILE`].
    pub fn load(dir: &Path) -> anyhow::Result<Self> {
        let certificate_file = dir.join(CERTIFICATE_FILE);
        let key_file = dir.join(KEY_FILE);
        let certificates = std::fs::read_to_string(&certificate_file)
            .with_context(|| format!("reading {}", certificate_file.display()))?;
        let key = std::fs::read_to_string(&key_file)
            .with_context(|| format!("reading {}", key_file.display()))?;
        Self::from_pem(&certificates, &key)
            .with_context(|| format!("the hosts' authority in {}", dir.display()))
    }

    /// The authority whose certificate is the first in `certificates` and
    /// whose key is `key`, both PEM.
    pub fn from_pem(certificates: &str, key: &str) -> anyhow::Result<Self> {
        let trusted = CertificateDer::pem_slice_iter(certificates.as_bytes())
            .collect::<Result<Vec<_>, _>>()
            .context("parsing the authorities' certificates")?;
        let own = trusted.first().context("no authority certificate")?;
        let key = KeyPair::from_pem(key).map_err(|error| {
            anyhow::anyhow!(
                "the authority's key must be PKCS#8 PEM (`openssl pkcs8 -topk8 -nocrypt` \
                 converts others): {error}"
            )
        })?;
        let signer = CertificateParams::from_ca_cert_der(own)
            .context("parsing the authority's certificate")?
            .self_signed(&key)?;
        let pem = trusted
            .iter()
            .map(|certificate| pem::encode(&pem::Pem::new("CERTIFICATE", certificate.to_vec())))
            .collect();
        let authority = Self {
            signer,
            key,
            trusted,
            pem,
        };
        authority.check()?;
        Ok(authority)
    }

    /// Checks that what this authority issues verifies against its own
    /// certificate: that the key is the certificate's, and that the issuer
    /// the certificates name is the certificate's subject, byte for byte.
    fn check(&self) -> anyhow::Result<()> {
        let probe = KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256)?;
        let now = SystemTime::now();
        let issued = self.issue(&["probe.invalid".to_owned()], &probe, now, ISSUED_FOR, None)?;
        verify(&self.roots(), &issued.der, now, "probe.invalid").context(
            "a certificate the authority issues does not verify against its certificate: \
             is ca.key the key of the first certificate in ca.crt?",
        )
    }

    /// Every authority trusted for hosts, PEM: what hosts trust the
    /// service by.
    #[must_use]
    pub fn pem(&self) -> &str {
        &self.pem
    }

    /// Every authority trusted for hosts.
    #[must_use]
    pub fn roots(&self) -> Arc<RootCertStore> {
        let mut roots = RootCertStore::empty();
        for certificate in &self.trusted {
            // Parsed at load; one that is no usable anchor is left out.
            let _ = roots.add(certificate.clone());
        }
        Arc::new(roots)
    }

    /// A certificate for `names` (the first is also its common name), for
    /// `key`, valid from a little before `now` for `lifetime`, for server
    /// and client authentication alike; a host's records how its name was
    /// `proven`.
    pub fn issue(
        &self,
        names: &[String],
        key: &impl PublicKeyData,
        now: SystemTime,
        lifetime: Duration,
        proven: Option<Proven>,
    ) -> anyhow::Result<Issued> {
        let first = names.first().context("a certificate names something")?;
        let mut params = CertificateParams::default();
        params.distinguished_name = rcgen::DistinguishedName::new();
        params.distinguished_name.push(DnType::CommonName, first);
        if let Some(proven) = proven {
            params
                .distinguished_name
                .push(DnType::OrganizationalUnitName, proven.unit());
        }
        params.subject_alt_names = names
            .iter()
            .map(|name| subject_name(name))
            .collect::<anyhow::Result<_>>()?;
        params.is_ca = IsCa::ExplicitNoCa;
        params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        params.extended_key_usages = vec![
            ExtendedKeyUsagePurpose::ServerAuth,
            ExtendedKeyUsagePurpose::ClientAuth,
        ];
        params.use_authority_key_identifier_extension = true;
        let not_after = now + lifetime;
        params.not_before = unix(now - BACKDATE)?;
        params.not_after = unix(not_after)?;
        let serial = serial()?;
        let serial_hex = serial_hex(&serial);
        params.serial_number = Some(serial);
        let certificate = params.signed_by(key, &self.signer, &self.key)?;
        Ok(Issued {
            der: certificate.der().clone(),
            pem: certificate.pem(),
            not_after: UNIX_EPOCH
                + Duration::from_secs(not_after.duration_since(UNIX_EPOCH)?.as_secs()),
            serial: serial_hex,
        })
    }
}

/// Checks that `certificate` chains to `roots`, is valid at `now`, and is
/// valid for `name`.
pub fn verify(
    roots: &RootCertStore,
    certificate: &CertificateDer<'_>,
    now: SystemTime,
    name: &str,
) -> anyhow::Result<()> {
    let end = webpki::EndEntityCert::try_from(certificate).context("parsing the certificate")?;
    let since = now
        .duration_since(UNIX_EPOCH)
        .context("a time before 1970")?;
    end.verify_for_usage(
        webpki::ALL_VERIFICATION_ALGS,
        &roots.roots,
        &[],
        UnixTime::since_unix_epoch(since),
        webpki::KeyUsage::server_auth(),
        None,
        None,
    )
    .map_err(|error| anyhow::anyhow!("the certificate does not verify: {error}"))?;
    let name = ServerName::try_from(name.to_owned()).context("the name")?;
    end.verify_is_valid_for_subject_name(&name)
        .map_err(|error| anyhow::anyhow!("the certificate is not valid for it: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn authority() -> Authority {
        let (certificate, key) = generate("test authority").unwrap();
        Authority::from_pem(&certificate, &key).unwrap()
    }

    #[test]
    fn what_the_authority_issues_verifies_for_its_names_only() {
        let authority = authority();
        let key = KeyPair::generate().unwrap();
        let now = SystemTime::now();
        let issued = authority
            .issue(
                &["control.example".into(), "10.0.0.2".into()],
                &key,
                now,
                ISSUED_FOR,
                None,
            )
            .unwrap();
        let roots = authority.roots();
        verify(&roots, &issued.der, now, "control.example").unwrap();
        verify(&roots, &issued.der, now, "10.0.0.2").unwrap();
        assert!(verify(&roots, &issued.der, now, "other.example").is_err());
        assert!(
            verify(
                &roots,
                &issued.der,
                now + ISSUED_FOR + Duration::from_secs(1),
                "control.example"
            )
            .is_err(),
            "expired"
        );
        let lasts = issued.not_after.duration_since(now).unwrap();
        assert!(lasts <= ISSUED_FOR && lasts + Duration::from_secs(2) > ISSUED_FOR);
        // Another authority's certificates do not verify against this one.
        let other = self::authority();
        let foreign = other
            .issue(&["control.example".into()], &key, now, ISSUED_FOR, None)
            .unwrap();
        assert!(verify(&roots, &foreign.der, now, "control.example").is_err());
    }

    #[test]
    fn a_key_that_is_not_the_certificates_is_refused_at_load() {
        let (certificate, _) = generate("one").unwrap();
        let (_, key) = generate("two").unwrap();
        let error = Authority::from_pem(&certificate, &key).unwrap_err();
        assert!(format!("{error:#}").contains("ca.key"), "{error:#}");
    }

    #[test]
    fn further_authorities_are_trusted_and_handed_out_after_the_signing_one() {
        let (one, key) = generate("one").unwrap();
        let (two, two_key) = generate("two").unwrap();
        let authority = Authority::from_pem(&format!("{one}{two}"), &key).unwrap();
        assert_eq!(authority.pem().matches("BEGIN CERTIFICATE").count(), 2);
        let older = Authority::from_pem(&two, &two_key).unwrap();
        let host = KeyPair::generate().unwrap();
        let now = SystemTime::now();
        let issued = older
            .issue(&["host-1".into()], &host, now, ISSUED_FOR, None)
            .unwrap();
        verify(&authority.roots(), &issued.der, now, "host-1").unwrap();
    }

    #[test]
    fn a_request_counts_only_if_signed_by_its_own_key() {
        let key = KeyPair::generate().unwrap();
        let params = CertificateParams::new(vec!["asked-for.example".to_owned()]).unwrap();
        let csr = params.serialize_request(&key).unwrap().pem().unwrap();
        let public = requested_key(&csr).unwrap();
        assert_eq!(public.der_bytes(), key.der_bytes());
        // The same request with one byte of its signature changed.
        let der = pem::parse(&csr).unwrap().into_contents();
        let mut tampered = der.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 1;
        let tampered = pem::encode(&pem::Pem::new("CERTIFICATE REQUEST", tampered));
        assert!(requested_key(&tampered).is_err());
        assert!(requested_key("not a request").is_err());
    }

    #[test]
    fn names_are_dns_names_or_addresses_without_wildcards() {
        assert!(subject_name("host-1").is_ok());
        assert!(subject_name("control.example.com").is_ok());
        assert!(subject_name("10.1.2.3").is_ok());
        assert!(subject_name("*.example.com").is_err());
        assert!(subject_name("not a name").is_err());
        assert!(subject_name("").is_err());
        assert!(subject_name("host-1.").is_err(), "a trailing dot");
        assert!(subject_name("control.example.com.").is_err());
    }

    #[test]
    fn a_certificate_records_how_its_name_was_proven() {
        let authority = authority();
        let key = KeyPair::generate().unwrap();
        let now = SystemTime::now();
        for proven in [Proven::GceIdentity, Proven::Certificate] {
            let issued = authority
                .issue(&["host-1".into()], &key, now, ISSUED_FOR, Some(proven))
                .unwrap();
            assert_eq!(Proven::of(&issued.der), Some(proven));
            verify(&authority.roots(), &issued.der, now, "host-1").unwrap();
        }
        // The service's own certificates, and older ones, record none.
        let issued = authority
            .issue(&["host-1".into()], &key, now, ISSUED_FOR, None)
            .unwrap();
        assert_eq!(Proven::of(&issued.der), None);
        assert_eq!(Proven::of(&CertificateDer::from(vec![1, 2, 3])), None);
    }
}
