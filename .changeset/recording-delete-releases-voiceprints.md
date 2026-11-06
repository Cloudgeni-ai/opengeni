---
"@opengeni/db": patch
---

Deleting a recording now takes its speakers' voices back out of the workspace voiceprints they taught, as renaming a speaker already did. `markRecordingDeleting` subtracts every learned voice and drops the recording's stored speaker voices in the same transaction that hides the recording. A person whose only samples came from deleted recordings is no longer remembered or suggested in other meetings. A retried deletion subtracts nothing more, and it releases the voices of a recording that was already marked as deleting.
