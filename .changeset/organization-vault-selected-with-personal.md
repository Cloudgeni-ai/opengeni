---
"@opengeni/db": patch
---

An organization vault limited to selected workspaces can also serve members' Personal workspaces, as its "Include personal workspaces" switch says. Before, a vault with a workspace list never reached a Personal workspace whatever the switch said. The switch alone now decides Personal workspaces, as it does for organization model keys. Migration 1171 turns the switch off on existing vaults with a list, so no vault reaches more than it did; an organization owner turns it on to serve Personal workspaces.
