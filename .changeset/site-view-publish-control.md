---
"@opengeni/react": minor
---

The Site view header says whether a Site is on the web, and publishes it from there. A published Site shows "Published", whose menu names the address with Open, Copy link and, for people who can publish, Publishing settings; an unpublished Site shows Publish to those people. Publish and Publishing settings open the Site's own publish form (the same form, permissions and publication as its Settings tab) in place of the Site, with the chat still beside it. The Site view no longer shows the frame's "Live" label, so "Live" never reads as "on the web"; Updating and Reconnecting still show. In the app components, `SitePublicLink` is now `SitePublicationControl` (it takes `onOpenPublishing` instead of linking to Settings), `useSitePublicationLink` returns `{ load, update }`, and `SitePublishPage` accepts `onSubmitted` and titles a published Site's form "Web address" in every layout.
