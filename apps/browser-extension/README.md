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

## Controlled tabs

While an agent controls a tab (the extension's debugger is attached), the tab
shows the agent's cursor as its icon and, if the person turned on "Tab group
for agent tabs" in the extension menu, sits in a grey tab group named after
the product, one per window, so the tab strip shows which tabs are in use.
Both end once control has stayed ended for a moment. The tab group needs
Chrome's optional `tabGroups` permission. Chrome warns about that permission
and turns an extension off when an update newly requires a permission it
warns about, so new permissions must always be optional.

- `src/tab-group.ts`: a tab leaves the group and goes back to where it was,
  or to the person's own group it came from (made again if the tab was its
  only one). A tab the person drags out stays out until that control ends,
  and a tab opened from a controlled tab leaves the group unless an agent
  takes it. The group's title ends in an unseen zero-width mark, so a group
  the person names after the product is never taken for it. Groups left
  behind when Chrome restarts are found by that title and colour. A tab the
  agent closes leaves the group first, but a group still open when Chrome
  closes may be kept in Chrome's saved groups, out of the extension's reach.
- `src/tab-icon.ts`: the page's own icon links are set aside and the cursor
  added once each page has loaded, and they are put back exactly, with any
  icon the page set meanwhile. Titles and content are left alone. Pages load
  the cursor from the extension (`web_accessible_resources`, at a URL that
  changes per browser session, hence Chrome 130 or later) because many
  sites' Content-Security-Policy refuses `data:` icons. Sites cannot probe
  for that URL, but a page showing the cursor can read it, and so that it is
  controlled; it stays the same until Chrome restarts or the extension
  reloads, so sites could use it to link visits made while controlled. Pages
  the extension cannot script (Chrome's own pages, the Web Store, PDFs) keep
  their icon.

Both are kept in local storage, so tabs get their place and icon back after
the extension updates or reloads. Chrome's debugger notification, with its
Cancel button, stays the way to stop every agent at once. Disabling or removing
the extension during control leaves the group, and the cursor until the page
reloads, since Chrome runs no extension code then.

## Site permissions

`contentSettings` is an optional permission. The extension asks for it only when
the person clicks Allow on its own `site-permissions.html` page, which an agent's
first permission action opens. Agents can then set camera, microphone,
geolocation and notifications for the exact `scheme://host:port/*` of a tab the
session opened and no other session is using, never a secondary pattern.
browserd checks the tab; the extension sets the permission only while that
tab's attachment lasts and the tab shows that site. Every change is recorded in local
storage and listed in the popup with Remove; setting a type back to prompt
clears it and re-applies the remaining changes. Turning it off clears every
change before giving the permission back, because Chrome keeps an extension's
rules after the permission is removed but no longer lets it clear them.

Store permission justification for `contentSettings`: optional, requested only
when the user clicks Allow on the extension's own page. It lets agents the user
directs allow or block camera, microphone, location and notifications for the
exact site (scheme, host and port) open in a tab the agent opened, for example to
test a video call. Every change is listed in the popup where the user can
remove it; turning it off removes all changes. No other content settings are
read or changed.

## Branding and listing ownership

- `manifest.json` owns the extension name, summary and icon paths. Chrome Web
  Store derives its title and summary from the uploaded package.
- `package.json` owns the extension version. Add a Changeset for
  `@opengeni/browser-extension` with every user-visible extension change; the
  Version PR bumps it, and the build stamps it into every packaged manifest.
  The source `manifest.json` must not declare a version.
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

## A product's own branded build

A product built on Opengeni can ship this extension under its own name, so
its people never see Opengeni. Write a brand file:

```json
{
  "name": "Acme Browser",
  "product": "Acme",
  "shortName": "Acme",
  "description": "Let Acme's agents work in your Chrome tabs, through the Acme app on this computer.",
  "homepageUrl": "https://acme.example",
  "iconsDir": "icons",
  "packageName": "acme-browser-extension"
}
```

`iconsDir` (relative to the brand file) holds `brand-mark.svg` and
`icon-16.png`, `icon-32.png`, `icon-48.png`, `icon-128.png`;
`bun run brand:icons --mark logo.svg --out icons [--tile "#202020"]` makes
them, plus store promo tiles, from one mark. An optional `key` (a base64
public key) fixes the unpacked build's extension ID.

Then `bun scripts/build.ts --store --brand path/to/brand.json --out path/to/dist`
writes `<packageName>-store.zip` for the product's own Chrome Web Store item.
Every name a person sees (manifest, popup, toolbar titles and connection
messages) comes from the brand. Branded builds use the native host
`ai.opengeni.browser.<extension-id>`; Opengeni Browser keeps
`ai.opengeni.browser`. The protocol is the same. List each branded store or
unpacked extension ID in `browserExtensionIds` in the desktop kit, or in
`OPENGENI_AGENT_BROWSER_EXTENSION_IDS` for standalone service installs.
Update the branded extension and its agent together so both use the new name.

## Publish an update

Publishing is automatic. When main changes the version in `package.json`
(Changesets does this), the Publish browser extension workflow builds the
store ZIP and submits it for review with automatic publishing, replacing an
older version still waiting for review. It first checks that a released agent
supports the extension's protocol (see below); if not, it waits, and each
completed agent release runs it again. A run that fails, for example because
the store dashboard asks for a justification of a new permission, opens a
"Chrome Web Store publish failed" issue; fix the cause and rerun the workflow.
It can also be run by hand, with a staged publish or to replace a pending
review.

Store listing edits (description and links from `store/listing.json`, icons,
promo images and screenshots) are still made by hand in the dashboard.

Keep distribution **Public**, select all available regions, and leave mature
content disabled for this extension. After Google approves and publishes the
update, verify the version and graphics on the
[public listing](https://chromewebstore.google.com/detail/opengeni-browser/phpmmcbeelfkcinjfbbggegjdcdmnnch)
and confirm it appears in [store search](https://chromewebstore.google.com/search/opengeni).
Google review and search indexing are separate; indexing can take a few hours.

## Extension and agent compatibility

Chrome updates an installed extension on its own schedule, and people update
their agent on theirs, so new extensions meet old agents and old extensions
meet new agents. `bridge-compat.json` lists every protocol an installed
extension uses to reach the agent: its bridge version and native host name,
per build, and the first agent release that supports it.

- A new agent keeps supporting every protocol in the list that is not
  retired. The agent test `installed_extension_protocols_stay_supported`
  fails otherwise.
- The extension may only use a listed protocol (`test/bridge-compat.test.ts`),
  and the store release waits until a released agent supports it.
- To change the protocol, add a new entry with the agent release that first
  supports it, and keep the old one. Retire the old entry (`retiredOn`,
  `retiredBy`) no sooner than 60 days after its replacement was released.
  Never delete an entry.
