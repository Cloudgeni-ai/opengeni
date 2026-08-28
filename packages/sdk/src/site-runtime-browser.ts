export const SITE_RUNTIME_PROTOCOL_VERSION = 1 as const;

/**
 * Phase-one Sites are self-contained SPAs. Network, frames, workers, forms,
 * plugins, and base-URL rewriting stay disabled; all privileged work crosses
 * the one page-lifetime MessageChannel owned by the authenticated Site shell.
 */
export const SITE_RUNTIME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export type SiteRuntimeRequest =
  | {
      id: string;
      method: "ai.start";
      params: { message: string; model?: string; modelContext?: string };
    }
  | { id: string; method: "ai.send"; params: { runtimeSessionId: string; text: string } }
  | { id: string; method: "ai.cancel"; params: { sessionId: string } };

export type SiteRuntimeResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: { code: string; message: string } }
  | { type: "event"; sessionId: string; event: unknown };

function boundedString(value: unknown, max: number, allowEmpty = false): value is string {
  return (
    typeof value === "string" && value.length <= max && (allowEmpty || value.trim().length > 0)
  );
}

/** Reject malformed or invented bridge verbs before they reach the parent. */
export function isSiteRuntimeRequest(value: unknown): value is SiteRuntimeRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  if (!boundedString(request.id, 256) || typeof request.method !== "string") return false;
  if (!request.params || typeof request.params !== "object" || Array.isArray(request.params))
    return false;
  const params = request.params as Record<string, unknown>;
  if (request.method === "ai.start") {
    return (
      boundedString(params.message, 1_000_000) &&
      (params.model === undefined || boundedString(params.model, 256)) &&
      (params.modelContext === undefined || boundedString(params.modelContext, 64_000, true))
    );
  }
  if (request.method === "ai.send") {
    return boundedString(params.runtimeSessionId, 128) && boundedString(params.text, 1_000_000);
  }
  if (request.method === "ai.cancel") return boundedString(params.sessionId, 128);
  return false;
}

/**
 * Platform-owned bootstrap injected only into the runtime copy of immutable
 * Site HTML. It receives a page-lifetime MessagePort from the authenticated
 * parent; no cookie, access key, connection credential, or bearer token enters
 * the opaque-origin iframe.
 */
export function siteRuntimeBootstrapScript(): string {
  return `(function(){"use strict";var port=null,connectResolve=null,pending=new Map(),listeners=new Set();var connected=new Promise(function(r){connectResolve=r;});function request(method,params){return connected.then(function(){return new Promise(function(resolve,reject){var id=crypto.randomUUID();pending.set(id,{resolve:resolve,reject:reject});port.postMessage({id:id,method:method,params:params});});});}var api=Object.freeze({ai:Object.freeze({start:function(input){return request("ai.start",input);},send:function(input){return request("ai.send",input);},cancel:function(input){return request("ai.cancel",input);}}),onEvent:function(listener){if(typeof listener!=="function")throw new TypeError("listener must be a function");listeners.add(listener);return function(){listeners.delete(listener);};}});Object.defineProperty(window,"OpenGeniSite",{value:Object.freeze({connect:function(){return connected.then(function(){return api;});}}),writable:false,configurable:false});window.addEventListener("message",function(event){var data=event.data;if(event.source!==parent||!data||data.type!=="opengeni.site.connect"||data.version!==1||port||!event.ports||event.ports.length!==1)return;port=event.ports[0];port.onmessage=function(message){var value=message.data;if(value&&value.type==="event"){listeners.forEach(function(listener){try{listener(value);}catch(_){}});return;}if(!value||typeof value.id!=="string")return;var item=pending.get(value.id);if(!item)return;pending.delete(value.id);if(value.ok)item.resolve(value.result);else item.reject(new Error(value.error&&value.error.message||"Site runtime request failed"));};port.start();connectResolve();},{once:false});})();`;
}

export function injectSiteRuntimeBootstrap(html: string): string {
  const script = `<meta http-equiv="Content-Security-Policy" content="${SITE_RUNTIME_CSP}"><script data-opengeni-site-runtime>${siteRuntimeBootstrapScript()}</script>`;
  const head = /<head(?:\s[^>]*)?>/iu.exec(html);
  if (head?.index !== undefined) {
    const index = head.index + head[0].length;
    return `${html.slice(0, index)}${script}${html.slice(index)}`;
  }
  return `${script}${html}`;
}
