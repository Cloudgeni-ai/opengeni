/** Rewrites the 0730/0732 probes and their claim implementations. Historical
 * fixtures withholding those probes must replay this tail after them too.
 * 0860 widens 0848's owner-only projections and rewrites the connected-command
 * claim and due probe this tail installs, so it replays after them. */
export const strictOwnerMaintenanceMigrationTail = [
  "0848_strict_owner_maintenance_probes.sql",
  "0849_strict_owner_maintenance_claims.sql",
  "0852_maintenance_predicate_privileges.sql",
  "0860_compute_commands_settle_by_push.sql",
] as const;
