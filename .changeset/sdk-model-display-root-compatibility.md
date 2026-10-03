---
"@opengeni/sdk": patch
---

Preserve the published SDK root exports for `humanizeModelSlug`, `isRawModelLabel`, `modelDisplayName`, `modelSlug`, and `modelVendor`. The aliases use the dependency-free model-display leaf without loading the contracts schema runtime in React Native bundles.