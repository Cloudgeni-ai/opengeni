---
"@opengeni/react": patch
---

Each provider row in the realtime model picker has its own `data-testid` (`realtime-model-provider-opengeni`, `-codex`, `-supergrok`, `-gateway`, `-elevenlabs`). The rows were keyed by billing class, so the AI Gateway and ElevenLabs rows, which both bill to the workspace's own key, shared one id.
