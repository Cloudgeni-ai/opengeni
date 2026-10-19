/** Rewrites the 0730/0732 probes and their claim implementations. Historical
 * fixtures withholding those probes must replay this tail after them too. */
export const strictOwnerMaintenanceMigrationTail = [
  "0848_strict_owner_maintenance_probes.sql",
  "0849_strict_owner_maintenance_claims.sql",
  "0852_maintenance_predicate_privileges.sql",
] as const;
