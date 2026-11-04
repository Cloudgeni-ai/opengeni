---
---

CI: every third-party GitHub Action is pinned to a full commit SHA, with the tag kept as a comment, so a moved or compromised tag can no longer change what runs in jobs that hold release signing keys and publish tokens. A guard test fails on any new unpinned action, and Dependabot keeps the pins current weekly.
