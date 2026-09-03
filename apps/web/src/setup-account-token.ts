export const SETUP_ACCOUNT_PATH = "/setup-account";
export const SETUP_TOKEN_PARAMETER = "token";
export const SETUP_TOKEN_MAX_LENGTH = 2_048;
export const SETUP_ACCOUNT_RESPONSE_HEADERS = {
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
} as const;

// Organization setup bearers are unpadded base64url HMAC-SHA256 signatures:
// 32 bytes encode to exactly 43 characters. Keep the broader length fence as
// an allocation bound, then require the canonical wire representation before
// retaining or reflecting any candidate.
const SETUP_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

declare global {
  interface Window {
    __OPENGENI_SETUP_ACCOUNT_TOKEN__?: unknown;
  }
}

export function isCanonicalSetupAccountToken(value: string): boolean {
  return value.length <= SETUP_TOKEN_MAX_LENGTH && SETUP_TOKEN_PATTERN.test(value);
}

export function takeBootstrappedSetupAccountToken(target: Window): string | null {
  const candidate = target.__OPENGENI_SETUP_ACCOUNT_TOKEN__;
  delete target.__OPENGENI_SETUP_ACCOUNT_TOKEN__;
  return typeof candidate === "string" && isCanonicalSetupAccountToken(candidate)
    ? candidate
    : null;
}

export function setupAccountQueryRedirectLocation(url: URL): string | null {
  if (url.pathname !== SETUP_ACCOUNT_PATH || !url.searchParams.has(SETUP_TOKEN_PARAMETER)) {
    return null;
  }
  const candidates = url.searchParams.getAll(SETUP_TOKEN_PARAMETER);
  const candidate = candidates.length === 1 ? candidates[0] : null;
  url.searchParams.delete(SETUP_TOKEN_PARAMETER);
  const search = url.searchParams.toString();
  const fragment =
    candidate && isCanonicalSetupAccountToken(candidate)
      ? new URLSearchParams({ [SETUP_TOKEN_PARAMETER]: candidate }).toString()
      : "";
  return `${SETUP_ACCOUNT_PATH}${search ? `?${search}` : ""}${fragment ? `#${fragment}` : ""}`;
}

export function setupAccountTokenFromUrl(value: string): {
  token: string | null;
  scrubbedPath: string;
} {
  const url = new URL(value, "https://opengeni.invalid");
  const fragment = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  const candidates = [
    ...fragment.getAll(SETUP_TOKEN_PARAMETER),
    ...url.searchParams.getAll(SETUP_TOKEN_PARAMETER),
  ];
  const candidate = candidates.length === 1 ? candidates[0] : null;
  const token = candidate && isCanonicalSetupAccountToken(candidate) ? candidate : null;
  fragment.delete(SETUP_TOKEN_PARAMETER);
  url.searchParams.delete(SETUP_TOKEN_PARAMETER);
  const remainingFragment = fragment.toString();
  return {
    token,
    scrubbedPath: `${url.pathname}${url.search}${remainingFragment ? `#${remainingFragment}` : ""}`,
  };
}
