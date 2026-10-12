import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";

import { renderSVG } from "uqr";

import { FakeMailbox, handleFakeMailMcp, type MailMessage } from "./mailbox";
import {
  OTP_SPLIT_SCRIPT,
  PASSKEY_LOGIN_SCRIPT,
  PASSKEY_REGISTER_SCRIPT,
  captchaParentScript,
  captchaWidgetScript,
  credentialFields,
  errorBox,
  escapeHtml,
  page,
  popupLoginScript,
} from "./pages";
import { otpauthUri, randomTotpSecret, totp, verifyTotp } from "./totp";
import {
  WebAuthnError,
  b64urlEncode,
  verifyAuthentication,
  verifyRegistration,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  type StoredCredential,
} from "./webauthn";

/**
 * Fake-login site suite (dossier §13B.3). One Bun server for the site
 * (`http://localhost:<port>`, rpId `localhost`) plus a second server on a
 * different host and port (`http://127.0.0.1:<iframePort>`) that hosts the
 * cross-origin CAPTCHA widget and the FakeID login popup.
 *
 * Every flow ends on `/welcome`, which renders `#logged-in[data-user][data-flow]`
 * ("Logged in as X"), and is recorded in `/state` (hash prefixes only, safe to
 * keep as evidence) and in the in-memory received-credential log
 * (`/__fake/received`, exact values, never written anywhere) so tests can assert
 * that the exact value arrived. Log lines carry hash prefixes, never values.
 */

export const SIGNUP_SYMBOLS = "!#%+-.:=?@_";

export type FakeLoginAccount = {
  username: string;
  password: string;
  email?: string;
  /** Base32 TOTP seed; when set the account has two-factor enabled. */
  totpSecret?: string;
};

export type FakeLoginOptions = {
  /** 0 picks a free port. */
  port?: number;
  iframePort?: number;
  /** Bind address for both servers (default 127.0.0.1). */
  bindHost?: string;
  /** Host name of the site; also the WebAuthn rpId (default localhost). */
  siteHost?: string;
  /** Host of the cross-origin server; must be a different site (default 127.0.0.1). */
  crossOriginHost?: string;
  accounts?: FakeLoginAccount[];
  now?: () => number;
  requireUserVerification?: boolean;
  /** Receives log lines (hash prefixes only). Default: console.log. */
  log?: (line: string) => void;
};

export type FakeLoginAttempt = {
  at: string;
  flow: string;
  username: string | null;
  ok: boolean;
  reason?: string;
  /** Field name → `sha256:<12 hex>` of the submitted value. */
  fields: Record<string, string>;
};

export type FakeLoginSuccess = { at: string; flow: string; username: string };

export type ReceivedCredential = { at: string; flow: string; field: string; value: string };

export type FakeLoginState = {
  successes: FakeLoginSuccess[];
  attempts: FakeLoginAttempt[];
  accounts: {
    username: string;
    email: string | null;
    totpEnabled: boolean;
    passkeys: { credentialId: string; signCount: number; lastUsedAt: string | null }[];
    passwordHash: string;
  }[];
  mail: { id: string; to: string; subject: string; receivedAt: string }[];
};

export type FakeLoginServer = {
  url: string;
  crossOriginUrl: string;
  mailApiUrl: string;
  mcpUrl: string;
  state(): FakeLoginState;
  received(): ReceivedCredential[];
  mailbox(): MailMessage[];
  account(username: string): FakeLoginAccount | undefined;
  latestCaptchaAnswer(): string | undefined;
  reset(): void;
  close(): Promise<void>;
};

export const DEFAULT_FAKE_LOGIN_ACCOUNTS: FakeLoginAccount[] = [
  { username: "alice", password: "Fake-Login-Alice-Password-1", email: "alice@fake-login.test" },
  {
    username: "totp-user",
    password: "Fake-Login-Totp-Password-2",
    email: "totp-user@fake-login.test",
    totpSecret: "JBSWY3DPEHPK3PXP",
  },
];

export function hashPrefix(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

/** Signup and password-change rules; returns human-readable problems. */
export function passwordProblems(password: string): string[] {
  const problems: string[] = [];
  if (password.length < 16) problems.push("Use at least 16 characters.");
  if (!/[A-Z]/u.test(password)) problems.push("Include an uppercase letter.");
  if (!/[0-9]/u.test(password)) problems.push("Include a digit.");
  if (![...password].some((char) => SIGNUP_SYMBOLS.includes(char))) {
    problems.push(`Include a symbol from ${SIGNUP_SYMBOLS}`);
  }
  const bad = [
    ...new Set(
      [...password].filter((char) => !/[A-Za-z0-9]/u.test(char) && !SIGNUP_SYMBOLS.includes(char)),
    ),
  ];
  if (bad.length > 0) problems.push(`These characters are not allowed: ${bad.join(" ")}`);
  return problems;
}

type Account = FakeLoginAccount & {
  userHandle: string;
  passkeys: StoredCredential[];
  failures: number;
  lockedUntil: number;
};

type Pending = {
  username: string;
  kind: "totp" | "otp-split" | "email-code";
  code?: string;
  expiresAt: number;
};

const LOCKOUT_FAILURES = 5;
const LOCKOUT_MS = 60_000;
const CAPTCHA_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function redirect(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { location, ...headers } });
}

