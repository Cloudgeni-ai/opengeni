//! Ready sandboxes against real Firecracker: restored, warmed and paused
//! ahead of time, then claimed by creates.

use std::time::Duration;

use tokio::time::{Instant, sleep};

use super::{
    Host, TemplateState, agains, assert_each_its_own, count, firecrackers, lab, save_results,
    start_batch, summary, totals,
};

/// Every create claims a ready sandbox: its first command runs within a
/// resume and an identity notice of the create, and each guest reports its
/// own id, machine id and random numbers. A restarted agent removes the
/// ready sandboxes nobody claimed.
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn ready_sandboxes_start_at_once_and_each_its_own() {
    let Some(lab) = lab() else {
        eprintln!("skipped: set COMPUTE_TEST_LAB");
        return;
    };
    let count = count();
    let keep = format!("1x512:{}", count + 1);
    let notice = ["--network", "--restore-notice-port", "53"];
    let ready = Host::new(
        &lab,
        "ready",
        &[
            &notice[..],
            &["--template-ready-port", "54", "--template", &keep],
        ]
        .concat(),
    );
    let agent = ready.start().await;
    let began = Instant::now();
    let target = u32::try_from(count + 1).unwrap();
    agent
        .wait_until("a full ready pool", |status| {
            status.templates.iter().any(|template| {
                template.state == TemplateState::Ready
                    && template.ready == target
                    && template.filling == 0
            })
        })
        .await;
    let filled_s = began.elapsed().as_secs_f64();
    assert_eq!(firecrackers(), count + 1, "only the ready sandboxes run");

    let (single, all, wall_s) = start_batch(&agent, count).await;
    assert_each_its_own(&single, &all);
    let creates: Vec<f64> = all.iter().map(|started| started.create_ms).collect();
    let status = agent.status().await;
    let done = |step: &str| {
        status
            .steps
            .iter()
            .find(|(name, _)| name == step)
            .map_or(0, |(_, stats)| stats.done)
    };
    let (boots, restores, resumes) = (done("boot"), done("restore"), done("resume"));
    agent.remove_all().await;
    agent.kill();

    // The pool refilled behind the claims; a restart that keeps none
    // removes every ready sandbox it finds.
    let mut restarted = ready;
    restarted.extra = [
        &notice[..],
        &["--template-ready-port", "54", "--template", "1x512"],
    ]
    .concat()
    .iter()
    .map(|&arg| arg.to_owned())
    .collect();
    let agent = restarted.start().await;
    let deadline = Instant::now() + Duration::from_secs(120);
    while firecrackers() > 0 {
        assert!(Instant::now() < deadline, "ready sandboxes left running");
        sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(agent.status().await.sandboxes.len(), 0);
    agent.kill();
    restarted.finish(&format!("ready-pool-{count}"));

    save_results(
        &format!("ready-pool-{count}"),
        &serde_json::json!({
            "sandboxes": count,
            "ready_target": count + 1,
            "pool_filled_s": filled_s,
            "single_create_to_first_command_ms": single.total_ms,
            "single_second_command_ms": single.again_ms,
            "concurrent_create_to_first_command_ms": summary(&totals(&all)),
            "concurrent_second_command_ms": summary(&agains(&all)),
            "concurrent_create_ms": summary(&creates),
            "concurrent_wall_s": wall_s,
            "boot_steps": boots,
            "restore_steps": restores,
            "resume_steps": resumes,
        }),
    );
    assert_eq!(
        (boots, restores),
        (0, 0),
        "every create claimed a ready sandbox"
    );
}
