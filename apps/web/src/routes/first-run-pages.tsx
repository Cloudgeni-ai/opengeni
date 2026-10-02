/**
 * One lazy entry for the first-run pages (Get started, the playground, "Let's
 * build your first agent") and the
 * Get started card the new-chat page loads on demand. A single entry keeps
 * their shared code in one place instead of re-bucketing it into the
 * direct-session graph.
 */
export { GetStartedCard } from "@/components/onboarding/get-started-card";
export { FirstAgentRoute } from "@/routes/first-agent";
export { GetStartedRoute } from "@/routes/get-started";
export { PlaygroundRoute } from "@/routes/playground";
