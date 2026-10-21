import { readFile } from "node:fs/promises";

import { protocol } from "electron";

import { LOCAL_SCHEME, localContentType, localFile } from "./local-pages";

/** Before `ready`: give the local scheme normal web-page rules (origin, relative URLs, CSP). */
export function registerLocalScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: LOCAL_SCHEME, privileges: { standard: true, secure: true } },
  ]);
}

/** After `ready`: serve `directory` at the local origin. */
export function serveLocalPages(directory: string): void {
  protocol.handle(LOCAL_SCHEME, async (request) => {
    const file = localFile(directory, request.url);
    if (!file) return new Response(null, { status: 404 });
    try {
      // Node's fs reads inside the app archive; Chromium's file loader does not.
      return new Response(await readFile(file), {
        headers: { "content-type": localContentType(file) },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}
