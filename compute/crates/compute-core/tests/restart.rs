//! Restarting a sandbox where it is ([`Input::Restart`]): its programs end
//! and its memory image is forgotten, without moving it or saving it first,
//! and a wake asked meanwhile boots it from its files.

use compute_core::{
    Action, At, Durability, Failure, Host, HostPolicy, Input, Level, Notice, OpId, Outcome,
    Priority, SandboxId, Size, SleepPolicy, SleepRules, State, Step,
};

const GIB: u64 = 1 << 30;
const ID: SandboxId = SandboxId(1);

struct Rig {
    host: Host,
    now: At,
}

impl Rig {
    /// A host with one sandbox at `state`, under rules that never put it to
    /// sleep by themselves.
    fn with(state: State) -> Self {
        let mut rig = Self {
            host: Host::new(HostPolicy::default()).unwrap(),
            now: At::ZERO,
        };
        rig.send(Input::Add {
            sandbox: ID,
            state,
            policy: SleepPolicy::new(SleepRules::NEVER).unwrap(),
            size: Size::whole(GIB),
            last_activity: At::ZERO,
        });
        rig
    }

    fn send(&mut self, input: Input) -> Vec<Action> {
        let mut out = Vec::new();
        self.host.handle(self.now, input, &mut out);
        out
    }

    fn finish(&mut self, op: OpId, outcome: Outcome) -> Vec<Action> {
        self.send(Input::Finished {
            sandbox: ID,
            op,
            outcome,
            wrote: true,
        })
    }

    fn touch(&mut self) -> Vec<Action> {
        self.send(Input::Touch {
            sandbox: ID,
            priority: Priority::Interactive,
        })
    }

    fn restarting(&self) -> bool {
        self.host.restarting(ID)
    }

    fn state(&self) -> State {
        self.host.sandbox(ID).unwrap().state
    }
}

fn started(actions: &[Action]) -> Vec<(Step, OpId)> {
    actions
        .iter()
        .filter_map(|action| match action {
            Action::Start { step, op, .. } => Some((*step, *op)),
            _ => None,
        })
        .collect()
}

fn the_start(actions: &[Action]) -> (Step, OpId) {
    let started = started(actions);
    assert_eq!(started.len(), 1, "{actions:?}");
    started[0]
}

fn ends(actions: &[Action]) -> bool {
    actions
        .iter()
        .any(|action| matches!(action, Action::EndForRestart { sandbox } if *sandbox == ID))
}

fn cancels(actions: &[Action], op: OpId) -> bool {
    actions
        .iter()
        .any(|action| matches!(action, Action::Cancel { op: cancelled, .. } if *cancelled == op))
}

fn programs_lost(actions: &[Action]) -> bool {
    actions.iter().any(|action| {
        matches!(
            action,
            Action::Notify {
                notice: Notice::MemoryLost,
                ..
            }
        )
    })
}

#[test]
fn a_running_sandbox_ends_its_vm_without_a_save_and_next_boots_from_its_files() {
    let mut rig = Rig::with(State::RUNNING);
    let out = rig.send(Input::Restart { sandbox: ID });
    assert!(ends(&out), "{out:?}");
    assert!(started(&out).is_empty(), "nothing is saved first: {out:?}");
    assert!(rig.restarting());

    // Ended on purpose: no programs-lost alarm, and nothing is left that
    // could bring them back.
    let out = rig.send(Input::Lost { sandbox: ID });
    assert!(!programs_lost(&out), "{out:?}");
    assert_eq!(
        rig.state(),
        State::new(Level::Saved, Durability::Local, false)
    );
    assert!(!rig.restarting());
    assert_eq!(the_start(&rig.touch()).0, Step::Boot);
}

#[test]
fn a_slow_archive_under_way_is_cancelled_and_never_waited_for() {
    // Saved here with its memory, while its copy crawls to the store.
    let mut rig = Rig::with(State::new(Level::Saved, Durability::Local, true));
    let (step, archive) = the_start(&rig.send(Input::Sleep {
        sandbox: ID,
        level: Level::Archived,
    }));
    assert_eq!(step, Step::Archive);

    let out = rig.send(Input::Restart { sandbox: ID });
    assert!(cancels(&out, archive), "{out:?}");
    // A wake asked meanwhile waits for the restart, then boots it.
    assert_eq!(started(&rig.touch()), Vec::new());

    let (step, forget) = the_start(&rig.finish(archive, Outcome::Cancelled));
    assert_eq!(step, Step::Forget, "its memory image goes before any wake");
    // The wake that waits does not cancel the forget it waits for.
    assert!(!cancels(&rig.touch(), forget));

    let out = rig.finish(forget, Outcome::Done);
    assert!(!rig.restarting());
    assert_eq!(the_start(&out).0, Step::Boot, "never restored: {out:?}");
}

