# Tool search shows the Connect card it names

No system-prompt or tool-description text changes. The text of the
`tool_search` result notice for an integration the person can connect changes,
and it now appears in two new forms.

Before, a search that named an integration the person had not connected only
told the model to call `capability_authorization_request`. Weaker models
skipped that second call and then said a card had been shown. Now a search that
clearly names one such integration (exactly one named, by a distinctive
mention) shows the card itself, through the card tool, and says so. Every
result that names one also carries a structured `connectCard.shown`, and every
`capability_authorization_request` result carries `cardShown`, so whether a card
is in the chat is a fact in the result, not an inference.

The existing notice gains one sentence (+31 bytes per notice, only on searches
that name a connectable integration):

```text
- Not connected yet: <name> (capabilityId "<id>"). If the task needs it, call capability_authorization_request with that capabilityId and a short rationale to show the person its Connect card.
+ Not connected yet: <name> (capabilityId "<id>"). If the task needs it, call capability_authorization_request with that capabilityId and a short rationale to show the person its Connect card. No card is shown until you do.
```

The plural form ("If the task needs one ... its capabilityId ...") gains the
same sentence. When the card call fails or times out, the notice keeps its old
text, without the added sentence, because whether a card was posted is unknown.
New forms when the search showed the card (the card tool's result message,
unchanged for a new card, follows):

```text
+ Not connected yet: <name> (capabilityId "<id>"). Its Connect card is now shown in this chat. <card tool message>
+ Not connected yet: <name> (capabilityId "<id>"). <card tool message, with "was posted" read as "is already in this chat"> It was not posted again.
```

The second form is the `capability_authorization_request` result message for a
card tool discovery already showed since the person's latest message: its
first "was posted" becomes "is already in this chat", and "It was not posted
again." is appended.

Both are general: they state whether a card is in the chat, for any
integration, model or route, and add no instruction beyond that fact.
