---
"@opengeni/agent-host": patch
---

The machine agent no longer migrates state from early releases. It stops reading the single-connection `credentials.json` file and the `nats_credentials` key, no longer recognises connections that were converted from that file (`legacy_origin`), and its renewal, update and `connections`/`disconnect` commands work only from the per-connection files. It also stops rewriting systemd units generated before coordinated browser shutdown and the `supervisor` subgroup, stops deleting old `systemctl set-property` drop-ins, and stops removing the Windows Service that early releases registered. A machine still on one of those shapes reconnects with `opengeni-agent connect` or reinstalls its service with `opengeni-agent service install --restart`. The API no longer treats a `legacy_origin` renewal failure as permanent.
