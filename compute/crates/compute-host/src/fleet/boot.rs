//! Which boot of its machine a host runs under, and telling its cloud.
//!
//! A restart ends every VM on the machine. On Compute Engine the host
//! writes the boot it runs under to its instance's guest attributes
//! (`compute/boot`) as it starts, which only software on the machine can
//! write and the control service reads through the cloud's API, and names
//! that boot in its registration ([`HostInfo::boot`]) only once the cloud
//! took it. It counts each boot on from the one the attribute named when
//! it first told of it, so while a boot runs its cloud names no other
//! one counted later. A host that stopped renewing, whose instance has
//! since named a boot counted later than its registration's, has
//! restarted: nothing it ran then runs any more, so the service gives up
//! on it without resetting the machine again or waiting for it (ADR 18).
//! One counted earlier or the same, or none, proves nothing, so a write
//! that fails costs only that second reset. Sandboxes cannot write it:
//! the metadata server's link-local network is closed to them.
//!
//! [`HostInfo::boot`]: compute_protocol::fleet::HostInfo::boot

use std::time::Duration;

use compute_protocol::fleet::Boot;
use reqwest::StatusCode;

/// Where a Compute Engine instance reaches its metadata server.
pub const METADATA: &str = "http://169.254.169.254";

/// The guest attribute a host writes its boot to, as namespace/key.
pub const BOOT_ATTRIBUTE: &str = "compute/boot";

/// How many times a host tries to tell its cloud while the metadata
/// server fails, [`TELL_AGAIN`] apart, and how long it tries at most: its
/// first registration waits for the outcome.
const TELLS: u32 = 4;
const TELL_AGAIN: Duration = Duration::from_secs(1);
const TELL_WITHIN: Duration = Duration::from_secs(10);

/// The boot to tell the cloud of, and where.
#[derive(Clone, Debug)]
pub struct Telling {
    /// What the kernel names the machine's current boot ([`boot_id`]).
    pub id: String,
    /// Where the metadata server answers: [`METADATA`] outside tests.
    pub metadata: String,
}

/// What the kernel names the machine's current boot, which no other boot
/// shares; `None` where it does not say.
#[must_use]
pub fn boot_id() -> Option<String> {
    let id = std::fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
    let id = id.trim();
    (!id.is_empty()).then(|| id.to_owned())
}

/// What telling the cloud came to.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Told {
    /// The cloud names this boot, so: written now, or by an earlier run
    /// of the agent under the same boot.
    Taken(Boot),
    /// No metadata server answered: not on Compute Engine.
    NoCloud,
    /// The metadata server refused, as it does while the instance's guest
    /// attributes are off (`enable-guest-attributes`), or failed.
    Refused(StatusCode),
}

/// Tells the cloud, through the metadata server at `metadata`, of the boot
/// the kernel names `id`, once: reads what the attribute names, and unless
/// it already names this boot, writes this one, counted one past it.
async fn tell(http: &reqwest::Client, metadata: &str, id: &str) -> Told {
    let url = format!(
        "{}/computeMetadata/v1/instance/guest-attributes/{BOOT_ATTRIBUTE}",
        metadata.trim_end_matches('/')
    );
    let named = match http
        .get(&url)
        .header("Metadata-Flavor", "Google")
        .send()
        .await
    {
        Err(_) => return Told::NoCloud,
        Ok(response) if response.status() == StatusCode::NOT_FOUND => None,
        Ok(response) if response.status().is_success() => match response.text().await {
            // One it cannot read counts as none: a boot counted too low
            // only costs a reset.
            Ok(value) => serde_json::from_str::<Boot>(&value).ok(),
            Err(_) => return Told::NoCloud,
        },
        Ok(response) => return Told::Refused(response.status()),
    };
    let boot = match named {
        Some(named) if named.id == id => return Told::Taken(named),
        Some(named) => Boot {
            id: id.to_owned(),
            nth: named.nth.saturating_add(1),
        },
        None => Boot {
            id: id.to_owned(),
            nth: 1,
        },
    };
    let value = serde_json::to_string(&boot).expect("a boot is a string and a number");
    match http
        .put(&url)
        .header("Metadata-Flavor", "Google")
        .body(value)
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => Told::Taken(boot),
        Ok(response) => Told::Refused(response.status()),
        Err(_) => Told::NoCloud,
    }
}

