use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use super::{CausalDot, CausalFrontier, OperationId};

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct RegisterContribution<T> {
    pub(crate) operation_id: OperationId,
    pub(crate) dot: CausalDot,
    pub(crate) operation_index: u32,
    pub(crate) base: Arc<CausalFrontier>,
    pub(crate) value: T,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct CausalRegister<T> {
    // Nearly every cell has exactly one contribution. Sorted vectors avoid a
    // tree allocation per sparse cell while retaining canonical order.
    contributions: Vec<RegisterContribution<T>>,
    maximal: Vec<OperationId>,
}

impl<T> CausalRegister<T> {
    pub(crate) fn insert(
        &mut self,
        contribution: RegisterContribution<T>,
        undone: &BTreeSet<OperationId>,
    ) {
        let operation_id = contribution.operation_id;
        let (position, replaced) = match self
            .contributions
            .binary_search_by_key(&operation_id, |candidate| candidate.operation_id)
        {
            Ok(position) => {
                self.contributions[position] = contribution;
                (position, true)
            }
            Err(position) => {
                self.contributions.insert(position, contribution);
                (position, false)
            }
        };
        if replaced {
            self.recompute_maximal(undone);
            return;
        }
        if undone.contains(&operation_id) {
            return;
        }
        let contribution = &self.contributions[position];
        let mut superseded = false;
        self.maximal.retain(|candidate_id| {
            let Some(candidate) = self
                .contributions
                .binary_search_by_key(candidate_id, |item| item.operation_id)
                .ok()
                .map(|position| &self.contributions[position])
            else {
                return false;
            };
            if happens_after(contribution, candidate) {
                false
            } else {
                if happens_after(candidate, contribution) {
                    superseded = true;
                }
                true
            }
        });
        if !superseded {
            match self.maximal.binary_search(&operation_id) {
                Ok(_) => {}
                Err(position) => self.maximal.insert(position, operation_id),
            }
        }
    }

    pub(crate) fn recompute_maximal(&mut self, undone: &BTreeSet<OperationId>) {
        self.maximal.clear();
        let mut observed = BTreeMap::new();
        let mut latest_in_transaction = BTreeMap::new();
        for contribution in self
            .contributions
            .iter()
            .filter(|candidate| !undone.contains(&candidate.operation_id))
        {
            for (replica, counter) in contribution.base.iter() {
                observed
                    .entry(replica)
                    .and_modify(|maximum: &mut u64| *maximum = (*maximum).max(counter))
                    .or_insert(counter);
            }
            latest_in_transaction
                .entry(contribution.dot)
                .and_modify(|maximum: &mut u32| {
                    *maximum = (*maximum).max(contribution.operation_index);
                })
                .or_insert(contribution.operation_index);
        }
        for contribution in self
            .contributions
            .iter()
            .filter(|candidate| !undone.contains(&candidate.operation_id))
        {
            let observed_later = observed
                .get(&contribution.dot.replica())
                .is_some_and(|counter| *counter >= contribution.dot.counter());
            let later_in_transaction = latest_in_transaction
                .get(&contribution.dot)
                .is_some_and(|index| *index > contribution.operation_index);
            if !observed_later && !later_in_transaction {
                self.maximal.push(contribution.operation_id);
            }
        }
    }

    pub(crate) fn visible(&self) -> Option<&RegisterContribution<T>> {
        self.maximal
            .iter()
            .filter_map(|id| {
                self.contributions
                    .binary_search_by_key(id, |candidate| candidate.operation_id)
                    .ok()
                    .map(|position| &self.contributions[position])
            })
            .max_by_key(|contribution| {
                (
                    contribution.dot.replica(),
                    contribution.dot.counter(),
                    contribution.operation_index,
                    contribution.operation_id,
                )
            })
    }

    pub(crate) fn contributions(&self) -> impl Iterator<Item = &RegisterContribution<T>> {
        self.contributions.iter()
    }
}

fn happens_after<T>(
    candidate_later: &RegisterContribution<T>,
    candidate_earlier: &RegisterContribution<T>,
) -> bool {
    if candidate_later.dot == candidate_earlier.dot {
        return candidate_later.operation_index > candidate_earlier.operation_index;
    }
    candidate_later.base.observes(candidate_earlier.dot)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::sync::Arc;

    use super::{CausalRegister, RegisterContribution};
    use crate::collaboration::{CausalDot, CausalFrontier, OperationId, ReplicaId};
    use crate::StableId;

    fn replica(value: u64) -> ReplicaId {
        ReplicaId::new(value).expect("replica")
    }

    fn dot(replica_id: u64, counter: u64) -> CausalDot {
        CausalDot::new(replica(replica_id), counter).expect("dot")
    }

    fn op(value: u64) -> OperationId {
        OperationId::from_stable_id(StableId::from_parts(99, value))
    }

    #[test]
    fn causal_successor_wins_even_when_its_tie_break_key_is_smaller() {
        let mut register = CausalRegister::default();
        let undone = BTreeSet::new();
        register.insert(
            RegisterContribution {
                operation_id: op(1),
                dot: dot(9, 1),
                operation_index: 0,
                base: Arc::new(CausalFrontier::new()),
                value: "first",
            },
            &undone,
        );
        register.insert(
            RegisterContribution {
                operation_id: op(2),
                dot: dot(1, 1),
                operation_index: 0,
                base: Arc::new(CausalFrontier::from_entries([(replica(9), 1)]).expect("base")),
                value: "later",
            },
            &undone,
        );
        assert_eq!(register.visible().map(|value| value.value), Some("later"));
    }

    #[test]
    fn concurrent_maxima_use_a_stable_tie_break_and_undo_reveals_the_other() {
        let mut register = CausalRegister::default();
        let mut undone = BTreeSet::new();
        for (replica_id, operation, value) in [(1, op(1), "one"), (2, op(2), "two")] {
            register.insert(
                RegisterContribution {
                    operation_id: operation,
                    dot: dot(replica_id, 1),
                    operation_index: 0,
                    base: Arc::new(CausalFrontier::new()),
                    value,
                },
                &undone,
            );
        }
        assert_eq!(register.visible().map(|value| value.value), Some("two"));
        undone.insert(op(2));
        register.recompute_maximal(&undone);
        assert_eq!(register.visible().map(|value| value.value), Some("one"));
    }
}
