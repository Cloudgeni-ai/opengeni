# OpenGeni public docs

Source for [docs.opengeni.ai](https://docs.opengeni.ai), built and hosted by
[Mintlify](https://mintlify.com). Mintlify deploys this directory from `main`
(dashboard Git Settings: repository `Cloudgeni-ai/opengeni`, branch `main`,
subdirectory `/docs-site`).

- `docs.json` is the site configuration and navigation. Every page must be
  listed there to be published.
- Pages are MDX. Keep them at the product concept and workflow level, and link
  to the canonical engineering docs under [`../docs`](../docs/README.md) for
  volatile details (commands, env vars, SDK signatures) instead of restating
  them.

Preview locally from this directory:

```bash
bunx mint dev
bunx mint validate
bunx mint broken-links
```