function cookie(name: string, value: string, maxAgeSeconds?: number): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax${maxAgeSeconds === undefined ? "" : `; Max-Age=${maxAgeSeconds}`}`;
}

function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

async function form(request: Request): Promise<Record<string, string>> {
  const data = await request.formData();
  const out: Record<string, string> = {};
  for (const [key, value] of data.entries()) if (typeof value === "string") out[key] = value;
  return out;
}

export async function startFakeLoginServer(
  options: FakeLoginOptions = {},
): Promise<FakeLoginServer> {
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? ((line: string) => console.log(line));
  const bindHost = options.bindHost ?? "127.0.0.1";
  const siteHost = options.siteHost ?? "localhost";
  const crossHost = options.crossOriginHost ?? "127.0.0.1";
  const requireUv = options.requireUserVerification ?? true;
  const seedAccounts = options.accounts ?? DEFAULT_FAKE_LOGIN_ACCOUNTS;

  const accounts = new Map<string, Account>();
  const sessions = new Map<string, string>();
  const pendings = new Map<string, Pending>();
  const enrollments = new Map<string, string>();
  const challenges = new Map<
    string,
    { kind: "create" | "get"; username?: string; expiresAt: number }
  >();
  const captchas = new Map<string, { answer: string; solved: boolean }>();
  const captchaTokens = new Map<string, number>();
  const popupTokens = new Map<string, { username: string; expiresAt: number }>();
  let latestCaptcha: string | undefined;
  let attempts: FakeLoginAttempt[] = [];
  let successes: FakeLoginSuccess[] = [];
  let received: ReceivedCredential[] = [];
  const mailbox = new FakeMailbox(now);

  const seed = () => {
    accounts.clear();
    for (const account of seedAccounts) {
      accounts.set(account.username, {
        ...account,
        userHandle: b64urlEncode(randomBytes(16)),
        passkeys: [],
        failures: 0,
        lockedUntil: 0,
      });
    }
  };
  seed();

  const iso = () => new Date(now()).toISOString();

  const record = (input: {
    flow: string;
    username: string | null;
    ok: boolean;
    reason?: string;
    values?: Record<string, string>;
  }) => {
    const fields: Record<string, string> = {};
    for (const [field, value] of Object.entries(input.values ?? {})) {
      fields[field] = hashPrefix(value);
      received.push({ at: iso(), flow: input.flow, field, value });
    }
    attempts.push({
      at: iso(),
      flow: input.flow,
      username: input.username,
      ok: input.ok,
      ...(input.reason ? { reason: input.reason } : {}),
      fields,
    });
    log(
      `[fake-login] flow=${input.flow} user=${input.username ?? "-"} ok=${input.ok}${input.reason ? ` reason=${input.reason}` : ""}${Object.entries(
        fields,
      )
        .map(([field, hash]) => ` ${field}=${hash}`)
        .join("")}`,
    );
  };

  const signIn = (flow: string, username: string): Record<string, string> => {
    const id = randomUUID();
    sessions.set(id, username);
    successes.push({ at: iso(), flow, username });
    log(`[fake-login] logged-in flow=${flow} user=${username}`);
    return { "set-cookie": cookie("fl_session", id) };
  };

  const currentUser = (request: Request): string | null => {
    const id = readCookie(request, "fl_session");
    return id ? (sessions.get(id) ?? null) : null;
  };

  const checkPassword = (
    flow: string,
    username: string,
    password: string,
    extra: Record<string, string> = {},
  ) => {
    const account = accounts.get(username);
    const values = { username, password, ...extra };
    if (!account) {
      record({ flow, username, ok: false, reason: "unknown_user", values });
      return { ok: false as const, error: "Wrong username or password." };
    }
    if (account.lockedUntil > now()) {
      record({ flow, username, ok: false, reason: "locked", values });
      return { ok: false as const, error: "Too many attempts. Try again in a minute." };
    }
    if (account.password !== password) {
      account.failures += 1;
      if (account.failures >= LOCKOUT_FAILURES) account.lockedUntil = now() + LOCKOUT_MS;
      record({ flow, username, ok: false, reason: "wrong_password", values });
      return { ok: false as const, error: "Wrong username or password." };
    }
    account.failures = 0;
    return { ok: true as const, account, values };
  };

  const origin = () => `http://${siteHost}:${site.port}`;
  const crossOrigin = () => `http://${crossHost}:${cross.port}`;

  const welcome = (user: string | null) => {
    const last = user
      ? [...successes].reverse().find((success) => success.username === user)
      : undefined;
    return page({
      title: user ? "Welcome" : "Not signed in",
      user,
      body: user
        ? `<h1 id="logged-in" data-logged-in="true" data-user="${escapeHtml(user)}" data-flow="${escapeHtml(last?.flow ?? "")}">Logged in as ${escapeHtml(user)}</h1>
<p>Signed in with <strong>${escapeHtml(last?.flow ?? "session")}</strong>.</p>
<p><a href="/totp/enroll">Set up two-factor authentication</a> · <a href="/passkey/register">Create a passkey</a> · <a href="/password-change">Change password</a></p>`
        : `<h1 id="logged-out" data-logged-in="false">Not signed in</h1><p><a href="/">Choose a sign-in method</a></p>`,
    });
  };

  const otpBoxes = () =>
    `<div class="otp" role="group" aria-label="6-digit code">${Array.from(
      { length: 6 },
      (_, index) =>
        `<input id="otp-${index}" inputmode="numeric" autocomplete="${index === 0 ? "one-time-code" : "off"}" maxlength="1" aria-label="Digit ${index + 1}">`,
    ).join("")}</div>`;

  const routes = async (request: Request, url: URL): Promise<Response> => {
    const path = url.pathname;
    const method = request.method;
    const user = currentUser(request);

    if (path === "/" && method === "GET") {
      const flows: [string, string][] = [
        ["/password", "Password login"],
        ["/signup", "Create an account"],
        ["/password-change", "Change password"],
        ["/totp/enroll", "Set up an authenticator app (TOTP)"],
        ["/totp/login", "Sign in with password and authenticator code"],
        ["/email-code", "Sign in with an emailed code"],
        ["/otp-split", "Sign in with a code typed into separate boxes"],
        ["/passkey/register", "Create a passkey"],
        ["/passkey/login", "Sign in with a passkey"],
        ["/popup-login", "Sign in with FakeID (popup)"],
        ["/captcha-iframe", "Sign in with a robot check"],
      ];
      return html(
        page({
          title: "Fake Login",
          user,
          body: `<h1>Fake Login test site</h1><ul class="flows">${flows
            .map(([href, label]) => `<li><a href="${href}">${label}</a></li>`)
            .join("")}</ul>`,
        }),
      );
    }

    if (path === "/welcome") return html(welcome(user));
    if (path === "/logout") {
      const id = readCookie(request, "fl_session");
      if (id) sessions.delete(id);
      return redirect("/welcome", { "set-cookie": cookie("fl_session", "", 0) });
    }
    if (path === "/whoami") {
      const last = user
        ? [...successes].reverse().find((success) => success.username === user)
        : undefined;
      return json({ loggedIn: user !== null, username: user, flow: last?.flow ?? null });
    }
    if (path === "/state") return json(snapshot());
    if (path === "/__fake/received") return json({ received });
    if (path === "/__fake/reset" && method === "POST") {
      reset();
      return json({ ok: true });
    }
    if (path === "/__fake/captcha/latest") return json({ answer: latestCaptcha ?? null });
    if (path.startsWith("/__fake/accounts/")) {
      const account = accounts.get(decodeURIComponent(path.slice("/__fake/accounts/".length)));
      if (!account) return json({ error: "unknown account" }, 404);
      return json({
        username: account.username,
        password: account.password,
        email: account.email ?? null,
        totpSecret: account.totpSecret ?? null,
        currentTotp: account.totpSecret ? totp(account.totpSecret, now()) : null,
        passkeys: account.passkeys.map(({ credentialId, signCount }) => ({
          credentialId,
          signCount,
        })),
      });
    }
    if (path === "/__mail/messages" && method === "GET") {
      return json({
        messages: mailbox.search({
          to: url.searchParams.get("to") ?? undefined,
          from: url.searchParams.get("from") ?? undefined,
          query: url.searchParams.get("q") ?? undefined,
        }),
      });
    }
    if (path.startsWith("/__mail/messages/")) {
      const message = mailbox.get(path.slice("/__mail/messages/".length));
      return message ? json(message) : json({ error: "not found" }, 404);
    }
    if (path === "/mcp") return handleFakeMailMcp(mailbox, request);

    // ---- password ------------------------------------------------------------
    if (path === "/password") {
      let errors: string[] = [];
      let username = "";
      if (method === "POST") {
        const body = await form(request);
        username = body.username ?? "";
        const result = checkPassword("password", username, body.password ?? "");
        if (result.ok) {
          record({ flow: "password", username, ok: true, values: result.values });
          const next = url.searchParams.get("next");
          return redirect(
            next && next.startsWith("/") ? next : "/welcome",
            signIn("password", username),
          );
        }
        errors = [result.error];
      }
      return html(
        page({
          title: "Sign in",
          user,
          body: `<h1>Sign in</h1>${errorBox(errors)}<form method="post" id="login-form">${credentialFields({ username })}<button type="submit" id="sign-in">Sign in</button></form>
<p class="hint">No account? <a href="/signup">Create one</a>.</p>`,
        }),
        errors.length ? 401 : 200,
      );
    }

    // ---- signup ----------------------------------------------------------------
    if (path === "/signup") {
      let errors: string[] = [];
      let username = "";
      let email = "";
      if (method === "POST") {
        const body = await form(request);
        username = (body.username ?? "").trim();
        email = (body.email ?? "").trim();
        const password = body.password ?? "";
        if (!/^[A-Za-z0-9._-]{3,40}$/u.test(username))
          errors.push("Usernames are 3-40 letters, digits, dots, dashes or underscores.");
        if (accounts.has(username)) errors.push("That username is taken.");
        if (email && !/^[^@\s]+@[^@\s]+$/u.test(email)) errors.push("Enter a valid email address.");
        errors.push(...passwordProblems(password));
        if ((body.confirm ?? "") !== password) errors.push("The passwords do not match.");
        record({
          flow: "signup",
          username,
          ok: errors.length === 0,
          ...(errors.length ? { reason: "invalid" } : {}),
          values: { username, password, ...(email ? { email } : {}) },
        });
        if (errors.length === 0) {
          accounts.set(username, {
            username,
            password,
            ...(email ? { email } : {}),
            userHandle: b64urlEncode(randomBytes(16)),
            passkeys: [],
            failures: 0,
            lockedUntil: 0,
          });
          return redirect("/welcome", signIn("signup", username));
        }
      }
      return html(
        page({
          title: "Create an account",
          user,
          body: `<h1>Create an account</h1>${errorBox(errors)}<form method="post" id="signup-form">
<label for="username">Username</label><input id="username" name="username" type="text" autocomplete="username" required value="${escapeHtml(username)}">
<label for="email">Email (optional)</label><input id="email" name="email" type="email" autocomplete="email" value="${escapeHtml(email)}">
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="new-password" required>
<label for="confirm">Confirm password</label><input id="confirm" name="confirm" type="password" autocomplete="new-password" required>
<p class="hint" id="password-rules">At least 16 characters, with an uppercase letter, a digit and a symbol from <code>${escapeHtml(SIGNUP_SYMBOLS)}</code>. No other symbols.</p>
<button type="submit" id="create-account">Create account</button></form>`,
        }),
        errors.length ? 422 : 200,
      );
    }

    // ---- password change ---------------------------------------------------------
    if (path === "/password-change") {
      if (!user) return redirect("/password?next=/password-change");
      const account = accounts.get(user)!;
      let errors: string[] = [];
      if (method === "POST") {
        const body = await form(request);
        const current = body.current ?? "";
        const next = body.password ?? "";
        if (current !== account.password) errors.push("Your current password is wrong.");
        errors.push(...passwordProblems(next));
        if (next === account.password) errors.push("Choose a password you have not used here.");
        if ((body.confirm ?? "") !== next) errors.push("The new passwords do not match.");
        record({
          flow: "password-change",
          username: user,
          ok: errors.length === 0,
          ...(errors.length ? { reason: "invalid" } : {}),
          values: { current, password: next },
        });
        if (errors.length === 0) {
          account.password = next;
          successes.push({ at: iso(), flow: "password-change", username: user });
          return html(
            page({
              title: "Password changed",
              user,
              body: `<h1 id="password-changed" data-user="${escapeHtml(user)}">Password changed for ${escapeHtml(user)}</h1><p class="ok">Use the new password next time you sign in.</p><p><a href="/welcome">Continue</a></p>`,
            }),
          );
        }
      }
      return html(
        page({
          title: "Change password",
          user,
          body: `<h1>Change password</h1>${errorBox(errors)}<form method="post" id="password-change-form">
<input type="text" name="username" autocomplete="username" value="${escapeHtml(user)}" hidden>
<label for="current">Current password</label><input id="current" name="current" type="password" autocomplete="current-password" required>
<label for="password">New password</label><input id="password" name="password" type="password" autocomplete="new-password" required>
<label for="confirm">Confirm new password</label><input id="confirm" name="confirm" type="password" autocomplete="new-password" required>
<p class="hint">At least 16 characters, with an uppercase letter, a digit and a symbol from <code>${escapeHtml(SIGNUP_SYMBOLS)}</code>.</p>
<button type="submit" id="change-password">Change password</button></form>`,
        }),
        errors.length ? 422 : 200,
      );
    }

    // ---- TOTP enrollment -----------------------------------------------------------
    if (path === "/totp/enroll") {
      if (!user) return redirect("/password?next=/totp/enroll");
      const account = accounts.get(user)!;
      const sessionId = readCookie(request, "fl_session")!;
      let errors: string[] = [];
      if (method === "POST") {
        const body = await form(request);
        const secret = enrollments.get(sessionId);
        const code = (body.code ?? "").trim();
        if (secret && verifyTotp(secret, code, now())) {
          account.totpSecret = secret;
          enrollments.delete(sessionId);
          record({ flow: "totp-enroll", username: user, ok: true, values: { code } });
          successes.push({ at: iso(), flow: "totp-enroll", username: user });
          return html(
            page({
              title: "Two-factor enabled",
              user,
              body: `<h1 id="totp-enabled" data-user="${escapeHtml(user)}">Two-factor authentication enabled for ${escapeHtml(user)}</h1><p class="ok">Next time, sign in at <a href="/totp/login">/totp/login</a> with your password and a code.</p>`,
            }),
          );
        }
        record({
          flow: "totp-enroll",
          username: user,
          ok: false,
          reason: "bad_code",
          values: { code },
        });
        errors = ["That code is not valid. Check your authenticator and try again."];
      }
      let secret = enrollments.get(sessionId);
      if (!secret) {
        secret = randomTotpSecret();
        enrollments.set(sessionId, secret);
      }
      const uri = otpauthUri({ issuer: "Fake Login", account: user, secret });
      return html(
        page({
          title: "Set up two-factor",
          user,
          body: `<h1>Set up an authenticator app</h1>${errorBox(errors)}
<p>Scan the QR code, or enter the setup key by hand.</p>
<div class="qr" id="totp-qr" aria-label="QR code for ${escapeHtml(uri)}">${renderSVG(uri, { border: 1 })}</div>
<p>Setup key: <code id="totp-secret">${secret}</code></p>
<p class="hint">URI: <code id="otpauth-uri">${escapeHtml(uri)}</code></p>
<form method="post" id="totp-enroll-form"><label for="code">6-digit code from the app</label>
<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required>
<button type="submit" id="verify-code">Verify and enable</button></form>`,
        }),
        errors.length ? 422 : 200,
      );
    }

    // ---- TOTP login and split boxes ------------------------------------------------------
    if (path === "/totp/login" || path === "/otp-split") {
      const flow = path === "/totp/login" ? "totp" : "otp-split";
      const kind = flow === "totp" ? "totp" : "otp-split";
      let errors: string[] = [];
      let username = "";
      if (method === "POST") {
        const body = await form(request);
        username = body.username ?? "";
        const result = checkPassword(flow, username, body.password ?? "");
        if (result.ok && !result.account.totpSecret) {
          record({ flow, username, ok: false, reason: "totp_not_enabled", values: result.values });
          errors = [
            "Two-factor authentication is not enabled for this account. Set it up at /totp/enroll.",
          ];
        } else if (result.ok) {
          record({
            flow,
            username,
            ok: true,
            reason: "password_ok_code_required",
            values: result.values,
          });
          const token = randomUUID();
          pendings.set(token, { username, kind, expiresAt: now() + 300_000 });
          return redirect(`${path}/code`, { "set-cookie": cookie("fl_pending", token, 300) });
        } else {
          errors = [result.error];
        }
      }
      return html(
        page({
          title: "Sign in",
          user,
          body: `<h1>Sign in</h1>${errorBox(errors)}<form method="post" id="login-form">${credentialFields({ username })}<button type="submit" id="sign-in">Continue</button></form>`,
        }),
        errors.length ? 401 : 200,
      );
    }
    if (path === "/totp/login/code" || path === "/otp-split/code") {
      const flow = path === "/totp/login/code" ? "totp" : "otp-split";
      const token = readCookie(request, "fl_pending");
      const pending = token ? pendings.get(token) : undefined;
      if (!pending || pending.expiresAt < now()) return redirect(path.replace(/\/code$/u, ""));
      let errors: string[] = [];
      if (method === "POST") {
        const code = ((await form(request)).code ?? "").trim();
        const secret = accounts.get(pending.username)?.totpSecret;
        if (secret && verifyTotp(secret, code, now())) {
          pendings.delete(token!);
          record({ flow, username: pending.username, ok: true, values: { code } });
          return redirect("/welcome", { ...signIn(flow, pending.username) });
        }
        record({
          flow,
          username: pending.username,
          ok: false,
          reason: "bad_code",
          values: { code },
        });
        errors = ["That code is not valid. Enter the current code from your authenticator."];
      }
      const body =
        flow === "totp"
          ? `<h1>Enter your authentication code</h1>${errorBox(errors)}<form method="post" id="code-form">
<label for="code">6-digit code</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required>
<button type="submit" id="verify-code">Verify</button></form>`
          : `<h1>Enter your authentication code</h1>${errorBox(errors)}<form method="post" id="otp-form">
<p id="otp-hint" class="hint">Type the 6 digits from your authenticator app.</p>${otpBoxes()}
<input type="hidden" id="code" name="code"><button type="submit" id="verify-code">Verify</button></form>`;
      return html(
        page({
          title: "Authentication code",
          user,
          body,
          ...(flow === "otp-split" ? { script: OTP_SPLIT_SCRIPT } : {}),
        }),
        errors.length ? 401 : 200,
      );
    }

    // ---- email code --------------------------------------------------------------------
    if (path === "/email-code") {
      let errors: string[] = [];
      let email = "";
      if (method === "POST") {
        email = ((await form(request)).email ?? "").trim();
        const account = [...accounts.values()].find(
          (candidate) => candidate.email?.toLowerCase() === email.toLowerCase(),
        );
        record({
          flow: "email-code",
          username: account?.username ?? null,
          ok: account !== undefined,
          ...(account ? { reason: "code_sent" } : { reason: "unknown_email" }),
          values: { email },
        });
        if (account) {
          const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
          mailbox.deliver({
            to: account.email!,
            from: "no-reply@fake-login.test",
            subject: "Your Fake Login sign-in code",
            body: `Hi ${account.username},\n\nYour sign-in code is ${code}. It expires in 10 minutes.\n\nIf you did not try to sign in, ignore this email.`,
          });
          const token = randomUUID();
          pendings.set(token, {
            username: account.username,
            kind: "email-code",
            code,
            expiresAt: now() + 600_000,
          });
          return redirect("/email-code/verify", { "set-cookie": cookie("fl_pending", token, 600) });
        }
        errors = ["No account uses that email address."];
      }
      return html(
        page({
          title: "Sign in with email",
          user,
          body: `<h1>Sign in with an emailed code</h1>${errorBox(errors)}<form method="post" id="email-form">
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required value="${escapeHtml(email)}">
<button type="submit" id="send-code">Email me a code</button></form>`,
        }),
        errors.length ? 404 : 200,
      );
    }
    if (path === "/email-code/verify") {
      const token = readCookie(request, "fl_pending");
      const pending = token ? pendings.get(token) : undefined;
      if (!pending || pending.kind !== "email-code" || pending.expiresAt < now())
        return redirect("/email-code");
      let errors: string[] = [];
      if (method === "POST") {
        const code = ((await form(request)).code ?? "").trim();
        if (code === pending.code) {
          pendings.delete(token!);
          record({ flow: "email-code", username: pending.username, ok: true, values: { code } });
          return redirect("/welcome", signIn("email-code", pending.username));
        }
        record({
          flow: "email-code",
          username: pending.username,
          ok: false,
          reason: "bad_code",
          values: { code },
        });
        errors = ["That code is not right. Check the latest email from Fake Login."];
      }
      const to = accounts.get(pending.username)?.email ?? "";
      return html(
        page({
          title: "Check your email",
          user,
          body: `<h1>Check your email</h1>${errorBox(errors)}<p>We sent a 6-digit code to <strong id="sent-to">${escapeHtml(to)}</strong>.</p>
<form method="post" id="code-form"><label for="code">Code</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required>
<button type="submit" id="verify-code">Sign in</button></form>`,
        }),
        errors.length ? 401 : 200,
      );
    }

    // ---- passkeys ------------------------------------------------------------------------
    if (path === "/passkey/register" && method === "GET") {
      if (!user) return redirect("/password?next=/passkey/register");
      return html(
        page({
          title: "Create a passkey",
          user,
          body: `<h1>Create a passkey</h1><p>Sign in next time without a password.</p>
<button type="button" id="create-passkey">Create a passkey</button><p id="passkey-status" hidden></p>`,
          script: PASSKEY_REGISTER_SCRIPT,
        }),
      );
    }
    if (path === "/passkey/register/options" && method === "POST") {
      if (!user) return json({ error: "Sign in first." }, 401);
      const account = accounts.get(user)!;
      const challenge = b64urlEncode(randomBytes(32));
      challenges.set(challenge, { kind: "create", username: user, expiresAt: now() + 300_000 });
      return json({
        challenge,
        rp: { id: siteHost, name: "Fake Login" },
        user: { id: account.userHandle, name: user, displayName: user },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
          { type: "public-key", alg: -8 },
        ],
        authenticatorSelection: {
          residentKey: "required",
          requireResidentKey: true,
          userVerification: requireUv ? "required" : "preferred",
        },
        attestation: "none",
        timeout: 60_000,
        excludeCredentials: account.passkeys.map((passkey) => ({
          type: "public-key",
          id: passkey.credentialId,
        })),
      });
    }
    if (path === "/passkey/register/verify" && method === "POST") {
      if (!user) return json({ error: "Sign in first." }, 401);
      const credential = (await request.json()) as RegistrationResponseJSON;
      const challenge = findChallenge(credential.response?.clientDataJSON, "create");
      try {
        if (!challenge || challenge.username !== user)
          throw new WebAuthnError("bad_challenge", "unknown or expired challenge");
        const verified = verifyRegistration({
          credential,
          expectedChallenge: challenge.value,
          origins: [origin()],
          rpId: siteHost,
          requireUserVerification: requireUv,
        });
        const account = accounts.get(user)!;
        account.passkeys.push({
          credentialId: verified.credentialId,
          publicKeyJwk: verified.publicKeyJwk,
          alg: verified.alg,
          signCount: verified.signCount,
          userHandle: account.userHandle,
          username: user,
          createdAt: iso(),
        });
        record({
          flow: "passkey-register",
          username: user,
          ok: true,
          values: { credentialId: verified.credentialId },
        });
        successes.push({ at: iso(), flow: "passkey-register", username: user });
        return json({
          ok: true,
          username: user,
          credentialId: verified.credentialId,
          signCount: verified.signCount,
        });
      } catch (error) {
        const code = error instanceof WebAuthnError ? error.code : "error";
        record({ flow: "passkey-register", username: user, ok: false, reason: code });
        return json({ error: `${code}: ${(error as Error).message}` }, 400);
      }
    }
    if (path === "/passkey/login" && method === "GET") {
      return html(
        page({
          title: "Sign in with a passkey",
          user,
          body: `<h1>Sign in with a passkey</h1>
<label for="username">Username (optional)</label><input id="username" name="username" type="text" autocomplete="username webauthn">
<button type="button" id="passkey-login">Sign in with a passkey</button><p id="passkey-status" hidden></p>`,
          script: PASSKEY_LOGIN_SCRIPT,
        }),
      );
    }
    if (path === "/passkey/login/options" && method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { username?: string };
      const challenge = b64urlEncode(randomBytes(32));
      const account = body.username ? accounts.get(body.username) : undefined;
      challenges.set(challenge, {
        kind: "get",
        ...(body.username ? { username: body.username } : {}),
        expiresAt: now() + 300_000,
      });
      return json({
        challenge,
        rpId: siteHost,
        timeout: 60_000,
        userVerification: requireUv ? "required" : "preferred",
        allowCredentials: account
          ? account.passkeys.map((passkey) => ({ type: "public-key", id: passkey.credentialId }))
          : [],
      });
    }
    if (path === "/passkey/login/verify" && method === "POST") {
      const credential = (await request.json()) as AuthenticationResponseJSON;
      const challenge = findChallenge(credential.response?.clientDataJSON, "get");
      const credentialId = (credential.rawId ?? "").replace(/=+$/u, "");
      const owner = [...accounts.values()].find((account) =>
        account.passkeys.some((passkey) => passkey.credentialId === credentialId),
      );
      const stored = owner?.passkeys.find((passkey) => passkey.credentialId === credentialId);
      try {
        if (!challenge) throw new WebAuthnError("bad_challenge", "unknown or expired challenge");
        if (!owner || !stored)
          throw new WebAuthnError("unknown_credential", "this passkey is not registered here");
        if (challenge.username && challenge.username !== owner.username)
          throw new WebAuthnError("unknown_credential", "passkey belongs to another user");
        if (credential.response.userHandle && credential.response.userHandle !== owner.userHandle) {
          throw new WebAuthnError("unknown_credential", "user handle does not match");
        }
        const verified = verifyAuthentication({
          credential,
          stored,
          expectedChallenge: challenge.value,
          origins: [origin()],
          rpId: siteHost,
          requireUserVerification: requireUv,
        });
        stored.signCount = verified.newSignCount;
        stored.lastUsedAt = iso();
        record({
          flow: "passkey",
          username: owner.username,
          ok: true,
          values: { credentialId, signCount: String(verified.newSignCount) },
        });
        return json(
          { ok: true, username: owner.username, signCount: verified.newSignCount },
          200,
          signIn("passkey", owner.username),
        );
      } catch (error) {
        const code = error instanceof WebAuthnError ? error.code : "error";
        record({
          flow: "passkey",
          username: owner?.username ?? null,
          ok: false,
          reason: code,
          values: { credentialId },
        });
        return json({ error: `${code}: ${(error as Error).message}` }, 400);
      }
    }

    // ---- popup login (opener side) ------------------------------------------------------------
    if (path === "/popup-login" && method === "GET") {
      return html(
        page({
          title: "Sign in with FakeID",
          user,
          body: `<h1>Sign in</h1><p>This site uses FakeID. A sign-in window opens.</p>
<button type="button" id="open-popup">Sign in with FakeID</button><p id="popup-status" class="hint"></p>`,
          script: popupLoginScript(crossOrigin(), origin()),
        }),
      );
    }
    if (path === "/popup-login/complete" && method === "POST") {
      const { token } = (await request.json().catch(() => ({}))) as { token?: string };
      const grant = token ? popupTokens.get(token) : undefined;
      if (!grant || grant.expiresAt < now()) return json({ error: "invalid token" }, 400);
      popupTokens.delete(token!);
      return json({ ok: true, username: grant.username }, 200, signIn("popup", grant.username));
    }

    // ---- CAPTCHA (parent side) -------------------------------------------------------------------
    if (path === "/captcha-iframe") {
      let errors: string[] = [];
      let username = "";
      if (method === "POST") {
        const body = await form(request);
        username = body.username ?? "";
        const token = body.captcha_token ?? "";
        if (!token || !captchaTokens.has(token)) {
          record({
            flow: "captcha",
            username,
            ok: false,
            reason: "captcha_missing",
            values: { username, password: body.password ?? "" },
          });
          errors = ["Complete the robot check first."];
        } else {
          captchaTokens.delete(token);
          const result = checkPassword("captcha", username, body.password ?? "");
          if (result.ok) {
            record({ flow: "captcha", username, ok: true, values: result.values });
            return redirect("/welcome", signIn("captcha", username));
          }
          errors = [result.error];
        }
      }
      return html(
        page({
          title: "Sign in",
          user,
          body: `<h1>Sign in</h1>${errorBox(errors)}<form method="post" id="login-form">${credentialFields({ username })}
<input type="hidden" id="captcha_token" name="captcha_token">
<label>Robot check</label>
<iframe id="captcha-frame" title="Robot check" src="${crossOrigin()}/captcha/widget?parent=${encodeURIComponent(origin())}" width="300" height="190" style="border:1px solid #c9ced6;border-radius:6px"></iframe>
<p id="captcha-state" class="hint">Solve the robot check to continue.</p>
<button type="submit" id="sign-in" disabled>Sign in</button></form>`,
          script: captchaParentScript(crossOrigin()),
        }),
        errors.length ? 401 : 200,
      );
    }

    return html(
      page({ title: "Not found", user, body: `<h1>Not found</h1><p><a href="/">Home</a></p>` }),
      404,
    );
  };

  const crossRoutes = async (request: Request, url: URL): Promise<Response> => {
    const path = url.pathname;
    if (path === "/captcha/widget") {
      return html(`<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:system-ui,sans-serif;font-size:14px;padding:12px;background:#fafbfc}
label.robot{display:flex;gap:10px;align-items:center;font-weight:600}input[type=checkbox]{width:22px;height:22px}
canvas{display:block;margin:10px 0 6px;border:1px solid #d5d9e0;border-radius:4px}
input#answer{width:120px;padding:6px 8px;font-size:15px}button{padding:6px 12px;font-size:14px}
.ok{color:#1f6b33;font-weight:600}.error{color:#9b1c1c}</style></head><body>
<label class="robot"><input type="checkbox" id="robot"> I'm not a robot</label>
<div id="solve" hidden><canvas id="challenge" width="230" height="66" aria-label="Type the characters you see"></canvas>
<input id="answer" aria-label="Characters in the image" autocomplete="off"> <button type="button" id="verify">Verify</button></div>
<p id="verdict"></p><script>${captchaWidgetScript(origin())}</script></body></html>`);
    }
    if (path === "/captcha/challenge" && request.method === "POST") {
      const id = randomUUID();
      const answer = Array.from(
        { length: 5 },
        () => CAPTCHA_ALPHABET[randomInt(0, CAPTCHA_ALPHABET.length)],
      ).join("");
      captchas.set(id, { answer, solved: false });
      latestCaptcha = answer;
      return json({ id, glyphs: answer });
    }
    if (path === "/captcha/verify" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { id?: string; answer?: string };
      const challenge = body.id ? captchas.get(body.id) : undefined;
      const ok =
        !!challenge &&
        !challenge.solved &&
        (body.answer ?? "").trim().toUpperCase() === challenge.answer;
      record({
        flow: "captcha-challenge",
        username: null,
        ok,
        ...(ok ? {} : { reason: "wrong_answer" }),
        values: { answer: body.answer ?? "" },
      });
      if (!ok) return json({ ok: false });
      challenge!.solved = true;
      const token = randomUUID();
      captchaTokens.set(token, now());
      return json({ ok: true, token });
    }
    if (path === "/idp/authorize") {
      const returnOrigin = url.searchParams.get("return_origin") ?? origin();
      let errors: string[] = [];
      let username = "";
      if (request.method === "POST") {
        const body = await form(request);
        username = body.username ?? "";
        const result = checkPassword("popup", username, body.password ?? "");
        if (result.ok) {
          record({ flow: "popup", username, ok: true, values: result.values });
          const token = randomUUID();
          popupTokens.set(token, { username, expiresAt: now() + 120_000 });
          return html(
            `<!doctype html><html><head><meta charset="utf-8"><title>FakeID</title></head><body><p id="idp-done">Signed in to FakeID. You can close this window.</p>
<script>window.opener && window.opener.postMessage({ type: 'fakeid-token', token: ${JSON.stringify(token)} }, ${JSON.stringify(returnOrigin)}); setTimeout(() => window.close(), 300);</script></body></html>`,
          );
        }
        errors = [result.error];
      }
      return html(
        page({
          title: "FakeID",
          body: `<h1>FakeID</h1><p class="hint">Signing in to <code>${escapeHtml(returnOrigin)}</code></p>${errorBox(errors)}
<form method="post" id="idp-form">${credentialFields({ username })}<button type="submit" id="idp-sign-in">Sign in</button></form>`,
        }).replace(
          `<header><strong><a href="/" style="color:#fff">Fake Login</a></strong><span id="whoami" data-user="">Not signed in</span></header>`,
          `<header><strong>FakeID</strong></header>`,
        ),
        errors.length ? 401 : 200,
      );
    }
    return new Response("not found", { status: 404 });
  };

  const findChallenge = (clientDataJSON: string | undefined, kind: "create" | "get") => {
    if (!clientDataJSON) return undefined;
    try {
      const value = (
        JSON.parse(Buffer.from(clientDataJSON, "base64url").toString("utf8")) as {
          challenge?: string;
        }
      ).challenge;
      const entry = value ? challenges.get(value) : undefined;
      if (!value || !entry || entry.kind !== kind || entry.expiresAt < now()) return undefined;
      challenges.delete(value);
      return { value, username: entry.username };
    } catch {
      return undefined;
    }
  };

  const snapshot = (): FakeLoginState => ({
    successes,
    attempts,
    accounts: [...accounts.values()].map((account) => ({
      username: account.username,
      email: account.email ?? null,
      totpEnabled: account.totpSecret !== undefined,
      passkeys: account.passkeys.map((passkey) => ({
        credentialId: passkey.credentialId,
        signCount: passkey.signCount,
        lastUsedAt: passkey.lastUsedAt ?? null,
      })),
      passwordHash: hashPrefix(account.password),
    })),
    mail: mailbox.all().map(({ id, to, subject, receivedAt }) => ({ id, to, subject, receivedAt })),
  });

  const reset = () => {
    seed();
    sessions.clear();
    pendings.clear();
    enrollments.clear();
    challenges.clear();
    captchas.clear();
    captchaTokens.clear();
    popupTokens.clear();
    latestCaptcha = undefined;
    attempts = [];
    successes = [];
    received = [];
    mailbox.clear();
  };

  const handle =
    (handler: (request: Request, url: URL) => Promise<Response>) =>
    async (request: Request): Promise<Response> => {
      try {
        return await handler(request, new URL(request.url));
      } catch (error) {
        log(`[fake-login] error ${(error as Error).message}`);
        return json({ error: "internal error" }, 500);
      }
    };

  const site = Bun.serve({ hostname: bindHost, port: options.port ?? 0, fetch: handle(routes) });
  const cross = Bun.serve({
    hostname: bindHost,
    port: options.iframePort ?? 0,
    fetch: handle(crossRoutes),
  });
  log(`[fake-login] site ${origin()} cross-origin ${crossOrigin()}`);

  return {
    url: origin(),
    crossOriginUrl: crossOrigin(),
    mailApiUrl: `${origin()}/__mail/messages`,
    mcpUrl: `${origin()}/mcp`,
    state: snapshot,
    received: () => [...received],
    mailbox: () => mailbox.all(),
    account: (username) => {
      const account = accounts.get(username);
      return account
        ? {
            username: account.username,
            password: account.password,
            ...(account.email ? { email: account.email } : {}),
            ...(account.totpSecret ? { totpSecret: account.totpSecret } : {}),
          }
        : undefined;
    },
    latestCaptchaAnswer: () => latestCaptcha,
    reset,
    close: async () => {
      await Promise.all([site.stop(true), cross.stop(true)]);
    },
  };
}
