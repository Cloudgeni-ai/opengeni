# Sites are called apps

"App" is now the one user-facing name for Sites (saved pages, dashboards,
trackers, boards), so the prompt calls them apps too and matches what the
person sees in the console. The publish domain stays `*.opengeni.site`, and
the Skill keeps its `sites` name. Size: 3 bytes smaller for a session with
documents and apps, in the modular prompt and in the legacy contract, which
carries the same five sentences so they stay in parity. Every such case's
bytes change, so live sessions pay one cold prompt prefix after deploy.

The first-party `site_*` tools are now `app_*` (`app_data_query`,
`app_sql_run`, `app_publication_update`, …) with the same descriptions in
app wording. The old names stay callable as hidden aliases that are never
listed, so saved references keep working.

```text
- Reserve audits, second sources, extra verification, documents, Sites, and visuals for requests that need them, and offer them in one sentence when they would clearly help.
+ Reserve audits, second sources, extra verification, documents, apps, and visuals for requests that need them, and offer them in one sentence when they would clearly help.
- First check whether the workspace already provides the capability natively (for example, a Site reaches the model and workspace tools through the host bridge and needs no server of its own).
+ First check whether the workspace already provides the capability natively (for example, an app reaches the model and workspace tools through the host bridge and needs no server of its own).
- Inline HTML stays in chat unless explicitly saved as a Site.
+ Inline HTML stays in chat unless explicitly saved as an app.
- For building, publishing, or embedding a saved Site, read the sites Skill when available.
+ For building, publishing, or embedding a saved app, read the sites Skill when available.
- Sites and native documents keep their tool-returned canonical links.
+ Apps and native documents keep their tool-returned canonical links.
```
