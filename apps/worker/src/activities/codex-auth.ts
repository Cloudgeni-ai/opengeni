// db-backed Codex token lifecycle for a turn: proactive refresh, single-flight
// per credential instance, and permanent-failure status surfacing.
//
// The implementation now lives in @opengeni/db (packages/db/src/codex-token-resolver.ts)
// so the API process can drive the SAME refreshing resolver for the P2 /wham/usage
// quota-bar reads without duplicating the refresh-CAS / single-flight / RLS logic.
// This module re-exports it for back-compat, keeping the agent-turn.ts call site
// (buildCodexTokenResolver) unchanged.
export { buildCodexTokenResolver, type CodexAuthDeps } from "@opengeni/db";
