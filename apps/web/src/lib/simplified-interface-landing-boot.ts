import { retainLandingSimplifiedInterface } from "./simplified-interface-landing";

// Side-effect entry imported by main.tsx ahead of the router: keep the
// simplified-interface flag the landing URL carries and drop the parameter
// before TanStack Router caches the initial location.
if (typeof window !== "undefined") retainLandingSimplifiedInterface(window);
