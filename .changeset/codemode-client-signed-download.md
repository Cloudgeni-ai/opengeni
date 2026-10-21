---
"@opengeni/runtime": patch
---

A fresh managed box installs the Codemode client in one command. The worker publishes the release's client bundle once to object storage under its digest and hands the box a short-lived signed URL; the box checks its existing copy, otherwise downloads, verifies the digest and installs, all in one provider command. Before, the 1.15 MB bundle was staged through the provider file API in about eight sequential round trips on every new box. If the download fails for any reason, the box falls back to the old staging path, and Connected Machines are unchanged.
