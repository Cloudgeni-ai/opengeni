//! Warm templates: the pool's template, prepared from a branch of a
//! repository and refreshed when the branch moves, at most every so often.
//!
//! A refresh starts a sandbox from the base template, clones the
//! repository at the branch's head where `actions/checkout` will look for
//! it, runs the prepare command there as the runner's user, and saves the
//! sandbox as a template named `<pool>-<seconds>-<commit>`. New runners
//! start from the newest; the pool's older templates are deleted (their
//! images stay while sandboxes use them). A failed refresh leaves the last
//! good template in use. The clone's token is given to that one command in
//! its environment, never written to the disk the template keeps.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, Result, bail};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::compute::{Compute, Created, NewSandbox, Snapshot};
use crate::github::Github;

/// The metadata key a template builder's sandbox carries, naming its pool.
pub const BUILDER_KEY: &str = "runner-pool-builder";
/// How often the branch's head is read.
pub const LOOK_EVERY: Duration = Duration::from_secs(60);
/// How many hex digits of the commit a template's name keeps.
const COMMIT_DIGITS: usize = 12;

/// What to keep warm.
#[derive(Clone, Debug)]
pub struct Settings {
    /// The pool, whose name begins its templates'.
    pub pool: String,
    /// The template refreshes start from.
    pub base: String,
    /// `owner/repo`.
    pub repo: String,
    /// The branch; `None` is the repository's default.
    pub branch: Option<String>,
    /// Run in the clone, as `user`, with `bash -l -c`.
    pub prepare: String,
    pub user: String,
    /// The runners' work folder: the clone goes to `<work>/<repo>/<repo>`.
    pub work: String,
    /// GitHub's web address, which the repository is cloned from.
    pub web: String,
    /// At most one refresh in this long.
    pub every: Duration,
    /// The longest a refresh's clone and prepare may take.
    pub within: Duration,
    /// How often the branch's head is read ([`LOOK_EVERY`]).
    pub look: Duration,
}

/// A template of the pool, as its name says.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Ours {
    id: String,
    name: String,
    at: u64,
    commit: String,
}

/// Reads `name` as one of `pool`'s templates: `<pool>-<seconds>-<commit>`.
fn parse(pool: &str, name: &str) -> Option<(u64, String)> {
    let rest = name.strip_prefix(pool)?.strip_prefix('-')?;
    let (at, commit) = rest.split_once('-')?;
    let at = at.parse().ok()?;
    (commit.len() == COMMIT_DIGITS && commit.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| (at, commit.to_owned()))
}

/// `pool`'s templates among `all`, oldest first.
fn ours(pool: &str, all: &[Snapshot]) -> Vec<Ours> {
    let mut found: Vec<Ours> = all
        .iter()
        .filter_map(|snapshot| {
            snapshot.names.iter().find_map(|name| {
                parse(pool, name).map(|(at, commit)| Ours {
                    id: snapshot.id.clone(),
                    name: name.clone(),
                    at,
                    commit,
                })
            })
        })
        .collect();
    found.sort_by(|a, b| (a.at, &a.name).cmp(&(b.at, &b.name)));
    found
}

fn now_s() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs())
}

/// The shell script that clones `repo` at `commit` into `dir`.
fn clone_script(web: &str, repo: &str, commit: &str, dir: &str) -> String {
    format!(
        "set -euo pipefail\n\
         rm -rf '{dir}'\n\
         mkdir -p '{dir}'\n\
         cd '{dir}'\n\
         git init -q\n\
         git remote add origin '{web}/{repo}'\n\
         git fetch -q --no-tags --depth=1 origin {commit}\n\
         git checkout -q --detach {commit}\n"
    )
}

