// Compares one gateway tick's renewals done per claim (one transaction per
// sandbox) with the batched form, for a fleet of open sandbox links.
// Usage: bun scripts/operator/bench-sandbox-link-renewal.ts [sandboxes=2000]
import { acquireSharedTestDatabase } from "@opengeni/testing/shared-pg";
import type postgres from "postgres";
import {
  createDb,
  createSandboxEnrollment,
  openSandboxAgentLink,
  renewSandboxAgentLink,
  renewSandboxAgentLinks,
  SANDBOX_AGENT_LINK_RENEW_BATCH_MAX,
} from "../../packages/db/src";

const sandboxes = Number(process.argv[2] ?? 2000);
const fixture = await acquireSharedTestDatabase("bench-sandbox-link-renewal");
if (!fixture) throw new Error("Real PostgreSQL required");
const client = createDb(fixture.appUrl, { max: 16 });
try {
  const [account] =
    await fixture.admin`insert into managed_accounts(name) values('Renewal fixture') returning id`;
  const [workspace] =
    await fixture.admin`insert into workspaces(account_id,name) values(${account!.id},'Renewal fixture') returning id`;
  await fixture.admin`insert into workspace_inference_controls(workspace_id,account_id) values(${workspace!.id},${account!.id})`;
  const workspaceId = workspace!.id as string;
  const claims: Array<{ agentId: string; epoch: number; connectionInstanceId: string }> = [];
  for (let index = 0; index < sandboxes; index++) {
    const enrollment = await createSandboxEnrollment(client.db, {
      accountId: account!.id,
      workspaceId,
      enrollmentId: crypto.randomUUID(),
      sandboxGroupId: crypto.randomUUID(),
      hasDisplay: false,
      workspaceRoot: "/workspace",
    });
    const claim = { agentId: enrollment.id, epoch: 1, connectionInstanceId: crypto.randomUUID() };
    await openSandboxAgentLink(client.db, { ...claim, workspaceId, leaseMs: 20_000 });
    claims.push(claim);
  }
  const driver = (client.db as unknown as { $client: postgres.Sql }).$client;
  let statements = 0;
  driver.options.debug = () => {
    statements++;
  };
  const tick = async (mode: "per_claim" | "batched") => {
    statements = 0;
    const startedAt = performance.now();
    if (mode === "per_claim") {
      // The former gateway: 16 renewals in flight, one transaction each.
      let next = 0;
      await Promise.all(
        Array.from({ length: 16 }, async () => {
          while (next < claims.length) {
            const claim = claims[next++]!;
            await renewSandboxAgentLink(client.db, { ...claim, workspaceId, leaseMs: 20_000 });
          }
        }),
      );
    } else {
      const batches: (typeof claims)[] = [];
      for (let start = 0; start < claims.length; start += 250) {
        batches.push(
          claims.slice(start, start + Math.min(250, SANDBOX_AGENT_LINK_RENEW_BATCH_MAX)),
        );
      }
      let next = 0;
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          while (next < batches.length) {
            await renewSandboxAgentLinks(client.db, {
              workspaceId,
              leaseMs: 20_000,
              claims: batches[next++]!,
            });
          }
        }),
      );
    }
    return { mode, sandboxes, ms: Math.round(performance.now() - startedAt), statements };
  };
  for (let round = 0; round < 3; round++) {
    console.log(JSON.stringify(await tick("per_claim")));
    console.log(JSON.stringify(await tick("batched")));
  }
} finally {
  await client.close();
  await fixture.release();
}
