import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** MCP auto-connect trusted issuers, their people, events, replays and signing
 * keys: five full-DML FORCE-RLS tables. */
export default {
  migration: "1263_mcp_auto_connect",
  forceRls: { fullDml: 5 },
} satisfies RuntimePostureMigration;
