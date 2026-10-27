---
"@opengeni/react": patch
"@opengeni/contracts": patch
"@opengeni/db": patch
---

`OnboardingUseCase` gains `everyday`, with `isOnboardingUseCase`. The self-service organization setup request accepts `useCase: "everyday"`, and migration 0999 lets the organization keep that answer as itself (the first answer still wins). In the web app, "How do you want to use Opengeni?" now leads with "Get help with everyday things", which creates an organization named after the person and goes straight to the model step and their first chat; the two existing choices are unchanged.