#[test]
fn an_archive_too_late_to_cancel_still_has_its_memory_image_forgotten() {
    let mut rig = Rig::with(State::new(Level::Saved, Durability::Local, true));
    let (_, archive) = the_start(&rig.send(Input::Sleep {
        sandbox: ID,
        level: Level::Archived,
    }));
    rig.send(Input::Restart { sandbox: ID });
    let (step, forget) = the_start(&rig.finish(archive, Outcome::Done));
    assert_eq!(step, Step::Forget);
    rig.finish(forget, Outcome::Done);
    assert_eq!(
        rig.state(),
        State::new(Level::Archived, Durability::Remote, false)
    );
    assert!(!rig.restarting());
}

#[test]
fn a_paused_sandbox_with_a_saved_copy_ends_then_forgets_that_copy() {
    let mut rig = Rig::with(State::new(Level::Paused, Durability::Local, true));
    assert!(ends(&rig.send(Input::Restart { sandbox: ID })));
    let (step, forget) = the_start(&rig.send(Input::Lost { sandbox: ID }));
    assert_eq!(step, Step::Forget);
    assert!(rig.restarting());
    rig.finish(forget, Outcome::Done);
    assert!(!rig.restarting());
    assert!(!rig.state().memory_saved);
}

#[test]
fn a_resume_under_way_is_cancelled_and_one_too_late_ends_again() {
    let mut rig = Rig::with(State::new(Level::Paused, Durability::Volatile, false));
    let (step, resume) = the_start(&rig.touch());
    assert_eq!(step, Step::Resume);
    let out = rig.send(Input::Restart { sandbox: ID });
    assert!(cancels(&out, resume), "{out:?}");
    assert!(!ends(&out), "a step still holds its VM");
    assert!(ends(&rig.finish(resume, Outcome::Done)));
    rig.send(Input::Lost { sandbox: ID });
    assert!(!rig.restarting());
}

#[test]
fn a_boot_under_way_is_a_restart_already() {
    let mut rig = Rig::with(State::new(Level::Saved, Durability::Local, false));
    let (step, _) = the_start(&rig.touch());
    assert_eq!(step, Step::Boot);
    let out = rig.send(Input::Restart { sandbox: ID });
    assert!(!rig.restarting(), "{out:?}");
}

#[test]
fn a_sandbox_kept_only_in_the_store_forgets_its_stored_image() {
    let mut rig = Rig::with(State::new(Level::Remote, Durability::Remote, true));
    let (step, forget) = the_start(&rig.send(Input::Restart { sandbox: ID }));
    assert_eq!(step, Step::Forget);
    rig.finish(forget, Outcome::Done);
    assert!(!rig.restarting());
    assert_eq!(the_start(&rig.touch()).0, Step::Fetch);
}

#[test]
fn asking_again_asks_its_vm_to_end_again() {
    let mut rig = Rig::with(State::RUNNING);
    assert!(ends(&rig.send(Input::Restart { sandbox: ID })));
    assert!(!ends(&rig.send(Input::Tick)));
    assert!(ends(&rig.send(Input::Restart { sandbox: ID })));
}

/// A memory image that cannot be forgotten, as while the store is out of
/// reach, never keeps the sandbox from waking: the restart ends, and a
/// wake restores the last save, which matches its files.
#[test]
fn a_restart_whose_forget_fails_ends_and_the_sandbox_wakes_from_its_save() {
    let mut rig = Rig::with(State::new(Level::Paused, Durability::Remote, true));
    assert!(ends(&rig.send(Input::Restart { sandbox: ID })));
    let (step, forget) = the_start(&rig.send(Input::Lost { sandbox: ID }));
    assert_eq!(step, Step::Forget);
    rig.finish(forget, Outcome::Failed(Failure::Transient));
    assert!(!rig.restarting());
    assert!(rig.state().memory_saved, "its save is kept");
    rig.now = At::from_millis(3_600_000);
    let out = rig.touch();
    let started = started(&out);
    assert!(
        matches!(started.as_slice(), [(Step::Restore, _)]),
        "{out:?}"
    );
}
