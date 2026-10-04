# Opengeni Browser

Chrome Manifest V3 bridge to the separately installed Opengeni machine agent.
See [connected machines](../../docs/connected-machines.md) for runtime setup.

Run `bun run build` in this directory for the unpacked extension and TAR.
For a Web Store upload, run `bun run build:store` (requires `zip`).
Upload `dist/opengeni-browser-extension-store.zip`. The store archive omits the
development manifest key; the unpacked archive preserves it.

The assigned Chrome Web Store item ID is `phpmmcbeelfkcinjfbbggegjdcdmnnch`.
The native agent must support that exact origin in both its installed native
messaging manifest and command-line dispatch. Do not publish an extension that
requires a host release users cannot install yet.

The extension privacy notice is [PRIVACY.md](PRIVACY.md). Store descriptions
must disclose the local agent requirement and the forwarding of browser data
to the configured deployment.

## Branding and listing ownership

- `manifest.json` owns the extension name, summary, version and icon paths.
  Chrome Web Store derives its title and summary from the uploaded package.
- `popup.html`, `popup.css` and `src/popup.ts` own the popup. The service worker
  owns toolbar status titles and connection errors. Protocol method names and
  the native host identifier keep their published spelling.
- The shared mark comes from `../web/public/favicon.svg`. Run
  `bun run brand:assets` after changing that mark to regenerate the extension
  icons and store promotional tiles. The popup bundles the licensed DM Sans
  font, matching the web app wordmark without a remote font request.
- `store/listing.json` owns the intended store description, links and
  distribution. `store/` contains the promotional images. These files are
  separate from the runtime package. Screenshots must show the current popup
  using synthetic profile labels and content.
- The **Cloudgeni AS** publisher manages the live item in the
  [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole/).
  Store edits are applied there; pushing source does not publish the extension.

## Publish an update

Run `bun run typecheck`, `bun test`, and `bun run build:store`. Upload the ZIP
to the existing item's Package tab. Apply the description and links from
`store/listing.json`, upload the new icon, promo images and screenshots, then
save the draft and submit it for review with automatic publishing enabled.
The version in `manifest.json` must be higher than the published version.

Keep distribution **Public**, select all available regions, and leave mature
content disabled for this extension. After Google approves and publishes the
update, verify the version and graphics on the
[public listing](https://chromewebstore.google.com/detail/opengeni-browser/phpmmcbeelfkcinjfbbggegjdcdmnnch)
and confirm it appears in [store search](https://chromewebstore.google.com/search/opengeni).
Google review and search indexing are separate; indexing can take a few hours.
