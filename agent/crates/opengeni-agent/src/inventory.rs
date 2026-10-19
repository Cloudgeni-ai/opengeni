//! The operation inventory a runner reports on every connection of a link,
//! and the connection generations it learns from the answers.
//!
//! Opengeni settles commands without always reaching the process that runs
//! them: when another process takes the enrollment's connection, every
//! requester waiting on this process is answered and its background commands
//! are settled lost. If this same process later holds the connection again, it
//! may still run or retain those operations, and only it knows which. So on
//! each connection it reports what it holds, and Opengeni answers, in the same
//! exchange, the ones it no longer recognises; the runner stops them.
//!
//! Each operation carries the connection generation of the connection it
//! started on (Opengeni increments it whenever a different process claims the
//! connection), so Opengeni can tell an operation started before a takeover
//! from one a requester is still waiting on. The runner learns the generation
//! from the first answer on a connection; operations that connection started
//! before that answer get it then, because a connection's generation never
//! changes while it lasts. An operation whose generation was never learned
//! reports 0, which Opengeni treats as current.
//!
//! Pure bookkeeping: the engine owns the registry and does the stopping.

use std::collections::{BTreeSet, HashMap, HashSet};

use opengeni_agent_engine::OpId;
use opengeni_agent_proto::v1;

/// Operations per inventory page. A page stays far below any transport's
/// payload limit (an op id is a short subject token), and a runner holding
/// more simply sends more pages; every page is answered on its own.
pub const INVENTORY_PAGE_OPS: usize = 256;

/// Where an operation's connection generation comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StartedOn {
    /// The local epoch of the connection it started on; the generation is
    /// known once that connection's report is answered.
    Epoch(u64),
    /// A generation carried from a predecessor process image.
    Generation(u64),
}

/// One connection's report: its pages and the ones still unanswered.
#[derive(Debug)]
struct Report {
    epoch: u64,
    pages: Vec<v1::OperationInventory>,
    pending: BTreeSet<u32>,
}

/// The inventory state of one runner process.
#[derive(Debug, Default)]
pub struct Inventory {
    next_epoch: u64,
    /// Each link scope's current connection epoch.
    current: HashMap<String, u64>,
    /// Each link scope's report for its current connection, once built.
    reports: HashMap<String, Report>,
    /// Learned connection generations, by local epoch.
    generations: HashMap<u64, u64>,
    /// Where each live operation started.
    started: HashMap<OpId, StartedOn>,
    /// Running operations Opengeni asked to stop: dropped when they exit.
    stopping: HashSet<OpId>,
}

impl Inventory {
    /// A new connection of `scope`: later operations of the scope start on
    /// it, and its report is built afresh. Returns its epoch (the report id).
    pub fn begin_connection(&mut self, scope: &str) -> u64 {
        self.next_epoch += 1;
        let epoch = self.next_epoch;
        self.current.insert(scope.to_string(), epoch);
        self.reports.remove(scope);
        epoch
    }

    /// Records that `op` (a scoped id) started on its scope's current
    /// connection. The scope is the longest current scope prefixing the id.
    pub fn note_started(&mut self, op: &OpId) {
        let epoch = self
            .current
            .iter()
            .filter(|(scope, _)| {
                op.as_str()
                    .strip_prefix(scope.as_str())
                    .is_some_and(|rest| rest.starts_with(':'))
            })
            .max_by_key(|(scope, _)| scope.len())
            .map(|(_, epoch)| *epoch);
        if let Some(epoch) = epoch {
            self.started.insert(op.clone(), StartedOn::Epoch(epoch));
        }
    }

    /// Records the generation a predecessor process image learned for `op`.
    pub fn note_handed_over(&mut self, op: &OpId, generation: u64) {
        if generation > 0 {
            self.started
                .insert(op.clone(), StartedOn::Generation(generation));
        }
    }

    /// The connection generation `op` started on, 0 when unknown.
    #[must_use]
    pub fn generation_of(&self, op: &OpId) -> u64 {
        match self.started.get(op) {
            Some(StartedOn::Generation(generation)) => *generation,
            Some(StartedOn::Epoch(epoch)) => self.generations.get(epoch).copied().unwrap_or(0),
            None => 0,
        }
    }

