//! The leader: one replica at a time, holding the store's lock, gives up on
//! hosts whose renewals stopped and sizes the host group.
//!
//! It watches each host's renewal count on its own monotonic clock and
//! gives up on a host once the count stood still for the term plus the
//! margin ([`compute_fleet::Expiry`]). Giving up is conditional on the
//! count it watched, so a renewal accepted meanwhile saves the host, and a
//! second leader, which can only happen while the first has not yet seen
//! it lost the lock, is as safe as one. A new leader starts with nothing
//! seen and so waits a whole term and margin before giving up on anyone.

use std::sync::Arc;
use std::time::{Duration, Instant};

use compute_fleet::{At, Expiry, LeaseTerms, ScaleDecision, ScalePolicy};

use crate::group::GcpGroup;
use crate::store::Store;
use crate::view::View;

/// How often the leader looks at renewal counts.
const EVERY: Duration = Duration::from_millis(250);
/// How often a replica that does not lead tries to.
const TRY_EVERY: Duration = Duration::from_secs(1);

/// How the leader sizes a host group.
#[derive(Debug)]
pub struct Scaling {
    pub group: GcpGroup,
    pub policy: ScalePolicy,
    /// How often it looks.
    pub every: Duration,
}

/// Leads whenever no other replica does, for as long as it runs.
pub async fn lead<S: Store>(
    store: Arc<S>,
    view: Arc<View>,
    terms: LeaseTerms,
    scaling: Option<Scaling>,
) {
    let origin = Instant::now();
    loop {
        let lead = match store.try_lead().await {
            Ok(Some(lead)) => lead,
            Ok(None) => {
                tokio::time::sleep(TRY_EVERY).await;
                continue;
            }
            Err(error) => {
                tracing::warn!(%error, "trying to lead failed");
                tokio::time::sleep(TRY_EVERY).await;
                continue;
            }
        };
        tracing::info!("this replica leads");
        led(&*store, &view, terms, scaling.as_ref(), lead, origin).await;
        tracing::warn!("this replica no longer leads");
    }
}

async fn led<S: Store>(
    store: &S,
    view: &View,
    terms: LeaseTerms,
    scaling: Option<&Scaling>,
    mut lead: S::Lead,
    origin: Instant,
) {
    let mut expiry = Expiry::new(terms);
    let mut tick = tokio::time::interval(EVERY);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut scaled: Option<Instant> = None;
    loop {
        tick.tick().await;
        if !store.leads(&mut lead).await {
            return;
        }
        let now = At::from_duration(origin.elapsed());
        give_up_on_lapsed(store, &mut expiry, now).await;
        if let Some(scaling) = scaling
            && scaled.is_none_or(|when| when.elapsed() >= scaling.every)
        {
            scaled = Some(Instant::now());
            if let Err(error) = scale(scaling, view).await {
                tracing::warn!(%error, "sizing the host group failed");
            }
        }
    }
}

/// Gives up on every host whose renewal count stood still too long.
pub async fn give_up_on_lapsed<S: Store>(store: &S, expiry: &mut Expiry, now: At) {
    match store.renewals().await {
        Ok(renewals) => {
            for (host, count) in renewals {
                expiry.observe(host, count, now);
            }
        }
        Err(error) => {
            // Seen nothing new: a host is given up on only once the store
            // shows again that its count stood still.
            tracing::warn!(%error, "reading renewal counts failed");
            return;
        }
    }
    let lapsed: Vec<_> = expiry.expired(now).collect();
    for (host, renewals) in lapsed {
        match store.give_up(host, renewals).await {
            Ok(given_up) => {
                // Either way it starts afresh: a host that renewed is
                // watched again from its new count, and one already given
                // up on is no longer listed.
                expiry.forget(host);
                if let Some(sandboxes) = given_up {
                    tracing::warn!(host = host.0, sandboxes, "gave up on a host");
                }
            }
            Err(error) => tracing::warn!(%error, host = host.0, "giving up on a host failed"),
        }
    }
}

/// Grows the group if its spare memory would run short.
async fn scale(scaling: &Scaling, view: &View) -> anyhow::Result<()> {
    let described = scaling.group.describe().await?;
    let prefix = format!("{}-", described.base_instance_name);
    let mut seen = view.group(|name| name.starts_with(&prefix));
    seen.booting = described
        .target_size
        .saturating_sub(seen.hosts + seen.draining);
    match scaling.policy.decide(&seen) {
        ScaleDecision::Grow { to } if to > described.target_size => {
            tracing::info!(
                from = described.target_size,
                to,
                free_mib = seen.free_memory_mib,
                "growing the host group"
            );
            scaling.group.resize(to).await?;
        }
        ScaleDecision::Shrink => {
            tracing::info!(
                "the host group has more spare than it needs; drain a host to shrink it"
            );
        }
        ScaleDecision::Grow { .. } | ScaleDecision::Hold => {}
    }
    Ok(())
}
