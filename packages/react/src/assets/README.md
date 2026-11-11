# Service marks

These provider-owned marks identify the connected service; they do not imply endorsement.

- `gmail.ico`: existing Gmail service mark.
- `google-calendar.svg`: Google's Calendar product mark,
  https://www.gstatic.com/images/branding/productlogos/calendar_2020q4/v13/192px.svg
  (retrieved 2026-11-09, unmodified).
- `google-drive.svg`: Google's Drive product mark,
  https://www.gstatic.com/images/branding/productlogos/drive_2020q4/v10/192px.svg
  (retrieved 2026-11-09, unmodified).
- `outlook.ico`: https://outlook.live.com/favicon.ico (retrieved 2026-09-20).
- `microsoft-teams.svg`, `onedrive.svg`, `sharepoint.svg`: byte-identical copies of the
  Microsoft product marks the console already bundles in
  `apps/web/src/assets/integration-logos/` (originally
  `https://res-1.cdn.office.net/files/fabric-cdn-prod_20230815.002/assets/brand-icons/product/svg/<product>_48x1.svg`).

Every reviewed Microsoft integration definition needs a mark here, or its chat setup card falls back
to a letter monogram.

The Google services keep `logoSourceUrl: null` in `data/catalog/curated.json`, so the catalog import
vendors nothing for them; `capabilityLogoFallback` shows these bundled marks for their MCP URLs.
`scripts/catalog-logo-coverage.test.ts` fails when a reviewed or built-in connector resolves no logo.

The React package bundles these assets so embedding hosts do not need matching public paths or make third-party image requests for these marks.
