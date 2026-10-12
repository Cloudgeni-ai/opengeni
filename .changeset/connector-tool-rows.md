---
"@opengeni/react": minor
"@opengeni/sdk": minor
---

Connector tool rows read short. A connector tool call now shows the connector's logo (when the host passes `resolveProviderLogo`, otherwise the usual icon) and a short label such as "List issues · Done". The account is named only when the connector has more than one account in the turn ("Get issue · kari@example.com"); approval cards say "Linear" or "Linear · kari@example.com" instead of the full route label. Tool display metadata gains optional `connector` and `providerDomain` fields, and older events with the long route label show just the tool name. The model still gets the full account description.
