//! What the host does for each guest connection and each operation its agent sends.

use std::collections::{HashMap, VecDeque};

use bytes::Bytes;
use compute_protocol::link::{HostFrame, RELAY_SUBJECT, may_publish, may_subscribe};

use super::{CONNECTION_NAME, Conn, ConnId, Core, Effect, Queued, Session, Stage, Sub, Target};
use crate::nats::{ClientOp, Connect, Delivery, Info, Publish, ServerOp, is_token};

impl Core {
    pub(super) fn send(&mut self, conn: ConnId, op: ServerOp) {
        self.effects.push(Effect::ToGuest { conn, op });
    }

    pub(super) fn accepted(&mut self, conn: ConnId, id: String) {
        let Some(sandbox) = self.sandboxes.get(&id) else {
            self.effects.push(Effect::CloseGuest { conn });
            return;
        };
        let max_payload = self
            .links
            .get(&sandbox.gateway)
            .filter(|link| link.id.is_some())
            .map(|link| link.max_payload);
        self.conns.insert(
            conn,
            Conn {
                sandbox: id,
                stage: Stage::AwaitInfo,
                verbose: false,
                pending: Vec::new(),
                pending_bytes: 0,
                sids: HashMap::new(),
            },
        );
        if let Some(max_payload) = max_payload {
            self.send_info(conn, max_payload);
        }
    }

    pub(super) fn send_info(&mut self, conn: ConnId, max_payload: u32) {
        if let Some(state) = self.conns.get_mut(&conn) {
            state.stage = Stage::AwaitConnect;
            self.send(conn, ServerOp::Info(Info::new(max_payload, conn)));
        }
    }

    /// Ends a connection, sending `error` first if given.
    pub(super) fn close_conn(&mut self, conn: ConnId, error: Option<&str>) {
        if !self.conns.contains_key(&conn) {
            return;
        }
        if let Some(error) = error {
            self.send(conn, ServerOp::Err(error.to_owned()));
        }
        self.effects.push(Effect::CloseGuest { conn });
        self.drop_conn(conn);
    }

    pub(super) fn close_sandbox_conn(&mut self, id: &str, error: Option<&str>) {
        if let Some(conn) = self.sandboxes.get(id).and_then(|sandbox| sandbox.conn) {
            self.close_conn(conn, error);
        }
    }

    /// Forgets a connection that ended.
    pub(super) fn drop_conn(&mut self, conn: ConnId) {
        let Some(state) = self.conns.remove(&conn) else {
            return;
        };
        if let Some(sandbox) = self.sandboxes.get_mut(&state.sandbox)
            && sandbox.conn == Some(conn)
        {
            sandbox.conn = None;
            sandbox.grace_until = None;
            for sub in sandbox.subs.values_mut() {
                sub.guest = None;
            }
        }
    }

    pub(super) fn guest(&mut self, now: u64, conn: ConnId, op: ClientOp) {
        let Some(stage) = self.conns.get(&conn).map(|state| state.stage) else {
            return;
        };
        match (stage, op) {
            (Stage::AwaitInfo, _) => self.close_conn(conn, Some("Protocol Error")),
            (Stage::AwaitConnect, ClientOp::Connect(connect)) => self.connect(now, conn, &connect),
            (Stage::AwaitConnect, _) => self.close_conn(conn, Some("Authorization Violation")),
            (Stage::Connected, ClientOp::Pong) => {}
            (Stage::Connected, op) if self.scope_of(conn).is_some() => self.operate(conn, op),
            (Stage::Connected, op) => self.hold(conn, op),
        }
    }

    /// Keeps what a connection sent before its session opened.
    pub(super) fn hold(&mut self, conn: ConnId, op: ClientOp) {
        let limit = self.settings.pending_bytes;
        let Some(state) = self.conns.get_mut(&conn) else {
            return;
        };
        state.pending_bytes += match &op {
            ClientOp::Pub(publish) => publish.size(),
            _ => 64,
        };
        state.pending.push(op);
        if state.pending_bytes > limit {
            self.close_conn(conn, Some("Slow Consumer"));
        }
    }

