---
"@opengeni/react": patch
---

The voice control says plainly whether voice can start. While the voice models load it reads "Checking voice" instead of a setup step from a placeholder model, a failed load reads "Voice couldn't load", and where the page may not use the microphone (an embedded frame without microphone permission) or the person blocked it, it says so and offers no Start button that would fail. `useRealtimeModelSelection()` returns `loadState`, which the voice controls take as `loadState`.

A new feature switch, `addCredits`, controls the new-chat page's "Add credits" button for billing managers. It is on in the `app` and `embed` presets, as before, and off in `companion`, so the Excel add-in no longer shows it; the credits notice still appears when a model's credits run out.
