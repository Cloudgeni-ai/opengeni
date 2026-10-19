//! The operation inventory a runner reports on its connections of a link.
//!
//! Opengeni settles commands without always reaching the process that runs
//! them: when another process takes the enrollment's connection, every
//! requester waiting on this process is answered and its background commands
//! are settled lost. And output Opengeni stored is released on the runner in
//! one answered exchange right where it was stored, which a crash can
//! interrupt. Only the runner knows what it still runs or retains, so it
//! reports that: on every connection, and again while the connection lasts
//! whenever it holds a completed op whose output nobody released for a while
//! (about a minute after completion, then with backoff, and only while it
//! holds such ops). Opengeni answers each page in that same exchange with the
//! ops to end, and collects completed output it has not stored yet. The
//! runner starts every exchange, so nothing about it ever reaches a runner
//! that is not talking, such as a sleeping compute sandbox.
//!
//! Each op carries the connection generation Opengeni dispatched its start
//! under (`OpStart.connection_generation`), stored at admission and never
//! inferred, so Opengeni can tell an op started before a takeover from one a
//! requester is still waiting on. 0 means an older Opengeni started it.
//!
//! Pure bookkeeping: the engine owns the registry and does the ending.

use std::collections::{BTreeSet, HashMap, HashSet};

use opengeni_agent_engine::OpId;
use opengeni_agent_proto::v1;

/// Operations per inventory page. A page stays far below any transport's
/// payload limit (an op id is a short subject token), and a runner holding
/// more simply sends more pages; every page is answered on its own.
pub const INVENTORY_PAGE_OPS: usize = 256;

/// How long a completed op's output may go unreleased before the runner
/// reports its inventory again, and the first re-report delay.
pub const INVENTORY_REREPORT_AFTER_MS: u64 = 60_000;

/// The longest delay between re-reports while unreleased output remains.
pub const INVENTORY_REREPORT_MAX_DELAY_MS: u64 = 10 * 60_000;

/// One op a link still runs or retains.
#[derive(Debug, Clone)]
pub struct LiveOp {
    /// The scoped registry id.
    pub op: OpId,
    /// The wire op id.
    pub wire: String,
    /// When it exited (engine clock), for a completed op with unreleased
    /// output; `None` while it runs.
    pub completed_at_ms: Option<u64>,
}

/// One report: its pages and the ones still unanswered.
#[derive(Debug)]
struct Report {
    id: u64,
    pages: Vec<v1::OperationInventory>,
    pending: BTreeSet<u32>,
}

/// The reporting state of one link's current connection.
#[derive(Debug)]
struct Link {
    /// The latest report on this connection; `None` until the first.
    report: Option<Report>,
    /// No re-report before this time (engine clock).
    next_rereport_at_ms: u64,
    /// The delay after the next re-report.
    rereport_delay_ms: u64,
}

/// The inventory state of one runner process.
#[derive(Debug, Default)]
pub struct Inventory {
    next_report_id: u64,
    /// Each link scope's current connection.
    links: HashMap<String, Link>,
    /// The connection generation each op was admitted under (nonzero only).
    generations: HashMap<OpId, u64>,
    /// Running operations Opengeni asked to end: dropped when they exit.
    stopping: HashSet<OpId>,
}

impl Inventory {
    /// A new connection of `scope`: its first report is due at once.
    pub fn begin_connection(&mut self, scope: &str) {
        self.links.insert(
            scope.to_string(),
            Link {
                report: None,
                next_rereport_at_ms: 0,
                rereport_delay_ms: INVENTORY_REREPORT_AFTER_MS,
            },
        );
    }

    /// Records the connection generation `op` was admitted under (from its
    /// OpStart, or carried from a predecessor process image). The first
    /// admission's generation stays; 0 (unknown) records nothing.
    pub fn note_started(&mut self, op: &OpId, generation: u64) {
        if generation > 0 {
            self.generations.entry(op.clone()).or_insert(generation);
        }
    }

    /// The connection generation `op` was admitted under, 0 when unknown.
    #[must_use]
    pub fn generation_of(&self, op: &OpId) -> u64 {
        self.generations.get(op).copied().unwrap_or(0)
    }

