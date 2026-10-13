/** HTML for the fake-login suite. Plain server-rendered pages with small inline scripts. */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

const STYLE = `
  :root { color-scheme: light; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  body { margin: 0; background: #f4f5f7; color: #1d2330; }
  header { background: #24324a; color: #fff; padding: 12px 24px; display: flex; gap: 16px; align-items: center; }
  header a { color: #cfe0ff; text-decoration: none; font-size: 14px; }
  header strong { font-size: 16px; margin-right: auto; }
  main { max-width: 460px; margin: 40px auto; background: #fff; border-radius: 10px; padding: 28px 32px;
         box-shadow: 0 1px 3px rgba(0,0,0,.12); }
  h1 { font-size: 22px; margin: 0 0 16px; }
  p { line-height: 1.45; }
  label { display: block; font-size: 14px; font-weight: 600; margin: 14px 0 6px; }
  input[type=text], input[type=email], input[type=password], input:not([type]) {
    width: 100%; box-sizing: border-box; padding: 10px 12px; font-size: 15px; border: 1px solid #b8c0cc; border-radius: 6px; }
  button { margin-top: 18px; padding: 10px 18px; font-size: 15px; border: 0; border-radius: 6px; background: #2f6fde; color: #fff; cursor: pointer; }
  button[disabled] { background: #9db5df; cursor: not-allowed; }
  .error { background: #fde8e8; color: #9b1c1c; padding: 10px 12px; border-radius: 6px; margin-bottom: 12px; }
  .error ul { margin: 4px 0 0 18px; padding: 0; }
  .ok { background: #e6f6ea; color: #1f6b33; padding: 10px 12px; border-radius: 6px; }
  .hint { color: #5a6475; font-size: 13px; }
  code { background: #eef1f5; padding: 2px 6px; border-radius: 4px; word-break: break-all; }
  .otp { display: flex; gap: 8px; margin-top: 8px; }
  .otp input { width: 44px; height: 52px; text-align: center; font-size: 24px; padding: 0; }
  .qr { width: 200px; height: 200px; margin: 12px 0; }
  ul.flows li { margin: 6px 0; }
`;

export function page(input: {
  title: string;
  body: string;
  user?: string | null;
  script?: string;
}): string {
  const who = input.user
    ? `<span id="whoami" data-user="${escapeHtml(input.user)}">Signed in as ${escapeHtml(input.user)}</span> <a href="/logout">Sign out</a>`
    : `<span id="whoami" data-user="">Not signed in</span>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)} · Fake Login</title><style>${STYLE}</style></head>
<body><header><strong><a href="/" style="color:#fff">Fake Login</a></strong>${who}</header>
<main>${input.body}</main>${input.script ? `<script>${input.script}</script>` : ""}</body></html>`;
}

export function errorBox(errors: readonly string[]): string {
  if (errors.length === 0) return "";
  if (errors.length === 1)
    return `<div class="error" role="alert" id="error">${escapeHtml(errors[0]!)}</div>`;
  return `<div class="error" role="alert" id="error">Fix these problems:<ul>${errors
    .map((error) => `<li>${escapeHtml(error)}</li>`)
    .join("")}</ul></div>`;
}

export function credentialFields(input: {
  username?: string;
  autocompletePassword?: string;
}): string {
  return `<label for="username">Username</label>
<input id="username" name="username" type="text" autocomplete="username" required value="${escapeHtml(input.username ?? "")}">
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="${input.autocompletePassword ?? "current-password"}" required>`;
}

/** base64url helpers shared by the WebAuthn pages. */
export const WEBAUTHN_CLIENT_HELPERS = `
const b64 = {
  toBuf(text) { const s = atob(text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=')); return Uint8Array.from(s, c => c.charCodeAt(0)).buffer; },
  fromBuf(buf) { let s = ''; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, ''); },
};
async function postJson(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || ('HTTP ' + response.status));
  return json;
}
function setStatus(text, ok) {
  const node = document.getElementById('passkey-status');
  node.textContent = text; node.className = ok ? 'ok' : 'error'; node.hidden = false;
}
`;

