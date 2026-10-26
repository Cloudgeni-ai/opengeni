# 23. GitHub Actions runner pools: a fresh sandbox per job

Status: Accepted, 2026-10-27

## Context

CI on persistent self-hosted runners is fast because they keep their
caches, and fragile for the same reason: jobs share a machine, leak state
into each other and need a person to clean up, and the machine is sized
for the busiest hour. A sandbox per job is clean every time and costs
nothing when no job runs, but only fast if it starts warm: the
repository, its dependencies and build caches already there.

GitHub offers runner scale sets for autoscalers: a named set of
just-in-time runners that workflows target by label. GitHub decides which
jobs the set takes and tells its listener over a long-polled message
queue; the autoscaler only starts and ends runners. It is the protocol
behind Actions Runner Controller and GitHub's own scale set client
(`actions/scaleset`), which is published for autoscalers outside
Kubernetes. Webhooks are the other way in, and GitHub itself warns their
delivery can be late or missed.

## Decision

- **A separate service, `compute-runners`**, one process per pool. It
  speaks GitHub's scale set API and compute's E2B API, as any client does;
  the control service learns nothing about GitHub. It ships in the control
  image beside `compute-control`, and the Helm chart runs each pool as a
  Deployment (`computeRunners.pools`).
- **The pool is a scale set**, found by name in its runner group or
  created, with the pool's labels. It authenticates as a GitHub App
  installation, or with a token, for a repository or an organization. The
  service never deletes the set.
- **One listener per set.** GitHub allows one message session per set and
  refuses a second, so a second replica waits and tries again: a standby,
  with no lock of our own. Each message is handled, then deleted: jobs
  offered are acquired, and the pool is scaled to the jobs GitHub has
  assigned it plus the idle runners asked for, up to its maximum. As in
  GitHub's own listener, a message whose jobs could not be acquired is
  neither handled nor deleted, and the next poll asks from the same place,
  so it is offered again; a session token that expired is refreshed once
  for the acquisition. After five failures in a row the session is given
  up and opened again.
- **A runner is a sandbox.** Each gets a just-in-time configuration from
  GitHub, then a sandbox from the pool's template with that configuration
  in its environment and its runner's name and id in its metadata. The
  image's command starts the runner; the reference image is
  `docker/github-runner.Dockerfile`, released as
  `opengeni-compute-github-runner`. Its start command counts the runner as
  a running command (ADR 3), so a job that waits quietly is never put to
  sleep, and runs Docker for the job. A runner takes one job and ends.
- **A sandbox ends with its job**: at once when GitHub reports the job
  completed, and at the latest when a reconciliation finds its runner gone
  from GitHub (ephemeral runners are removed when their job ends). An
  unused runner beyond what the pool needs is removed from GitHub, then its
  sandbox killed; GitHub refuses to remove a busy runner
  (`JobStillRunningException`), which keeps its job. Any other refusal
  (rate limits, a lapsed token) is an error, and the runner is asked about
  again at the next check. A registration whose sandbox is gone is removed,
  and so is one of the pool's names with no sandbox at all (the service
  stopped between registering it and starting its sandbox). Every sandbox
  has a timeout, the pool's longest job, in case all else fails.
- **No state of its own.** What runs is read back from the sandboxes'
  metadata and GitHub every 30 s and at start, so a restart or a standby
  taking over loses nothing and never leaks a sandbox or a registration. A
  standby taking over also adopts the pool's newest template, which the
  replica before it may have made.
- **Warm templates refreshed from the default branch.** Given a repository
  and a prepare command, the service watches the branch. When it moves (and
  at most every `--warm-every`), it starts a sandbox from the base template,
  clones the repository at that commit where `actions/checkout` puts it,
  runs the prepare command there (install dependencies, build once to fill
  caches), and saves the sandbox as a template (ADR 22). New runners start
  from the newest; older templates of the pool are deleted, and an image
  stays while a sandbox still uses it. A failed refresh leaves the last
  good template in use. The clone's token is given to that one command,
  never written to the disk the template keeps.
  `actions/checkout` cleans untracked files by default, which would delete
  the prepared dependencies: warm workflows check out with `clean: false`.
- **A build cache in object storage.** The service serves Turborepo's
  remote cache API, keeping artifacts in a bucket under the pool's name,
  and gives runners its address and a per-pool token in their
  environment, so `turbo` shares task results between jobs and runs with
  no change to workflows. Artifacts expire after `--cache-days` without a
  read. Runners reach the cache from their hosts, outside the cluster, so
  it is served on an address of its own, guarded by the token.

## Consequences

- A job starts on a clean machine with the default branch's dependencies
  and caches already on its disk; a pull request only rebuilds what it
  changed, and shares what one job built with the next through the cache.
- Jobs are isolated from each other by a VM, not a container, so they may
  run Docker and change the system freely.
- A runner costs a sandbox start (seconds) plus the runner's own start.
  Idle runners (`--min-idle`) hide that at the price of their memory.
- The pool holds no lock: if GitHub ever let two sessions in, two
  listeners would each scale for the same jobs, and the surplus idle
  runners would be removed again as excess.
- Every job of a pool shares its cache and its token, so a job can write
  what the next one reads. Workflows from untrusted forks need a pool of
  their own, with its own cache or none.
- Warm templates keep the guest version of the sandbox they were prepared
  in (ADR 22); refreshing from a base of a newer release moves them on.
- Only GitHub Actions is served. Other CI systems with just-in-time
  runners (GitLab, Buildkite) would be further services of the same shape.