    /// The pages of `scope`'s inventory to send now (at `now_ms`, engine
    /// clock): the unanswered pages of its current report, or a new report
    /// when the connection has none yet, or when every page was answered, a
    /// completed op's output has gone unreleased for
    /// [`INVENTORY_REREPORT_AFTER_MS`] and the backoff has passed. `live`
    /// lists the scope's live ops; it is called only when a report may be
    /// built. Empty when the scope has no connection.
    pub fn pending_pages(
        &mut self,
        scope: &str,
        now_ms: u64,
        live: impl FnOnce() -> Vec<LiveOp>,
    ) -> Vec<v1::OperationInventory> {
        let Some(link) = self.links.get(scope) else {
            return Vec::new();
        };
        match &link.report {
            Some(report) if !report.pending.is_empty() => {
                return report
                    .pages
                    .iter()
                    .filter(|page| report.pending.contains(&page.page))
                    .cloned()
                    .collect();
            }
            Some(_) if now_ms < link.next_rereport_at_ms => return Vec::new(),
            _ => {}
        }
        let first = link.report.is_none();
        let live = live();
        self.prune(scope, &live);
        let link = self.links.get_mut(scope).expect("link checked above");
        if first {
            link.next_rereport_at_ms = now_ms.saturating_add(INVENTORY_REREPORT_AFTER_MS);
        } else {
            let unreleased = live.iter().any(|op| {
                op.completed_at_ms
                    .is_some_and(|at| now_ms.saturating_sub(at) >= INVENTORY_REREPORT_AFTER_MS)
            });
            if !unreleased {
                // Nothing waits on a release: the backoff starts over.
                link.rereport_delay_ms = INVENTORY_REREPORT_AFTER_MS;
                return Vec::new();
            }
            link.next_rereport_at_ms = now_ms.saturating_add(link.rereport_delay_ms);
            link.rereport_delay_ms = link
                .rereport_delay_ms
                .saturating_mul(2)
                .min(INVENTORY_REREPORT_MAX_DELAY_MS);
        }
        self.next_report_id += 1;
        let id = self.next_report_id;
        let operations: Vec<v1::InventoryOperation> = live
            .iter()
            .filter(|op| !self.stopping.contains(&op.op))
            .map(|op| v1::InventoryOperation {
                op_id: op.wire.clone(),
                connection_generation: self.generation_of(&op.op),
                complete: op.completed_at_ms.is_some(),
                completed_age_ms: op.completed_at_ms.map_or(0, |at| now_ms.saturating_sub(at)),
            })
            .collect();
        let chunks: Vec<Vec<v1::InventoryOperation>> = if operations.is_empty() {
            vec![Vec::new()]
        } else {
            operations
                .chunks(INVENTORY_PAGE_OPS)
                .map(<[v1::InventoryOperation]>::to_vec)
                .collect()
        };
        let count = u32::try_from(chunks.len()).unwrap_or(u32::MAX);
        let pages: Vec<v1::OperationInventory> = chunks
            .into_iter()
            .zip(0..count)
            .map(|(operations, page)| v1::OperationInventory {
                report_id: id,
                page,
                pages: count,
                operations,
            })
            .collect();
        let pending = pages.iter().map(|page| page.page).collect();
        let link = self.links.get_mut(scope).expect("link checked above");
        link.report = Some(Report {
            id,
            pages: pages.clone(),
            pending,
        });
        pages
    }

    /// Applies one answer for `scope`. Returns the wire ids to end, or `None`
    /// for an answer that is not for a pending page of the current report.
    /// Only ids that page reported are returned.
    pub fn answer(&mut self, scope: &str, ack: &v1::OperationInventoryAck) -> Option<Vec<String>> {
        let report = self.links.get_mut(scope)?.report.as_mut()?;
        if report.id != ack.report_id || !report.pending.remove(&ack.page) {
            return None;
        }
        let reported: HashSet<&str> = report
            .pages
            .iter()
            .find(|page| page.page == ack.page)
            .map(|page| {
                page.operations
                    .iter()
                    .map(|operation| operation.op_id.as_str())
                    .collect()
            })
            .unwrap_or_default();
        let mut seen = HashSet::new();
        Some(
            ack.end_op_ids
                .iter()
                .filter(|id| reported.contains(id.as_str()) && seen.insert(id.as_str()))
                .cloned()
                .collect(),
        )
    }

    /// Marks a running operation to be dropped when it exits.
    pub fn mark_stopping(&mut self, op: &OpId) {
        self.stopping.insert(op.clone());
    }

    /// Whether `op` was marked to be dropped at exit (clears the mark).
    pub fn take_stopping(&mut self, op: &OpId) -> bool {
        self.stopping.remove(op)
    }

