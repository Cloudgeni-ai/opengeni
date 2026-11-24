# The final response is the message after the last tool call

One sentence joins the progress-update paragraph, in the modular
`base_behavior` module and in the legacy contract alike, so the two stay in
parity and no `diff` line is needed:

> Text you write before a tool call is a progress update; only the message
> after your last tool call is the final response, so do follow-up tool work,
> such as saving notes, before you write it.

Why it is general: the turn's output, the reply a person sees and what an API
caller receives as the result, is the last assistant message. Text written
before a tool call is recorded as commentary and, once the turn ends, folds
into the work log with the tool calls. The prompt already said the final
response must be self-contained, but not which message that is. A model that
wrote its answer, then made a bookkeeping call (saving a note, appending to a
log) and ended with a short trailer, such as a progress bar or a sign-off,
left the person with only the trailer and the answer hidden in the work log.
The sentence tells the model which message is the reply, so it does the
bookkeeping first and writes the whole answer last.

Size: 192 bytes more for every session (modular and legacy). The text is
unconditional, so every live session pays one cold prompt prefix after deploy
and nothing changes within a session.
