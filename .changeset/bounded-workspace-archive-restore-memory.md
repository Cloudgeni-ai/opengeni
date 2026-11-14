---
"@opengeni/runtime": patch
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/capabilities": patch
"@opengeni/artifact-tool": patch
"@opengeni/vaults-protonpass": patch
---

Restoring a large workspace archive no longer multiplies worker memory. Byte copies used `Uint8Array.from(buffer)`, which Bun runs element by element through its generic iterator path when the source is a Node Buffer (the result of base64 decoding, file reads, object storage and Postgres bytea). That used about 16 times the archive size in transient memory and was about 100 times slower. A cold restore did it at least twice, so restoring a workspace archive of a few hundred MB could take a worker past 15 GB and kill it. Byte copies now use `new Uint8Array(buffer)`, which makes the same copy at native speed. Archive base64 is decoded once into a view of the decoded bytes. Canonical form is now checked from the decoded length and the final four characters instead of re-encoding the whole archive. Object-storage restores verify the fetched bytes directly instead of decoding the base64 copy again. Native snapshot receipts are recognised from their ASCII prefix without decoding a whole tar archive as text. Restoring a 48 MB archive now raises peak memory by about 2 times the archive size instead of 37 times, and takes 0.2 seconds instead of 3.4 seconds.
