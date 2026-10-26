---
"@opengeni/react": patch
---

Up and Steer now work on a message as soon as it shows as queued. A sent message appears in the queue row at once, but the server needs a moment to place it in the queue, and until the next queue read Up did nothing and Steer was greyed out. Both are now taken immediately and carried out once the message lands: Up pulls it back into the composer, and Steer sends it to the agent now. Neither ever acts on an older message instead. If the send fails nothing is steered or recalled, and if the agent starts the message first the composer stays as it was and shows "Already sent". Typing or sending another message while Up waits cancels that press and keeps what you typed.
