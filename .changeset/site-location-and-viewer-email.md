---
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/contracts": minor
"@opengeni/db": patch
"@opengeni/runtime": patch
---

Sites can have several pages and use links with query parameters. `site.location` gives a Site its own address (`path`, `search`, `hash`, `href` and parsed `params`), `site.navigate(to, { replace })` moves between the Site's own pages without reloading, and `site.onLocationChange` hears Back, Forward and links. On a published Site this is the real address, kept through sign-in including its `#hash`; in the console it is kept in the Site page's `?page=` parameter. Ordinary links to the Site's own pages now move the Site instead of failing inside its frame (`createOpenGeniSiteClient({ links: false })` opts out). Older hosts report no location.

Site SQL binds two more verified viewer values: `:viewer_access` (`member`, `invited`, `user` or `guest`) and `:viewer_email` (the verified email in lowercase, or NULL). `:viewer_kind` is unchanged.
