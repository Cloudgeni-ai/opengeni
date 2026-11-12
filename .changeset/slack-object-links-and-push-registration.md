---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
"@opengeni/react-native": patch
---

Slack replies no longer show Opengeni links as raw Markdown. An image or link to an artifact (`![Preview](artifact:<id>)`, `[deck](artifact:<id>)`), a chat (`session:<id>`) or a console path now becomes a Slack link to that page in Opengeni, and a `sandbox:` path becomes its label. A clickable thumbnail links with its alt text. Markdown tables become an aligned code block, and links in their cells keep their address. Operations an earlier release bound to other bytes keep them on retry. The console's file page opens a Site when an `artifact:<uuid>` link names one, since Sites share the UUID format.

Native app push registration now says why a deployment can't deliver to the app. `PUT /v1/native-app/push-device` answers 409 with `details.code` `native_push_unavailable` (`NATIVE_PUSH_UNAVAILABLE_DETAIL_CODE`, `isNativePushUnavailableError` in the SDK) when the app ID isn't in `OPENGENI_NATIVE_APP_IDS` or the platform has no push credentials, instead of a bare 400, or of accepting a registration that would never get a push. The iPhone app shows "This server isn't set up to send notifications to this app." instead of "Try again", shows a failed calls change under Calls from agents, and reports its APNs environment from its signing profile, also when it re-registers rotated tokens in the background (it re-registers a stored registration for the wrong environment too).

The iPhone message field grows with its text again, up to six lines (four with large text on a small screen, and never more than half the room above the keyboard) before it scrolls. On the new architecture iOS reports a field's content size only when its layout changes, so the fixed height the composer set from it never grew past one line and earlier lines scrolled out of view.
