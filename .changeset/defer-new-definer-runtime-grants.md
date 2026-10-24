---
"@opengeni/db": patch
---

Keep a rolling release safe for the previous binary: migration 0937 withholds the runtime role's EXECUTE on the new event trigger, recording recovery, MCP Events and event source feed `SECURITY DEFINER` routines, and its DML on `event_ingress_routes`, until a later release grants them. Readiness knows all five routines with their own checks and accepts the grants withheld or made. Stalled-recording recovery and event intake retention skip their pass while EXECUTE is withheld: until then, a recording stuck in transcription or deletion is not restarted, and a stuck deletion keeps its audio longer.
