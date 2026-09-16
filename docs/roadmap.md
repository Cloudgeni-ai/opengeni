# Roadmap

Directions we intend to take Opengeni. None of these are commitments to a
date; open a [GitHub issue](https://github.com/Cloudgeni-ai/opengeni/issues)
to discuss any of them.

- First-class `agents` and `environments` API resources.
- Outbound webhooks for event delivery.
- A provider-neutral stock repository picker; embedded hosts can already submit
  mixed-provider, multi-binding `ResourceRef[]` through the current API.
- More OpenAI Agents SDK-compatible sandbox backends.
- Native mid-session file mounts for Docker sandboxes once the SDK supports
  privilege-safe late in-container mounts.
- Deeper Temporal/OpenAI Agents SDK integration when the TypeScript SDK supports
  durable agent, tool, and sandbox boundaries cleanly.

## Related reading

- [Anthropic Managed Agents overview](https://platform.claude.com/docs/en/managed-agents/overview)
- [Anthropic engineering: Managed Agents](https://www.anthropic.com/engineering/managed-agents)
