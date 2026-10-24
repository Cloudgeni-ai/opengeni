---
"@opengeni/browserd": patch
---

Computer-use action batches spend less time on fixed waits. Lookups inside a batch no longer walk every menu of the app's menu bar, a step picks its element from the read its wait just made, batched steps no longer wait for the cursor glide, polls run every 100 ms, and text-field writes poll their read-back instead of sleeping. Setting a dropdown to the value it already shows no longer empties it.
