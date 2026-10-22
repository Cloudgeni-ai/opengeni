---
"@opengeni/react": patch
---

The in-flight shimmer on "Working", running tools, running agents, transcription and timeline loading labels no longer keeps the main thread busy. It used to animate a text-clipped gradient, which repainted the text on every frame for as long as anything was running and slowed typing and scrolling in long chats. The new `ShimmerText` slides a masked highlight copy with transforms only, so the compositor runs it. It looks the same and still turns off for reduced motion and forced colors. The `og-shimmer-text` class remains for host markup.
