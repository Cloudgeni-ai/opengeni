import type { GitHubInstallationBindingCandidate } from "@opengeni/contracts";

// GitHub redirects can land on an API-only host. Keep these pages self-contained
// while using the same dark palette and typography as @opengeni/react.
const pageStyle = `
  :root{color-scheme:dark;--bg:oklch(.155 .012 260);--surface:oklch(.19 .014 260);--raised:oklch(.225 .015 260);--border:oklch(.3 .014 260);--border-strong:oklch(.42 .016 260);--fg:oklch(.955 .005 260);--muted:oklch(.73 .012 260);--blue:oklch(.54 .18 255);--blue-light:oklch(.72 .15 255)}
  *{box-sizing:border-box}
  html{min-height:100%;background:var(--bg)}
  body{margin:0;min-height:100vh;min-height:100dvh;color:var(--fg);background:var(--bg);font-family:"Inter Variable",Inter,ui-sans-serif,system-ui,sans-serif;font-feature-settings:"cv11","ss01","ss03";-webkit-font-smoothing:antialiased}
  .shell{width:min(100% - 48px,700px);margin:0 auto}
  header{height:84px;display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid var(--border)}
  .brand{font-size:16px;font-weight:670;letter-spacing:-.045em;color:var(--fg);text-decoration:none}
  .context{font-size:12px;color:var(--muted)}
  main{padding:clamp(48px,10vh,100px) 0 96px}
  h1{margin:0 0 14px;font-size:clamp(27px,4vw,36px);font-weight:640;letter-spacing:-.05em;line-height:1.17}
  p{margin:0;color:var(--muted);font-size:14px;line-height:1.65;max-width:59ch}
  .intro{margin-bottom:32px}
  .options{display:grid;gap:10px;margin:0 0 24px;padding:0;border:0;max-height:min(390px,52vh);overflow:auto}
  .option{display:flex;gap:14px;align-items:center;min-height:70px;padding:14px 16px;border:1px solid var(--border);border-radius:10px;background:var(--surface);cursor:pointer;transition:background .15s,border-color .15s}
  .option:hover{background:var(--raised)}
  .option:has(input:checked){border-color:var(--blue-light);background:var(--raised)}
  .option:has(input:focus-visible){outline:2px solid var(--blue-light);outline-offset:3px}
  .option input{margin:0;flex:none;width:17px;height:17px;accent-color:var(--blue-light)}
  .option-text{min-width:0;display:grid;gap:3px}
  .option strong{overflow-wrap:anywhere;font-size:14px;font-weight:600}
  .option small{font-size:12px;color:var(--muted)}
  .actions{display:flex;align-items:center;flex-wrap:wrap;gap:12px;margin-top:24px}
  .button{display:inline-flex;min-height:42px;align-items:center;justify-content:center;padding:0 17px;border:1px solid var(--blue);border-radius:8px;background:var(--blue);color:#fff;font-family:inherit;font-size:13px;font-weight:600;text-decoration:none;cursor:pointer}
  .button:hover{background:oklch(.6 .18 255)}
  .button:disabled{cursor:wait;opacity:.7}
  .secondary{border-color:var(--border);background:transparent;color:var(--fg)}
  .secondary:hover{background:var(--raised)}
  :is(button,a):focus-visible{outline:2px solid var(--blue-light);outline-offset:3px}
  .note{margin-top:30px;padding-top:20px;border-top:1px solid var(--border);font-size:12px}
  .env-header{display:flex;justify-content:space-between;align-items:center;gap:14px;margin-top:36px}
  h2{margin:0;font-size:14px;font-weight:600}
  pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:380px;overflow:auto;padding:18px;border:1px solid var(--border);border-radius:10px;background:var(--surface);font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}
  @media(max-width:480px){.shell{width:calc(100% - 32px)}header{height:70px}main{padding-top:56px}.actions{align-items:stretch;flex-direction:column}.actions form,.actions .button{width:100%}}
  @media(prefers-reduced-motion:reduce){.option{transition:none}}
`;

function page(title: string, content: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · OpenGeni</title><style>${pageStyle}</style></head><body><div class="shell"><header><span class="brand">OpenGeni</span><span class="context">GitHub connection</span></header><main>${content}</main></div></body></html>`;
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
    `<h1>Choose a GitHub account</h1><p class="intro">Connect an account where the OpenGeni GitHub App is already installed, or install it on another account.</p><form id="existing-account" method="get" action="${escapeHtml(action)}"><input type="hidden" name="state" value="${escapeHtml(state)}"><fieldset class="options" aria-label="Available GitHub accounts">${options}</fieldset></form><div class="actions"><button class="button" type="submit" form="existing-account">Connect selected account</button><form method="get" action="${escapeHtml(action)}"><input type="hidden" name="state" value="${escapeHtml(state)}"><input type="hidden" name="installation_id" value="new"><button class="button secondary" type="submit">Install on another account</button></form></div><p class="note">Only accounts GitHub has confirmed you own or manage appear here.</p>`,
  );
}

export function githubSetupSuccessHtml(account: string, returnUrl: string): string {
  return page(
    "GitHub connected",
    `<h1>GitHub connected</h1><p class="intro"><strong>${escapeHtml(account)}</strong> is now available in this OpenGeni workspace. OpenGeni can access only the repositories allowed for this installation.</p><a class="button" href="${escapeHtml(returnUrl)}">Back to OpenGeni</a>`,
  );
}

export function githubSetupPendingHtml(): string {
  return page(
    "GitHub approval pending",
    `<h1>Waiting for an organization owner</h1><p>An owner needs to approve your GitHub App request before you can connect. OpenGeni has not created a workspace binding.</p>`,
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
    body: "GitHub connection links stay valid for 10 minutes, and each one works once. Go back to OpenGeni and select Connect again to get a fresh link.",
  },
  cancelled: {
    title: "GitHub connection cancelled",
    body: "You cancelled on GitHub, so nothing was connected. Go back to OpenGeni and select Connect when you are ready.",
  },
  not_owner: {
    title: "An owner needs to connect this account",
    body: "Only the owner of the GitHub account, or an owner of the GitHub organization, can connect it to OpenGeni. Ask an owner to connect it, or install the app on an account you own.",
  },
  forbidden: {
    title: "You can't manage GitHub here",
    body: "Your OpenGeni access doesn't allow connecting GitHub for this workspace. Ask a workspace admin to connect it.",
  },
  policy_denied: {
    title: "GitHub is turned off for your organization",
    body: "Your organization's integration policy doesn't allow connecting GitHub. Ask an organization admin to allow it, then select Connect again.",
  },
  signed_out: {
    title: "Sign in to continue",
    body: "Your OpenGeni sign-in wasn't available when GitHub sent you back. Sign in to OpenGeni and select Connect again.",
  },
  failed: {
    title: "GitHub couldn't finish connecting",
    body: "Nothing was connected. Go back to OpenGeni and select Connect to try again.",
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
    `<h1>${escapeHtml(copy.title)}</h1><p class="intro">${escapeHtml(copy.body)}</p><a class="button" href="${escapeHtml(returnUrl)}">Back to OpenGeni</a>${note}`,
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
