# Read-only database paths

Idle clients must not turn authorization checks into durable writes. Keep live
authority and the existing write fences; remove writes that only establish a
read of facts the caller is already allowed to ask about.

## Measured causes

Repeated API-key authentication updates `last_used_at` and `updated_at` on every
request. Allowance and task-budget reads insert and delete temporary capability
rows. The subscription organization-admin predicate does the same just to read
the current account/subject's membership. Idle maintenance separately opens
inventory capabilities and refreshes unchanged allowance snapshots.

Transaction commits are not a write metric: read-only transactions also commit.
Verification uses `pg_stat_user_tables` deltas, checks for an assigned transaction
ID in read-only probes, and keeps maintenance separate from interactive reads.

## Design

API-key authentication reads the live key and workspace scope in one read-only
repeatable-read snapshot. This prevents mixed old/new permissions without a row
lock. A separate conditional write records last use at most once per minute per
key across replicas. No authorization or revocation decision is cached.
The touch skips locked rows and failures are diagnostic only; it never changes
the key's policy `updatedAt`. Busy keys may therefore have older last-use
telemetry, without changing authentication.

The subscription admin helper becomes a stable read of the same membership,
backed by an owner-only SELECT policy restricted to the exact current account
and subject, and to active, non-revoked owner/admin memberships. Runtime roles
retain no direct membership-table access. Membership
status and revocation remain live. Accepted-authority and mutation/fence
capabilities are unchanged; no caller-set marker or signed-token system is added.

Allowance `get`/`state` and existing task-counter reads use SELECT-only owner
policies bounded to the current account, workspace and data schema. Private
tables keep FORCE RLS and no runtime grants. The allowance advisory fence stays
in place; a pure state read no longer takes a workspace tuple lock. Task reads
that initialize a legacy counter, prepare an import or open provider custody
still acquire the original transaction capability before writing. Existing
mutation and locking-read policies remain capability-backed.

Maintenance first reads a private, content-free scheduling projection. With no
due work it returns before allocating a transaction ID or inserting an inventory
capability. Source-row triggers maintain the projection transactionally; the
original capability-backed source rows still decide what maintenance may do.
The projection has no runtime or PUBLIC privileges, including column grants.
It is deliberately not FORCE-RLS: a global due probe under a strict owner must
be able to see its scheduling hints without manufacturing a grant to read them.
Provisioning and runtime posture enforce this private boundary.

Allowance maintenance now schedules the next period boundary or unspent grant
expiry, rather than rewriting every configured workspace each minute. Mutations
that affect usage already arm maintenance. Eligibility changes in organization
memberships, workspace memberships, external identities and the local-account
identity increment an account revision in the same transaction. Unrelated edits
do not. Account deletion removes that marker.

Maintenance only reads those revisions: it never locks or writes an account
marker while holding workspace usage locks. A source-row trigger projects the
revision observed by its member-page cursor; a newer membership revision resets
the cursor. The completed revision advances only after the final page. A change
racing enumeration remains newer than its checkpoint, so it cannot be lost.
Revision-behind work uses the membership-change time as its effective deadline,
not a future period boundary. Error retries retain their existing backoff.
Import and pending-receipt deadlines use the same private scheduling index.
Each pending receipt consequently adds a small index insert and delete to its
real custody lifecycle. Membership changes add one revision update per affected
account, and due-policy changes update their scheduling projection. This moves
bookkeeping to actual changes instead of every idle poll; it is not write-free
accounting.

Live allowance admission checks and member-usage enumeration still acquire the
original short-lived read capability. They inspect the canonical current member
predicate, not a cached authorization list. These are actual-work/admin reads,
not the idle state-polling path. Other tenancy, writer and subscription custody
capabilities remain unchanged. This change does not promise zero writes during
real work or remove all database transactions.

## Verification

Use a non-superuser, non-BYPASSRLS migration owner as well as the application
role. Test active admin/member/revoked/wrong-account predicates, read-only
transactions, no assigned transaction ID, zero probe-table writes, API-key
concurrent touches and immediate revocation/expiry. Compare a realistic paced
polling workload and idle maintenance before/after, not only hot-loop timings.
