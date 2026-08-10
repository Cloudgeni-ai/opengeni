---
name: social-media-marketing
description: Use when running marketing, social media, content performance, audience signal, campaign reporting, or daily media analysis tasks through OpenGeni social account connectors and MCP tools.
---

# Social Media Marketing

Use this skill for scheduled or ad hoc marketing analysis over connected social media accounts.

## Workflow

1. Call `opengeni__social_daily_analysis_context` first with the selected `connectionIds`, `documentBaseIds`, and a 24 hour window unless the user requested another window.
2. If you need narrower post data, call `opengeni__social_posts_recent` with explicit connection IDs and date bounds.
3. If document base IDs are available, use the docs MCP search tools for brand voice, campaign calendars, audience research, messaging rules, and reporting definitions.
4. Produce a report with:
   - Executive summary
   - Notable account changes
   - Winning posts
   - Underperforming posts
   - Audience and content signals
   - Recommended actions for the next 24 hours
   - Data gaps and caveats

## Analysis Rules

- Use only metrics, posts, account data, and document snippets returned by tools.
- Do not invent impressions, engagement, conversions, sentiment, follower counts, or platform capabilities.
- Treat missing metrics as missing data and say what integration or provider sync would be needed.
- Compare posts with like-for-like metrics from the same platform when possible.
- Keep recommendations concrete: target account, content theme, suggested action, expected signal to monitor.
- Separate observation from recommendation.

## Output Style

Prefer a concise structured report. Include exact post URLs or external IDs when available. If there are no posts in the window, provide account-level gaps and next data collection steps instead of filler analysis.