    /// Forgets the bookkeeping of `scope`'s ops that are no longer live.
    fn prune(&mut self, scope: &str, live: &[LiveOp]) {
        let live: HashSet<&OpId> = live.iter().map(|op| &op.op).collect();
        let prefix = format!("{scope}:");
        let in_scope = |op: &OpId| op.as_str().starts_with(&prefix);
        self.generations
            .retain(|op, _| !in_scope(op) || live.contains(op));
        self.stopping
            .retain(|op| !in_scope(op) || live.contains(op));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_pages() -> Vec<v1::OperationInventory> {
        Vec::new()
    }

    fn running(scope: &str, wire: &str) -> LiveOp {
        LiveOp {
            op: OpId::new(format!("{scope}:{wire}")),
            wire: wire.to_string(),
            completed_at_ms: None,
        }
    }

    fn completed(scope: &str, wire: &str, at: u64) -> LiveOp {
        LiveOp {
            completed_at_ms: Some(at),
            ..running(scope, wire)
        }
    }

    fn ack(report_id: u64, page: u32, end: &[&str]) -> v1::OperationInventoryAck {
        v1::OperationInventoryAck {
            report_id,
            page,
            end_op_ids: end.iter().map(ToString::to_string).collect(),
        }
    }

    fn reported(pages: &[v1::OperationInventory]) -> Vec<(String, u64, bool, u64)> {
        pages
            .iter()
            .flat_map(|page| page.operations.iter())
            .map(|op| {
                (
                    op.op_id.clone(),
                    op.connection_generation,
                    op.complete,
                    op.completed_age_ms,
                )
            })
            .collect()
    }

    #[test]
    fn an_operation_reports_the_generation_it_was_admitted_under() {
        let mut inventory = Inventory::default();
        inventory.begin_connection("link");
        let early = running("link", "early");
        let older = running("link", "older");
        inventory.note_started(&early.op, 7);
        inventory.note_started(&older.op, 0);
        // A duplicate start under a later generation never rewrites it.
        inventory.note_started(&early.op, 9);
        let pages = inventory.pending_pages("link", 1_000, || {
            vec![early.clone(), older.clone(), completed("link", "done", 400)]
        });
        assert_eq!(
            reported(&pages),
            vec![
                ("early".to_string(), 7, false, 0),
                ("older".to_string(), 0, false, 0),
                ("done".to_string(), 0, true, 600),
            ]
        );
        // Nothing is learned from an answer: a lost answer leaves the
        // generation exactly as admitted.
        inventory.begin_connection("link");
        let pages = inventory.pending_pages("link", 2_000, || vec![early.clone()]);
        assert_eq!(reported(&pages), vec![("early".to_string(), 7, false, 0)]);
        assert_eq!(inventory.generation_of(&early.op), 7);
    }

    #[test]
    fn only_an_answer_for_a_pending_page_of_the_current_report_counts() {
        let mut inventory = Inventory::default();
        inventory.begin_connection("link");
        let ops: Vec<LiveOp> = (0..=INVENTORY_PAGE_OPS)
            .map(|n| running("link", &format!("op-{n}")))
            .collect();
        let pages = inventory.pending_pages("link", 0, || ops.clone());
        assert_eq!(pages.len(), 2, "one more op than a page holds");
        assert_eq!(pages[0].operations.len(), INVENTORY_PAGE_OPS);
        assert_eq!(pages[1].operations.len(), 1);
        let first = pages[0].report_id;
        assert!(pages
            .iter()
            .all(|page| page.pages == 2 && page.report_id == first));

        // A stale report, an unknown page, another scope: ignored.
        assert_eq!(
            inventory.answer("link", &ack(first + 1, 0, &["op-0"])),
            None
        );
        assert_eq!(inventory.answer("link", &ack(first, 5, &["op-0"])), None);
        assert_eq!(inventory.answer("other", &ack(first, 0, &["op-0"])), None);

        // An id the page did not report is never ended; duplicates once.
        let last = format!("op-{INVENTORY_PAGE_OPS}");
        assert_eq!(
            inventory.answer("link", &ack(first, 1, &[&last, &last, "op-0", "foreign"])),
            Some(vec![last.clone()])
        );
        assert_eq!(
            inventory.answer("link", &ack(first, 1, &[&last])),
            None,
            "answered once"
        );
        let pending = inventory.pending_pages("link", 0, || unreachable!("report pending"));
        assert_eq!(
            pending.iter().map(|page| page.page).collect::<Vec<_>>(),
            vec![0]
        );

        // A new connection starts a new report; the old one's answers no
        // longer count.
        inventory.begin_connection("link");
        assert_eq!(inventory.answer("link", &ack(first, 0, &["op-0"])), None);
        let pages = inventory.pending_pages("link", 0, Vec::new);
        assert_eq!(pages.len(), 1, "an empty report is one empty page");
        assert_eq!(pages[0].operations, Vec::<v1::InventoryOperation>::new());
        assert_ne!(pages[0].report_id, first);
        // A scope without a connection reports nothing.
        assert_eq!(
            inventory.pending_pages("other", 0, || unreachable!("no connection")),
            no_pages()
        );
    }

    #[test]
    fn unreleased_output_is_reported_again_with_backoff_and_only_while_it_remains() {
        let mut inventory = Inventory::default();
        inventory.begin_connection("link");
        let answer_all = |inventory: &mut Inventory, pages: &[v1::OperationInventory]| {
            for page in pages {
                assert_eq!(
                    inventory.answer("link", &ack(page.report_id, page.page, &[])),
                    Some(vec![])
                );
            }
        };
        let pages = inventory.pending_pages("link", 0, || vec![running("link", "job")]);
        answer_all(&mut inventory, &pages);

        // It completes at 10 s. Nothing is reported again until its output
        // has gone unreleased for a minute.
        let done = || vec![completed("link", "job", 10_000)];
        assert_eq!(inventory.pending_pages("link", 60_000, done), no_pages());
        assert_eq!(inventory.pending_pages("link", 69_999, done), no_pages());
        let again = inventory.pending_pages("link", 70_000, done);
        assert_eq!(reported(&again), vec![("job".to_string(), 0, true, 60_000)]);
        assert_ne!(again[0].report_id, pages[0].report_id);
        // Unanswered, the same pages repeat; answered, the backoff holds.
        let repeat = inventory.pending_pages("link", 71_000, || unreachable!("pending"));
        assert_eq!(repeat, again);
        answer_all(&mut inventory, &again);
        assert_eq!(inventory.pending_pages("link", 129_999, done), no_pages());
        let third = inventory.pending_pages("link", 130_000, done);
        assert_eq!(third.len(), 1);
        answer_all(&mut inventory, &third);
        assert_eq!(inventory.pending_pages("link", 249_999, done), no_pages());
        let fourth = inventory.pending_pages("link", 250_000, done);
        assert_eq!(fourth.len(), 1);
        answer_all(&mut inventory, &fourth);

        // The delay never exceeds its cap.
        let mut at = 250_000;
        for _ in 0..8 {
            at += INVENTORY_REREPORT_MAX_DELAY_MS;
            let pages = inventory.pending_pages("link", at, done);
            assert_eq!(pages.len(), 1, "re-reported within the cap at {at}");
            answer_all(&mut inventory, &pages);
        }

        // Released: nothing more is sent, however long the link lasts, and
        // the next unreleased output starts the backoff over.
        let idle = || vec![running("link", "other")];
        assert_eq!(
            inventory.pending_pages("link", at + 3_600_000, idle),
            no_pages()
        );
        let later = at + 3_600_000;
        let next = || vec![completed("link", "next", later)];
        assert_eq!(
            inventory.pending_pages("link", later + 59_999, next),
            no_pages()
        );
        let pages = inventory.pending_pages("link", later + 60_000, next);
        assert_eq!(pages.len(), 1);
        answer_all(&mut inventory, &pages);
        assert_eq!(
            inventory.pending_pages("link", later + 119_999, next),
            no_pages()
        );
        assert_eq!(
            inventory.pending_pages("link", later + 120_000, next).len(),
            1
        );
    }

    #[test]
    fn bookkeeping_follows_the_live_operations() {
        let mut inventory = Inventory::default();
        inventory.begin_connection("link");
        let gone = running("link", "gone");
        let stopping = running("link", "stopping");
        let other_scope = running("other", "kept");
        inventory.note_started(&gone.op, 3);
        inventory.note_started(&stopping.op, 3);
        inventory.note_started(&other_scope.op, 2);
        inventory.mark_stopping(&stopping.op);

        // Only "stopping" is still live: it is not reported (already being
        // ended), and "gone" is forgotten; the other scope is untouched.
        let pages = inventory.pending_pages("link", 0, || vec![stopping.clone()]);
        assert_eq!(pages[0].operations, Vec::<v1::InventoryOperation>::new());
        assert_eq!(inventory.generation_of(&gone.op), 0);
        assert_eq!(inventory.generation_of(&other_scope.op), 2);
        assert!(inventory.take_stopping(&stopping.op));
        assert!(!inventory.take_stopping(&stopping.op));

        // A scope id is matched whole, never as a prefix of another scope.
        let mut only_lin = Inventory::default();
        only_lin.begin_connection("lin");
        only_lin.note_started(&gone.op, 4);
        let _ = only_lin.pending_pages("lin", 0, Vec::new);
        assert_eq!(only_lin.generation_of(&gone.op), 4);
    }
}