    pub(super) fn connect(&mut self, now: u64, conn: ConnId, connect: &Connect) {
        let Some(instance) = connect
            .name
            .as_deref()
            .and_then(|name| name.strip_prefix(CONNECTION_NAME))
            .filter(|instance| is_token(instance))
            .map(str::to_owned)
        else {
            self.close_conn(conn, Some("Authorization Violation"));
            return;
        };
        let Some(state) = self.conns.get_mut(&conn) else {
            return;
        };
        state.stage = Stage::Connected;
        state.verbose = connect.verbose;
        let id = state.sandbox.clone();
        if connect.verbose {
            self.send(conn, ServerOp::Ok);
        }
        let Some(sandbox) = self.sandboxes.get(&id) else {
            return;
        };
        if sandbox.instance.as_deref() == Some(instance.as_str()) {
            // The same agent again: it takes up the session.
            if let Some(old) = sandbox.conn {
                self.close_conn(old, None);
            }
        } else {
            // Another agent process: a new session.
            self.end_session(&id);
            self.close_sandbox_conn(&id, None);
            let sandbox = self.sandboxes.get_mut(&id).expect("checked above");
            sandbox.instance = Some(instance);
            sandbox.subs.clear();
            sandbox.next_sid = 1;
            sandbox.queued.clear();
            sandbox.relay = None;
            sandbox.retry_at = None;
            sandbox.retry_delay = self.settings.retry_min_ms;
            self.save(&id);
        }
        let sandbox = self.sandboxes.get_mut(&id).expect("checked above");
        sandbox.conn = Some(conn);
        if sandbox.refused {
            self.close_conn(conn, Some("Authorization Violation"));
            return;
        }
        if matches!(sandbox.session, Session::Open { .. }) {
            self.ready(now, conn);
        } else {
            self.try_open(now, &id);
        }
    }

    /// The scope of the session `conn` holds, once it is open.
    pub(super) fn scope_of(&self, conn: ConnId) -> Option<&str> {
        let state = self.conns.get(&conn)?;
        let sandbox = self.sandboxes.get(&state.sandbox)?;
        match &sandbox.session {
            Session::Open { scope, .. } if sandbox.conn == Some(conn) => Some(scope),
            _ => None,
        }
    }

    /// `conn`'s session opened: it does what it sent meanwhile, its pings
    /// answered in turn.
    pub(super) fn ready(&mut self, now: u64, conn: ConnId) {
        let Some(state) = self.conns.get_mut(&conn) else {
            return;
        };
        let pending = std::mem::take(&mut state.pending);
        state.pending_bytes = 0;
        let id = state.sandbox.clone();
        for op in pending {
            if !self.conns.contains_key(&conn) {
                return;
            }
            self.operate(conn, op);
        }
        let grace = self.settings.grace_ms;
        if let Some(sandbox) = self.sandboxes.get_mut(&id)
            && sandbox.conn == Some(conn)
            && sandbox.subs.values().any(|sub| sub.guest.is_none())
        {
            sandbox.grace_until = Some(now + grace);
        }
    }

    /// Does what a connection whose session is open asked.
    pub(super) fn operate(&mut self, conn: ConnId, op: ClientOp) {
        match op {
            ClientOp::Ping => self.send(conn, ServerOp::Pong),
            ClientOp::Pong => {}
            ClientOp::Connect(_) => self.close_conn(conn, Some("Protocol Error")),
            ClientOp::Sub {
                subject,
                queue,
                sid,
            } => self.subscribe(conn, subject, queue, sid),
            ClientOp::Unsub { sid, max } => self.unsubscribe(conn, &sid, max),
            ClientOp::Pub(publish) => self.publish(conn, publish),
        }
    }

    pub(super) fn ok(&mut self, conn: ConnId) {
        if self.conns.get(&conn).is_some_and(|state| state.verbose) {
            self.send(conn, ServerOp::Ok);
        }
    }

