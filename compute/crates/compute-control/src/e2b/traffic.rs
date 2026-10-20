//! Sandbox traffic: requests to a port in a sandbox, through the owner
//! host's `connect` and the guest's gateway.
//!
//! Each request is HTTP/1.1 over a stream to the guest port. Streams are
//! kept for the next request to the same sandbox and port, at most
//! [`IDLE_PER_PORT`] of them for [`IDLE_FOR`]. A kept stream is open on
//! the host, so it holds the sandbox awake like any open stream; that is
//! why it is kept only briefly, and dropped as soon as that time is up. An
//! upgrade (a WebSocket, say) takes its stream for itself and relays bytes
//! both ways.
//!
//! A pause or kill cuts a sandbox's traffic: every stream through the
//! front door ends, and kept streams are dropped. Another replica's pause
//! cuts nothing here, and a connect to the guest, or a stream hold, may
//! wake a sandbox paused meanwhile. Once one ends, the pause is fenced
//! against it at once ([`ops::fence_wake`]): nothing is forwarded unless
//! the sandbox still runs, and one paused meanwhile is recorded as pausing
//! again. One whose caller went away first, or whose replica stopped, is
//! found by the periodic check of paused sandboxes' hosts
//! ([`ops::check_paused`]).
//!
//! A Connect stream (an
//! envd command's or PTY's output, say) holds the sandbox awake while it
//! is open, through a hold with a short time to live that is renewed while
//! any is open, and released soon after the last one ends. Each replica
//! keeps its own hold, so one replica's streams ending does not release a
//! sandbox another replica's streams still need. Its keepalive
//! bytes move nothing: neither the E2B timeout, which only connect and
//! set-timeout calls move, nor the hold, which only open streams keep.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use axum::extract::Request;
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use compute_guest::{ENVD_PORT, GATEWAY_PORT, gateway};
use compute_protocol::host::{Id, PriorityName};
use http_body_util::{BodyExt as _, StreamBody};
use hyper::body::{Body as _, Frame, Incoming};
use hyper::client::conn::http1::{self, SendRequest};
use hyper_util::rt::TokioIo;
use serde_json::json;
use tokio::io::{AsyncBufReadExt as _, AsyncReadExt as _, AsyncWriteExt as _};
use tokio::sync::watch;
use tokio::time::Instant;

use super::lifecycle::{self, OnTraffic, State};
use super::ops;
use super::route::{self, HOP_BY_HOP, TRAFFIC_TOKEN, Target};
use super::{Front, Refused};
use crate::store::Store;

/// How many idle streams are kept per sandbox and port.
pub const IDLE_PER_PORT: usize = 8;
/// How long an idle stream is kept. As short as the hold's grace, since a
/// kept stream keeps the sandbox awake.
pub const IDLE_FOR: Duration = HOLD_GRACE;
/// How long an open stream's hold lives unless renewed.
const HOLD_TTL: Duration = Duration::from_secs(45);
/// How often it is renewed.
const HOLD_EVERY: Duration = Duration::from_secs(15);
/// How long after the last stream ends the hold is released, so a client
/// that opens its next stream at once does not let the sandbox sleep.
const HOLD_GRACE: Duration = Duration::from_secs(2);
/// How long the guest may take to answer a gateway header.
const DIAL_WITHIN: Duration = Duration::from_secs(30);
/// How long a kept stream may take to be ready again.
const READY_WITHIN: Duration = Duration::from_millis(100);

/// The traffic of every sandbox this replica has carried lately.
#[derive(Debug, Default)]
pub struct Traffic {
    lanes: Mutex<HashMap<Id, Arc<Lane>>>,
}

/// A kept stream, and when it became idle.
type Idle = (SendRequest<Body>, Instant);

/// One sandbox's traffic.
#[derive(Debug)]
struct Lane {
    /// Raised by every cut; requests end when it changes.
    cuts: watch::Sender<u64>,
    /// Idle streams by port, with when each became idle.
    idle: Mutex<HashMap<u16, Vec<Idle>>>,
    /// How many Connect streams are open.
    streams: watch::Sender<usize>,
    /// Whether a task holds the sandbox for them.
    holding: AtomicBool,
}

