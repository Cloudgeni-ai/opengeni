# Account line on a connector's only account

No system-prompt text changes. Tools of a connector with a single account in
the turn now carry an account line, as tools of a connector with several
accounts already did. It reuses that line's form (`Account: <account>.`) and
its first sentence (`Use only this account.`); the default-account sentence is
left out because there is nothing to choose between.

Tool description, first line, on every tool of a connector's only connected
account (MCP connectors and API integrations alike; +34 bytes plus the
account label's bytes per tool, for example +80 bytes for
`Outlook Calendar — iris@example.com · Yours`):

```text
+ Account: <connector> — <identity> · <Yours|Shared>. Use only this account.
```

The connected-accounts notice in tool search results names such an account as
`<connector> (<identity> · <Yours|Shared>)` instead of the connector alone
(+3 bytes plus the account's bytes, only on searches that already show the
notice).

Why it is general: with one account, tool descriptions did not say whose
account the connector was signed in as, so a model could look in other
connectors and answer from the wrong account. Every connected account's tools
now name it, for any connector. The line comes only from the account accepted
for the turn, so it is the same on every turn with that account and is a
one-time change to the cached tool descriptions.
