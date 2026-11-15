# A message that arrives mid-task is left to the model's judgment

The "New messages while you work" paragraph loses its case rules and is
shorter (about -270 bytes with goals on).

Before, the paragraph decided for the model what to do with each kind of new
message. A question or status message was to be answered "without starting or
resuming other work", and with nothing in flight "the answer is your final
response". When an earlier turn had been stopped and replaced by a newer
message, nothing was still running, so a question dropped the earlier request
for good: the model answered only the newest message.

Now the paragraph names the ways a new message can relate to the earlier
request (replace it, change it, add to it, or a side question), leaves the call
to the model, and says to carry on with whatever earlier work still stands. The
wait, status-length and acknowledgement rules are unchanged. The legacy contract
carries the same edit, so the two stay in parity.

```text
- Decide whether it replaces the active request or adds to it.
- If it replaces it, drop the previous work and focus on the new request.
- If it adds to unfinished work, handle both together.
- If it only asks a question or for status, answer it without starting or resuming other work in that turn unless the user asks.
- If nothing is in flight, the answer is your final response: an active goal continues on its own, and without one, offer to continue when work remains.
+ Use your judgment about how it relates to the earlier request: it may replace it, change it, add to it, or be a side question.
+ Act on that, and carry on with whatever earlier work still stands.
```
