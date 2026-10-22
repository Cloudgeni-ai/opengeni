---
"@opengeni/config": minor
"@opengeni/core": minor
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/runtime": minor
---

A deployment that ships its own branded build of the browser extension can now name and link it. Set `OPENGENI_BROWSER_EXTENSION_NAME` and `OPENGENI_BROWSER_EXTENSION_INSTALL_URL`. Agent tool descriptions, setup notes and errors, `/v1/config/client` (`browserExtension`), the machine card's Chrome step and the browser panel's install hint then use that name and install link. Without them, everything still says Opengeni Browser and links its Chrome Web Store page, unchanged.