impl Default for Lane {
    fn default() -> Self {
        Self {
            cuts: watch::Sender::new(0),
            idle: Mutex::new(HashMap::new()),
            streams: watch::Sender::new(0),
            holding: AtomicBool::new(false),
        }
    }
}

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Traffic {
    fn lane(&self, id: Id) -> Arc<Lane> {
        Arc::clone(locked(&self.lanes).entry(id).or_default())
    }

    /// Ends every request to `id` through this replica, and drops its
    /// kept streams.
    pub fn cut(&self, id: Id) {
        let lane = locked(&self.lanes).get(&id).cloned();
        if let Some(lane) = lane {
            lane.cuts.send_modify(|cuts| *cuts += 1);
            locked(&lane.idle).clear();
        }
    }

    /// Cuts `id`'s traffic and forgets it.
    pub fn forget(&self, id: Id) {
        self.cut(id);
        locked(&self.lanes).remove(&id);
    }

    /// How many idle streams are kept for `id`'s `port`.
    #[must_use]
    pub fn idle(&self, id: Id, port: u16) -> usize {
        locked(&self.lanes)
            .get(&id)
            .map_or(0, |lane| locked(&lane.idle).get(&port).map_or(0, Vec::len))
    }
}

impl Lane {
    /// A kept stream to `port` that is ready for a request.
    async fn kept(&self, port: u16) -> Option<SendRequest<Body>> {
        loop {
            let (mut sender, since) = locked(&self.idle).get_mut(&port)?.pop()?;
            if sender.is_closed() || since.elapsed() > IDLE_FOR {
                continue;
            }
            if matches!(
                tokio::time::timeout(READY_WITHIN, sender.ready()).await,
                Ok(Ok(()))
            ) {
                return Some(sender);
            }
        }
    }

    /// Keeps `sender` for the next request, unless the lane was cut since
    /// `cuts`, and drops it once [`IDLE_FOR`] is up.
    fn keep(self: &Arc<Self>, port: u16, sender: SendRequest<Body>, cuts: u64) {
        if *self.cuts.borrow() != cuts || sender.is_closed() {
            return;
        }
        {
            let mut idle = locked(&self.idle);
            let kept = idle.entry(port).or_default();
            prune(kept);
            if kept.len() >= IDLE_PER_PORT {
                return;
            }
            kept.push((sender, Instant::now()));
        }
        let lane = Arc::downgrade(self);
        tokio::spawn(async move {
            tokio::time::sleep(IDLE_FOR + Duration::from_millis(50)).await;
            if let Some(lane) = lane.upgrade() {
                let mut idle = locked(&lane.idle);
                if let Some(kept) = idle.get_mut(&port) {
                    prune(kept);
                    if kept.is_empty() {
                        idle.remove(&port);
                    }
                }
            }
        });
    }
}

/// Drops the closed streams and those idle too long; dropping one closes
/// it, which ends its stream on the host.
fn prune(kept: &mut Vec<Idle>) {
    kept.retain(|(sender, since)| !sender.is_closed() && since.elapsed() <= IDLE_FOR);
}

/// E2B's answer for traffic to a sandbox that is not there.
fn not_found(id: Id) -> Response {
    let body = json!({
        "sandboxId": id.to_string(),
        "message": "The sandbox was not found",
        "code": 502,
    });
    (StatusCode::BAD_GATEWAY, axum::Json(body)).into_response()
}

/// E2B's answer for traffic to a sandbox still changing state: envd's
/// port answers 503, which the SDK retries; other ports 409.
fn transitioning(target: Target) -> Response {
    let status = if target.port == ENVD_PORT {
        StatusCode::SERVICE_UNAVAILABLE
    } else {
        StatusCode::CONFLICT
    };
    let body = json!({
        "sandboxId": target.id.to_string(),
        "message": "The sandbox is still transitioning. Try again in a moment.",
        "code": status.as_u16(),
    });
    (status, axum::Json(body)).into_response()
}

/// E2B's answer for traffic to a port nothing listens on.
fn port_closed(target: Target) -> Response {
    let body = json!({
        "sandboxId": target.id.to_string(),
        "message": "The sandbox is running but port is not open",
        "port": target.port,
        "code": 502,
    });
    (StatusCode::BAD_GATEWAY, axum::Json(body)).into_response()
}

/// Whether `headers` carry `token` as the traffic token: `None` when they
/// do, else the refusal.
fn refuse_token(headers: &HeaderMap, token: &str) -> Option<Response> {
    let given = headers.get(TRAFFIC_TOKEN).map(HeaderValue::as_bytes);
    let message = match given {
        None => "Missing traffic access token",
        // Compared by digest, so the time taken says nothing of the token.
        Some(given) if blake3::hash(given) == blake3::hash(token.as_bytes()) => return None,
        Some(_) => "Invalid traffic access token",
    };
    let body = json!({ "message": message, "code": 403 });
    Some((StatusCode::FORBIDDEN, axum::Json(body)).into_response())
}

