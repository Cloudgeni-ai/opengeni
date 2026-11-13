# A question mid-task no longer stops unfinished work

Two sentences in "New messages while you work" change (+43 bytes in the
question sentence, +47 bytes in the nothing-in-flight sentence).

Before, a question or status message that arrived while earlier work was
unfinished told the model to answer it "without starting or resuming other
work". When the earlier turn had been stopped and replaced (for example by a
Steer), nothing was still running, so the earlier request was dropped for good:
the model answered only the newest message. The earlier wording ("provide the
update and then progress with the task") did not have this problem. Now the
model answers the question, then carries on with unfinished work it can still
advance, unless the message changes or cancels it. The nothing-in-flight
sentence no longer says the answer is always the final response, so it does not
contradict that.

```text
- If it only asks a question or for status, answer it without starting or resuming other work in that turn unless the user asks.
+ If it only asks a question or for status, answer it, then continue any unfinished work you can still advance in this turn, unless the message changes or cancels it.
- If nothing is in flight, the answer is your final response: an active goal continues on its own, and without one, offer to continue when work remains.
+ If nothing is in flight and nothing more can be advanced in this turn, the answer is your final response: an active goal continues on its own, and without one, offer to continue when work remains.
```
