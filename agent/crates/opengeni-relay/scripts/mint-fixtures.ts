/**
 * Regenerate the cross-stack token fixture
 * (agent/crates/opengeni-relay/tests/fixtures/ts_minted_tokens.txt).
 *
 * It mints an `ogs_` viewer stream token and an `ogr_` agent relay producer token
 * with the TypeScript control-plane mint (@opengeni/contracts), exactly as the live
 * enrollment + viewer paths do. The Rust relay's cross-stack test reads these and
 * asserts its verify accepts them — locking the §10.5 single-source token contract
 * so the TS mint and the Rust verify provably agree.
 *
 *   bun run agent/crates/opengeni-relay/scripts/mint-fixtures.ts
 *
 * The secret + claims are fixed and `exp` is 2100-01-01 so the committed fixture
 * never expires.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { signRelayToken, signStreamToken } from "@opengeni/contracts";

const secret = "cross-stack-fixture-secret-do-not-use-in-prod";
const exp = 4_102_444_800; // 2100-01-01
const workspaceId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const viewerId = "33333333-3333-4333-8333-333333333333";
const agentId = "44444444-4444-4444-8444-444444444444";
const leaseEpoch = 7;
const port = 7681;

const ogs = await signStreamToken(secret, {
  workspaceId,
  sessionId,
  viewerId,
  leaseEpoch,
  mode: "view",
  port,
  exp,
});
const ogr = await signRelayToken(secret, { workspaceId, agentId, exp });

const body = [
  "# Cross-stack token fixtures — minted by the TypeScript control plane",
  "# (packages/contracts signStreamToken / signRelayToken) and verified by the Rust",
  "# relay (opengeni_relay::token). This file LOCKS the §10.5 single-source token",
  "# contract: if the TS HMAC envelope and the Rust verify ever drift, the cross-stack",
  "# test (tests/cross_stack_token.rs) fails.",
  "#",
  "# Regenerate with: bun run agent/crates/opengeni-relay/scripts/mint-fixtures.ts",
  "# (the secret + claims are fixed; exp is 2100-01-01 so the fixture never expires).",
  `secret=${secret}`,
  `exp=${exp}`,
  `workspaceId=${workspaceId}`,
  `sessionId=${sessionId}`,
  `viewerId=${viewerId}`,
  `agentId=${agentId}`,
  `leaseEpoch=${leaseEpoch}`,
  `port=${port}`,
  `ogs=${ogs}`,
  `ogr=${ogr}`,
  "",
].join("\n");

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "tests", "fixtures", "ts_minted_tokens.txt");
writeFileSync(out, body);
console.log(`wrote ${out}`);
