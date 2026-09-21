import { parseArgs } from "node:util";
import { z } from "zod";
import { createDb, reconcileHistoricalChildReadAcknowledgments } from "@opengeni/db";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    workspace: { type: "string" },
    parent: { type: "string" },
    after: { type: "string" },
    limit: { type: "string" },
    apply: { type: "boolean", default: false },
  },
});
const input = z
  .object({
    workspaceId: z.string().uuid(),
    parentSessionId: z.string().uuid(),
    afterSequence: z.coerce.number().int().nonnegative(),
    limit: z.coerce.number().int().min(1).max(100),
    apply: z.boolean(),
  })
  .parse({
    workspaceId: values.workspace,
    parentSessionId: values.parent,
    afterSequence: values.after ?? 0,
    limit: values.limit ?? 50,
    apply: values.apply,
  });
const url = process.env.OPENGENI_DATABASE_URL;
if (!url)
  throw new Error("Set OPENGENI_DATABASE_URL explicitly; this script does not load dotenv files");
const client = createDb(url);
try {
  // Content-free evidence counts only. `applied` means apply mode was requested,
  // not that every proof advanced a cursor (human intent and holes can prevent it).
  console.log(
    JSON.stringify(await reconcileHistoricalChildReadAcknowledgments(client.db, input), null, 2),
  );
} finally {
  await client.close();
}
