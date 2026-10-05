---
"@opengeni/react": patch
---

Every `@opengeni/react` entry is now marked `"use client"`, so a Next.js App Router Server Component (for example `app/page.tsx`) can render `<OpenGeniChat />` directly. Before, `next build` failed while prerendering with `TypeError: createContext is not a function`, and the host had to wrap the chat in its own client component.