/// Serves a request to a sandbox's port.
pub async fn serve<S: Store>(
    front: &Arc<Front<S>>,
    target: Result<Target, String>,
    request: Request,
) -> Response {
    let target = match target {
        Ok(target) => target,
        Err(message) => return Refused::invalid(message).into_response(),
    };
    match carry(front, target, request).await {
        Ok(response) => response,
        Err(refused) if refused.status == 404 => not_found(target.id),
        Err(refused) => refused.into_response(),
    }
}

async fn carry<S: Store>(
    front: &Arc<Front<S>>,
    target: Target,
    mut request: Request,
) -> Result<Response, Refused> {
    let id = target.id;
    let Some(row) = front.store().lifecycle(id).await? else {
        return Ok(not_found(id));
    };
    // Before anything that could resume it: a request without the traffic
    // token changes nothing.
    if target.port != ENVD_PORT
        && let Some(token) = &row.record.traffic_token
        && let Some(refusal) = refuse_token(request.headers(), token)
    {
        return Ok(refusal);
    }
    match lifecycle::on_traffic(&row.record) {
        OnTraffic::Route => {}
        OnTraffic::Resume => {
            ops::connect(front, &row.team, id, None).await?;
        }
        OnTraffic::NotFound => return Ok(not_found(id)),
        OnTraffic::Transitioning => return Ok(transitioning(target)),
    }
    let team = row.team;
    let lane = front.traffic.lane(id);
    let mut cut = lane.cuts.subscribe();
    let cuts = *cut.borrow_and_update();
    let upgrade = request.headers().contains_key(header::UPGRADE);
    let streaming = route::is_stream(request.headers());
    let caller_upgrade = upgrade.then(|| hyper::upgrade::on(&mut request));
    let request = outbound(request, upgrade)?;
    let open = streaming.then(|| Open::new(front, &lane, &team, id));
    let sent = tokio::select! {
        sent = send(front, &lane, &team, target, request) => sent?,
        _ = cut.changed() => return Err(Refused::not_found(id)),
    };
    let Sent { response, sender } = match sent {
        Dialed::Sent(sent) => sent,
        Dialed::PortClosed => return Ok(port_closed(target)),
        // Paused or killed meanwhile: what a request then would get; a
        // retry finds it paused, or gone.
        Dialed::NotRunning => return Ok(transitioning(target)),
    };
    let mut response = response;
    if response.status() == StatusCode::SWITCHING_PROTOCOLS {
        let guest_upgrade = hyper::upgrade::on(&mut response);
        if let Some(caller_upgrade) = caller_upgrade {
            tokio::spawn(relay(caller_upgrade, guest_upgrade, cut, open));
        }
        let (parts, _) = response.into_parts();
        return Ok(Response::from_parts(parts, Body::empty()));
    }
    let (mut parts, incoming) = response.into_parts();
    strip(&mut parts.headers);
    if incoming.is_end_stream() {
        lane.keep(target.port, sender, cuts);
        return Ok(Response::from_parts(parts, Body::empty()));
    }
    let body = Carried {
        incoming,
        cut,
        kept: Some(Keep {
            lane,
            port: target.port,
            sender,
            cuts,
        }),
        _open: open,
        done: false,
    };
    let frames = futures::stream::unfold(body, Carried::next);
    Ok(Response::from_parts(
        parts,
        Body::new(StreamBody::new(frames)),
    ))
}

/// Relays an upgraded connection both ways until either side closes or
/// the sandbox's traffic is cut.
async fn relay(
    caller: hyper::upgrade::OnUpgrade,
    guest: hyper::upgrade::OnUpgrade,
    mut cut: watch::Receiver<u64>,
    _open: Option<Open>,
) {
    let (Ok(caller), Ok(guest)) = (caller.await, guest.await) else {
        return;
    };
    let mut caller = TokioIo::new(caller);
    let mut guest = TokioIo::new(guest);
    tokio::select! {
        _ = tokio::io::copy_bidirectional(&mut caller, &mut guest) => {}
        _ = cut.changed() => {}
    }
}

/// Drops hop-by-hop headers, and those the connection header names.
fn strip(headers: &mut HeaderMap) {
    let named: Vec<String> = headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(|name| name.trim().to_ascii_lowercase())
        .filter(|name| !name.is_empty())
        .collect();
    for name in HOP_BY_HOP
        .iter()
        .copied()
        .chain(named.iter().map(String::as_str))
    {
        headers.remove(name);
    }
}

