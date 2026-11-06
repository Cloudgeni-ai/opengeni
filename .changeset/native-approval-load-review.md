---
"@opengeni/react-native": minor
"@opengeni/react": patch
---

React Native hosts can now show readable approval cards. `NativeSessionScreen` and `ApprovalStrip` take `loadReview`, the same hook and the same `ToolActionReview` as the web `ApprovalSurface`: return the server's review from `client.getToolActionReview`, or your own plain title, consequence and the fields worth reading, so a write tool whose arguments are only identifiers no longer shows its raw title and identifiers. The review only changes what the card says; the approval decided is always the one the agent asked for, and a review for another approval is ignored. While it loads the card shows the tool's title and holds Approve (Reject still works); resolving `null` or a 404 keeps the standard card; any other failure shows the standard card, still decidable, with Try again. A loaded review's `availableActions`, `approvedBy`, samples and protected fields now show on the native card as they do on the web. On the web, `ApprovalSurface`'s `loadReview` may now resolve `null` to keep the standard card, so one loader serves both.
