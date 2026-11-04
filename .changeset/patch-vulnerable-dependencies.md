---
"@opengeni/network": patch
"@opengeni/runtime": patch
"@opengeni/desktop": patch
"@opengeni/documents": patch
"@opengeni/artifact-tool": patch
---

Dependency security updates: sharp 0.35.5 (bundled libvips fixes), Electron 44.10.1, @azure/msal-node 7.1.2, undici 6.29.1, @grpc/grpc-js 1.14.7, and patched transitive versions of dompurify, ip-address, js-yaml, proxy-addr, fast-uri, seroval, follow-redirects and body-parser. This clears the critical and most high advisories reported by `bun audit` for server and desktop code.
