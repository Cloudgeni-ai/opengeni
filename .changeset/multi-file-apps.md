---
"@opengeni/contracts": minor
---

Big apps stay fast: an app version can be a split build (Bun `--splitting` or Vite with `base: "./"`) instead of one HTML file, so each page loads only its own code. Upload the build's other files as JSON `{files: [{path, base64}]}` to the new `assets.putUrl` of `POST .../published-artifacts/uploads` (`artifacts_prepare_upload`). Published apps load them from their own host (`/_og/a/...`) and the console from the API (`/v1/app-assets/...`), cached for a year. New `@opengeni/contracts/app-assets`. Single-file apps are unchanged.
