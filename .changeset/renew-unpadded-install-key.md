---
"@opengeni/db": patch
"@opengeni/api-router": patch
---

Connected machines can renew their credentials again. Recording a machine's promotion proof decoded its install key with PostgreSQL's strict base64 decoder, but agents send that key as unpadded base64 (43 characters), which PostgreSQL rejects, so every `POST /v1/enrollments/renew` failed with a 500. Machines whose credentials had expired stayed offline, and connecting a new machine failed at its first proof. The key is now padded (and URL-safe characters translated) before it is hashed, giving the same hash as before for padded keys.
