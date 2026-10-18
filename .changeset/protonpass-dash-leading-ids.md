---
"@opengeni/vaults-protonpass": patch
---

Accept Proton Pass item and vault ids that start with "-". Proton ids are URL-safe base64, so about one in 64 newly created items was wrongly reported as an unknown outcome. Ids still reach pass-cli only as `--name=value`, so they can never be read as options.
