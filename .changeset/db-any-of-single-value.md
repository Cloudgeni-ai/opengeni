---
"@opengeni/db": patch
---

Id-list reads that receive exactly one id now compare it as a single value (`= $n`) instead of a one-element array. PostgreSQL costs the reusable plan of an array comparison for a several-element list, so for one id it kept choosing a fresh custom plan on every execution: the session lock reads on every event append were re-planned on 99% of calls. The single-value form gets an exact one-row reusable plan. Lists of any other length still bind as one array parameter.
