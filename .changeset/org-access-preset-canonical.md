---
"@opengeni/contracts": patch
---

Organization access presets now list canonical permissions only. The legacy `variable-sets:*` and `environments:*` names are aliases of `secrets:*`, so they are no longer part of Full access or Read only. A key whose policy holds exactly the canonical full set can now state or delegate `workspace:admin`; before, the check also demanded the six legacy variable-set names, so a key saved with canonical names only was refused with "cannot delegate a legacy workspace-admin wildcard from a custom policy". Keys that still list the legacy names next to the canonical ones keep working and normalize to Full access. Saving a policy maps any legacy name to its `secrets:*` equivalent.
