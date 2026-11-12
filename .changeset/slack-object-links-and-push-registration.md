---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
"@opengeni/sdk": patch
---

Slack replies no longer show Opengeni links as raw Markdown. An image or link to an artifact (`![Preview](artifact:<id>)`, `[deck](artifact:<id>)`), a chat (`session:<id>`) or a console path now becomes a Slack link to that page in Opengeni, and a `sandbox:` path becomes its label. Markdown tables become an aligned code block. Operations an earlier release bound to other bytes keep them on retry.

Native app push registration now says why a deployment can't deliver to the app. `PUT /v1/native-app/push-device` answers 409 with `details.code` `native_push_unavailable` (`NATIVE_PUSH_UNAVAILABLE_DETAIL_CODE`, `isNativePushUnavailableError` in the SDK) when the app ID isn't in `OPENGENI_NATIVE_APP_IDS` or the platform has no push credentials, instead of a bare 400, or of accepting a registration that would never get a push. The iPhone app shows "This server isn't set up to send notifications to this app." instead of "Try again", shows a failed calls change under Calls from agents, and reports its APNs environment from its signing profile.