/// Keeps the pool's template warm until `stop`, telling `current` each new
/// one. Refreshes only while `leading`, so a standby builds nothing; on
/// taking over it adopts the newest template, which the replica that led
/// before may have made, and refreshes nothing until it has: what it had
/// as a standby may be gone, and a refresh failing then would keep it for
/// as long as refreshes wait.
pub async fn keep(
    settings: Settings,
    github: Arc<Github>,
    compute: Compute,
    current: watch::Sender<String>,
    leading: watch::Receiver<bool>,
    stop: CancellationToken,
) {
    let mut have: Option<Ours> = None;
    let mut tried: Option<u64> = None;
    adopt(&settings, &compute, &current, &mut have, &mut tried).await;
    let mut branch = settings.branch.clone();
    let mut cleared = false;
    loop {
        if *leading.borrow() {
            if !cleared && adopt(&settings, &compute, &current, &mut have, &mut tried).await {
                clear_builders(&compute, &settings.pool).await;
                cleared = true;
            }
            let due = cleared
                && tried.is_none_or(|at| now_s() >= at.saturating_add(settings.every.as_secs()));
            if due {
                match look(&settings, &github, &mut branch, have.as_ref()).await {
                    Ok(Some(commit)) => {
                        tried = Some(now_s());
                        tokio::select! {
                            refreshed = refresh(&settings, &github, &compute, &commit) => match refreshed {
                                Ok(made) => {
                                    tracing::info!(template = %made.name, "runners start from a fresh warm template");
                                    current.send_replace(made.name.clone());
                                    forget_older(&compute, &settings.pool, &made).await;
                                    have = Some(made);
                                }
                                Err(error) => tracing::warn!(
                                    error = format!("{error:#}"),
                                    "refreshing the warm template failed; runners keep the last one"
                                ),
                            },
                            () = stop.cancelled() => return,
                        }
                    }
                    Ok(None) => {}
                    Err(error) => tracing::warn!(
                        error = format!("{error:#}"),
                        "reading the branch's head failed"
                    ),
                }
            }
        } else {
            cleared = false;
        }
        tokio::select! {
            () = tokio::time::sleep(settings.look) => {}
            () = stop.cancelled() => return,
        }
    }
}

/// Takes the pool's newest template as the one runners start from (the
/// base when it has none), and as the one last made. Keeps what it had
/// when the templates cannot be listed, and says whether they were.
async fn adopt(
    settings: &Settings,
    compute: &Compute,
    current: &watch::Sender<String>,
    have: &mut Option<Ours>,
    tried: &mut Option<u64>,
) -> bool {
    let all = match compute.snapshots().await {
        Ok(all) => all,
        Err(error) => {
            tracing::warn!(
                error = format!("{error:#}"),
                "listing templates failed; runners keep the template they had"
            );
            return false;
        }
    };
    let newest = ours(&settings.pool, &all).pop();
    let name = newest
        .as_ref()
        .map_or_else(|| settings.base.clone(), |newest| newest.name.clone());
    if *current.borrow() != name {
        tracing::info!(template = %name, "runners start from the pool's newest template");
        current.send_replace(name);
    }
    *tried = newest.as_ref().map(|newest| newest.at);
    *have = newest;
    true
}

/// The branch's head, when no template has it yet.
async fn look(
    settings: &Settings,
    github: &Github,
    branch: &mut Option<String>,
    have: Option<&Ours>,
) -> Result<Option<String>> {
    let name = if let Some(name) = branch {
        name.clone()
    } else {
        let found = github.default_branch(&settings.repo).await?;
        *branch = Some(found.clone());
        found
    };
    let head = github.branch_head(&settings.repo, &name).await?;
    Ok((have.is_none_or(|have| !head.starts_with(&have.commit))).then_some(head))
}

/// Ends builders a stopped service left behind.
async fn clear_builders(compute: &Compute, pool: &str) {
    match compute.list(&[(BUILDER_KEY, pool)]).await {
        Ok(left) => {
            for builder in left {
                tracing::info!(sandbox = %builder.id, "a template builder left behind goes");
                if let Err(error) = compute.kill(&builder.id).await {
                    tracing::warn!(error = format!("{error:#}"), "killing a builder failed");
                }
            }
        }
        Err(error) => tracing::warn!(error = format!("{error:#}"), "listing builders failed"),
    }
}

/// Prepares a template at `commit` and saves it.
async fn refresh(
    settings: &Settings,
    github: &Github,
    compute: &Compute,
    commit: &str,
) -> Result<Ours> {
    let short = &commit[..COMMIT_DIGITS];
    let at = now_s();
    let name = format!("{}-{at}-{short}", settings.pool);
    tracing::info!(%commit, template = %name, "preparing a warm template");
    let builder = compute
        .create(&NewSandbox {
            template: settings.base.clone(),
            timeout_s: settings.within.as_secs() + 45 * 60,
            metadata: BTreeMap::from([(BUILDER_KEY.into(), settings.pool.clone())]),
            env: BTreeMap::new(),
        })
        .await
        .context("starting a template builder")?;
    let made = prepare(settings, github, compute, &builder, commit, &name).await;
    if let Err(error) = compute.kill(&builder.id).await {
        tracing::warn!(sandbox = %builder.id, error = format!("{error:#}"), "killing a template builder failed");
    }
    let snapshot = made?;
    Ok(Ours {
        id: snapshot.id,
        name,
        at,
        commit: short.into(),
    })
}

