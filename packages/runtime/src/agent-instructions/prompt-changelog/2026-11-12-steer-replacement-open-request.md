# A Steer's replacement turn knows the earlier request is unfinished

A Steer sent while a turn is working ends that turn as `superseded` at its next
model step and runs as a new turn on the same history. That history showed the
earlier request, the work done on it, then the new message, with nothing saying
the earlier turn stopped before it finished. The runtime mechanics paragraph
"New messages while you work" assumes the earlier work is still in flight, and
for a question it says to answer "without starting or resuming other work".
After a supersession nothing is in flight, so models answered only the newest
message and dropped or deferred the earlier request.

The replacement turn's first model input now leads its turn-scoped operational
notice (after the new message) with a 396-byte note: the previous turn stopped
unfinished, nothing else continues it, and unless the newest message cancels or
replaces it, the model answers the newest message and also finishes the earlier
request, even when the newest message is only a question. It appears only when
the replaced turn really ended `superseded`, once per turn. No system-prompt
text changes, and every earlier item keeps its exact bytes.