export const PASSKEY_REGISTER_SCRIPT = `${WEBAUTHN_CLIENT_HELPERS}
document.getElementById('create-passkey').addEventListener('click', async () => {
  try {
    const options = await postJson('/passkey/register/options');
    options.challenge = b64.toBuf(options.challenge);
    options.user.id = b64.toBuf(options.user.id);
    options.excludeCredentials = (options.excludeCredentials || []).map(c => ({ ...c, id: b64.toBuf(c.id) }));
    const credential = await navigator.credentials.create({ publicKey: options });
    const result = await postJson('/passkey/register/verify', {
      id: credential.id, rawId: b64.fromBuf(credential.rawId), type: credential.type,
      response: {
        clientDataJSON: b64.fromBuf(credential.response.clientDataJSON),
        attestationObject: b64.fromBuf(credential.response.attestationObject),
        transports: credential.response.getTransports ? credential.response.getTransports() : [],
      },
    });
    setStatus('Passkey saved for ' + result.username, true);
    document.getElementById('passkey-status').dataset.credentialId = result.credentialId;
  } catch (error) {
    setStatus('Passkey registration failed: ' + (error && error.message ? error.message : error), false);
  }
});
`;

export const PASSKEY_LOGIN_SCRIPT = `${WEBAUTHN_CLIENT_HELPERS}
document.getElementById('passkey-login').addEventListener('click', async () => {
  try {
    const username = document.getElementById('username').value.trim();
    const options = await postJson('/passkey/login/options', username ? { username } : {});
    options.challenge = b64.toBuf(options.challenge);
    options.allowCredentials = (options.allowCredentials || []).map(c => ({ ...c, id: b64.toBuf(c.id) }));
    const credential = await navigator.credentials.get({ publicKey: options });
    const result = await postJson('/passkey/login/verify', {
      id: credential.id, rawId: b64.fromBuf(credential.rawId), type: credential.type,
      response: {
        clientDataJSON: b64.fromBuf(credential.response.clientDataJSON),
        authenticatorData: b64.fromBuf(credential.response.authenticatorData),
        signature: b64.fromBuf(credential.response.signature),
        userHandle: credential.response.userHandle ? b64.fromBuf(credential.response.userHandle) : null,
      },
    });
    setStatus('Signed in as ' + result.username, true);
    location.href = '/welcome';
  } catch (error) {
    setStatus('Passkey sign-in failed: ' + (error && error.message ? error.message : error), false);
  }
});
`;

/**
 * Six single-character boxes that only accept digits delivered as key events
 * (keydown). Text inserted without key events (CDP Input.insertText, paste, IME
 * commit) is discarded, which is exactly what makes `type.mode: "keys"` necessary.
 */
export const OTP_SPLIT_SCRIPT = `
const boxes = Array.from(document.querySelectorAll('.otp input'));
const form = document.getElementById('otp-form');
const hidden = document.getElementById('code');
let keyed = false;
function maybeSubmit() {
  const code = boxes.map(b => b.value).join('');
  hidden.value = code;
  if (code.length === boxes.length && /^[0-9]+$/.test(code)) form.submit();
}
boxes.forEach((box, index) => {
  box.addEventListener('keydown', (event) => {
    if (/^[0-9]$/.test(event.key)) {
      event.preventDefault();
      box.value = event.key;
      keyed = true;
      if (index + 1 < boxes.length) boxes[index + 1].focus();
      maybeSubmit();
    } else if (event.key === 'Backspace') {
      event.preventDefault();
      if (box.value) box.value = ''; else if (index > 0) { boxes[index - 1].value = ''; boxes[index - 1].focus(); }
    } else if (event.key.length === 1) {
      event.preventDefault();
    }
  });
  box.addEventListener('input', () => {
    // Values that did not arrive through keydown are rejected.
    if (!keyed) { box.value = ''; document.getElementById('otp-hint').textContent = 'Type the digits one by one.'; }
    keyed = false;
  });
  box.addEventListener('paste', (event) => { event.preventDefault(); document.getElementById('otp-hint').textContent = 'Pasting is disabled. Type the digits.'; });
});
form.addEventListener('submit', () => { hidden.value = boxes.map(b => b.value).join(''); });
boxes[0].focus();
`;