/// The request as it goes to the guest: in origin form, without
/// hop-by-hop headers unless it upgrades.
fn outbound(request: Request, upgrade: bool) -> Result<Request, Refused> {
    let (mut parts, body) = request.into_parts();
    let path = parts.uri.path_and_query().map_or("/", |path| path.as_str());
    parts.uri = path
        .parse::<Uri>()
        .map_err(|error| Refused::invalid(format!("bad path: {error}")))?;
    if !upgrade {
        strip(&mut parts.headers);
    }
    Ok(Request::from_parts(parts, body))
}

/// A response and the stream it came on.
struct Sent {
    response: hyper::Response<Incoming>,
    sender: SendRequest<Body>,
}

enum Dialed {
    Sent(Sent),
    PortClosed,
    /// The sandbox stopped running while its stream was being opened, or
    /// its envd was starting again.
    NotRunning,
}

/// Sends `request` on a kept stream, or on a new one when there is none
/// or the kept one closed before taking it.
async fn send<S: Store>(
    front: &Arc<Front<S>>,
    lane: &Lane,
    team: &str,
    target: Target,
    request: Request,
) -> Result<Dialed, Refused> {
    let mut request = request;
    if let Some(mut sender) = lane.kept(target.port).await {
        match sender.try_send_request(request).await {
            Ok(response) => return Ok(Dialed::Sent(Sent { response, sender })),
            Err(mut error) => match error.take_message() {
                Some(unsent) => request = unsent,
                None => {
                    return Err(Refused::new(
                        502,
                        format!(
                            "the sandbox's port {} failed: {}",
                            target.port,
                            error.into_error()
                        ),
                    ));
                }
            },
        }
    }
    // The lifecycle was read before the connect, which may take long enough
    // for a pause on another replica to complete, and then wake the sandbox
    // again. So however it ends, the pause is fenced against it at once,
    // and nothing is forwarded unless the sandbox still runs.
    let dialed = dial(front, team, target).await;
    let running = ops::fence_wake(front, target.id).await?;
    let mut sender = match dialed? {
        Dial::Open(sender) => sender,
        Dial::Closed => return Ok(Dialed::PortClosed),
        Dial::EnvdNotUp => return Ok(Dialed::NotRunning),
    };
    if !running {
        return Ok(Dialed::NotRunning);
    }
    let response = sender.send_request(request).await.map_err(|error| {
        Refused::new(
            502,
            format!("the sandbox's port {} failed: {error}", target.port),
        )
    })?;
    Ok(Dialed::Sent(Sent { response, sender }))
}

/// What opening a stream to a guest port came to.
enum Dial {
    Open(SendRequest<Body>),
    /// Nothing listens there.
    Closed,
    /// envd starts again and takes no stream until it has the sandbox's
    /// token: as for a sandbox still changing state, the caller retries.
    EnvdNotUp,
}

/// Opens a stream to the guest port.
async fn dial<S: Store>(front: &Front<S>, team: &str, target: Target) -> Result<Dial, Refused> {
    let reached = front
        .service
        .connect(team, target.id, GATEWAY_PORT, PriorityName::Interactive)
        .await?;
    let mut stream = reached.answered.stream;
    let answer = tokio::time::timeout(DIAL_WITHIN, async {
        stream
            .get_mut()
            .write_all(format!("tcp {}\n", target.port).as_bytes())
            .await?;
        stream.get_mut().flush().await?;
        let mut line = String::new();
        (&mut stream).take(512).read_line(&mut line).await?;
        Ok::<_, std::io::Error>(line)
    })
    .await
    .map_err(|_| Refused::new(502, "the sandbox's gateway did not answer in time"))?
    .map_err(|error| Refused::new(502, format!("reaching the sandbox's gateway: {error}")))?;
    let answer = answer.trim_end();
    if answer.strip_prefix("error ") == Some(gateway::ENVD_NOT_UP) {
        return Ok(Dial::EnvdNotUp);
    }
    if answer != "ok" {
        tracing::debug!(id = %target.id, port = target.port, answer, "a guest port refused");
        return Ok(Dial::Closed);
    }
    let (sender, connection) = http1::handshake(TokioIo::new(stream))
        .await
        .map_err(|error| Refused::new(502, format!("the sandbox's port: {error}")))?;
    tokio::spawn(async move {
        if let Err(error) = connection.with_upgrades().await {
            tracing::debug!(%error, "a stream to a guest port ended");
        }
    });
    Ok(Dial::Open(sender))
}

