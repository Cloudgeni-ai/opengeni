---
"@opengeni/db": patch
---

Count the JSON nodes and object properties of session history items in linear time. The counts previously came from row-producing `jsonb_path_query('strict $.**')` scans, which Postgres serves in quadratic time for large items; they now come from `jsonb_path_query_array` with the same results and the same history limits.
