<!-- docs-refs: record -->

# Voice dictation browser evidence (OPE-11)

Point-in-time deterministic UI evidence captured on 2026-07-19 with Google
Chrome 149.0.7827.196. The fixture renders the real `ChatComposer` and
`VoiceDictationControl`, but it never opens a microphone or calls a transcription
provider. Every screenshot contains synthetic copy only and is scrubbed of
credentials, user data, and provider responses.

Regenerate from the repository root:

```bash
OPE11_CAPTURE_EVIDENCE=1 \
  bun scripts/run-browser-e2e.ts ./test/e2e/transcription.browser.e2e.ts
```

Latest repeat verification: **2 tests passed, 49 assertions**. The additional
assertions pin zero page errors, zero overflow, and local-only requests after an
editable dictated final is sent; the visible capture matrix is unchanged.

The test runs every case with reduced-motion emulation and verifies:

- zero axe violations;
- zero page errors;
- zero horizontal overflow;
- stable accessible button names, live status/alert semantics, disabled state,
  and keyboard focus;
- partial and cancelled text never enters the textarea;
- final text enters the ordinary editable draft and can be edited and sent via
  the ordinary composer; and
- every browser request remains on the local fixture origin (no provider or
  external network call).

## Capture matrix

| File | Width | Theme | State / evidence |
|---|---:|---|---|
| `360-dark-partial.png` | 360 | Dark | Recording with ephemeral partial text; existing draft remains unchanged. |
| `360-light-permission.png` | 360 | Light | Microphone permission denial with an actionable alert and retry affordance. |
| `375-dark-cancelled.png` | 375 | Dark | Escape cancellation result; partial text is absent and the draft is preserved. |
| `375-dark-requesting.png` | 375 | Dark | Slow permission request with busy state and a cancel affordance. |
| `375-light-error.png` | 375 | Light | Sanitized provider error with retry affordance. |
| `768-dark-reconnecting.png` | 768 | Dark | Reconnecting status with retry timing. |
| `768-light-final.png` | 768 | Light | Final transcript appended to the ordinary editable textarea. |
| `768-light-final-edited-and-sent.png` | 768 | Light | Dictated text edited by the operator, then sent through the ordinary composer. |
| `1440-dark-listening.png` | 1440 | Dark | Recording state and visible keyboard focus on the mic control. |
| `1440-light-disabled.png` | 1440 | Light | Voice dictation unavailable while the normal composer remains visible. |
| `1440-light-idle.png` | 1440 | Light | Compact default mic affordance in the idle composer. |

The harness source is `packages/react/demo/transcription-harness.tsx`; the
repeatable browser specification is `test/e2e/transcription.browser.e2e.ts`.
These images are not evidence of provider quality, provider latency, real
microphone behavior, production deployment, or live production acceptance.
