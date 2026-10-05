import type { GitHubInstallationBindingCandidate } from "@opengeni/contracts";

// GitHub redirects can land on an API-only host. Keep these pages self-contained
// (no external scripts, styles or fonts) while mirroring the web app's design:
// the @opengeni/react token values (packages/react/styles/tokens.css), the
// page glow behind the signed-out pages, the "teal wash" primary button and the
// Opengeni brand mark and wordmark (apps/web/src/components/brand-mark.tsx).
// Dark is the default like the app; light follows prefers-color-scheme.
const pageStyle = `
  :root{color-scheme:dark;--bg:#202020;--surface:#333333;--surface-2:#383838;--border:#454545;--border-strong:#555555;--fg:#e6e6e6;--muted:#b8b8b8;--subtle:#a3a3a3;--accent:#c4c4c4;--selected:rgb(196 196 196 / .07);--hover:rgb(230 230 230 / .06);--primary:#2b3432;--primary-fg:#eeeeee;--primary-border:#4e5e59;--primary-hover:#47504e;--glow-teal:#79d9c125;--glow-peach:#ffb78724;--ring:rgb(196 196 196 / .55);--shadow:0 8px 28px rgb(0 0 0 / .32),0 2px 8px rgb(0 0 0 / .2)}
  @media(prefers-color-scheme:light){:root{color-scheme:light;--bg:#ffffff;--surface:#ffffff;--surface-2:#eeeeee;--border:#dedede;--border-strong:#bdbdbd;--fg:#242424;--muted:#5f5f5f;--subtle:#696969;--accent:#545454;--selected:rgb(84 84 84 / .05);--hover:rgb(36 36 36 / .04);--primary:#ebf2f0;--primary-fg:#292929;--primary-border:#c4d5d0;--primary-hover:#d2d8d6;--glow-teal:#9fe3d359;--glow-peach:#ffb78752;--ring:rgb(84 84 84 / .55);--shadow:0 8px 28px rgb(0 0 0 / .07),0 2px 8px rgb(0 0 0 / .04)}}
  *{box-sizing:border-box}
  html{min-height:100%;background:var(--bg)}
  body{margin:0;min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;color:var(--fg);background:radial-gradient(ellipse 42% 70% at 0 20%,var(--glow-teal),transparent 95%),radial-gradient(ellipse 42% 65% at 0 100%,var(--glow-peach),transparent 95%),var(--bg);font-family:"Inter Variable",Inter,ui-sans-serif,system-ui,sans-serif;font-feature-settings:"cv11","ss01","ss03";-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
  header{width:100%;max-width:1040px;margin:0 auto;padding:24px 40px;display:flex;align-items:center;justify-content:space-between;gap:16px}
  .brand{display:flex;align-items:center;gap:9px;color:var(--fg)}
  .brand svg{width:27px;height:auto;flex:none}
  .wordmark{font-family:"DM Sans Variable","DM Sans","Inter Variable",Inter,ui-sans-serif,system-ui,sans-serif;font-size:20px;font-weight:550;letter-spacing:-.055em;line-height:1}
  .context{font-size:12px;color:var(--subtle)}
  main{flex:1;display:flex;align-items:flex-start;justify-content:center;padding:clamp(24px,8vh,88px) 16px 64px}
  .card{width:100%;max-width:520px;padding:30px;border:1px solid var(--border);border-radius:14px;background:var(--surface);box-shadow:var(--shadow)}
  h1{margin:0 0 6px;font-size:20px;font-weight:600;letter-spacing:-.5px;line-height:28px;overflow-wrap:anywhere}
  p{margin:0;color:var(--muted);font-size:14px;line-height:20px}
  p strong{color:var(--fg);font-weight:600}
  .intro{margin-bottom:24px}
  .options{display:grid;gap:8px;margin:-4px;padding:4px;border:0;min-width:0;max-height:min(368px,50vh);overflow:auto}
  .option{display:flex;gap:12px;align-items:center;min-height:56px;padding:10px 14px;border:1px solid var(--border);border-radius:10px;background:var(--surface);background-image:linear-gradient(transparent,transparent);cursor:pointer;transition:background-color .12s,border-color .12s}
  .option:hover{background-image:linear-gradient(var(--hover),var(--hover))}
  .option:has(input:checked){border-color:var(--accent);background-color:var(--selected)}
  .option:has(input:focus-visible){outline:2px solid var(--ring);outline-offset:2px}
  .option input{appearance:none;-webkit-appearance:none;margin:0;flex:none;display:grid;place-items:center;width:16px;height:16px;border:1px solid var(--border-strong);border-radius:50%;background:var(--surface);cursor:pointer}
  .option input::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--accent);transform:scale(0);transition:transform .12s}
  .option input:checked{border-color:var(--accent)}
  .option input:checked::before{transform:scale(1)}
  .option input:focus-visible{outline:none}
  .option-text{min-width:0;display:grid;gap:2px}
  .option strong{overflow-wrap:anywhere;font-size:14px;font-weight:500;line-height:20px}
  .option small{font-size:12px;line-height:16px;color:var(--muted)}
  .actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:20px}
  .actions form{margin:0}
  .button{display:inline-flex;min-height:38px;align-items:center;justify-content:center;gap:8px;padding:0 16px;border:1px solid var(--primary-border);border-radius:10px;background:var(--primary);color:var(--primary-fg);font-family:inherit;font-size:14px;font-weight:500;line-height:20px;white-space:nowrap;text-decoration:none;cursor:pointer;transition:background-color .12s}
  .button:hover{background:var(--primary-hover)}
  .button:disabled{cursor:wait;opacity:.5}
  .secondary{border-color:var(--border);background:var(--surface);color:var(--fg)}
  .secondary:hover{background:var(--surface-2)}
  :is(button,a):focus-visible{outline:2px solid var(--ring);outline-offset:2px}
  .note{margin-top:24px;padding-top:16px;border-top:1px solid var(--border);font-size:12px;line-height:16px;color:var(--subtle)}
  .env-header{display:flex;justify-content:space-between;align-items:center;gap:14px;margin-top:24px;margin-bottom:10px}
  h2{margin:0;font-size:14px;font-weight:600}
  pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;max-height:380px;overflow:auto;padding:14px 16px;border:1px solid var(--border);border-radius:10px;background:var(--bg);font:12px/18px "JetBrains Mono Variable","JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
  @media(max-width:520px){header{padding:16px}.wordmark{font-size:18px}.brand svg{width:24px}main{padding-top:16px}.card{padding:20px;border-radius:14px}.actions{align-items:stretch;flex-direction:column}.actions form,.actions .button{width:100%}}
  @media(forced-colors:active){body{background:Canvas}.option:has(input:checked){border-color:Highlight}}
  @media(prefers-reduced-motion:reduce){.option,.button,.option input::before{transition:none}}
`;

