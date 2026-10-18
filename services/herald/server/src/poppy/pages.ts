import { SCOPES } from './config.js';

// Server-rendered pages for Direct and Device Sign-In. Everything shown here
// that came from a Personal Agent (name, logo, scopes it asked for) is
// untrusted and escaped; the client_id domain is shown because the agent
// chooses its own name, and the domain is what the User can trust.

export function escapeHtml(value: unknown): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// JSON for a <script> block; escapes the characters that could end it.
function scriptJson(value: unknown): string {
    return JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

export function pageHeaders(nonce: string): Record<string, string> {
    return {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': [
            "default-src 'none'",
            `script-src 'nonce-${nonce}' https://cdn.jsdelivr.net`,
            `style-src 'nonce-${nonce}'`,
            'img-src https: data:',
            "connect-src 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'",
            "base-uri 'none'",
        ].join('; '),
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
    };
}

const STYLE = `
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 440px; margin: 40px auto; padding: 0 16px; color: #111827; }
h1 { font-size: 22px; margin-bottom: 4px; }
.muted { color: #6b7280; font-size: 14px; }
.agent { display: flex; gap: 12px; align-items: center; margin: 24px 0 8px; }
.agent img { width: 48px; height: 48px; border-radius: 10px; object-fit: cover; }
.domain { font-family: ui-monospace, monospace; font-size: 14px; background: #f3f4f6; padding: 2px 6px; border-radius: 4px; }
.box { border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px; margin: 16px 0; }
.code { font-family: ui-monospace, monospace; font-size: 26px; letter-spacing: 3px; text-align: center; }
label.scope { display: flex; gap: 10px; align-items: flex-start; margin: 8px 0; }
button, .button { display: inline-block; padding: 10px 18px; border-radius: 8px; border: 0; font-weight: 600; font-size: 15px; cursor: pointer; text-decoration: none; }
.primary { background: #4f46e5; color: #fff; }
.secondary { background: #e5e7eb; color: #111827; }
input[type=text] { font-family: ui-monospace, monospace; font-size: 20px; padding: 8px; width: 100%; box-sizing: border-box; text-transform: uppercase; }
#qr { display: block; margin: 12px auto; }
.did { font-family: ui-monospace, monospace; font-size: 11px; word-break: break-all; color: #6b7280; }
.hidden { display: none; }
.error { color: #b91c1c; }
`;

function layout(nonce: string, title: string, body: string, script = ''): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
${body}
${script}
</body>
</html>`;
}

export function errorPage(nonce: string, organization: string, message: string): string {
    return layout(nonce, `${organization} sign-in`, `
<h1>This sign-in can't continue</h1>
<p>${escapeHtml(message)}</p>
<p class="muted">Return to the app that sent you here and try again.</p>`);
}

export interface ConsentPageInput {
    nonce: string;
    organization: string;
    agentName: string;
    agentDomain: string;
    logoUri?: string;
    scope: string[];
    accessDays: number;
    challengeUrl: string;
    statusUrl: string;
    decideUrl: string;
    csrf: string;
    userCode?: string;
}

export function consentPage(input: ConsentPageInput): string {
    const scopes = input.scope.map(scope => `
<label class="scope"><input type="checkbox" name="scope" value="${escapeHtml(scope)}" checked>
<span><strong>${escapeHtml(scope)}</strong><br><span class="muted">${escapeHtml(SCOPES[scope as keyof typeof SCOPES] ?? scope)}</span></span></label>`).join('');
    const logo = input.logoUri ? `<img src="${escapeHtml(input.logoUri)}" alt="">` : '';
    const code = input.userCode ? `
<div class="box"><p class="muted">Check that this code matches the one your agent shows:</p><p class="code">${escapeHtml(input.userCode)}</p></div>` : '';

    const body = `
