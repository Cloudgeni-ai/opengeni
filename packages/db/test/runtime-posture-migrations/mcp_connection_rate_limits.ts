import type { RuntimePostureMigration } from "../runtime-posture-migrations";

/** Shared MCP rate limits: one content-free full-DML FORCE-RLS table. */
export default {
  migration: "1522_mcp_connection_rate_limits",
  forceRls: { fullDml: 1 },
} satisfies RuntimePostureMigration;
