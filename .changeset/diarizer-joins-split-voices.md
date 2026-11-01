---
"@opengeni/worker-bundle": patch
---

Speaker detection no longer splits one voice into many speakers on room
recordings. After clustering, speakers whose average voices nearly match are
joined. A one-hour in-room meeting that showed 16 speakers now shows 3, and
the AMI reference meetings ES2004a and EN2002a still find all 4 of 4 speakers
with unchanged error rates.
