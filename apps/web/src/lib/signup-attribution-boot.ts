import { retainSignupAttribution } from "./signup-attribution";

// Side-effect entry imported by main.tsx ahead of the router: capture
// first-touch campaign parameters in memory and consume one-shot auth return
// markers before TanStack Router caches the initial location.
if (typeof window !== "undefined") retainSignupAttribution(window);
