---
"@opengeni/react": patch
---

A turn parked on a usage limit now reads "Usage limit reached" with the guidance "Try again after your quota resets, or switch to another model or provider." It no longer shows a running clock or promises that the work continues automatically. Waits that need a person (reconnect, disabled accounts, an ineligible pinned account) keep their recorded reason and are not labelled a limit; they also show no clock. A work row with nothing to reveal (for example a turn parked before any visible work) renders without a chevron and is not a disclosure control, and the wait guidance stays visible when the work is expanded. Approval and agent waits and the Working clock are unchanged. `TurnSummaryStatus` gains an optional `guidance` line and `TurnSummary` an optional `expandable` prop.
