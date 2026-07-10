---
"@opengeni/runtime": patch
---

Make Connected Machine (selfhosted) faults legible to the agent in-band. The `exec_command` tool now returns a four-field rendering (what happened / which layer / what was preserved / what to try) with a correct retry verdict — machine-offline and consent faults no longer reach the model mislabelled "Please try again". PAYLOAD_TOO_LARGE is typed with a distinguishing flag and rendered with the size wall plus recovery moves (redirect to a file, read in chunks). A transient offline blip the transport KNOWS occurred pre-send (no connection / no responder — the op provably never reached the machine) now heals with a short bounded retry for any op kind, while an ambiguous post-send fault is never blindly re-issued.
