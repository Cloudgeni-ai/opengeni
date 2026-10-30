---
"@opengeni/site-gateway": patch
---

Large Sites open instead of failing with Cloudflare's "Error 1102 Worker exceeded resource limits". The gateway used to hold a Site's page as several full copies while adding the bridge bootstrap, resolving the client script tag and hashing it for the ETag, so a 65 MB page with inlined media ran past the Worker's memory limit. The page is now streamed through a bounded rewrite that holds only the leading head and short client-script tags, its ETag comes from the Site, version and gateway runtime instead of the body (a 304 still needs an edge-cache hit or the API's answer), and the edge cache is filled from a backpressured tee. A page the API reports as over 256 MB gets a clear "Site too large" page (one that runs past it while streaming is cut off and never cached), any unexpected gateway error shows a plain "Something went wrong" page instead of Cloudflare's, and the report form reads at most its size cap.
