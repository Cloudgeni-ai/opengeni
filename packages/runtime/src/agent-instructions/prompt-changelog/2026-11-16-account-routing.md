# Connected tools before Connect cards; a default account for writes

No system-prompt text changes. Two operational texts change: the account line
on tools of a connector with several accounts in a turn, and the closing line
of the per-turn "Connector availability" notice. Neither names a task, a
person, a test fixture or a particular integration.

Account line, shown only when a turn has several accounts of one connector
(+33 bytes per tool that carries it):

```text
- Use only this account; if the intended account for a write is unclear, ask before calling.
+ Use only this account. When the request does not say which account to write to, use the default; ask only if there is none.
```

When exactly one of those accounts is the person's own, the account name in
that line gains a suffix: `(the default: the person's own account)` on its
tools (+40 bytes), or `(not the default; the default is the person's own
account, <identity · Yours>)` on the other accounts' tools (+61
bytes plus the default's account label). The connected-accounts notice in tool search
results marks the default the same way (`, the default`). With several of the
person's own accounts, or only shared ones, nothing is marked and the model
asks as before.

Why it is general: with several accounts, models either asked every time or
picked whichever account's tool was listed first, which could be a shared
account when the person meant their own. A default derived from ownership
applies to every connector, and the model asks only when ownership doesn't
settle it.

"Connector availability" notice, closing line (+178 bytes, only on turns
that have an unavailable connector):

```text
- When the person's request needs one of them, tell them which connector is unavailable and why, using only the reason given here; do not guess another cause or claim to have read or updated that system. Continue with unaffected work only when safe.
+ Prefer loaded tools that can do the task: one of these connectors is needed only when the person named it or no loaded tool can do it, and an answer from other tools says which of these was not checked. When one is needed, tell them which connector is unavailable and why, using only the reason given here; do not guess another cause or claim to have read or updated that system. Continue with unaffected work only when safe.
```

Why it is general: the notice listed an unconnected connector (for example a
mail service with no signed-in account) as something the request "needs",
which led models to offer its Connect card instead of using a connected
service of the same kind. The new line states when an unavailable connector
is actually needed, for any connector, and keeps an answer from other tools
honest about the source it did not check (for example an expired sign-in). The structural parts of this change
(no automatic Connect card beside a connected account of the same kind;
connected matches first in catalog search; ties between accounts' copies of
a tool go to the default) add no text.
