/**
 * The in-chat connect cards the embedded conversation loads on demand, in one
 * lazy chunk: a separate dynamic entry per card would reshuffle how the
 * bundler groups shared UI, so eager pages would download code they never use.
 */
export { SessionMcpCapabilityCard } from "./session-mcp-capability-card";
export { SessionIntegrationCapabilityCard } from "./session-integration-capability-card";