    /// The pages of `scope`'s report not yet answered. The report is built on
    /// first use for the current connection from `live`: the scope's live
    /// operations as (scoped id, wire id). Also forgets bookkeeping for
    /// operations no longer live. Empty when the scope has no connection.
    pub fn pending_pages(
        &mut self,
        scope: &str,
        live: impl FnOnce() -> Vec<(OpId, String)>,
    ) -> Vec<v1::OperationInventory> {
        let Some(&epoch) = self.current.get(scope) else {
            return Vec::new();
        };
        if self
            .reports
            .get(scope)
            .is_none_or(|report| report.epoch != epoch)
        {
            let live = live();
            self.prune(scope, &live);
            let operations: Vec<v1::InventoryOperation> = live
                .iter()
                .filter(|(op, _)| !self.stopping.contains(op))
                .map(|(op, wire)| v1::InventoryOperation {
                    op_id: wire.clone(),
                    connection_generation: self.generation_of(op),
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
            let pages = u32::try_from(chunks.len()).unwrap_or(u32::MAX);
            let pages: Vec<v1::OperationInventory> = chunks
                .into_iter()
                .zip(0..pages)
                .map(|(operations, page)| v1::OperationInventory {
                    report_id: epoch,
                    page,
                    pages,
                    operations,
                })
                .collect();
            let pending = pages.iter().map(|page| page.page).collect();
            self.reports.insert(
                scope.to_string(),
                Report {
                    epoch,
                    pages,
                    pending,
                },
            );
        }
        let report = &self.reports[scope];
        report
            .pages
            .iter()
            .filter(|page| report.pending.contains(&page.page))
            .cloned()
            .collect()
    }

    /// Applies one answer for `scope`. Returns the wire ids to stop, or
    /// `None` for an answer that is not for a pending page of the current
    /// connection's report. Only ids that page reported are returned.
    pub fn answer(&mut self, scope: &str, ack: &v1::OperationInventoryAck) -> Option<Vec<String>> {
        let epoch = *self.current.get(scope)?;
        if ack.report_id != epoch || ack.connection_generation == 0 {
            return None;
        }
        let report = self.reports.get_mut(scope)?;
        if report.epoch != epoch || !report.pending.remove(&ack.page) {
            return None;
        }
        self.generations.insert(epoch, ack.connection_generation);
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
            ack.stop_op_ids
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

    /// Forgets operations of `scope` that are no longer live, and generations
    /// no live operation or current connection refers to.
    fn prune(&mut self, scope: &str, live: &[(OpId, String)]) {
        let live: HashSet<&OpId> = live.iter().map(|(op, _)| op).collect();
        let prefix = format!("{scope}:");
        let in_scope = |op: &OpId| op.as_str().starts_with(&prefix);
        self.started
            .retain(|op, _| !in_scope(op) || live.contains(op));
        self.stopping
            .retain(|op| !in_scope(op) || live.contains(op));
        let referenced: HashSet<u64> = self
            .started
            .values()
            .filter_map(|started| match started {
                StartedOn::Epoch(epoch) => Some(*epoch),
                StartedOn::Generation(_) => None,
            })
            .chain(self.current.values().copied())
            .collect();
        self.generations
            .retain(|epoch, _| referenced.contains(epoch));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn op(scope: &str, wire: &str) -> (OpId, String) {
        (OpId::new(format!("{scope}:{wire}")), wire.to_string())
    }

    fn ack(report_id: u64, page: u32, generation: u64, stop: &[&str]) -> v1::OperationInventoryAck {
        v1::OperationInventoryAck {
            report_id,
            page,
            connection_generation: generation,
            stop_op_ids: stop.iter().map(ToString::to_string).collect(),
        }
    }

    #[test]
    fn an_operation_carries_the_generation_of_the_connection_it_started_on() {
        let mut inventory = Inventory::default();
        let first = inventory.begin_connection("link");
        let (early, _) = op("link", "early");
        inventory.note_started(&early);
        assert_eq!(inventory.generation_of(&early), 0, "unknown until answered");

        // The first answer gives every operation of that connection, even one
        // started before it, the connection's generation.
        let pages = inventory.pending_pages("link", || vec![op("link", "early")]);
        assert_eq!(pages.len(), 1);
        assert_eq!(pages[0].operations[0].connection_generation, 0);
        assert_eq!(
            inventory.answer("link", &ack(first, 0, 7, &[])),
            Some(vec![])
        );
        assert_eq!(inventory.generation_of(&early), 7);
        let (late, _) = op("link", "late");
        inventory.note_started(&late);
        assert_eq!(inventory.generation_of(&late), 7);

        // The next connection reports both with generation 7; a third op on
        // it is unknown until that connection's answer (here: generation 9).
        let second = inventory.begin_connection("link");
        let (third, _) = op("link", "third");
        inventory.note_started(&third);
        let pages = inventory.pending_pages("link", || {
            vec![op("link", "early"), op("link", "late"), op("link", "third")]
        });
        let reported: Vec<(String, u64)> = pages[0]
            .operations
            .iter()
            .map(|operation| (operation.op_id.clone(), operation.connection_generation))
            .collect();
        assert_eq!(
            reported,
            vec![
                ("early".to_string(), 7),
                ("late".to_string(), 7),
                ("third".to_string(), 0)
            ]
        );
        assert_eq!(
            inventory.answer("link", &ack(second, 0, 9, &["early"])),
            Some(vec!["early".to_string()])
        );
        assert_eq!(inventory.generation_of(&third), 9);
        assert_eq!(inventory.generation_of(&late), 7, "never rewritten");

        // A handed-over generation is kept as is.
        let (carried, _) = op("link", "carried");
        inventory.note_handed_over(&carried, 4);
        assert_eq!(inventory.generation_of(&carried), 4);
    }

    #[test]
    fn only_an_answer_for_a_pending_page_of_the_current_report_counts() {
        let mut inventory = Inventory::default();
        let first = inventory.begin_connection("link");
        let ops: Vec<(OpId, String)> = (0..=INVENTORY_PAGE_OPS)
            .map(|n| op("link", &format!("op-{n}")))
            .collect();
        let pages = inventory.pending_pages("link", || ops.clone());
        assert_eq!(pages.len(), 2, "one more op than a page holds");
        assert_eq!(pages[0].operations.len(), INVENTORY_PAGE_OPS);
        assert_eq!(pages[1].operations.len(), 1);
        assert!(pages
            .iter()
            .all(|page| page.pages == 2 && page.report_id == first));

        // A stale report, a zero generation, an unknown page: ignored.
        assert_eq!(
            inventory.answer("link", &ack(first + 1, 0, 3, &["op-0"])),
            None
        );
        assert_eq!(inventory.answer("link", &ack(first, 0, 0, &["op-0"])), None);
        assert_eq!(inventory.answer("link", &ack(first, 5, 3, &["op-0"])), None);
        assert_eq!(
            inventory.answer("other", &ack(first, 0, 3, &["op-0"])),
            None
        );

        // An id the page did not report is never stopped; duplicates once.
        let last = format!("op-{INVENTORY_PAGE_OPS}");
        assert_eq!(
            inventory.answer(
                "link",
                &ack(first, 1, 3, &[&last, &last, "op-0", "foreign"])
            ),
            Some(vec![last.clone()])
        );
        assert_eq!(
            inventory.answer("link", &ack(first, 1, 3, &[&last])),
            None,
            "answered once"
        );
        let pending = inventory.pending_pages("link", || unreachable!("report already built"));
        assert_eq!(
            pending.iter().map(|page| page.page).collect::<Vec<_>>(),
            vec![0]
        );

        // A new connection starts a new report; the old one's answers no
        // longer count.
        let second = inventory.begin_connection("link");
        assert_eq!(inventory.answer("link", &ack(first, 0, 3, &["op-0"])), None);
        let pages = inventory.pending_pages("link", Vec::new);
        assert_eq!(pages.len(), 1, "an empty report is one empty page");
        assert_eq!(pages[0].operations, Vec::<v1::InventoryOperation>::new());
        assert_eq!(pages[0].report_id, second);
    }

    #[test]
    fn bookkeeping_follows_the_live_operations() {
        let mut inventory = Inventory::default();
        let first = inventory.begin_connection("link");
        let (gone, _) = op("link", "gone");
        let (stopping, _) = op("link", "stopping");
        let (other_scope, _) = op("other", "kept");
        inventory.note_started(&gone);
        inventory.note_started(&stopping);
        inventory.note_handed_over(&other_scope, 2);
        inventory.mark_stopping(&stopping);
        let _ =
            inventory.pending_pages("link", || vec![op("link", "gone"), op("link", "stopping")]);
        assert_eq!(
            inventory.answer("link", &ack(first, 0, 5, &[])),
            Some(vec![])
        );

        // Only "stopping" is still live: it is not reported (already being
        // stopped), and "gone" is forgotten; the other scope is untouched.
        inventory.begin_connection("link");
        let pages = inventory.pending_pages("link", || vec![op("link", "stopping")]);
        assert_eq!(pages[0].operations, Vec::<v1::InventoryOperation>::new());
        assert_eq!(inventory.generation_of(&gone), 0);
        assert_eq!(inventory.generation_of(&other_scope), 2);
        assert!(inventory.take_stopping(&stopping));
        assert!(!inventory.take_stopping(&stopping));

        // A scope id is matched whole, never as a prefix of another scope.
        inventory.begin_connection("lin");
        let (not_lin, _) = op("link", "x");
        let mut only_lin = Inventory::default();
        only_lin.begin_connection("lin");
        only_lin.note_started(&not_lin);
        assert!(only_lin.started.is_empty());
    }
}
