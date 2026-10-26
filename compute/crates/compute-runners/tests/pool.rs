//! A pool end to end, against GitHub and compute faked in one server.

mod fake;

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use compute_runners::compute::Compute;
use compute_runners::github::{Credentials, Github, Scope};
use compute_runners::pool::{self, BORN_KEY, ID_KEY, JIT_ENV, NAME_KEY, POOL_KEY, Pool};
use fake::{Fake, Sandbox};
use serde_json::json;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

struct Running {
    fake: Fake,
    leading: watch::Receiver<bool>,
    stop: CancellationToken,
    done: tokio::task::JoinHandle<()>,
}

fn github(fake: &Fake) -> Arc<Github> {
    Arc::new(Github::new(
        reqwest::Client::new(),
        &fake.base,
        &fake.base,
        Scope::parse("acme/web").unwrap(),
        Credentials::Token("admin".into()),
    ))
}

async fn pool(fake: &Fake, min_idle: u32) -> Pool {
    let github = github(fake);
    let set = github
        .ensure_scale_set(1, "ci", &["ci".into()])
        .await
        .unwrap();
    let settings = pool::Settings {
        name: "ci".into(),
        min_idle,
        max: 4,
        timeout_s: 600,
        env: BTreeMap::from([("TURBO_API".into(), "http://cache".into())]),
        standby: Duration::from_millis(100),
    };
    let (_, template) = watch::channel("runner-base".to_owned());
    let compute = Compute::new(reqwest::Client::new(), &fake.base, "key");
    Pool::new(github, compute, set.id, settings, template)
}

async fn listening(fake: Fake, min_idle: u32) -> Running {
    let pool = pool(&fake, min_idle).await;
    let (leading_tx, leading) = watch::channel(false);
    let stop = CancellationToken::new();
    let stopping = stop.clone();
    let done = tokio::spawn(async move {
        pool::listen(pool, "replica-a", &leading_tx, &stopping)
            .await
            .unwrap();
    });
    Running {
        fake,
        leading,
        stop,
        done,
    }
}

async fn until_leading(leading: &mut watch::Receiver<bool>, want: bool) {
    tokio::time::timeout(
        Duration::from_secs(10),
        leading.wait_for(|now| *now == want),
    )
    .await
    .expect("leadership never changed")
    .unwrap();
}

#[tokio::test]
async fn a_job_runs_in_a_fresh_sandbox_that_ends_with_it() {
    let Running {
        fake,
        mut leading,
        stop,
        done,
    } = listening(Fake::start().await, 0).await;
    until_leading(&mut leading, true).await;
    assert!(fake.world().sandboxes.is_empty(), "no job, no runner");

    fake.send(
        &json!([{"messageType": "JobAvailable", "runnerRequestId": 11}]),
        1,
    );
    fake.until("a runner for the job", |world| world.sandboxes.len() == 1)
        .await;
    let (sandbox, started) = fake
        .world()
        .sandboxes
        .iter()
        .next()
        .map(|(id, s)| (id.clone(), s.clone()))
        .unwrap();
    let Sandbox {
        template,
        metadata,
        env,
    } = started;
    assert_eq!(template, "runner-base");
    assert_eq!(metadata[POOL_KEY], "ci");
    let name = metadata[NAME_KEY].clone();
    let id: u64 = metadata[ID_KEY].parse().unwrap();
    assert!(name.starts_with("ci-"), "{name}");
    assert_eq!(env[JIT_ENV], format!("jit-{id}"));
    assert_eq!(env["TURBO_API"], "http://cache");
    assert_eq!(fake.world().acquired, [11]);

    // GitHub gives the runner the job, which runs, then ends; an
    // ephemeral runner is removed with its job.
    fake.world().runners.insert(id, (name.clone(), true));
    fake.send(
        &json!([{"messageType": "JobStarted", "runnerRequestId": 11, "runnerName": name}]),
        1,
    );
    fake.world().runners.remove(&id);
    fake.send(
        &json!([{"messageType": "JobCompleted", "runnerRequestId": 11, "runnerName": name, "result": "succeeded"}]),
        0,
    );
    fake.until("the runner's sandbox to go", |world| {
        world.killed.contains(&sandbox)
    })
    .await;
    fake.until("every message handled", |world| {
        world.messages.is_empty() && world.deleted_messages.len() == 3
    })
    .await;
    assert!(fake.world().sandboxes.is_empty());

    stop.cancel();
    done.await.unwrap();
    assert_eq!(fake.world().session, None, "the session is closed on stop");
    assert_eq!(fake.world().sessions_closed, 1);
}

