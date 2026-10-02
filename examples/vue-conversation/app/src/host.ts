import { createSessionProxyHandler, type OpenGeniClient } from "@opengeni/sdk";

export type HostIdentity = {
  tenantId: string;
  userId: string;
  workspaceId: string;
  source: string;
  csrf: string;
};

/** Replace this adapter with your verified host session + tenant mapping store. */
export type HostOptions = {
  origin: string;
  authenticate: (request: Request) => Promise<HostIdentity | null>;
};

export function sameOrigin(request: Request, origin: string): boolean {
  return (
    request.headers.get("origin") === origin &&
    request.headers.get("sec-fetch-site") !== "cross-site"
  );
}

export function createHostHandler(client: OpenGeniClient, options: HostOptions) {
  const proxy = createSessionProxyHandler(client, {
    basePath: "/api/conversation",
    chats: "private",
    files: false,
    modelSelection: false,
    maxBodyBytes: 32_768,
    resolve: async (request) => {
      const identity = await options.authenticate(request);
      return identity
        ? { workspaceId: identity.workspaceId, user: identity.userId, source: identity.source }
        : Response.json({ error: "Sign in to the guest desk." }, { status: 401 });
    },
    authorizeMutation: async (request) => {
      const identity = await options.authenticate(request);
      return (
        !!identity &&
        sameOrigin(request, options.origin) &&
        request.headers.get("x-host-csrf") === identity.csrf
      );
    },
    createSession: ({ initialMessage, idempotencyKey }) => ({
      initialMessage,
      idempotencyKey,
      sandboxBackend: "none",
      tools: [],
      bundledSkillIds: [],
      agent: {
        identity:
          "You are Harbor's guest desk assistant. Help hotel guests plan their stay. Be concise. Do not claim bookings or access to hotel records.",
        capabilities: { from: "none", humanInput: true },
        renderer: "markdown",
      },
    }),
  });

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    let response: Response;
    if (url.pathname === "/api/context" && request.method === "GET") {
      const me = await options.authenticate(request);
      response = me
        ? Response.json({
            workspaceId: me.workspaceId,
            // Browser storage namespace, not authority. Changing it grants nothing.
            storageScope: JSON.stringify([me.source, me.tenantId, me.userId]),
            csrf: me.csrf,
          })
        : Response.json({ error: "Sign in to the guest desk." }, { status: 401 });
    } else if (url.pathname.startsWith("/api/conversation/")) {
      response = await proxy(request);
    } else {
      response = new Response("Not found", { status: 404 });
    }
    response.headers.set("cache-control", "no-store");
    response.headers.set("x-content-type-options", "nosniff");
    return response;
  };
}
