---
"@opengeni/react": patch
---

Send refusals and chat status lines no longer end with "Your message is saved." (or "Your message and attachments are saved."). The message is already visible in the chat or the composer. This covers model, repository, speed, billing, usage-limit and Site-assistant refusals, the provider-retry notice, and the "Unable to start yet" and "No agent turn is running yet" lines. The connector-account refusal now ends "then edit and send your message." `COMPOSER_MODEL_UNAVAILABLE_MESSAGE`, `COMPOSER_ACCOUNT_UNAVAILABLE_MESSAGE` and `COMPOSER_SESSION_USAGE_LIMIT_MESSAGE` carry the shorter text. A refusal restored from storage in the earlier wording is still recognized.
