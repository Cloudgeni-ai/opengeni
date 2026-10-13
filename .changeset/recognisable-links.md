---
"@opengeni/react": patch
---

Links are now recognisable at rest. A new `og-link` utility gives text links a quiet resting underline tinted from the link's own colour, a full-ink underline on hover, and a focus outline, because the neutral grey palette cannot mark links by colour alone. Chat markdown links (web, artifact and sandbox file links), child-session links, usage-meter and viewer retry actions use it, and so do the web app's shared link primitives (`Button` link variant, help links, setting-row links, empty-state links) and inline text links across settings, capabilities, schedules and knowledge. The precompiled stylesheet ships the utility for hosts without Tailwind.
