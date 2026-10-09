---
"@opengeni/db": patch
---

A wait for a person no longer keeps a sandbox box warm. A held `wait_for_input` or a turn waiting for an approval or human input does not block idle command containment: after the normal idle window the workspace is saved, the box is stopped, and it resumes on demand. The notice that the command was stopped does not wake the waiting agent; it arrives with the next turn, when the person answers or the wait times out. A background command that printed output inside the window still keeps its box, whether or not anything waits on it. Rolling migration 0686 widens the containment inventory; the containment notice now says the command printed no output in that time.
