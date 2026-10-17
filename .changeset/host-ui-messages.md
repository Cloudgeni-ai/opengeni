---
"@opengeni/react": major
"@opengeni/react-native": major
---

Apps can now show the components in their own words and languages. Every label, notice and user-facing error in `@opengeni/react` and `@opengeni/react-native` comes from one typed message catalog: pass `locale` and `messages` to `OpenGeniProvider` (or `OpenGeniMessagesProvider` from the new DOM-free `@opengeni/react/messages` entry), with plural forms chosen per language and English as the fallback. `englishMessages` is the full default catalog for translation tooling, and `OpenGeniMessageCatalog` types a complete translation.

Breaking: default label objects that used to be constants are now functions of the translator (for example `defaultChatComposerMessages(t)`, `SESSION_GROUP_LABELS(t)`, `DEFAULT_SESSION_USAGE_LIMIT_LABELS(t)`, `defaultNativeTimelineMessages(t)`, `DEFAULT_OPENGENI_NATIVE_LABELS(t)`), and exported helpers that produce text take the translator first (for example `buildTimeline(t, events)`, `machineDisplayName(t, machine)`, `orgLabel(t, accountId, grants)`). Get it with `useOpenGeniText()` in components, or `createOpenGeniText()` elsewhere.
