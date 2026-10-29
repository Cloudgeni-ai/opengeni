---
"@opengeni/db": patch
"@opengeni/subscriptions": patch
---

The subscription usage pools read no longer fails for heavily used organizations. It returned every usage reading and call of the last 14 days as one value, which passes Postgres's 256 MB limit at around a million of them. It now returns each window's changes, its first reading in every five-minute slot, and call totals between readings, so its size follows how often usage changes rather than how many calls ran. The forecast samples usage on five-minute slot boundaries, so it is the same from this read as from every row, apart from how a total's calls are capped when damping call-size outliers.
