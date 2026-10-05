---
"@opengeni/config": patch
"@opengeni/runtime": patch
"@opengeni/deployment": patch
---

The deployment Opper rail now offers Claude Opus 5.5 (EU) (`opper/aws/claude-opus-5-5`, AWS Bedrock eu-north-1, no provider logging) instead of the Gemini 3.8 Flash and Claude Sonnet 4.6 EU starters. Reasoning is runnable (`low` through `max`, default `medium`), image input is enabled, and every Opper request without its own output cap gets the route's `maxOutputTokens`, because Opper otherwise stops at 4,096 tokens, which hidden thinking can use up. Opper streams use a 60-minute keepalive-only progress bound, because hidden thinking sends only keepalives and `max` effort exceeded the default 10 minutes. Billing still uses Opper's reported cost +5%. Workspace and organization custom Opper ids now get runnable reasoning, image input for the Claude and Gemini families, and a Claude output cap; an id that names a configured route inherits that route's definition. New `OPENGENI_MANAGED_MODELS_JSON` replaces the managed Gateway, OpenRouter, and Opper model lists in code catalog mode without a code deploy, using the catalog document's entry schemas. Database catalog mode ignores it.
