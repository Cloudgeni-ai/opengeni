---
"@opengeni/db": patch
---

Reading whether an idle session still holds an agent wait no longer walks the session's whole history. The deciding-turn lookup sorted every finished turn of the session and, for each person turn, scanned all of the session's delivered updates, so a long waiting session cost over a million buffer reads per read on a busy deployment. Two online indexes (`session_turns_finished_order_idx`, `session_system_updates_delivered_turn_idx`, built concurrently in rolling migrations 0786 and 0787) let it stop at the newest finished turn and probe consumed input directly; results are unchanged.
