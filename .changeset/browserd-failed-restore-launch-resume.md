---
"@opengeni/browserd": patch
"@opengeni/db": patch
"@opengeni/api-router": patch
---

A managed browser whose restored launch failed before it finished can be resumed again. Previously, if Chrome started from a restored private profile but the launch then threw, cleanup removed the profile but left the launch record "in progress". Every later cleanup or resume of that browser was then refused as "Current browser is unavailable", and the stuck resume eventually marked the browser lost.

Now the browser service records such a launch as failed, with a short error code, and logs the original error. Cleanup of that exact controller generation succeeds, so the next resume restores again from the saved private checkpoint. Launch records left "in progress" by earlier versions are treated the same way when no process was recorded and the restored profile is gone. A launch that might still be running stays protected as before.

A browser that was lost because its resume timed out (`controller_transition_expired` after a resume) can now be resumed through the normal resume request. The API first ends the old controller generation, then returns the browser to suspended and restores it from the same checkpoint under a new generation. Browsers lost during create, suspend or end are unchanged.
