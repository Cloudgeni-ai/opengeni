# Built-in integration marks

The console's built-in integrations (Slack, Atlassian, Google Drive, Microsoft
Teams, OneDrive, Outlook) are set up through their own integration flows, not
catalog rows, so they cannot use a vendored registry `logoAssetPath` or the
first-party catalog marks in `apps/web/public/capability-logos`. These files
are the exact marks those flows used to load from each vendor's CDN. They are
bundled by Vite and served from the console's own origin, so opening the
Capabilities page never contacts a vendor host.

`manifest.json` records each file's integration, original URL, licence
posture and modifications. The marks remain property of their owners and are
reproduced only to identify the corresponding integration. Keep this set to
built-in integrations; registry connectors belong in `data/catalog/logos/`.