async fn prepare(
    settings: &Settings,
    github: &Github,
    compute: &Compute,
    builder: &Created,
    commit: &str,
    name: &str,
) -> Result<Snapshot> {
    let started = tokio::time::Instant::now();
    let repo_name = settings.repo.rsplit('/').next().unwrap_or(&settings.repo);
    let dir = format!(
        "{}/{repo_name}/{repo_name}",
        settings.work.trim_end_matches('/')
    );
    let web = settings.web.trim_end_matches('/');
    let credential = STANDARD.encode(format!("x-access-token:{}", github.token().await?));
    let secret_env = BTreeMap::from([
        ("GIT_CONFIG_COUNT".to_owned(), "1".to_owned()),
        (
            "GIT_CONFIG_KEY_0".to_owned(),
            format!("http.{web}/.extraheader"),
        ),
        (
            "GIT_CONFIG_VALUE_0".to_owned(),
            format!("AUTHORIZATION: basic {credential}"),
        ),
    ]);
    let cloned = compute
        .run(
            builder,
            &settings.user,
            &clone_script(web, &settings.repo, commit, &dir),
            &secret_env,
            settings.within,
        )
        .await
        .context("cloning the repository")?;
    if cloned.exit_code != 0 {
        bail!(
            "cloning the repository exited {}:\n{}",
            cloned.exit_code,
            cloned.tail
        );
    }
    if !settings.prepare.trim().is_empty() {
        let left = settings.within.saturating_sub(started.elapsed());
        let script = format!("cd '{dir}' && {}", settings.prepare);
        let prepared = compute
            .run(builder, &settings.user, &script, &BTreeMap::new(), left)
            .await
            .context("running the prepare command")?;
        if prepared.exit_code != 0 {
            bail!(
                "the prepare command exited {}:\n{}",
                prepared.exit_code,
                prepared.tail
            );
        }
    }
    let synced = compute
        .run(
            builder,
            "root",
            "sync",
            &BTreeMap::new(),
            Duration::from_secs(300),
        )
        .await
        .context("writing the disk out")?;
    if synced.exit_code != 0 {
        bail!("sync exited {}", synced.exit_code);
    }
    compute.snapshot(&builder.id, name).await
}

/// Deletes the pool's templates older than `kept`.
async fn forget_older(compute: &Compute, pool: &str, kept: &Ours) {
    let all = match compute.snapshots().await {
        Ok(all) => all,
        Err(error) => {
            tracing::warn!(
                error = format!("{error:#}"),
                "listing templates failed; older ones stay until the next refresh"
            );
            return;
        }
    };
    for older in ours(pool, &all)
        .into_iter()
        .filter(|older| older.id != kept.id && older.at <= kept.at)
    {
        tracing::info!(template = %older.name, "an older warm template goes");
        if let Err(error) = compute.delete_template(&older.id).await {
            tracing::warn!(template = %older.name, error = format!("{error:#}"), "deleting an older template failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(id: &str, names: &[&str]) -> Snapshot {
        Snapshot {
            id: id.into(),
            names: names.iter().map(|&name| name.into()).collect(),
        }
    }

    #[test]
    fn a_pools_templates_are_read_from_their_names_oldest_first() {
        let all = [
            snapshot("a", &["ci-200-0123456789ab"]),
            snapshot("b", &["ci-100-ba9876543210"]),
            snapshot("c", &["ci-gpu-300-0123456789ab"]),
            snapshot("d", &["ci-300-short"]),
            snapshot("e", &["other"]),
            snapshot("f", &["cix-400-0123456789ab"]),
        ];
        let found = ours("ci", &all);
        let ids: Vec<&str> = found.iter().map(|ours| ours.id.as_str()).collect();
        assert_eq!(ids, ["b", "a"]);
        assert_eq!(found[1].commit, "0123456789ab");
        assert_eq!(found[1].at, 200);
        assert_eq!(ours("ci-gpu", &all).len(), 1);
    }

    #[test]
    fn the_clone_takes_its_token_from_the_environment_alone() {
        let script = clone_script(
            "https://github.com",
            "acme/web",
            &"a".repeat(40),
            "/home/runner/_work/web/web",
        );
        assert!(script.contains("git remote add origin 'https://github.com/acme/web'"));
        assert!(script.contains(&format!("--depth=1 origin {}", "a".repeat(40))));
        assert!(!script.to_lowercase().contains("token"));
        assert!(!script.contains("config "));
    }
}