export function popupLoginScript(idpOrigin: string, mainOrigin: string): string {
  return `
document.getElementById('open-popup').addEventListener('click', () => {
  window.open(${JSON.stringify(`${idpOrigin}/idp/authorize?return_origin=${encodeURIComponent(mainOrigin)}`)}, 'fakeid', 'popup,width=480,height=640');
});
window.addEventListener('message', async (event) => {
  if (event.origin !== ${JSON.stringify(idpOrigin)} || !event.data || event.data.type !== 'fakeid-token') return;
  const response = await fetch('/popup-login/complete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: event.data.token }) });
  if (response.ok) location.href = '/welcome';
  else document.getElementById('popup-status').textContent = 'Sign-in with FakeID failed.';
});
`;
}

export function captchaParentScript(widgetOrigin: string): string {
  return `
window.addEventListener('message', (event) => {
  if (event.origin !== ${JSON.stringify(widgetOrigin)} || !event.data || event.data.type !== 'captcha-solved') return;
  document.getElementById('captcha_token').value = event.data.token;
  document.getElementById('sign-in').disabled = false;
  document.getElementById('captcha-state').textContent = 'Challenge solved.';
});
`;
}

export function captchaWidgetScript(parentOrigin: string): string {
  return `
let challengeId = null;
function draw(text) {
  const canvas = document.getElementById('challenge');
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f2efe6'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < 6; i++) {
    ctx.strokeStyle = 'rgba(80,80,120,0.5)'; ctx.beginPath();
    ctx.moveTo(Math.random() * canvas.width, Math.random() * canvas.height);
    ctx.bezierCurveTo(Math.random() * 240, Math.random() * 70, Math.random() * 240, Math.random() * 70, Math.random() * canvas.width, Math.random() * canvas.height);
    ctx.stroke();
  }
  [...text].forEach((ch, i) => {
    ctx.save();
    ctx.translate(26 + i * 40, 46 + (Math.random() * 10 - 5));
    ctx.rotate((Math.random() - 0.5) * 0.6);
    ctx.font = 'bold ' + (30 + Math.floor(Math.random() * 6)) + 'px Georgia, serif';
    ctx.fillStyle = ['#3a2f6b', '#6b2f3a', '#2f5b3a', '#1f3f6b'][i % 4];
    ctx.fillText(ch, 0, 0);
    ctx.restore();
  });
}
async function load() {
  const response = await fetch('/captcha/challenge', { method: 'POST' });
  const json = await response.json();
  challengeId = json.id;
  document.getElementById('challenge').dataset.challengeId = json.id;
  draw(json.glyphs);
  document.getElementById('solve').hidden = false;
  document.getElementById('answer').value = '';
  document.getElementById('answer').focus();
}
document.getElementById('robot').addEventListener('change', (event) => { if (event.target.checked) load(); });
document.getElementById('verify').addEventListener('click', async () => {
  const answer = document.getElementById('answer').value;
  const response = await fetch('/captcha/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: challengeId, answer }) });
  const json = await response.json();
  if (json.token) {
    document.getElementById('solve').hidden = true;
    document.getElementById('verdict').textContent = 'Verified';
    document.getElementById('verdict').className = 'ok';
    parent.postMessage({ type: 'captcha-solved', token: json.token }, ${JSON.stringify(parentOrigin)});
  } else {
    document.getElementById('verdict').textContent = 'Wrong answer, try this one.';
    document.getElementById('verdict').className = 'error';
    load();
  }
});
`;
}