    pub(super) fn subscribe(
        &mut self,
        conn: ConnId,
        subject: String,
        queue: Option<String>,
        guest: String,
    ) {
        let Some(state) = self.conns.get(&conn) else {
            return;
        };
        let id = state.sandbox.clone();
        if state.sids.contains_key(&guest) {
            // A sid used again replaces its subscription.
            self.unsubscribe(conn, &guest, None);
        }
        if subject == RELAY_SUBJECT {
            let relay = self
                .sandboxes
                .get(&id)
                .and_then(|sandbox| sandbox.relay.clone());
            if let Some(state) = self.conns.get_mut(&conn) {
                state.sids.insert(guest.clone(), Target::Relay);
            }
            self.ok(conn);
            if let Some(relay) = relay {
                let payload = Bytes::from(serde_json::to_vec(&relay).unwrap_or_default());
                self.send(conn, relay_delivery(guest, payload));
            }
            return;
        }
        let Some(scope) = self.scope_of(conn) else {
            return;
        };
        if !may_subscribe(scope, &subject) {
            self.send(
                conn,
                ServerOp::Err(format!(
                    "Permissions Violation for Subscription to \"{subject}\""
                )),
            );
            return;
        }
        let sandbox = self.sandboxes.get_mut(&id).expect("a scope has a sandbox");
        let taken = sandbox
            .subs
            .iter_mut()
            .find(|(_, sub)| sub.guest.is_none() && sub.subject == subject && sub.queue == queue);
        let sid = if let Some((sid, sub)) = taken {
            sub.guest = Some(guest.clone());
            sub.delivered = 0;
            sub.max = None;
            *sid
        } else {
            let sid = sandbox.next_sid;
            sandbox.next_sid += 1;
            sandbox.subs.insert(
                sid,
                Sub {
                    subject: subject.clone(),
                    queue: queue.clone(),
                    guest: Some(guest.clone()),
                    delivered: 0,
                    max: None,
                },
            );
            if let Some((link, s)) = sandbox.session.on() {
                self.effects.push(Effect::Frame {
                    link,
                    frame: HostFrame::Sub {
                        s,
                        sid,
                        subject,
                        queue,
                    },
                    payload: Bytes::new(),
                });
            }
            self.save(&id);
            sid
        };
        let sandbox = self.sandboxes.get_mut(&id).expect("a scope has a sandbox");
        if sandbox.subs.values().all(|sub| sub.guest.is_some()) {
            sandbox.grace_until = None;
        }
        let (waiting, rest): (VecDeque<Queued>, VecDeque<Queued>) =
            std::mem::take(&mut sandbox.queued)
                .into_iter()
                .partition(|queued| queued.sid == sid);
        sandbox.queued = rest;
        if let Some(state) = self.conns.get_mut(&conn) {
            state.sids.insert(guest, Target::Host(sid));
        }
        self.ok(conn);
        for queued in waiting {
            self.deliver(&id, conn, queued);
        }
    }

    pub(super) fn unsubscribe(&mut self, conn: ConnId, guest: &str, max: Option<u64>) {
        let Some(state) = self.conns.get_mut(&conn) else {
            return;
        };
        let id = state.sandbox.clone();
        match state.sids.get(guest).copied() {
            None => {}
            Some(Target::Relay) => {
                state.sids.remove(guest);
            }
            Some(Target::Host(sid)) => {
                let sandbox = self
                    .sandboxes
                    .get_mut(&id)
                    .expect("a connection has a sandbox");
                if let (Some(max), Some(sub)) = (max, sandbox.subs.get_mut(&sid))
                    && sub.delivered < max
                {
                    sub.max = Some(max);
                } else {
                    self.remove_sub(&id, sid, true);
                    self.save(&id);
                }
            }
        }
        self.ok(conn);
    }

    pub(super) fn publish(&mut self, conn: ConnId, publish: Publish) {
        let Some(scope) = self.scope_of(conn) else {
            return;
        };
        if !may_publish(scope, &publish.subject) {
            let text = format!(
                "Permissions Violation for Publish to \"{}\"",
                publish.subject
            );
            self.send(conn, ServerOp::Err(text));
            return;
        }
        let id = &self.conns[&conn].sandbox;
        let sandbox = &self.sandboxes[id];
        let max_payload = self
            .links
            .get(&sandbox.gateway)
            .map_or(0, |link| link.max_payload);
        if publish.size() > max_payload as usize {
            self.close_conn(conn, Some("Maximum Payload Violation"));
            return;
        }
        let Some((link, s)) = sandbox.session.on() else {
            return;
        };
        self.effects.push(Effect::Frame {
            link,
            frame: HostFrame::Pub {
                s,
                subject: publish.subject,
                reply: publish.reply,
                headers: publish.headers,
            },
            payload: publish.payload,
        });
        self.ok(conn);
    }
}

pub(super) fn relay_delivery(sid: String, payload: Bytes) -> ServerOp {
    ServerOp::Msg(Delivery {
        subject: RELAY_SUBJECT.to_owned(),
        sid,
        reply: None,
        headers: None,
        payload,
    })
}
