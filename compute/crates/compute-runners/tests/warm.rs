//! Warm templates, refreshed from a branch, against GitHub and compute
//! faked in one server.

mod fake;

use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use compute_runners::compute::Compute;
use compute_runners::github::{Credentials, Github, Scope};
use compute_runners::warm::{self, BUILDER_KEY};
use fake::Fake;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

fn settings() -> warm::Settings {
    warm::Settings {
        pool: "ci".into(),
        base: "runner-base".into(),
        repo: "acme/web".into(),
        branch: None,
        prepare: "bun install && bun run build".into(),
        user: "runner".into(),
        work: "/home/runner/_work".into(),
        web: "https://github.example".into(),
        every: Duration::ZERO,
        within: Duration::from_secs(60),
        look: Duration::from_millis(50),
    }
}

#[tokio::test]
async fn a_template_follows_the_branch_and_older_ones_go() {
    let fake = Fake::start().await;
    {
        let mut world = fake.world();
        world.head = "b".repeat(40);
        world.templates.push((
            "tpl-old".into(),
            "ci-100-aaaaaaaaaaaa".into(),
            "sbx-gone".into(),
        ));
        world.templates.push((
            "tpl-other".into(),
            "cd-100-aaaaaaaaaaaa".into(),
            "sbx-gone".into(),
        ));
    }
    let github = Arc::new(Github::new(
        reqwest::Client::new(),
        &fake.base,
        &fake.base,
        Scope::parse("acme/web").unwrap(),
        Credentials::Token("the-token".into()),
    ));
    let compute = Compute::new(reqwest::Client::new(), &fake.base, "key");
    let (current_tx, mut current) = watch::channel("runner-base".to_owned());
    let (leading_tx, leading) = watch::channel(true);
    let stop = CancellationToken::new();
    let keeping = tokio::spawn(warm::keep(
        settings(),
        github,
        compute,
        current_tx,
        leading,
        stop.clone(),
    ));

    // The newest existing template is used at once, then a fresh one is
    // prepared at the branch's head.
    tokio::time::timeout(
        Duration::from_secs(10),
        current.wait_for(|name| name.ends_with("-bbbbbbbbbbbb")),
    )
    .await
    .expect("no fresh template")
    .unwrap();
    fake.until("the older template deleted", |world| {
        world.deleted_templates == ["tpl-old"]
    })
    .await;
    the_refresh_ran_as_it_should(&fake.world());

    // A failed prepare keeps the last good template, and its builder
    // goes too. Standing by, nothing more is built.
    let good = current.borrow().clone();
    {
        let mut world = fake.world();
        world.failing = Some("bun install".into());
        world.head = "c".repeat(40);
    }
    fake.until("a failed refresh", |world| world.processes.len() >= 5)
        .await;
    leading_tx.send_replace(false);
    // Any refresh begun ends.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(*current.borrow(), good);
    {
        let world = fake.world();
        assert!(
            world
                .sandboxes
                .values()
                .all(|sandbox| !sandbox.metadata.contains_key(BUILDER_KEY)),
            "failed builders go"
        );
        assert!(world.templates.iter().any(|(_, name, _)| *name == good));
    }
    let before = fake.world().processes.len();
    fake.world().failing = None;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(fake.world().processes.len(), before);

    stop.cancel();
    keeping.await.unwrap();
}

#[tokio::test]
async fn a_replica_taking_over_starts_runners_from_the_newest_template() {
    let fake = Fake::start().await;
    {
        let mut world = fake.world();
        world.head = "b".repeat(40);
        world.templates.push((
            "tpl-a".into(),
            "ci-100-aaaaaaaaaaaa".into(),
            "sbx-gone".into(),
        ));
    }
    let github = Arc::new(Github::new(
        reqwest::Client::new(),
        &fake.base,
        &fake.base,
        Scope::parse("acme/web").unwrap(),
        Credentials::Token("the-token".into()),
    ));
    let compute = Compute::new(reqwest::Client::new(), &fake.base, "key");
    let (current_tx, mut current) = watch::channel("runner-base".to_owned());
    let (leading_tx, leading) = watch::channel(false);
    let stop = CancellationToken::new();
    let keeping = tokio::spawn(warm::keep(
        settings(),
        github,
        compute,
        current_tx,
        leading,
        stop.clone(),
    ));
    tokio::time::timeout(
        Duration::from_secs(10),
        current.wait_for(|name| name == "ci-100-aaaaaaaaaaaa"),
    )
    .await
    .expect("the newest template, at start")
    .unwrap();

    // While this replica stands by, the one leading makes B at the head
    // and deletes A.
    {
        let mut world = fake.world();
        world.templates.clear();
        world.templates.push((
            "tpl-b".into(),
            "ci-200-bbbbbbbbbbbb".into(),
            "sbx-gone".into(),
        ));
    }
    leading_tx.send_replace(true);
    tokio::time::timeout(
        Duration::from_secs(10),
        current.wait_for(|name| name == "ci-200-bbbbbbbbbbbb"),
    )
    .await
    .expect("B, on taking over")
    .unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        fake.world().processes.is_empty(),
        "B is at the head: nothing is built"
    );

    // Standing by again, then taking over once every template is gone:
    // runners start from the base.
    leading_tx.send_replace(false);
    tokio::time::sleep(Duration::from_millis(200)).await;
    {
        let mut world = fake.world();
        world.templates.clear();
        world.failing = Some("git".into());
    }
    leading_tx.send_replace(true);
    tokio::time::timeout(
        Duration::from_secs(10),
        current.wait_for(|name| name == "runner-base"),
    )
    .await
    .expect("the base, when no template is left")
    .unwrap();

    stop.cancel();
    keeping.await.unwrap();
}

