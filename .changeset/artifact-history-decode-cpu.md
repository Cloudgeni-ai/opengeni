---
"@opengeni/contracts": patch
---

Opening a document or presentation with a long edit history no longer blocks the server for about a second. The 64-bit checksum on stored edits now uses integer arithmetic instead of one BigInt per byte, with bit-identical results, and decoding a stored edit validates its nested command once instead of twice. Decoding a real 307-edit document history dropped from about 1.16 s to 0.12 s.
