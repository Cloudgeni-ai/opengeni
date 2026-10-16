---
"@opengeni/browserd": patch
---

Returning an expired browser resume to its checkpoint now works on ordinary Linux machines. Before moving an interrupted launch aside, the controller proves that no process uses the browser's profile, and that proof also required reading every process's executable link. An agent running as a normal user can't read that link for root's or other users' processes, so the proof always failed and the browser stayed stuck with "Current browser is unavailable". The proof now relies on each process's command line, which is the only part that names the profile. A process whose command line names the profile, or whose command line can't be read, still blocks the move.