/// A replica taking over whose look at the templates fails looks again
/// before refreshing anything: the template it had as a standby may be
/// gone, and a refresh failing then would keep it for as long as
/// refreshes wait.
#[tokio::test]
async fn a_takeover_that_cannot_list_templates_lists_them_again() {
    let fake = Fake::start().await;
    {
        let mut world = fake.world();
        world.head = "b".repeat(40);
        world.templates.push((
            "tpl-a".into(),
            "ci-100-aaaaaaaaaaaa".into(),
            "sbx-gone".into(),
        ));
    }
    let github = Arc::new(Github::new(
        reqwest::Client::new(),
        &fake.base,
        &fake.base,
        Scope::parse("acme/web").unwrap(),
        Credentials::Token("the-token".into()),
    ));
    let compute = Compute::new(reqwest::Client::new(), &fake.base, "key");
    let (current_tx, mut current) = watch::channel("runner-base".to_owned());
    let (leading_tx, leading) = watch::channel(false);
    let stop = CancellationToken::new();
    let keeping = tokio::spawn(warm::keep(
        warm::Settings {
            every: Duration::from_secs(3600),
            ..settings()
        },
        github,
        compute,
        current_tx,
        leading,
        stop.clone(),
    ));
    tokio::time::timeout(
        Duration::from_secs(10),
        current.wait_for(|name| name == "ci-100-aaaaaaaaaaaa"),
    )
    .await
    .expect("A, at start")
    .unwrap();

    // While it stands by, the replica leading makes B and deletes A; as
    // it takes over, one listing and one creation fail.
    {
        let mut world = fake.world();
        world.templates.clear();
        world.templates.push((
            "tpl-b".into(),
            "ci-200-bbbbbbbbbbbb".into(),
            "sbx-gone".into(),
        ));
        world.listing_failures = 1;
        world.create_failures = 1;
    }
    leading_tx.send_replace(true);
    tokio::time::timeout(
        Duration::from_secs(10),
        current.wait_for(|name| name == "ci-200-bbbbbbbbbbbb"),
    )
    .await
    .expect("B, once the templates can be listed")
    .unwrap();
    assert_eq!(
        fake.world().create_failures,
        1,
        "B is at the head: no builder was asked for"
    );

    stop.cancel();
    keeping.await.unwrap();
}

/// One refresh: cloned with the token in its environment alone, prepared,
/// written out, saved, and its builder gone.
fn the_refresh_ran_as_it_should(world: &fake::World) {
    let names: Vec<&str> = world
        .templates
        .iter()
        .map(|(_, name, _)| name.as_str())
        .collect();
    assert_eq!(names.len(), 2, "{names:?}");
    assert!(
        names.contains(&"cd-100-aaaaaaaaaaaa"),
        "another pool's template stays"
    );
    let builder = &world
        .templates
        .iter()
        .find(|(_, name, _)| name.starts_with("ci-"))
        .unwrap()
        .2;
    assert!(world.killed.contains(builder), "the builder goes");
    let [clone, prepare, sync] = world.processes.as_slice() else {
        panic!("{:#?}", world.processes);
    };
    assert!(clone.sandbox == *builder && prepare.sandbox == *builder && sync.sandbox == *builder);
    assert_eq!(clone.user, "runner");
    assert!(clone.script.contains("'https://github.example/acme/web'"));
    assert!(clone.script.contains("'/home/runner/_work/web/web'"));
    assert!(
        !clone.script.contains("the-token"),
        "the token is never in the script"
    );
    let credential = STANDARD.encode("x-access-token:the-token");
    assert_eq!(
        clone.env["GIT_CONFIG_KEY_0"],
        "http.https://github.example/.extraheader"
    );
    assert_eq!(
        clone.env["GIT_CONFIG_VALUE_0"],
        format!("AUTHORIZATION: basic {credential}")
    );
    assert_eq!(
        prepare.script,
        "cd '/home/runner/_work/web/web' && bun install && bun run build"
    );
    assert!(prepare.env.is_empty(), "the prepare command gets no token");
    assert_eq!((sync.user.as_str(), sync.script.as_str()), ("root", "sync"));
    let builders: Vec<_> = world
        .sandboxes
        .values()
        .filter(|sandbox| sandbox.metadata.contains_key(BUILDER_KEY))
        .collect();
    assert!(builders.is_empty());
}
