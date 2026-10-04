---
"@opengeni/config": minor
"@opengeni/runtime": minor
"@opengeni/core": minor
"@opengeni/contracts": minor
---

Add provider-agnostic web search. When a deployment names a search provider (TinyFish, Exa, Tavily, Firecrawl, Brave, Jina, or self-hosted SearXNG), models without hosted search receive `web_search` and `web_fetch` tools; hosted search stays the default where it exists, and `replace` mode can swap it. Priced calls are credit-billed at provider cost plus 5%. Off until configured.