// The Opengeni iconmark (two stacked chevrons), filled with the text color.
const brandMark = `<svg viewBox="0 0 176 138.73" fill="currentColor" aria-hidden="true"><path transform="translate(-75 -39.5966)" d="M251 83.5966L207 109L163 83.5966L119 109L75 83.5966L141 45.4915A44 44 0 0 1 185 45.4915ZM185.25 172.3642A44.5 44.5 0 0 1 140.75 172.3642L75 134.4034L119 109L163 134.4034L207 109L251 134.4034Z"/></svg>`;

function page(title: string, content: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><title>${escapeHtml(title)} · Opengeni</title><style>${pageStyle}</style></head><body><header><span class="brand">${brandMark}<span class="wordmark">Opengeni</span></span><span class="context">GitHub connection</span></header><main><div class="card">${content}</div></main></body></html>`;
}

export function githubInstallationChooserHtml(
  candidates: GitHubInstallationBindingCandidate[],
  state: string,
  workspaceId: string,
  baseUrl: string,
): string {
  const action = `${baseUrl}/v1/workspaces/${encodeURIComponent(workspaceId)}/github/installations/select`;
  const options = candidates
    .map(({ installation, authorityKind }, index) => {
      const account = escapeHtml(
        installation.accountLogin ?? `installation ${installation.installationId}`,
      );
      const label = authorityKind === "personal_owner" ? "Personal account" : "Organization owner";
      return `<label class="option"><input type="radio" name="installation_id" value="${installation.installationId}" required${candidates.length === 1 && index === 0 ? " checked" : ""}><span class="option-text"><strong>${account}</strong><small>${label}</small></span></label>`;
    })
    .join("");
  return page(
    "Choose a GitHub account",
    `<h1>Choose a GitHub account</h1><p class="intro">Connect an account where the Opengeni GitHub App is already installed, or install it on another account.</p><form id="existing-account" method="get" action="${escapeHtml(action)}"><input type="hidden" name="state" value="${escapeHtml(state)}"><fieldset class="options" aria-label="Available GitHub accounts">${options}</fieldset></form><div class="actions"><button class="button" type="submit" form="existing-account">Connect selected account</button><form method="get" action="${escapeHtml(action)}"><input type="hidden" name="state" value="${escapeHtml(state)}"><input type="hidden" name="installation_id" value="new"><button class="button secondary" type="submit">Install on another account</button></form></div><p class="note">Only accounts GitHub has confirmed you own or manage appear here.</p>`,
  );
}

export function githubSetupSuccessHtml(account: string, returnUrl: string): string {
  return page(
    "GitHub connected",
    `<h1>GitHub connected</h1><p class="intro"><strong>${escapeHtml(account)}</strong> is now available in this Opengeni workspace. Opengeni can access only the repositories allowed for this installation.</p><a class="button" href="${escapeHtml(returnUrl)}">Back to Opengeni</a>`,
  );
}

export function githubSetupPendingHtml(): string {
  return page(
    "GitHub approval pending",
    `<h1>Waiting for an organization owner</h1><p>An owner needs to approve your GitHub App request before you can connect. Opengeni has not created a workspace binding.</p>`,
  );
}

/**
 * Why a GitHub browser step could not continue. Browser navigation (a stale
 * page-load link, GitHub's Cancel button, a non-owner) must land on a readable
 * page with a way back, never on a raw JSON error body.
 */
export type GitHubConnectFailure =
  | "expired"
  | "cancelled"
  | "not_owner"
  | "forbidden"
  | "policy_denied"
  | "signed_out"
  | "failed";

const GITHUB_CONNECT_FAILURE_COPY: Record<GitHubConnectFailure, { title: string; body: string }> = {
  expired: {
    title: "This GitHub link expired",
    body: "GitHub connection links stay valid for 10 minutes, and each one works once. Go back to Opengeni and select Connect again to get a fresh link.",
  },
  cancelled: {
    title: "GitHub connection cancelled",
    body: "You cancelled on GitHub, so nothing was connected. Go back to Opengeni and select Connect when you are ready.",
  },
  not_owner: {
    title: "An owner needs to connect this account",
    body: "Only the owner of the GitHub account, or an owner of the GitHub organization, can connect it to Opengeni. Ask an owner to connect it, or install the app on an account you own.",
  },
  forbidden: {
    title: "You can't manage GitHub here",
    body: "Your Opengeni access doesn't allow connecting GitHub for this workspace. Ask a workspace admin to connect it.",
  },
  policy_denied: {
    title: "GitHub is turned off for your organization",
    body: "Your organization's integration policy doesn't allow connecting GitHub. Ask an organization admin to allow it, then select Connect again.",
  },
  signed_out: {
    title: "Sign in to continue",
    body: "Your Opengeni sign-in wasn't available when GitHub sent you back. Sign in to Opengeni and select Connect again.",
  },
  failed: {
    title: "GitHub couldn't finish connecting",
    body: "Nothing was connected. Go back to Opengeni and select Connect to try again.",
  },
};

export function githubConnectFailureHtml(
  failure: GitHubConnectFailure,
  returnUrl: string,
  detail?: string | null,
): string {
  const copy = GITHUB_CONNECT_FAILURE_COPY[failure];
  const note = detail?.trim()
    ? `<p class="note">Details: ${escapeHtml(detail.trim().slice(0, 300))}</p>`
    : "";
  return page(
    copy.title,
    `<h1>${escapeHtml(copy.title)}</h1><p class="intro">${escapeHtml(copy.body)}</p><a class="button" href="${escapeHtml(returnUrl)}">Back to Opengeni</a>${note}`,
  );
}

export function githubSuccessHtml(envLines: string[]): string {
  const escaped = escapeHtml(envLines.join("\n"));
  return page(
    "GitHub App created",
    `<h1>GitHub App created</h1><p>Add these values to .env, then restart API and worker.</p><div class="env-header"><h2>Environment variables</h2><button class="button secondary" id="copy-env" type="button">Copy env</button></div><pre id="env-lines">${escaped}</pre><script>(()=>{const button=document.getElementById("copy-env");const env=document.getElementById("env-lines");async function copyText(text){if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(text);return;}const area=document.createElement("textarea");area.value=text;area.setAttribute("readonly","");area.style.position="fixed";area.style.inset="-9999px";document.body.append(area);area.select();document.execCommand("copy");area.remove();}button?.addEventListener("click",async()=>{try{await copyText(env?.textContent||"");button.textContent="Copied";setTimeout(()=>button.textContent="Copy env",1600);}catch{button.textContent="Copy failed";setTimeout(()=>button.textContent="Copy env",2200);}});})();</script>`,
  );
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char] ?? char,
  );
}
