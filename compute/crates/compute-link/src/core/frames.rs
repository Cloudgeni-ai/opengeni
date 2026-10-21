//! What the host does for each frame a gateway sends.

use bytes::Bytes;
use compute_protocol::link::{Ending, GatewayFrame, HostFrame, Refusal, Relay};

use super::conns::relay_delivery;
use super::{ConnId, Core, Effect, LinkId, Queued, Session, Target};
use crate::nats::{Delivery, ServerOp};

impl Core {
    pub(super) fn gateway(
        &mut self,
        now: u64,
        link_id: LinkId,
        frame: GatewayFrame,
        payload: Bytes,
    ) {
        let Some(gateway) = self.link_ids.get(&link_id) else {
            return;
        };
        let link = &self.links[gateway];
        let s = match &frame {
            GatewayFrame::Hello { .. } => {
                tracing::warn!(%gateway, "a gateway said hello again; ignored");
                return;
            }
            GatewayFrame::Opened { s, .. }
            | GatewayFrame::Refused { s, .. }
            | GatewayFrame::Msg { s, .. }
            | GatewayFrame::Relay { s, .. }
            | GatewayFrame::Closed { s, .. }
            | GatewayFrame::Error { s, .. } => *s,
        };
        // A frame for a session the host already ended is stale.
        let Some(id) = link.sessions.get(&s).cloned() else {
            return;
        };
        match frame {
            GatewayFrame::Hello { .. } => {}
            GatewayFrame::Opened { s, scope, relay } => {
                self.opened(now, &id, link_id, s, scope, relay);
            }
            GatewayFrame::Refused { code, message, .. } => self.refused(now, &id, code, &message),
            GatewayFrame::Msg {
                sid,
                subject,
                reply,
                headers,
                ..
            } => self.message(
                now,
                &id,
                Queued {
                    sid,
                    at: now,
                    subject,
                    reply,
                    headers,
                    payload,
                },
            ),
            GatewayFrame::Relay { relay, .. } => self.set_relay(&id, relay),
            GatewayFrame::Closed { code, message, .. } => self.closed(now, &id, code, &message),
            GatewayFrame::Error {
                code, message, sid, ..
            } => self.refused_op(&id, &code, &message, sid),
        }
    }

    pub(super) fn opened(
        &mut self,
        now: u64,
        id: &str,
        link_id: LinkId,
        s: u32,
        scope: String,
        relay: Relay,
    ) {
        let Some(sandbox) = self.sandboxes.get_mut(id) else {
            return;
        };
        if sandbox.session != (Session::Opening { link: link_id, s }) {
            return;
        }
        let instance = sandbox.instance.as_deref().unwrap_or_default();
        if scope
            .rsplit_once(".connection.")
            .is_none_or(|(_, rest)| rest != instance)
        {
            tracing::error!(sandbox = id, %scope, "a gateway opened a session under another instance's scope");
            self.end_session(id);
            self.schedule_retry(now, id);
            return;
        }
        sandbox.session = Session::Open {
            link: link_id,
            s,
            scope,
        };
        sandbox.retry_delay = self.settings.retry_min_ms;
        for (sid, sub) in &sandbox.subs {
            self.effects.push(Effect::Frame {
                link: link_id,
                frame: HostFrame::Sub {
                    s,
                    sid: *sid,
                    subject: sub.subject.clone(),
                    queue: sub.queue.clone(),
                },
                payload: Bytes::new(),
            });
        }
        if let Some(state) = sandbox.running {
            self.effects.push(Effect::Frame {
                link: link_id,
                frame: HostFrame::State { s, state },
                payload: Bytes::new(),
            });
        }
        let conns: Vec<ConnId> = sandbox.conns.iter().copied().collect();
        self.set_relay(id, relay);
        for conn in conns {
            self.ready(now, conn);
        }
    }

    pub(super) fn refused(&mut self, now: u64, id: &str, code: Refusal, message: &str) {
        let Some(sandbox) = self.sandboxes.get_mut(id) else {
            return;
        };
        if let Some((link_id, s)) = sandbox.session.on()
            && let Some(link) = self.links.get_mut(&sandbox.gateway)
            && link.id == Some(link_id)
        {
            link.sessions.remove(&s);
        }
        sandbox.session = Session::Idle;
        if code.transient() {
            tracing::info!(
                sandbox = id,
                ?code,
                message,
                "a gateway did not open a session yet"
            );
            self.schedule_retry(now, id);
        } else {
            tracing::warn!(sandbox = id, ?code, message, "a gateway refused a session");
            sandbox.refused = true;
            self.close_sandbox_conns(now, id, Some("Authorization Violation"));
        }
    }

