---
"@opengeni/runtime": patch
---

Sites and other workspace tool gateway callers can now use a connection's tool that is set to Ask by default once a person sets it to Allow. The workspace tool gateway hid such tools (for example Gmail "Send message") from Sites before it applied the saved permission, so a Site still got "tool unavailable" after the change to Allow. The gateway now applies saved permissions first and filters on the effective approval. Tools that still need approval stay hidden from Sites, which cannot show an approval prompt.
