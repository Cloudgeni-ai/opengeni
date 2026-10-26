//! Which boot of its machine a host runs under, and telling its cloud.
//!
//! A restart ends every VM on the machine. The host names its boot, the
//! kernel's id for it and when it began, in its registration
//! ([`HostInfo::boot`]), and on Compute Engine also writes it to its
//! instance's guest attributes (`compute/boot`) as it starts, which only
//! software on the machine can write and the control service reads
//! through the cloud's API. A host that stopped renewing, whose instance
//! has since written a later boot than its registration named, has
//! restarted: nothing it ran then runs any more, so the service gives up
//! on it without resetting the machine again or waiting for it (ADR 18).
//! An earlier boot there, or none, proves nothing, so a write that fails
//! costs only that second reset. Sandboxes cannot write it: the metadata
//! server's link-local network is closed to them.
//!
//! [`HostInfo::boot`]: compute_protocol::fleet::HostInfo::boot

use std::time::Duration;

use compute_protocol::fleet::Boot;

/// Where a Compute Engine instance reaches its metadata server.
pub const METADATA: &str = "http://169.254.169.254";

/// The guest attribute a host writes its boot to, as namespace/key.
pub const BOOT_ATTRIBUTE: &str = "compute/boot";

/// How many times a host tries to tell its cloud, [`TELL_AGAIN`] apart.
const TELLS: u32 = 5;
const TELL_AGAIN: Duration = Duration::from_secs(3);

/// The machine's current boot as its kernel names it, which a restart
/// changes; `None` where the kernel does not say.
#[must_use]
pub fn this_boot() -> Option<Boot> {
    let id = std::fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
    let stat = std::fs::read_to_string("/proc/stat").ok()?;
    boot(&id, &stat)
}

/// The boot named by `boot_id` as the kernel prints it, begun at the
/// `btime` in `stat` (`/proc/stat`).
fn boot(boot_id: &str, stat: &str) -> Option<Boot> {
    let id = boot_id.trim();
    let at = stat
        .lines()
        .find_map(|line| line.strip_prefix("btime "))?
        .trim()
        .parse()
        .ok()?;
    (!id.is_empty()).then(|| Boot {
        id: id.to_owned(),
        at,
    })
}

/// What telling the cloud came to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Told {
    /// The metadata server took it.
    Taken,
    /// No metadata server answered: not on Compute Engine, or not yet.
    NoCloud,
    /// The metadata server refused it, as it does while the instance's
    /// guest attributes are off (`enable-guest-attributes`).
    Refused(u16),
}

/// Writes `boot` to this instance's guest attributes through the metadata
/// server at `metadata` ([`METADATA`] outside tests), once.
pub async fn tell(http: &reqwest::Client, metadata: &str, boot: &Boot) -> Told {
    let url = format!(
        "{}/computeMetadata/v1/instance/guest-attributes/{BOOT_ATTRIBUTE}",
        metadata.trim_end_matches('/')
    );
    let value = serde_json::to_string(boot).expect("a boot is a string and a number");
    match http
        .put(url)
        .header("Metadata-Flavor", "Google")
        .body(value)
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => Told::Taken,
        Ok(response) => Told::Refused(response.status().as_u16()),
        Err(_) => Told::NoCloud,
    }
}

/// Tells the cloud `boot`, trying a few times, and says how it went; a
/// host off Compute Engine says so only at debug level.
pub async fn tell_cloud(metadata: &str, boot: &Boot) {
    let Ok(http) = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
    else {
        return;
    };
    let mut told = Told::NoCloud;
    for attempt in 0..TELLS {
        if attempt > 0 {
            tokio::time::sleep(TELL_AGAIN).await;
        }
        told = tell(&http, metadata, boot).await;
        if told == Told::Taken {
            tracing::info!(boot = %boot.id, at = boot.at, "told the cloud this machine's boot");
            return;
        }
    }
    if let Told::Refused(status) = told {
        tracing::warn!(
            status,
            "the metadata server refused this machine's boot: after a restart, the control service resets the machine again before the host rejoins (are the instance's guest attributes on?)"
        );
    } else {
        tracing::debug!("no metadata server took this machine's boot");
    }
}

#[cfg(test)]
mod tests {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::net::TcpListener;

    use super::*;

    /// The boot a host names is the kernel's, the same however often it
    /// is read while the machine runs.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_host_names_the_kernels_boot() {
        let boot = this_boot().expect("Linux names its boot");
        assert_eq!(boot.id.len(), 36, "a UUID: {boot:?}");
        assert!(boot.at > 1_600_000_000, "{boot:?}");
        assert_eq!(this_boot().map(|again| again.id), Some(boot.id));
    }

    /// A boot is the kernel's id for it and its `btime`; without either
    /// there is none.
    #[test]
    fn a_boot_is_read_from_its_id_and_when_it_began() {
        let stat = "cpu  1 2 3\nintr 5\nbtime 1761480000\nprocesses 9\n";
        assert_eq!(
            boot("8c5f0e9e-4f4b-4b5e-9a49-1c0b7d0b6a11\n", stat),
            Some(Boot {
                id: "8c5f0e9e-4f4b-4b5e-9a49-1c0b7d0b6a11".into(),
                at: 1_761_480_000,
            })
        );
        assert_eq!(boot("\n", stat), None);
        assert_eq!(boot("8c5f0e9e", "cpu  1 2 3\n"), None);
    }

    /// A metadata server that answers one request with `status`, and
    /// hands back what it was sent, up to its body's end `ends`.
    async fn metadata(
        status: &'static str,
        ends: &'static str,
    ) -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let served = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4096];
            while !request.ends_with(ends.as_bytes()) {
                let read = stream.read(&mut buffer).await.unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
            }
            stream
                .write_all(format!("HTTP/1.1 {status}\r\ncontent-length: 0\r\n\r\n").as_bytes())
                .await
                .unwrap();
            String::from_utf8(request).unwrap()
        });
        (format!("http://{address}"), served)
    }

    /// The host writes its boot to its guest attribute, as the metadata
    /// server takes writes: a PUT of the value alone, flavored Google,
    /// and the value is the boot as the service reads it.
    #[tokio::test]
    async fn a_host_writes_its_boot_to_its_guest_attribute() {
        let boot = Boot {
            id: "8c5f0e9e-4f4b-4b5e-9a49-1c0b7d0b6a11".into(),
            at: 1_761_480_000,
        };
        let http = reqwest::Client::new();
        let (url, served) = metadata("200 OK", "}").await;
        assert_eq!(tell(&http, &url, &boot).await, Told::Taken);
        let request = served.await.unwrap();
        let lower = request.to_lowercase();
        assert!(
            lower.starts_with(
                "put /computemetadata/v1/instance/guest-attributes/compute/boot http/1.1\r\n"
            ),
            "{request}"
        );
        assert!(
            lower.contains("\r\nmetadata-flavor: google\r\n"),
            "{request}"
        );
        let (_, value) = request.split_once("\r\n\r\n").unwrap();
        assert_eq!(serde_json::from_str::<Boot>(value).unwrap(), boot);

        let (url, served) = metadata("400 Bad Request", "}").await;
        assert_eq!(tell(&http, &url, &boot).await, Told::Refused(400));
        served.await.unwrap();

        let unused = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let nobody = format!("http://{}", unused.local_addr().unwrap());
        drop(unused);
        assert_eq!(tell(&http, &nobody, &boot).await, Told::NoCloud);
    }
}
