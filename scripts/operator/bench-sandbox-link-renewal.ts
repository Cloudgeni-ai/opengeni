import { acquireSharedTestDatabase } from "@opengeni/testing/shared-pg";
import type postgres from "postgres";
import {
  createDb,
  createSandboxEnrollment,
  openSandboxAgentLink,
  renewSandboxAgentLink,
} from "../../packages/db/src";

const fixture = await acquireSharedTestDatabase("bench-sandbox-link-renewal");
if (!fixture) throw new Error("Real PostgreSQL required");
const client = createDb(fixture.appUrl, { max: 1 });
try {
  const [account] =
    await fixture.admin`insert into managed_accounts(name) values('Renewal fixture') returning id`;
  const [workspace] =
    await fixture.admin`insert into workspaces(account_id,name) values(${account!.id},'Renewal fixture') returning id`;
  await fixture.admin`insert into workspace_inference_controls(workspace_id,account_id) values(${workspace!.id},${account!.id})`;
  const enrollment = await createSandboxEnrollment(client.db, {
    accountId: account!.id,
    workspaceId: workspace!.id,
    enrollmentId: crypto.randomUUID(),
    sandboxGroupId: crypto.randomUUID(),
    hasDisplay: false,
    workspaceRoot: "/workspace",
  });
  const link = {
    workspaceId: workspace!.id,
    agentId: enrollment.id,
    epoch: 1,
    connectionInstanceId: crypto.randomUUID(),
    leaseMs: 20_000,
  };
  await openSandboxAgentLink(client.db, link);
  const driver = (client.db as unknown as { $client: postgres.Sql }).$client;
  let statements: string[] = [];
  driver.options.debug = (_id: number, text: string) => statements.push(text);
  for (let sample = 0; sample < 45; sample++) {
    statements = [];
    const start = performance.now();
    const result = await renewSandboxAgentLink(client.db, link);
    const ms = performance.now() - start;
    if (!result.renewed) throw new Error("Renewal unexpectedly refused");
    console.log(
      JSON.stringify({
        sample,
        ms,
        statements: statements.length,
        sql: sample === 5 ? statements : undefined,
      }),
    );
  }
} finally {
  await client.close();
  await fixture.release();
}