    pub(super) fn closed(&mut self, now: u64, id: &str, code: Ending, message: &str) {
        let Some(sandbox) = self.sandboxes.get_mut(id) else {
            return;
        };
        if let Some((link_id, s)) = sandbox.session.on()
            && let Some(link) = self.links.get_mut(&sandbox.gateway)
            && link.id == Some(link_id)
        {
            link.sessions.remove(&s);
        }
        sandbox.session = Session::Idle;
        match code {
            Ending::Revoked | Ending::Superseded => {
                tracing::warn!(sandbox = id, ?code, message, "a gateway ended a session");
                sandbox.refused = true;
                // What waits goes, and is owed nothing; what its agent got
                // it may still answer, once a new ticket opens a session.
                sandbox.waiting.clear();
            }
            Ending::Lost | Ending::Other => {
                tracing::info!(
                    sandbox = id,
                    ?code,
                    message,
                    "a gateway ended a session; opening it again"
                );
                self.schedule_retry(now, id);
            }
        }
        // Its agent connects again, to a session that is open, or not at
        // all.
        self.close_sandbox_conns(now, id, Some("Session Ended"));
    }

    /// The gateway refused one operation: a subscription, told to the
    /// connection that holds it, if one does, or another, told to every
    /// connection, as the gateway does not say which one sent it.
    pub(super) fn refused_op(&mut self, id: &str, code: &str, message: &str, sid: Option<u32>) {
        tracing::info!(
            sandbox = id,
            code,
            message,
            ?sid,
            "a gateway refused an operation"
        );
        let Some(sandbox) = self.sandboxes.get(id) else {
            return;
        };
        if let Some((sid, sub)) = sid.and_then(|sid| sandbox.subs.get(&sid).map(|sub| (sid, sub))) {
            let text = format!(
                "Permissions Violation for Subscription to \"{}\"",
                sub.subject
            );
            let holder = sub.guest.as_ref().map(|(conn, _)| *conn);
            self.remove_sub(id, sid, false);
            self.save(id);
            if let Some(conn) = holder {
                self.send(conn, ServerOp::Err(text));
            }
        } else {
            let conns: Vec<ConnId> = sandbox.conns.iter().copied().collect();
            for conn in conns {
                self.send(conn, ServerOp::Err(message.to_owned()));
            }
        }
    }

    pub(super) fn message(&mut self, now: u64, id: &str, queued: Queued) {
        if queued.quiet() {
            self.quiet_request(now, id, queued);
            return;
        }
        if queued.reply.is_some() {
            self.asked(now, id);
        }
        let Some(sandbox) = self.sandboxes.get_mut(id) else {
            return;
        };
        let Some(sub) = sandbox.subs.get(&queued.sid) else {
            return;
        };
        let open = matches!(sandbox.session, Session::Open { .. });
        if open && sub.guest.is_some() {
            self.deliver(now, id, queued);
        } else if !sandbox.waiting.push(queued, &self.settings) && !sandbox.waiting.dropping {
            sandbox.waiting.dropping = true;
            tracing::warn!(
                sandbox = id,
                waiting = sandbox.waiting.messages.len(),
                bytes = sandbox.waiting.bytes,
                "messages for an agent that is not connected are dropped: as many wait as the host keeps"
            );
        }
    }

    /// Sends a message to the connection that holds its subscription: a
    /// request delivered is owed an answer, and a no-wake one is answered
    /// by the host if its sandbox sleeps first.
    pub(super) fn deliver(&mut self, now: u64, id: &str, queued: Queued) {
        let quiet = queued.quiet();
        let Some(sandbox) = self.sandboxes.get_mut(id) else {
            return;
        };
        let Some(sub) = sandbox.subs.get_mut(&queued.sid) else {
            return;
        };
        let Some((conn, guest)) = sub.guest.clone() else {
            return;
        };
        sub.delivered += 1;
        let done = sub.max.is_some_and(|max| sub.delivered >= max);
        let asked = queued.reply.clone().map(|reply| (reply, queued.at));
        self.send(
            conn,
            ServerOp::Msg(Delivery {
                subject: queued.subject,
                sid: guest,
                reply: queued.reply,
                headers: queued.headers,
                payload: queued.payload,
            }),
        );
        if done {
            self.remove_sub(id, queued.sid, true);
            self.save(id);
        }
        match asked {
            Some((reply, at)) if quiet => {
                if let Some(sandbox) = self.sandboxes.get_mut(id) {
                    sandbox.quiet.insert(reply, at);
                }
            }
            Some((reply, at)) => self.owes(now, at, id, reply),
            None => {}
        }
    }

    pub(super) fn set_relay(&mut self, id: &str, relay: Relay) {
        let Some(sandbox) = self.sandboxes.get_mut(id) else {
            return;
        };
        let payload = Bytes::from(serde_json::to_vec(&relay).unwrap_or_default());
        sandbox.relay = Some(relay);
        let sids: Vec<(ConnId, String)> = sandbox
            .conns
            .iter()
            .filter_map(|conn| self.conns.get(conn).map(|state| (*conn, state)))
            .flat_map(|(conn, state)| {
                state
                    .sids
                    .iter()
                    .filter(|(_, target)| **target == Target::Relay)
                    .map(move |(sid, _)| (conn, sid.clone()))
            })
            .collect();
        for (conn, sid) in sids {
            self.send(conn, relay_delivery(sid, payload.clone()));
        }
    }
}
