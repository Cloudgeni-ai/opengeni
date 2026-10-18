# Permission-aware workbench preview

This deterministic harness imports the production KnowledgePage, workspace shortcut navigation, personal resource hooks/status surface, and stylesheet. Only context/API data and surrounding layout are preview wiring. It never contacts a production API or model.

From `apps/web`, start:

```sh
bun run vite --config test/workbench-permissions-preview.vite.config.ts --host 127.0.0.1 --port 4347 --strictPort
```

From the repository root:

```sh
bun apps/web/test/workbench-permissions-preview.browser.ts
bun node_modules/typescript/bin/tsc --noEmit -p apps/web/test/workbench-permissions-preview.tsconfig.json
```

Optional environment variables: `OPENGENI_PERMISSIONS_PREVIEW_URL`, `OPENGENI_PERMISSIONS_PREVIEW_OUTPUT` (screenshots), and `OPENGENI_PREVIEW_CHROMIUM` (installed Chromium executable).

The browser check uses the exact eleven reader permissions retained from acceptance39155745687. It verifies published Knowledge listing/opening, no pending/resource requests without permission, manager review requests and controls, rigs-only/machines-only catalogs, permission revocation, and visible authorized errors/Retry at desktop and mobile widths. The fixture rejects unauthorized calls rather than swallowing 403s. Unit tests separately cover stale responses and unchanged ownership/attachment fences.

This is a local real-component check, not the full managed-auth/API/PostgreSQL/live-model acceptance journey. Containing-source release and requalification remain required.
