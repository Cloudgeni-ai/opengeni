export const OPEN_GENI_MOTION = Object.freeze({
  fast: "var(--og-duration-fast)",
  base: "var(--og-duration-base)",
  slow: "var(--og-duration-slow)",
  disclose: "var(--og-duration-disclose)",
  settle: "var(--og-duration-disclose-settle)",
  easeOut: "var(--og-ease-out)",
  easeInOut: "var(--og-ease-in-out)",
});

export type OpenGeniMotionToken = keyof typeof OPEN_GENI_MOTION;