#[tokio::test]
async fn idle_runners_are_kept_and_replaced() {
    let Running {
        fake,
        mut leading,
        stop,
        done,
    } = listening(Fake::start().await, 2).await;
    until_leading(&mut leading, true).await;
    fake.until("two idle runners", |world| {
        world.sandboxes.len() == 2 && world.runners.len() == 2
    })
    .await;

    // A job takes one; the pool starts another so two stay idle.
    let (name, id) = {
        let world = fake.world();
        let (id, (name, _)) = world.runners.iter().next().unwrap();
        (name.clone(), *id)
    };
    fake.world().runners.insert(id, (name.clone(), true));
    fake.send(
        &json!([{"messageType": "JobStarted", "runnerRequestId": 5, "runnerName": name}]),
        1,
    );
    fake.until("a third runner", |world| world.sandboxes.len() == 3)
        .await;

    stop.cancel();
    done.await.unwrap();
}

#[tokio::test]
async fn what_runs_is_read_back_and_set_right() {
    let fake = Fake::start().await;
    let mut pool = pool(&fake, 1).await;
    let old = |name: &str, id: u64| Sandbox {
        template: "runner-base".into(),
        metadata: BTreeMap::from([
            (POOL_KEY.into(), "ci".into()),
            (NAME_KEY.into(), name.into()),
            (ID_KEY.into(), id.to_string()),
            (BORN_KEY.into(), "1000".into()),
        ]),
        env: BTreeMap::new(),
    };
    {
        let mut world = fake.world();
        // A runner GitHub knows, in its sandbox: taken on.
        world.runners.insert(7, ("ci-kept".into(), false));
        world.sandboxes.insert("sbx-kept".into(), old("ci-kept", 7));
        // A runner GitHub no longer knows: its sandbox goes.
        world.sandboxes.insert("sbx-gone".into(), old("ci-gone", 8));
        // A sandbox of the pool naming no runner: it goes.
        let mut nameless = old("x", 9);
        nameless.metadata.remove(NAME_KEY);
        world.sandboxes.insert("sbx-nameless".into(), nameless);
        // Another pool's sandbox: left alone.
        let mut other = old("cd-1", 10);
        other.metadata.insert(POOL_KEY.into(), "cd".into());
        world.sandboxes.insert("sbx-other".into(), other);
    }
    pool.reconcile().await.unwrap();
    {
        let world = fake.world();
        let mut killed = world.killed.clone();
        killed.sort();
        assert_eq!(killed, ["sbx-gone", "sbx-nameless"]);
        assert!(world.sandboxes.contains_key("sbx-kept"));
        assert!(world.sandboxes.contains_key("sbx-other"));
        assert_eq!(
            world.sandboxes.len(),
            2,
            "the kept runner is the idle one wanted"
        );
    }

    // The kept runner's sandbox vanishes: its registration goes, and a
    // new runner takes its place.
    fake.world().sandboxes.remove("sbx-kept");
    pool.reconcile().await.unwrap();
    let world = fake.world();
    assert!(
        !world.runners.contains_key(&7),
        "the registration of a sandbox gone is removed"
    );
    assert_eq!(world.runners.len(), 1);
    let fresh: Vec<&Sandbox> = world
        .sandboxes
        .values()
        .filter(|sandbox| sandbox.metadata[POOL_KEY] == "ci")
        .collect();
    assert_eq!(fresh.len(), 1);
    assert_ne!(fresh[0].metadata[NAME_KEY], "ci-kept");
}

#[tokio::test]
async fn a_second_listener_stands_by_until_the_session_is_free() {
    let fake = Fake::start().await;
    fake.world().session = Some(("session-held".into(), "replica-b".into()));
    let Running {
        fake,
        mut leading,
        stop,
        done,
    } = listening(fake, 0).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!*leading.borrow(), "a standby does not lead");
    assert_eq!(fake.world().session.as_ref().unwrap().1, "replica-b");

    fake.world().session = None;
    until_leading(&mut leading, true).await;
    assert_eq!(fake.world().session.as_ref().unwrap().1, "replica-a");
    stop.cancel();
    done.await.unwrap();
    assert!(!*leading.borrow(), "a stopped listener no longer leads");
}

#[tokio::test]
async fn an_expired_queue_token_is_refreshed() {
    let Running {
        fake,
        mut leading,
        stop,
        done,
    } = listening(Fake::start().await, 0).await;
    until_leading(&mut leading, true).await;
    fake.world().queue_token = "expired-elsewhere".into();
    fake.until("a refresh", |world| world.refreshes == 1).await;
    fake.send(
        &json!([{"messageType": "JobAvailable", "runnerRequestId": 3}]),
        1,
    );
    fake.until("the job acquired with the fresh token", |world| {
        world.acquired == [3] && world.sandboxes.len() == 1
    })
    .await;
    stop.cancel();
    done.await.unwrap();
}