/// A stream to give back once the response it carries is read.
struct Keep {
    lane: Arc<Lane>,
    port: u16,
    sender: SendRequest<Body>,
    cuts: u64,
}

/// A response body on its way to the caller.
struct Carried {
    incoming: Incoming,
    cut: watch::Receiver<u64>,
    kept: Option<Keep>,
    _open: Option<Open>,
    done: bool,
}

impl Carried {
    /// Keeps the stream for the next request, its response all read.
    fn give_back(&mut self) {
        if let Some(keep) = self.kept.take() {
            keep.lane.keep(keep.port, keep.sender, keep.cuts);
        }
    }

    async fn next(mut self) -> Option<(Result<Frame<Bytes>, std::io::Error>, Self)> {
        if self.done {
            return None;
        }
        tokio::select! {
            biased;
            _ = self.cut.changed() => {
                self.done = true;
                self.kept = None;
                Some((Err(std::io::Error::other("the sandbox paused or ended")), self))
            }
            frame = self.incoming.frame() => match frame {
                None => {
                    self.give_back();
                    None
                }
                Some(Ok(frame)) => {
                    // A caller that knows the length stops reading at its
                    // end, so the stream goes back as soon as it is read.
                    if self.incoming.is_end_stream() {
                        self.give_back();
                        self.done = true;
                    }
                    Some((Ok(frame), self))
                }
                Some(Err(error)) => {
                    self.done = true;
                    self.kept = None;
                    Some((Err(std::io::Error::other(error)), self))
                }
            },
        }
    }
}

/// An open Connect stream: while any is, the sandbox is held awake.
struct Open {
    lane: Arc<Lane>,
}

impl Open {
    fn new<S: Store>(front: &Arc<Front<S>>, lane: &Arc<Lane>, team: &str, id: Id) -> Self {
        lane.streams.send_modify(|open| *open += 1);
        if !lane.holding.swap(true, Ordering::AcqRel) {
            tokio::spawn(hold(
                Arc::clone(front),
                Arc::clone(lane),
                team.to_owned(),
                id,
            ));
        }
        Self {
            lane: Arc::clone(lane),
        }
    }
}

impl Drop for Open {
    fn drop(&mut self) {
        self.lane
            .streams
            .send_modify(|open| *open = open.saturating_sub(1));
    }
}

/// Holds a sandbox awake while its lane has open streams and it runs;
/// releases it soon after the last one ends.
async fn hold<S: Store>(front: Arc<Front<S>>, lane: Arc<Lane>, team: String, id: Id) {
    let mut open = lane.streams.subscribe();
    let mut held = false;
    let mut next = Instant::now();
    loop {
        if *open.borrow_and_update() == 0 {
            tokio::time::sleep(HOLD_GRACE).await;
            if *open.borrow_and_update() == 0 {
                if held
                    && let Err(failure) =
                        front.service.release(&team, id, front.stream_hold()).await
                {
                    tracing::debug!(%id, %failure, "releasing a stream hold");
                }
                held = false;
                lane.holding.store(false, Ordering::Release);
                // A stream that opened just now found the flag still set,
                // so this task goes on for it.
                if *lane.streams.borrow() == 0 || lane.holding.swap(true, Ordering::AcqRel) {
                    return;
                }
                next = Instant::now();
            }
        }
        if Instant::now() >= next {
            next = Instant::now() + HOLD_EVERY;
            let running = matches!(
                front.store().lifecycle(id).await,
                Ok(Some(row)) if row.record.state == State::Running
            );
            if running {
                // A hold wakes the sandbox, so it is fenced like a connect.
                let holding = front
                    .service
                    .hold(&team, id, front.stream_hold(), Some(HOLD_TTL))
                    .await;
                let still = ops::fence_wake(&front, id).await.unwrap_or(false);
                match holding {
                    Ok(()) => held = true,
                    Err(failure) => {
                        tracing::debug!(%id, %failure, "holding a sandbox for its streams");
                    }
                }
                // Paused meanwhile: its streams are cut, and the hold
                // would keep the pause from saving it.
                if held && !still {
                    if let Err(failure) =
                        front.service.release(&team, id, front.stream_hold()).await
                    {
                        tracing::debug!(%id, %failure, "releasing a stream hold after a pause");
                    }
                    held = false;
                }
            }
        }
        tokio::select! {
            () = tokio::time::sleep_until(next) => {}
            _ = open.changed() => {}
        }
    }
}