<h1>Connect an agent to ${escapeHtml(input.organization)}</h1>
<div class="agent">${logo}<div><strong>${escapeHtml(input.agentName)}</strong><br><span class="domain">${escapeHtml(input.agentDomain)}</span></div></div>
<p class="muted">An agent calling itself “${escapeHtml(input.agentName)}”, run from <span class="domain">${escapeHtml(input.agentDomain)}</span>, wants to act on your ${escapeHtml(input.organization)} account.</p>
${code}
<div id="signin" class="box">
<p>Sign in with your Archon wallet to see what it is asking for.</p>
<a id="qr-link" href="${escapeHtml(input.challengeUrl)}" target="_blank" rel="noopener"><canvas id="qr"></canvas></a>
<p><a class="button primary" href="${escapeHtml(input.challengeUrl)}" target="_blank" rel="noopener">Open in wallet</a></p>
<p class="muted" id="waiting">Waiting for your wallet…</p>
</div>
<form id="consent" class="box hidden">
<p>Signed in as <strong id="account-name"></strong></p>
<p class="did" id="account-did"></p>
<p>Allow this agent to:</p>
${scopes}
<p class="muted">Access lasts ${input.accessDays} days, until the agent signs out, or until you disconnect it in your account settings.</p>
<p><button type="submit" class="primary">Allow</button> <button type="button" id="decline" class="secondary">Decline</button></p>
<p class="error" id="error"></p>
</form>
<div id="done" class="box hidden"><p id="done-text"></p></div>`;

    const config = scriptJson({
        statusUrl: input.statusUrl,
        decideUrl: input.decideUrl,
        csrf: input.csrf,
        challengeUrl: input.challengeUrl,
    });

    const script = `
<script nonce="${input.nonce}" src="https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js"></script>
<script nonce="${input.nonce}">
(function () {
  var cfg = ${config};
  try { QRCode.toCanvas(document.getElementById('qr'), cfg.challengeUrl, { width: 220, margin: 2 }); }
  catch (e) { document.getElementById('qr-link').classList.add('hidden'); }
  var form = document.getElementById('consent');
  var polling = setInterval(poll, 2000);
  function show(id) { document.getElementById(id).classList.remove('hidden'); }
  function hide(id) { document.getElementById(id).classList.add('hidden'); }
  async function poll() {
    try {
      var res = await fetch(cfg.statusUrl, { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) { clearInterval(polling); finish('This sign-in has expired. Start again from your agent.'); return; }
      var data = await res.json();
      if (data.status === 'authenticated') {
        clearInterval(polling);
        document.getElementById('account-name').textContent = data.name || 'your Archon identity';
        document.getElementById('account-did').textContent = data.did;
        hide('signin'); show('consent');
      }
    } catch (e) {}
  }
  function finish(text) {
    hide('signin'); hide('consent');
    document.getElementById('done-text').textContent = text;
    show('done');
  }
  var buttons = form.querySelectorAll('button');
  async function decide(decision) {
    buttons.forEach(function (b) { b.disabled = true; });
    var scope = Array.prototype.slice.call(form.querySelectorAll('input[name=scope]:checked')).map(function (el) { return el.value; });
    var res = await fetch(cfg.decideUrl, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Poppy-CSRF': cfg.csrf },
      body: JSON.stringify({ decision: decision, scope: scope })
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) { document.getElementById('error').textContent = data.error_description || 'Something went wrong.'; buttons.forEach(function (b) { b.disabled = false; }); return; }
    if (data.redirect) { window.location.assign(data.redirect); return; }
    finish(data.message || 'Done. You can close this page.');
  }
  form.addEventListener('submit', function (ev) { ev.preventDefault(); decide('approve'); });
  document.getElementById('decline').addEventListener('click', function () { decide('decline'); });
})();
</script>`;

    return layout(input.nonce, `Connect an agent to ${input.organization}`, body, script);
}

export function deviceEntryPage(nonce: string, organization: string, actionUrl: string, userCode: string, message = ''): string {
    return layout(nonce, `${organization} device sign-in`, `
<h1>Connect an agent to ${escapeHtml(organization)}</h1>
<p>Enter the code your agent shows you.</p>
<form method="post" action="${escapeHtml(actionUrl)}" class="box">
<p><input type="text" name="user_code" value="${escapeHtml(userCode)}" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="12" required></p>
<p><button type="submit" class="primary">Continue</button></p>
${message ? `<p class="error">${escapeHtml(message)}</p>` : ''}
</form>
<p class="muted">Continuing does not connect anything. You will sign in with your wallet and choose what to allow.</p>`);
}
