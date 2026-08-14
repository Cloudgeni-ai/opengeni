/** Five-second heartbeats get four missed intervals before another daemon may
 * claim the enrollment. Server time is authoritative. */
export const AGENT_CONNECTION_LEASE_MS = 20_000;
