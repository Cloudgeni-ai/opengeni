/** Exact in-process request proof, installed only by the verified Site gateway. */
const authorities = new WeakMap<Request, () => Promise<void>>();

export function bindSiteSessionRequestAuthority(request: Request, reauthorize: () => Promise<void>): void {
  authorities.set(request, reauthorize);
}

/** Periodic SSE reauthorization must check the Site cookie, not only its delegate. */
export async function reauthorizeSiteSessionRequest(request: Request): Promise<void> {
  await authorities.get(request)?.();
}
