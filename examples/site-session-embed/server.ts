import index from "./index.html";
import { createCodemodeSiteRequestHandler } from "@opengeni/codemode";
const server = Bun.serve({
  port: 0,
  routes: {
    "/__opengeni/site-tools/*": createCodemodeSiteRequestHandler(),
    "/*": index,
  },
  development: true,
});
console.log(`Site preview: ${server.url}`);
