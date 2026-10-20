-- deployment-mode: rolling
-- A compute lease records why it drains and when its sandbox sleeps.
--
-- group_end_requested_at: a chat or workspace deletion ended the lease's
-- group. Its compute sandbox is then deleted without a workspace capture,
-- because nothing will restore it; a rotation or an archive capture still
-- captures first.
--
-- compute_asleep_since: the agent gateway reported the lease's current
-- compute sandbox asleep at this time (compute keeps its memory and disk
-- and runs no VM). Warm time accrues only while the sandbox is awake: no tick
-- accrues past this moment, and on waking the meter cursor moves forward by
-- exactly the time asleep.
--
-- Both are null for every other backend and for the previous release, which
-- never creates compute leases.

ALTER TABLE sandbox_leases
  ADD COLUMN IF NOT EXISTS group_end_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS compute_asleep_since timestamptz;
