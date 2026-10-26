# Main CI on GCP self-hosted runners

Main CI (`ci.yml` for pushes to `main`, its weekly schedule and Version-PR
`workflow_dispatch` on `main`) can run its Linux jobs on ephemeral GCP runners
instead of the GitHub-hosted pool. The Team plan's hosted pool (60 concurrent
jobs for the organization) is shared with PR CI and Batch CI, and main CI
(about 50 jobs per run) used to saturate it after every landing.

This is a temporary catch-up aid. Once the PR backlog is cleared, switch it off
and delete the GCP resources (see "Turning it off").

## Switch

The `plan` job (always GitHub-hosted) selects the pool in its first step and
exposes it as `needs.plan.outputs.runner_pool`. It selects `gcp` only when all of
these hold, and `hosted` otherwise:

- the run is a `push`, `schedule` or `workflow_dispatch` run of this repository on
  `refs/heads/main`;
- the repository variable `MAIN_CI_RUNNER` is `gcp`;
- the repository variable `GCP_RUNNER_HEARTBEAT` (epoch seconds, refreshed every
  minute by the runner controller after a healthy poll) is at most 5 minutes
  older than the run attempt's start. GitHub captures `vars` when the attempt is
  created, so the check uses the attempt's `run_started_at` (from the API with
  the job token), not the time `plan` happens to start; if that lookup fails it
  uses the current time.

The heavy jobs (shards, suites, contracts, deployment and image builds) use:

```yaml
runs-on: ${{ needs.plan.outputs.runner_pool == 'gcp' && fromJSON('["self-hosted","linux","x64","opengeni-main-gcp"]') || 'ubuntu-latest' }}
```

`automation-admission`, `plan`, `merge-content`, `test`, `automation-report` and
`full-green` stay on `ubuntu-latest`, and so does `api-image`, which signs the
agent with `public-release` credentials on main pushes: release signing
credentials never reach a self-hosted runner.

- Enable: `gh variable set MAIN_CI_RUNNER -R Cloudgeni-ai/opengeni --body gcp`
- Roll back (one step): `gh variable set MAIN_CI_RUNNER -R Cloudgeni-ai/opengeni --body hosted`

The choice is made once per run by `plan`, so a change applies to the next run.
The controller withholds the heartbeat when it cannot create runners or when a
labelled job has waited more than 10 minutes, so the next run is hosted without
anyone acting. Pull-request runs, pushes to `production` and every other
workflow always use GitHub-hosted runners.
`scripts/ci/gcp-main-runners-workflow.test.ts` keeps the label out of every
other workflow and action and exercises the selection step.

### A run stuck waiting for GCP runners

A run whose `plan` already chose `gcp` keeps waiting if the pool dies
afterwards. Its queued jobs also hold the merge batcher, which counts queued
main jobs. To recover:

1. `gh variable set MAIN_CI_RUNNER -R Cloudgeni-ai/opengeni --body hosted`
2. Cancel the stuck run (`gh run cancel <run-id> -R Cloudgeni-ai/opengeni`).
3. Re-run **all** jobs (`gh run rerun <run-id> -R Cloudgeni-ai/opengeni`). Re-running only the
   failed jobs reuses `plan`'s recorded `runner_pool=gcp` and queues on the dead
   pool again.

## Turning it off

1. `gh variable set MAIN_CI_RUNNER -R Cloudgeni-ai/opengeni --body hosted`
   (main CI is hosted from the next run).
2. After in-flight GCP runs finish (or are cancelled), delete the GCP resources
   in project `cloudgeni-gecko` (the controller's source is on its VM at
   `/opt/gh-runner-controller/controller.ts`):

   ```bash
   P=cloudgeni-gecko Z=europe-west1-b R=europe-west1
   gcloud compute instances delete opengeni-gh-runner-controller --project $P --zone $Z --quiet
   gcloud compute instances list --project $P --filter=labels.purpose=gh-runner --format='value(name)' \
     | xargs -r gcloud compute instances delete --project $P --zone $Z --quiet
   gcloud compute images list --project $P --filter=family=opengeni-gh-runner --format='value(name)' \
     | xargs -r gcloud compute images delete --project $P --quiet
   gcloud compute routers nats delete gh-runners-nat --router gh-runners-router --region $R --project $P --quiet
   gcloud compute routers delete gh-runners-router --region $R --project $P --quiet
   gcloud compute firewall-rules delete gh-runners-deny-ingress --project $P --quiet
   gcloud compute networks subnets delete gh-runners-ew1 --region $R --project $P --quiet
   gcloud compute networks delete gh-runners --project $P --quiet
   gcloud projects remove-iam-policy-binding $P --role=roles/compute.instanceAdmin.v1 --condition=None \
     --member=serviceAccount:gh-runner-controller@$P.iam.gserviceaccount.com
   gcloud iam service-accounts delete gh-runner-controller@$P.iam.gserviceaccount.com --project $P --quiet
   ```

3. Delete the org runner group and the variables:
   `gh api -X DELETE orgs/Cloudgeni-ai/actions/runner-groups/<id of opengeni-main-gcp>`,
   `gh variable delete GCP_RUNNER_HEARTBEAT -R Cloudgeni-ai/opengeni` and
   `gh variable delete MAIN_CI_RUNNER -R Cloudgeni-ai/opengeni`.
4. A follow-up PR can restore `runs-on: ubuntu-latest` and remove the selection
   step; it is not required for the pool to be off.

## Runners

- One job per runner: a controller creates a fresh GCE VM for each queued job
  that requests `opengeni-main-gcp`, registers it with a single-use JIT
  configuration, and deletes it after the job (the VM powers off when the
  runner exits).
- Image family `opengeni-gh-runner` (Ubuntu 24.04 with docker, buildx, compose,
  node 22, Rust, gh, helm, kind, kubectl, xvfb, Google Chrome and the actions
  runner); runner user `runner` with passwordless sudo, like the hosted image.
  Docker Hub pulls (daemon and buildx builders) go through `mirror.gcr.io`.
- Isolated `gh-runners` VPC: no inbound traffic, egress through Cloud NAT, no
  GCP service account and no credentials on the VM besides its JIT config.
- Machines: `n2-standard-4` (4 vCPUs and 16 GB, the shape of `ubuntu-latest`
  for public repositories, so test concurrency matches hosted runs) with 150 GB
  pd-ssd, falling back to `c2d`, `n2d` and `e2` 4-vCPU types on quota, at most
  60 at once. About $0.25 per busy runner hour; the controller and NAT cost
  about $0.07 per hour while idle.

## Fork and pull-request safety

- Org runner group `opengeni-main-gcp` admits only this repository and only the
  workflow `Cloudgeni-ai/opengeni/.github/workflows/ci.yml@refs/heads/main`, so
  fork PRs (which run from `refs/pull/<n>/merge`) cannot be assigned these runners
  even if a PR edits a workflow to request the label.
- The controller only creates runners for queued jobs of `ci.yml` runs on `main`
  with event `push`, `schedule` or `workflow_dispatch` from this repository.
- A job-started hook on every runner refuses any job whose repository, event or
  `GITHUB_WORKFLOW_REF` is not the allowed one before any step runs.

## Merge batcher

Self-hosted jobs do not hold GitHub-hosted runners. Until the batcher's
capacity model excludes jobs labelled `self-hosted` (a separate change; see
`docs/merge-batcher.md`), it still counts main CI's GCP jobs as hosted demand,
so this change frees hosted capacity for PR CI first and for Batch CI only
once that batcher change is deployed.