/// Tells the cloud of the boot `telling` names, trying again a few times
/// while the metadata server fails, and returns the boot as the cloud
/// took it, which the host may name; `None` if it took none.
pub async fn tell_cloud(telling: &Telling) -> Option<Boot> {
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .ok()?;
    let telling_again = async {
        let mut told = Told::NoCloud;
        for attempt in 0..TELLS {
            if attempt > 0 {
                tokio::time::sleep(TELL_AGAIN).await;
            }
            told = tell(&http, &telling.metadata, &telling.id).await;
            match &told {
                Told::Refused(status) if status.is_server_error() => {}
                _ => break,
            }
        }
        told
    };
    match tokio::time::timeout(TELL_WITHIN, telling_again).await {
        Ok(Told::Taken(boot)) => {
            tracing::info!(boot = %boot.id, nth = boot.nth, "told the cloud this machine's boot");
            Some(boot)
        }
        Ok(Told::NoCloud) => {
            tracing::debug!("no metadata server answered: not telling a cloud of this boot");
            None
        }
        Ok(Told::Refused(status)) => {
            tracing::warn!(
                status = status.as_u16(),
                "the metadata server refused this machine's boot: after a restart, the control service resets the machine again before the host rejoins (are the instance's guest attributes on?)"
            );
            None
        }
        Err(_) => {
            tracing::warn!("telling the cloud of this machine's boot took too long");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use std::convert::Infallible;
    use std::sync::{Arc, Mutex};

    use bytes::Bytes;
    use http_body_util::{BodyExt as _, Full};
    use hyper::{Method, Request, Response};
    use hyper_util::rt::TokioIo;
    use tokio::net::TcpListener;

    use super::*;

    /// The kernel names the boot the same however often it is read while
    /// the machine runs.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_host_reads_the_kernels_boot() {
        let id = boot_id().expect("Linux names its boot");
        assert_eq!(id.len(), 36, "a UUID: {id}");
        assert_eq!(boot_id(), Some(id));
    }

    /// A metadata server holding one guest attribute, which refuses
    /// writes with `refuse` if set; it notes each request it is sent.
    #[derive(Default)]
    struct Metadata {
        value: Mutex<Option<String>>,
        refuse: Option<u16>,
        heard: Mutex<Vec<String>>,
    }

    impl Metadata {
        async fn answer(&self, request: Request<hyper::body::Incoming>) -> Response<Full<Bytes>> {
            let method = request.method().clone();
            let path = request.uri().path().to_owned();
            let flavored = request
                .headers()
                .get("metadata-flavor")
                .is_some_and(|flavor| flavor == "Google");
            let body = request.into_body().collect().await.unwrap().to_bytes();
            let body = String::from_utf8(body.to_vec()).unwrap();
            self.heard.lock().unwrap().push(format!("{method} {body}"));
            let respond = |status: u16, body: String| {
                let mut response = Response::new(Full::new(Bytes::from(body)));
                *response.status_mut() = hyper::StatusCode::from_u16(status).unwrap();
                response
            };
            if !flavored || path != "/computeMetadata/v1/instance/guest-attributes/compute/boot" {
                return respond(403, String::new());
            }
            match method {
                Method::GET => match self.value.lock().unwrap().clone() {
                    Some(value) => respond(200, value),
                    None => respond(404, "not found.".into()),
                },
                Method::PUT => {
                    if let Some(status) = self.refuse {
                        return respond(status, String::new());
                    }
                    *self.value.lock().unwrap() = Some(body);
                    respond(200, String::new())
                }
                _ => respond(405, String::new()),
            }
        }

        /// Serves until the test ends, at the URL returned.
        async fn serve(self: &Arc<Self>) -> String {
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let address = listener.local_addr().unwrap();
            let metadata = Arc::clone(self);
            tokio::spawn(async move {
                loop {
                    let Ok((tcp, _)) = listener.accept().await else {
                        continue;
                    };
                    let metadata = Arc::clone(&metadata);
                    tokio::spawn(async move {
                        let answer = hyper::service::service_fn(move |request| {
                            let metadata = Arc::clone(&metadata);
                            async move { Ok::<_, Infallible>(metadata.answer(request).await) }
                        });
                        let _ = hyper::server::conn::http1::Builder::new()
                            .serve_connection(TokioIo::new(tcp), answer)
                            .await;
                    });
                }
            });
            format!("http://{address}")
        }

        fn named(&self) -> Option<Boot> {
            let value = self.value.lock().unwrap().clone()?;
            Some(serde_json::from_str(&value).unwrap())
        }
    }

    fn telling(id: &str, metadata: String) -> Telling {
        Telling {
            id: id.into(),
            metadata,
        }
    }

    /// A host counts its boot on from the one its instance names, writes
    /// it, and names it; the first boot told of is the first.
    #[tokio::test]
    async fn a_host_counts_its_boot_on_from_the_one_its_cloud_names() {
        let metadata = Arc::new(Metadata::default());
        let url = metadata.serve().await;
        let first = tell_cloud(&telling("boot-a", url.clone())).await;
        let first_boot = Boot {
            id: "boot-a".into(),
            nth: 1,
        };
        assert_eq!(first, Some(first_boot.clone()));
        assert_eq!(metadata.named(), Some(first_boot));

        let second = tell_cloud(&telling("boot-b", url)).await.unwrap();
        assert_eq!(
            second,
            Boot {
                id: "boot-b".into(),
                nth: 2
            }
        );
        assert_eq!(metadata.named(), Some(second));
        let heard = metadata.heard.lock().unwrap().clone();
        assert_eq!(heard.len(), 4, "{heard:?}");
        assert_eq!(heard[3], r#"PUT {"id":"boot-b","nth":2}"#);
    }

    /// An agent started again under the same boot names the boot its
    /// cloud already has, as it was counted, and writes nothing.
    #[tokio::test]
    async fn an_agent_started_again_names_the_boot_its_cloud_has() {
        let metadata = Arc::new(Metadata::default());
        *metadata.value.lock().unwrap() = Some(r#"{"id":"boot-a","nth":5}"#.into());
        let url = metadata.serve().await;
        assert_eq!(
            tell_cloud(&telling("boot-a", url)).await,
            Some(Boot {
                id: "boot-a".into(),
                nth: 5
            })
        );
        let heard = metadata.heard.lock().unwrap().clone();
        assert_eq!(heard, vec!["GET ".to_owned()]);
    }

    /// A value it cannot read counts as no boot: the host counts from 1,
    /// which can only cost a reset.
    #[tokio::test]
    async fn a_value_it_cannot_read_counts_as_none() {
        let metadata = Arc::new(Metadata::default());
        *metadata.value.lock().unwrap() = Some(r#"{"id":"boot-a","at":1761480000}"#.into());
        let url = metadata.serve().await;
        let told = tell_cloud(&telling("boot-b", url)).await.unwrap();
        assert_eq!(told.nth, 1);
    }

    /// A host whose write is refused, or with no metadata server, names no
    /// boot, and does not wait long to say so.
    #[tokio::test]
    async fn a_host_its_cloud_took_no_boot_from_names_none() {
        let refusing = Arc::new(Metadata {
            refuse: Some(403),
            ..Metadata::default()
        });
        let url = refusing.serve().await;
        let started = std::time::Instant::now();
        assert_eq!(tell_cloud(&telling("boot-a", url)).await, None);
        assert_eq!(refusing.named(), None);

        let unused = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let nobody = format!("http://{}", unused.local_addr().unwrap());
        drop(unused);
        assert_eq!(tell_cloud(&telling("boot-a", nobody)).await, None);
        assert!(started.elapsed() < TELL_AGAIN, "{:?}", started.elapsed());
    }

    /// A metadata server that fails is asked again, a few times.
    #[tokio::test]
    async fn a_failing_metadata_server_is_asked_again() {
        let failing = Arc::new(Metadata {
            refuse: Some(503),
            ..Metadata::default()
        });
        let url = failing.serve().await;
        assert_eq!(tell_cloud(&telling("boot-a", url)).await, None);
        let heard = failing.heard.lock().unwrap().clone();
        let puts = heard
            .iter()
            .filter(|heard| heard.starts_with("PUT"))
            .count();
        assert_eq!(puts, usize::try_from(TELLS).unwrap(), "{heard:?}");
    }
}
