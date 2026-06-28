/**
 * `@opengeni/agent-proto` — generated TypeScript wire-protocol types for the
 * OpenGeni self-hosted agent.
 *
 * This is the **control-plane side** of the single-source-of-truth wire protocol
 * defined once in `agent/proto/opengeni_agent.proto`. The types here are
 * code-generated (ts-proto) from that schema; the SAME schema generates the Rust
 * (`prost`) types the agent uses. Because both stacks are generated from the one
 * IDL, the control plane and the agent can never drift — proven by the
 * cross-stack round-trip test (`test/roundtrip.test.ts`).
 *
 * Do not edit `src/gen/*` by hand; regenerate via `bun run --filter
 * @opengeni/agent-proto codegen` (or `agent/scripts/codegen.sh` to regenerate
 * both Rust and TS at once).
 */

export * from "./gen/opengeni_agent";
