import type { OwnerMigratedTestDatabase } from "@opengeni/testing";
import { MANAGED_BROWSER_SESSION_CAPABILITIES } from "@opengeni/db";

export async function seedBrowserDeadlineCheckpoint(owned: OwnerMigratedTestDatabase, options: { checkpoint?: boolean; rotation?: string } = {}) {
  const accountId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const sandboxGroupId = crypto.randomUUID();
  const leaseId = crypto.randomUUID();
  const browserSessionId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const controllerGeneration = crypto.randomUUID();
  const instanceId = `deadline-fixture-${crypto.randomUUID()}`;
  await owned.admin.begin(async (tx) => {
    await tx`insert into managed_accounts (id, name) values (${accountId}, 'Checkpoint test')`;
    await tx`insert into workspaces (id, account_id, name) values (${workspaceId}, ${accountId}, 'Checkpoint test')`;
    await tx`insert into workspace_inference_controls (workspace_id, account_id) values (${workspaceId}, ${accountId})`;
    await tx`insert into workspace_interaction_revisions (workspace_id, account_id) values (${workspaceId}, ${accountId})`;
    await tx`insert into sandbox_leases (
      id, account_id, workspace_id, sandbox_group_id, liveness, instance_id, backend,
      lease_epoch, expires_at, refcount, provider_created_at, provider_deadline_at,
      rotation_requested_at, rotation_reason, resume_backend_id, resume_state
    ) values (${leaseId}, ${accountId}, ${workspaceId}, ${sandboxGroupId}, 'warm', ${instanceId},
      'modal', 1, now() + interval '1 hour', 1, now() - interval '23 hours',
      now() + interval '1 hour', now(), ${options.rotation ?? "provider_deadline"}, 'modal',
      ${tx.json({ sessionState: { providerState: { sandboxId: instanceId } } })})`;
    await tx`insert into interaction_operations (
      operation_id, account_id, workspace_id, resource_kind, resource_id, kind,
      request_digest, state, controller_generation, actor_subject_id, dispatched_at, settled_at
    ) values (${operationId}, ${accountId}, ${workspaceId}, 'browser_session', ${browserSessionId},
      'create', ${"a".repeat(64)}, 'completed', ${controllerGeneration}, 'fixture-human', now(), now())`;
    await tx`insert into browser_sessions (
      id, account_id, workspace_id, name, lifecycle, placement_kind, sandbox_group_id,
      controller_host_sandbox_group_id, controller_id, controller_generation,
      placement_instance_id, driver_id, engine, headless, capabilities,
      create_operation_id, created_by_subject_id, controller_heartbeat_at
    ) values (${browserSessionId}, ${accountId}, ${workspaceId}, 'Checkpoint fixture', 'active',
      'sandbox_group', ${sandboxGroupId}, ${sandboxGroupId}, 'fixture-browserd', ${controllerGeneration},
      ${instanceId}, 'opengeni.cdp.v1', 'chromium', true,
      ${tx.json({ ...MANAGED_BROWSER_SESSION_CAPABILITIES, privateCheckpoint: options.checkpoint ?? true })},
      ${operationId}, 'fixture-human', now())`;
    await tx`insert into sandbox_lease_holders (
      account_id, workspace_id, lease_id, kind, holder_id, last_heartbeat_at
    ) values (${accountId}, ${workspaceId}, ${leaseId}, 'interaction',
      ${`browser-session:${browserSessionId}`}, now())`;
  });
  return {
    accountId,
    workspaceId,
    sandboxGroupId,
    leaseId,
    leaseEpoch: 1,
    instanceId,
    browserSessionId,
    controllerGeneration,
  };
}
