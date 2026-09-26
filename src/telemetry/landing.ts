/**
 * Meridian landing page.
 *
 * The at-a-glance dashboard: a short how-it-works intro, per-account cards
 * (usage + est. cost, click to switch the active profile), and a compact
 * 24h traffic strip. Site chrome (logo, nav, status) lives in the shared
 * header from profileBar.ts. Fetches /health, /telemetry/summary,
 * /v1/usage/quota/all, /profiles/list and /settings/api/routing client-side for live data.
 *
 * Token authentication: when any profile has an accessKey, the dashboard
 * requires a valid Token. The Token is stored in sessionStorage (tab-only)
 * and attached as x-api-key via window.meridianApiFetch. An invalid/missing
 * Token renders a full-page blocking login screen — no nav, no dashboard content.
 * Any profile's Token grants full dashboard access.
 */

import { profileBarCss, profileBarHtml, profileBarJs, themeCss } from "./profileBar"
import { profileFactsJs } from "./profileFacts"
import { reorderClientJs, reorderCss, reorderLiveRegionHtml } from "./profileOrder"
import { DEFAULT_PROFILE_SORT, PROFILE_SORT_MODES } from "./profileSort"
import { FADE_FROM, GENERAL_WINDOW_TYPES, SPENT_AT } from "./profileSpent"

export const landingHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Meridian</title>
<style>
  ${themeCss}
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
         color: var(--text); line-height: 1.6; min-height: 100vh; }
  .container { max-width: 960px; margin: 0 auto; padding: 28px 24px; }

  /* Intro — friendly one-paragraph overview of how Meridian works */
  .intro { margin-bottom: 28px; }
  .intro h2 { font-size: 20px; font-weight: 700; margin-bottom: 6px; }
  .intro p { font-size: 13px; color: var(--muted); max-width: 640px; }
  .intro code { font-family: 'SF Mono', SFMono-Regular, Consolas, monospace; font-size: 12px;
    background: var(--surface); border: 1px solid var(--border); border-radius: 5px;
    padding: 1px 6px; color: var(--accent2); white-space: nowrap; }
  .intro a { color: var(--accent); text-decoration: none; }
  .intro a:hover { text-decoration: underline; }
  .intro-meta { font-size: 12px; color: var(--muted); margin-top: 8px; }

  /* Profile cards — the centerpiece: usage + cost per account, click to switch */
  .profile-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .profile-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
    padding: 18px 20px; position: relative; transition: border-color 0.15s; }
  .profile-card.switchable { cursor: pointer; }
  .profile-card.switchable:hover { border-color: var(--accent); }
  .profile-card.active { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }

  /* Spent accounts recede. --spend-fade is set per card (0..1) from the
     shared classifier; hovering restores the card so a dimmed one can still
     be read. An account that needs a login is NOT dimmed — it needs
     attention, not fading, so it keeps full contrast and turns red.

     The fade is on the card's CONTENTS and never on the card, because
     filter and opacity apply to an element's OWN border and box-shadow.
     Fading .profile-card therefore greyed out the accent ring on
     .profile-card.active - the one mark on the page saying which account is
     serving requests - so the active profile became unfindable the moment it
     passed 95%, which is precisely when somebody comes looking for it. A
     descendant cannot undo an ancestor's filter or opacity, so scoping the
     fade to the children is the only thing that leaves the ring alone; the
     "Active" pill sits inside those contents and fades with them. */
  .profile-card.spend-fading > *, .profile-card.spend-spent > * {
    filter: grayscale(var(--spend-fade, 0));
    opacity: calc(1 - 0.55 * var(--spend-fade, 0));
    transition: filter 0.2s, opacity 0.2s; }
  .profile-card.spend-fading:hover > *, .profile-card.spend-spent:hover > * { filter: none; opacity: 1; }
  .profile-card.needs-login { border-color: var(--red); }
  .profile-card.needs-login .prof-dot { background: var(--red); }
  .spend-pill { font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
    color: var(--muted); background: var(--surface2); border: 1px solid var(--border);
    border-radius: 10px; padding: 1px 8px; }
  .spend-pill.needs-login { color: var(--red); background: rgba(248,81,73,0.12);
    border-color: rgba(248,81,73,0.35); }
  ${reorderCss}
  .profile-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 4px; }
  .profile-name { font-size: 13px; font-weight: 600; letter-spacing: 0.5px; display: flex; align-items: center; gap: 8px; }
  .profile-name .prof-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--border); }
  .profile-card.active .prof-dot { background: var(--accent); box-shadow: 0 0 6px rgba(88,166,255,0.5); }
  .active-pill { font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
    color: var(--accent); background: rgba(88,166,255,0.12); border: 1px solid rgba(88,166,255,0.35);
    border-radius: 10px; padding: 1px 8px; }
  .switch-hint { font-size: 9px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px;
    color: var(--muted); opacity: 0; transition: opacity 0.15s; }
  .profile-card.switchable:hover .switch-hint { opacity: 1; }
  .profile-cost { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--text); }

  /* Account details on hover. Drawn rather than a title attribute: the native
     tooltip cannot show a label/value list, and this one has to match the grid
     on /profiles row for row. */
  .prof-info { position: relative; display: inline-flex; }
  .prof-info-dot { width: 14px; height: 14px; flex-shrink: 0; border-radius: 50%;
    border: 1px solid var(--border); background: var(--surface2); color: var(--muted);
    font-size: 11px; font-weight: 600; text-align: center; line-height: 12px; }
  .prof-info:hover .prof-info-popover {
    display: flex; flex-direction: column; gap: 4px; }
  .prof-info-popover { display: none; position: absolute; bottom: 120%; left: 50%; transform: translateX(-50%);
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    padding: 12px 16px; min-width: 220px; z-index: 10; box-shadow: 0 4px 16px rgba(0,0,0,0.2); }
  .prof-info-row { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; }
  .prof-info-label { color: var(--muted); }
  .prof-info-value { font-weight: 500; color: var(--text); text-align: right; }
  .prof-info-value.code { font-family: 'SF Mono', SFMono-Regular, Consolas, monospace; font-size: 11px; }

  /* Token card for each profile */
  .token-row { display: flex; align-items: center; gap: 8px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); }
  .token-value { font-family: 'SF Mono', SFMono-Regular, Consolas, monospace; font-size: 11px;
    background: var(--surface2); border: 1px solid var(--border); border-radius: 6px;
    padding: 4px 8px; flex: 1; color: var(--text); word-break: break-all; }
  .token-btn { font-size: 11px; padding: 4px 10px; white-space: nowrap; }
  .token-actions { display: flex; gap: 6px; }
  .token-hidden .token-value { color: var(--muted); }

  /* Panel cards (login, add, rename, etc.) */
  .panel-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 20px; margin-bottom: 16px; }
  .panel-card h3 { font-size: 14px; font-weight: 600; margin-bottom: 12px; }
  .panel-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .text-input { flex: 1; min-width: 200px; padding: 6px 10px; font-size: 13px;
    background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; color: var(--text); }
  .text-input:focus { outline: none; border-color: var(--accent); }
  .text-input.mono { font-family: 'SF Mono', SFMono-Regular, Consolas, monospace; }
  .btn { padding: 6px 14px; font-size: 13px; font-weight: 500; border: none; border-radius: 6px;
    cursor: pointer; background: var(--accent); color: #fff; }
  .btn:hover { filter: brightness(1.1); }
  .btn:disabled { opacity: 0.6; cursor: not-allowed; }
  .btn-quiet { background: var(--surface2); color: var(--text); border: 1px solid var(--border); }
  .btn-quiet:hover { background: var(--border); }
  .btn-danger { background: var(--red); color: #fff; }
  .inline-err { color: var(--red); font-size: 12px; margin-top: 8px; }
  .notice-bar { padding: 8px 12px; border-radius: 6px; margin-bottom: 16px; font-size: 13px; }
  .notice-bar.ok { background: rgba(52,199,89,0.15); color: var(--green); border: 1px solid rgba(52,199,89,0.3); }
  .notice-bar.err { background: rgba(248,81,73,0.15); color: var(--red); border: 1px solid rgba(248,81,73,0.3); }

  /* Login steps */
  .login-steps { margin: 12px 0; padding-left: 20px; font-size: 13px; }
  .login-steps li { margin-bottom: 8px; }
  .login-steps a { color: var(--accent); word-break: break-all; }

  /* Traffic strip */
  .strip { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 24px; }
  .strip-item { flex: 1; min-width: 140px; background: var(--surface); border: 1px solid var(--border);
    border-radius: 10px; padding: 14px 16px; }
  .strip-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
    color: var(--muted); margin-bottom: 4px; }
  .strip-value { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--text); }
  .strip-detail { font-size: 11px; color: var(--muted); margin-top: 2px; }

  /* Section headers */
  .section { margin-top: 28px; }
  .section-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 12px; }
  .section-title { font-size: 14px; font-weight: 600; letter-spacing: 0.5px; }

  /* Footer */
  .footer { margin-top: 32px; text-align: center; font-size: 12px; color: var(--muted); }
  .footer a { color: var(--accent); text-decoration: none; }
  .footer a:hover { text-decoration: underline; }

  /* ==== Token Login Page (blocking) ==== */
  .login-page { display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 24px; }
  .login-box { width: 100%; max-width: 420px; background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 32px; }
  .login-box h1 { font-size: 22px; font-weight: 700; margin-bottom: 4px; text-align: center; }
  .login-box .subtitle { text-align: center; color: var(--muted); margin-bottom: 28px; font-size: 14px; }
  .login-box .token-input-group { margin-bottom: 20px; }
  .login-box label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 6px; }
  .login-box .token-input { width: 100%; padding: 10px 12px; font-size: 14px;
    background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; color: var(--text); }
  .login-box .token-input:focus { outline: none; border-color: var(--accent); }
  .login-box .btn-submit { width: 100%; padding: 12px; font-size: 14px; font-weight: 600; }
  .login-box .login-error { color: var(--red); font-size: 13px; text-align: center; margin-top: 12px; min-height: 20px; }
  .login-box .login-footer { margin-top: 24px; text-align: center; font-size: 12px; color: var(--muted); }
  .login-box .login-footer a { color: var(--accent); text-decoration: none; }
  .login-box .login-footer a:hover { text-decoration: underline; }

  /* Hidden content during login */
  .hidden { display: none !important; }

  ${profileBarCss}
</style>
</head>
<body>
<div id="mhHeader"></div>
<div class="container" id="mainContent">
  <div id="loginScreen" class="hidden">
    <div class="login-box">
      <h1>Meridian</h1>
      <p class="subtitle">Enter a profile Token to access the dashboard</p>
      <form id="tokenForm" onsubmit="return false;">
        <div class="token-input-group">
          <label for="tokenInput">Token</label>
          <input type="password" id="tokenInput" class="token-input" placeholder="mrd_..." autocomplete="off" required>
        </div>
        <button type="button" class="btn btn-submit" id="tokenSubmit" onclick="submitToken()">Sign in</button>
        <div class="login-error" id="tokenError"></div>
      </form>
      <p class="login-footer">Any profile Token works. Generate one from the Profiles page after signing in.</p>
    </div>
  </div>

  <div id="dashboardContent" class="hidden">
    <section class="intro">
      <h2>Meridian</h2>
      <p>Local proxy for <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a>,
        <a href="https://github.com/anomalyco/opencode">OpenCode</a> and other agents — connects them to
        your <a href="https://www.anthropic.com/claude/pricing">Claude Max/Team</a> subscription via the Agent SDK.</p>
      <p class="intro-meta" id="introMeta"></p>
    </section>

    <div id="accountsSection"></div>

    <div class="section">
      <div class="section-head"><div class="section-title">Last 24 Hours</div></div>
      <div class="strip" id="trafficStrip"></div>
    </div>

    <div class="footer">Meridian · <a href="https://github.com/rynfar/meridian">GitHub</a> · Built on the <a href="https://github.com/anthropics/claude-agent-sdk-typescript">Claude Agent SDK</a></div>
  </div>
</div>

${profileBarHtml}
${reorderLiveRegionHtml}

<script>
  ${profileFactsJs}
  ${reorderClientJs}

  /* ==== Token Login Logic ==== */
  const TOKEN_STORAGE = 'meridian.apiKey';
  var tokenErrorEl = document.getElementById('tokenError');
  var tokenInputEl = document.getElementById('tokenInput');
  var tokenSubmitEl = document.getElementById('tokenSubmit');
  var loginScreenEl = document.getElementById('loginScreen');
  var dashboardContentEl = document.getElementById('dashboardContent');

  function storedToken() {
    try { return sessionStorage.getItem(TOKEN_STORAGE) || ''; }
    catch (_) { return ''; }
  }
  function setStoredToken(key) {
    try {
      if (key) sessionStorage.setItem(TOKEN_STORAGE, key);
      else sessionStorage.removeItem(TOKEN_STORAGE);
    } catch (_) { /* lost token is not worth failing over */ }
  }

  async function validateToken(token) {
    try {
      var res = await fetch('/profiles/list', { headers: { 'x-api-key': token } });
      return res.ok;
    } catch (_) {
      return false;
    }
  }

  function showLoginScreen(error) {
    loginScreenEl.classList.remove('hidden');
    dashboardContentEl.classList.add('hidden');
    if (error) tokenErrorEl.textContent = error;
    tokenInputEl.focus();
  }

  function showDashboard() {
    loginScreenEl.classList.add('hidden');
    dashboardContentEl.classList.remove('hidden');
  }

  async function submitToken() {
    var token = tokenInputEl.value.trim();
    if (!token) { tokenErrorEl.textContent = 'Enter a Token'; return; }
    tokenSubmitEl.disabled = true; tokenSubmitEl.textContent = 'Verifying…'; tokenErrorEl.textContent = '';
    var ok = await validateToken(token);
    if (ok) {
      setStoredToken(token);
      tokenErrorEl.textContent = '';
      showDashboard();
      refresh();
      if (window.meridianHeaderRefresh) window.meridianHeaderRefresh();
    } else {
      tokenErrorEl.textContent = 'Invalid Token';
      tokenSubmitEl.disabled = false; tokenSubmitEl.textContent = 'Sign in';
      tokenInputEl.focus();
    }
  }

  /* ==== Dashboard Auth Helpers ==== */
  function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function tokens(v){if(v==null)return '—';if(v>=1e6)return (v/1e6).toFixed(1)+'M';if(v>=1e3)return (v/1e3).toFixed(1)+'k';return String(v)}
  function usd(v){if(v==null)return '—';return '$'+Number(v).toFixed(2)}
  function ms(v){if(v==null)return '—';return v<1000?v+'ms':(v/1000).toFixed(1)+'s'}

  // Authenticated fetches. A 401 means the server requires a Token and the
  // browser isn't sending it (or it's wrong) — flag locked so the page
  // renders the login screen instead of undefined metrics.
  function apiFetch(url, opts) {
    return (window.meridianApiFetch || fetch)(url, opts);
  }
  function apiGet(url) {
    return apiFetch(url).then(function(r) {
      if (r.status === 401) { var e = new Error('unauthorized'); e.locked = true; throw e; }
      return r.json();
    });
  }
  function apiPost(url, body, headers) {
    var h = { 'Content-Type': 'application/json' };
    if (headers) { for (var k in headers) h[k] = headers[k]; }
    return apiFetch(url, { method: 'POST', headers: h, body: JSON.stringify(body) }).then(function(r) {
      if (r.status === 401) { var e = new Error('unauthorized'); e.locked = true; throw e; }
      return r.json().then(function(data) { return { status: r.status, data: data }; });
    });
  }

  var lastData = null;
  var notice = null;
  var loginState = null;
  var adding = false;
  var addMode = 'claude';
  var addError = null;
  var renaming = null;
  var confirmingRemove = null;
  var meridianReorder = { adopt: function(){}, focusAnchor: function(){ return null; }, restoreFocus: function(){} };

  /* ==== Initial bootstrap ==== */
  // Check for stored Token on load; if present, validate and show dashboard.
  // If validation fails, clear and show login. If no Token, show login.
  async function bootstrap() {
    var token = storedToken();
    if (token) {
      var ok = await validateToken(token);
      if (ok) {
        showDashboard();
        refresh();
        if (window.meridianHeaderRefresh) window.meridianHeaderRefresh();
        return;
      }
      // Invalid/expired Token — clear and fall through to login
      setStoredToken('');
    }
    showLoginScreen();
  }

  /* ==== Dashboard rendering (only runs after successful Token auth) ==== */
  function markLocked(e) { if (e && e.locked) { setStoredToken(''); showLoginScreen('Session expired — please sign in again.'); } return null; }

  async function refresh() {
    try {
      var results = await Promise.all([
        fetch('/health').then(r => r.json()),
        apiGet('/telemetry/summary?window=86400000').catch(markLocked),
        apiGet('/v1/usage/quota/all').catch(markLocked),
        apiGet('/profiles/list').catch(markLocked),
        apiGet('/settings/api/routing').catch(markLocked)
      ]);
      var health = results[0], stats = results[1], quota = results[2], profiles = results[3], routing = results[4];
      meridianReorder.adopt(routing);
      render(health, stats, quota, profiles);
    } catch (e) {
      if (!e || !e.locked) {
        document.getElementById('content').innerHTML = '<div style="color:var(--red);padding:40px;text-align:center">Could not connect</div>';
      }
    }
  }

  function opFailed(e, fallback) {
    if (e && e.locked) { return; } // markLocked handles it
    notice = { type: 'err', text: fallback, at: Date.now() };
    if (lastData) render(lastData[0], lastData[1], lastData[2], lastData[3]);
  }

  function introSection(h) {
    var b = h.backend === 'antigravity' ? 'Antigravity (agy CLI)' : 'Claude Agent SDK';
    var v = h.version || '—';
    return '<div class="intro-meta">Backend: ' + esc(b) + ' · Meridian ' + esc(v) + (h.build?.updateAvailable ? ' · ' + esc(h.build.latest) + ' available' : '') + '</div>';
  }

  function profileSection(q, s, pl, h) {
    if (!pl || !pl.profiles || pl.profiles.length === 0) return '';
    var activeId = pl.activeProfile;
    var o = '<div class="section"><div class="section-head"><div class="section-title">Accounts</div>'
      + '<div><button type="button" class="btn" data-action="add">Add account</button></div></div>'
      + '<div class="profile-grid">';
    pl.profiles.forEach(function(p) {
      var spend = q[p.id];
      var isActive = p.id === activeId;
      var spendPct = spend ? spend.spentPct : null;
      var needsLogin = spend && spend.reason === 'unusable';
      var fade = (spend && typeof spend.spentPct === 'number') ? Math.min(1, Math.max(0, (spend.spentPct - 0.95) / 0.05)) : 0;
      var cardClass = 'profile-card' + (isActive ? ' active' : '') + ' switchable' + (needsLogin ? ' needs-login' : '') + (fade > 0 ? (fade >= 1 ? ' spend-spent' : ' spend-fading') : '');
      o += '<div class="' + cardClass + '" style="--spend-fade:' + fade + '" data-profile="' + esc(p.id) + '">'
        + '<div class="profile-head">'
        + '<div class="profile-name">'
        + '<span class="prof-dot"></span>'
        + esc(p.id)
        + (isActive ? '<span class="active-pill">Active</span>' : '<span class="switch-hint">Click to switch</span>')
        + '</div>'
        + '<div class="prof-info">'
        + '<span class="prof-info-dot">i</span>'
        + '<div class="prof-info-popover">'
        + '<div class="prof-info-row"><span class="prof-info-label">Type</span><span class="prof-info-value">' + esc(p.type || 'claude-max') + '</span></div>'
        + (p.aliases && p.aliases.length ? '<div class="prof-info-row"><span class="prof-info-label">Aliases</span><span class="prof-info-value">' + esc(p.aliases.join(', ')) + '</span></div>' : '')
        + (p.accessKey ? '<div class="prof-info-row"><span class="prof-info-label">Token</span><span class="prof-info-value code">' + esc(p.accessKey) + '</span></div>' : '')
        + '</div></div></div>'
        + '<div class="profile-cost">' + usd(spend ? spend.estCostUsd : null) + '</div>'
        + (spend ? '<div style="font-size:12px;color:var(--muted);margin-top:4px">' + tokens(spend.inputTokens) + ' in / ' + tokens(spend.outputTokens) + ' out / ' + tokens(spend.cacheReadTokens) + ' cache</div>' : '')
        + cardActions(p, spend)
        + (p.accessKey ? tokenRow(p) : '')
        + '</div>';
    });
    o += '</div></div>';
    return o;
  }

  function tokenRow(p) {
    var hidden = true;
    return '<div class="token-row" data-token-row="' + esc(p.id) + '">'
      + '<span class="token-value token-hidden" data-token-value="' + esc(p.id) + '">' + '•'.repeat(24) + '</span>'
      + '<div class="token-actions">'
      + '<button type="button" class="btn btn-quiet token-btn" data-action="token-reveal" data-profile="' + esc(p.id) + '">Reveal</button>'
      + '<button type="button" class="btn btn-quiet token-btn" data-action="token-regenerate" data-profile="' + esc(p.id) + '">Regenerate</button>'
      + '<button type="button" class="btn btn-quiet token-btn" data-action="token-revoke" data-profile="' + esc(p.id) + '">Revoke</button>'
      + '</div></div>';
  }

  function cardActions(p, spend) {
    var o = '<div class="card-actions">';
    if (spend && spend.reason === 'unusable') {
      o += '<button type="button" class="btn" data-action="login" data-profile="' + esc(p.id) + '">Log in</button>';
    } else if (p.type === 'claude-max' || !p.type) {
      o += '<button type="button" class="btn btn-quiet" data-action="refresh-token" data-profile="' + esc(p.id) + '">Refresh token</button>';
    }
    if (renaming === p.id) {
      o += '<input id="rename-input" class="text-input" value="' + esc(p.id) + '" maxlength="64">'
        + '<button type="button" class="btn" data-action="rename-save" data-profile="' + esc(p.id) + '">Save</button>'
        + '<button type="button" class="btn btn-quiet" data-action="rename-cancel">Cancel</button>';
    } else {
      o += '<button type="button" class="btn btn-quiet" data-action="rename" data-profile="' + esc(p.id) + '">Rename</button>';
    }
    if (confirmingRemove === p.id) {
      o += '<button type="button" class="btn btn-danger" data-action="remove-confirm" data-profile="' + esc(p.id) + '">Confirm remove</button>'
        + '<button type="button" class="btn btn-quiet" data-action="remove-cancel">Keep</button>';
    } else {
      o += '<button type="button" class="btn btn-quiet" data-action="remove" data-profile="' + esc(p.id) + '">Remove</button>';
    }
    return o + '</div>';
  }

  function noticeHtml() {
    if (!notice || Date.now() - notice.at > 30000) return '';
    return '<div class="notice-bar ' + notice.type + '">' + esc(notice.text) + '</div>';
  }

  function loginPanel() {
    if (!loginState) return '';
    var o = '<div class="panel-card"><h3>Log in — ' + esc(loginState.profile) + '</h3>';
    if (loginState.busy && !loginState.authorizeUrl) {
      o += '<p>Starting login…</p></div>';
      return o;
    }
    if (!loginState.authorizeUrl) {
      o += '<div class="inline-err">' + esc(loginState.error || 'Login could not start.') + '</div>'
        + '<div class="panel-row" style="margin-top:10px"><button type="button" class="btn btn-quiet" data-action="login-cancel">Close</button></div></div>';
      return o;
    }
    o += '<ol class="login-steps"><li>Open the Claude login link (sign into the <strong>' + esc(loginState.profile) + '</strong> account in that browser tab):<br>'
      + '<a href="' + esc(loginState.authorizeUrl) + '" target="_blank" rel="noopener">Open Claude login</a></li>'
      + '<li>Paste the code Claude shows below and complete the login.</li></ol>'
      + '<div class="panel-row"><input id="login-code" class="text-input mono" placeholder="Paste code or callback URL" autocomplete="off">'
      + '<button type="button" class="btn" data-action="login-complete"' + (loginState.busy ? ' disabled' : '') + '>'
      + (loginState.busy ? 'Working…' : 'Complete login') + '</button>'
      + '<button type="button" class="btn btn-quiet" data-action="login-cancel">Cancel</button></div>'
      + (loginState.error ? '<div class="inline-err">' + esc(loginState.error) + '</div>' : '')
      + '</div>';
    return o;
  }

  function addPanel() {
    if (!adding) return '';
    var o = '<div class="panel-card"><h3>Add account</h3>'
      + '<div class="panel-row" style="margin-bottom:10px">'
      + '<button type="button" class="btn' + (addMode === 'claude' ? '' : ' btn-quiet') + '" data-action="add-mode" data-mode="claude">Claude login</button>'
      + '<button type="button" class="btn' + (addMode === 'token' ? '' : ' btn-quiet') + '" data-action="add-mode" data-mode="token">OAuth token</button></div>'
      + '<div class="panel-row"><input id="add-id" class="text-input" placeholder="Account name (letters, numbers, - _)">'
      + (addMode === 'token' ? '<input id="add-token" type="password" class="text-input mono" placeholder="claude setup-token value" autocomplete="off">' : '')
      + '<button type="button" class="btn" data-action="add-save">' + (addMode === 'claude' ? 'Add & log in' : 'Add') + '</button>'
      + '<button type="button" class="btn btn-quiet" data-action="add-cancel">Cancel</button></div>'
      + (addMode === 'token' ? '<p style="margin-top:8px">Generate the value with <code>claude setup-token</code> on a machine signed into that account.</p>' : '')
      + (addError ? '<div class="inline-err">' + esc(addError) + '</div>' : '')
      + '</div>';
    return o;
  }

  function render(h, s, q, pl) {
    lastData = [h, s, q, pl];
    s = s || {};
    var refocusId = meridianReorder.focusAnchor();
    var o = '';
    o += introSection(h);
    o += noticeHtml();
    o += loginPanel();
    o += addPanel();
    var accounts = profileSection(q, s, pl, h);
    if (!accounts) {
      accounts = '<div class="section"><div class="section-head"><div class="section-title">Accounts</div>'
        + '<div><button type="button" class="btn" data-action="add">Add account</button></div></div>'
        + '<div class="panel-card"><p>No accounts yet. Add one to route requests through your Claude subscription.</p></div></div>';
    }
    o += accounts;

    var tu = s.tokenUsage || {};
    var cache = tu.avgCacheHitRate != null ? Math.round(tu.avgCacheHitRate * 100) + '%' : '—';
    var reqTotal = s.totalRequests == null ? '—' : String(s.totalRequests);
    var errLine = s.errorCount > 0 ? s.errorCount + ' error' + (s.errorCount === 1 ? '' : 's') : (s.totalRequests == null ? 'locked' : 'no errors');
    var items = [
      ['Requests', reqTotal, '', errLine, s.errorCount > 0 ? 'red' : ''],
      ['Tokens Out', tokens(tu.totalOutputTokens), '', tokens(tu.totalInputTokens) + ' in'],
      ['Cache Hit', cache, tu.avgCacheHitRate >= 0.5 ? 'green' : '', 'prompt cache'],
      ['Est. API Value', usd(s.costEstimate && s.costEstimate.totalUsd), '', 'list prices'],
      ['Median Response', ms(s.totalDuration && s.totalDuration.p50), '', 'p95 ' + ms(s.totalDuration && s.totalDuration.p95)]
    ];
    if (s.envelopeViolationCount > 0) items.push(['Envelope', String(s.envelopeViolationCount), 'red', 'wire-contract violations']);
    o += '<div class="section"><div class="section-title">Last 24 Hours</div>' + strip(items) + '</div>';
    o += '<div class="footer">Meridian · <a href="https://github.com/rynfar/meridian">GitHub</a> · Built on the <a href="https://github.com/anthropics/claude-agent-sdk-typescript">Claude Agent SDK</a></div>';
    document.getElementById('content').innerHTML = o;
    meridianReorder.restoreFocus(refocusId);
  }

  function strip(items) {
    var o = '<div class="strip">';
    items.forEach(function(it) {
      var cls = it[2] ? ' style="color:var(--' + it[2] + ')"' : '';
      o += '<div class="strip-item"><div class="strip-label">' + esc(it[0]) + '</div>'
        + '<div class="strip-value"' + cls + '>' + esc(it[1]) + '</div>'
        + '<div class="strip-detail">' + esc(it[3]) + '</div></div>';
    });
    return o + '</div>';
  }

  function switchProfile(id) {
    apiPost('/profiles/active', { profile: id })
      .then(function(res) {
        if (res.data && res.data.success) { refresh(); if (window.meridianHeaderRefresh) window.meridianHeaderRefresh(); }
        else { notice = { type: 'err', text: (res.data && (res.data.error || res.data.message)) || 'Switch failed', at: Date.now() }; if (lastData) render(lastData[0], lastData[1], lastData[2], lastData[3]); }
      })
      .catch(function(e) { opFailed(e, 'Could not reach the server'); });
  }

  function startLogin(id) {
    loginState = { profile: id, busy: true, error: null, authorizeUrl: null, state: null };
    if (lastData) render(lastData[0], lastData[1], lastData[2], lastData[3]);
    apiFetch('/auth/claude/start?profile=' + encodeURIComponent(id))
      .then(function(r) { return r.json().then(function(d) { return { status: r.status, d: d }; }); })
      .then(function(res) {
        if (res.status === 200 && res.d.authorizeUrl) {
          loginState = { profile: id, authorizeUrl: res.d.authorizeUrl, state: res.d.state, busy: false, error: null };
        } else {
          loginState = { profile: id, busy: false, error: (res.d && res.d.error && res.d.error.message) || 'Login could not start.', authorizeUrl: null, state: null };
        }
        if (lastData) render(lastData[0], lastData[1], lastData[2], lastData[3]);
      })
      .catch(function(e) {
        if (e && e.locked) { setStoredToken(''); showLoginScreen('Session expired — please sign in again.'); loginState = null; }
        else { loginState = { profile: id, busy: false, error: 'Could not reach the server.', authorizeUrl: null, state: null }; }
        if (lastData) render(lastData[0], lastData[1], lastData[2], lastData[3]);
      });
  }

  function completeLogin() {
    if (!loginState || loginState.busy) return;
    var input = document.getElementById('login-code');
    var code = input ? input.value : '';
    if (!code.trim()) { loginState.error = 'Paste the code Claude shows after sign-in.'; if (lastData) render(lastData[0], lastData[1], lastData[2], lastData[3]); return; }
    loginState.busy = true; loginState.error = null;
    if (lastData) render(lastData[0], lastData[1], lastData[2], lastData[3]);
    apiPost('/auth/claude/exchange', { profile: loginState.profile, code: code, state: loginState.state })
      .then(function(res) {
        if (res.status === 200 && res.data && res.data.success) {
          notice = { type: 'ok', text: 'Account "' + loginState.profile + '" logged in.', at: Date.now() };
          loginState = null; refresh(); if (window.meridianHeaderRefresh) window.meridianHeaderRefresh();
        } else {
          loginState.error = (res.data && res.data.error && res.data.error.message) || 'Login failed.';
          loginState.busy = false;
          if (lastData) render(lastData[0], lastData[1], lastData[2], lastData[3]);
        }
      })
      .catch(function(e) {
        if (e && e.locked) { setStoredToken(''); showLoginScreen('Session expired — please sign in again.'); loginState = null; if (lastData) render(lastData[0], lastData[1], lastData[2], lastData[3]); }
        else { loginState.error = 'Could not reach the server.'; loginState.busy = false; if (lastData) render(lastData[0], lastData[1], lastData[2], lastData[3]); }
      });
  }

  function cancelLogin() { loginState = null; if (lastData) render(lastData[0], lastData[1], lastData[2], lastData[3]); }

  function startRename(id) { renaming = id; if (lastData) render(lastData[0], lastData[1], lastData[2], lastData[3]); }
  function cancelRename() { renaming = null; if (lastData) render(lastData[0], lastData[1], lastData[2], lastData[3]); }
  function saveRename(id) {
    var input = document.getElementById('rename-input');
    var newId = input ? input.value.trim() : '';
    if (!newId || newId === id) { cancelRename(); return; }
    apiPost('/profiles/rename', { id: id, newId: newId })
      .then(function(res) { if (res.data && res.data.success) { renaming = null; refresh(); if (window.meridianHeaderRefresh) window.meridianHeaderRefresh(); } else { notice = { type: 'err', text: (res.data && res.data.error) || 'Rename failed', at: Date.now() }; if (lastData) render(lastData[0], lastData[1], lastData[2], lastData[3]); } })
      .catch(function(e) { opFailed(e, 'Could not reach the server'); });
  }

  function confirmRemove(id) { confirmingRemove = id; if (lastData) render(lastData[0], lastData[1], lastData[2], lastData[3]); }
  function cancelRemove() { confirmingRemove = null; if (lastData) render(lastData[0], lastData[1], lastData[2], lastData[3]); }
  function doRemove(id) {
    apiPost('/profiles/remove', { id: id })
      .then(function(res) { if (res.data && res.data.success) { confirmingRemove = null; refresh(); if (window.meridianHeaderRefresh) window.meridianHeaderRefresh(); } else { notice = { type: 'err', text: (res.data && res.data.error) || 'Remove failed', at: Date.now() }; if (lastData) render(lastData[0], lastData[1], lastData[2], lastData[3]); } })
      .catch(function(e) { opFailed(e, 'Could not reach the server'); });
  }

  function toggleAdd() { adding = !adding; addError = null; if (!adding) addMode = 'claude'; if (lastData) render(lastData[0], lastData[1], lastData[2], lastData[3]); }
  function setAddMode(mode) { addMode = mode; addError = null; if (lastData) render(lastData[0], lastData[1], lastData[2], lastData[3]); }
  function doAdd() {
    var idInput = document.getElementById('add-id');
    var id = idInput ? idInput.value.trim() : '';
    if (!id) { addError = 'Enter an account name'; if (lastData) render(lastData[0], lastData[1], lastData[2], lastData[3]); return; }
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) { addError = 'Account name: letters, numbers, - _ only'; if (lastData) render(lastData[0], lastData[1], lastData[2], lastData[3]); return; }
    if (addMode === 'token') {
      var tokenInput = document.getElementById('add-token');
      var token = tokenInput ? tokenInput.value.trim() : '';
      if (!token) { addError = 'Paste the claude setup-token value'; if (lastData) render(lastData[0], lastData[1], lastData[2], lastData[3]); return; }
      apiPost('/profiles/add-oauth-token', { id: id, oauthToken: token })
        .then(function(res) { if (res.data && res.data.success) { adding = false; refresh(); if (window.meridianHeaderRefresh) window.meridianHeaderRefresh(); } else { addError = (res.data && res.data.error) || 'Add failed'; if (lastData) render(lastData[0], lastData[1], lastData[2], lastData[3]); } })
        .catch(function(e) { opFailed(e, 'Could not reach the server'); });
    } else {
      apiPost('/profiles/add', { id: id })
        .then(function(res) { if (res.data && res.data.success) { startLogin(id); adding = false; } else { addError = (res.data && res.data.error) || 'Add failed'; if (lastData) render(lastData[0], lastData[1], lastData[2], lastData[3]); } })
        .catch(function(e) { opFailed(e, 'Could not reach the server'); });
    }
  }

  function refreshToken(id) {
    apiPost('/auth/refresh', {})
      .then(function(res) { if (res.data && res.data.success) { notice = { type: 'ok', text: 'Token refreshed for ' + id, at: Date.now() }; if (lastData) render(lastData[0], lastData[1], lastData[2], lastData[3]); } else { notice = { type: 'err', text: (res.data && res.data.error) || 'Refresh failed', at: Date.now() }; if (lastData) render(lastData[0], lastData[1], lastData[2], lastData[3]); } })
      .catch(function(e) { opFailed(e, 'Could not reach the server'); });
  }

  function revealToken(id) {
    var row = document.querySelector('[data-token-row="' + esc(id) + '"]');
    var valueEl = row ? row.querySelector('[data-token-value="' + esc(id) + '"]') : null;
    if (!valueEl) return;
    var profiles = lastData[3];
    var profile = profiles.profiles.find(function(p) { return p.id === id; });
    if (profile && profile.accessKey) {
      valueEl.textContent = profile.accessKey;
      valueEl.classList.remove('token-hidden');
      row.querySelector('[data-action="token-reveal"]').textContent = 'Hide';
      row.querySelector('[data-action="token-reveal"]').onclick = function() { hideToken(id); };
    }
  }

  function hideToken(id) {
    var row = document.querySelector('[data-token-row="' + esc(id) + '"]');
    var valueEl = row ? row.querySelector('[data-token-value="' + esc(id) + '"]') : null;
    if (!valueEl) return;
    valueEl.textContent = '•'.repeat(24);
    valueEl.classList.add('token-hidden');
    row.querySelector('[data-action="token-reveal"]').textContent = 'Reveal';
    row.querySelector('[data-action="token-reveal"]').onclick = function() { revealToken(id); };
  }

  function regenerateToken(id) {
    if (!confirm('Regenerate Token for "' + id + '"? The old Token will stop working immediately.')) return;
    apiPost('/profiles/' + encodeURIComponent(id) + '/api-key', {})
      .then(function(res) { if (res.data && res.data.success && res.data.accessKey) { notice = { type: 'ok', text: 'Token regenerated for ' + id, at: Date.now() }; refresh(); if (window.meridianHeaderRefresh) window.meridianHeaderRefresh(); } else { notice = { type: 'err', text: (res.data && res.data.error) || 'Regenerate failed', at: Date.now() }; if (lastData) render(lastData[0], lastData[1], lastData[2], lastData[3]); } })
      .catch(function(e) { opFailed(e, 'Could not reach the server'); });
  }

  function revokeToken(id) {
    if (!confirm('Revoke Token for "' + id + '"? This will invalidate the Token — clients using it will get 401 until a new one is minted.')) return;
    apiPost('/profiles/' + encodeURIComponent(id) + '/api-key', { _method: 'DELETE' })
      .then(function(res) { if (res.data && res.data.success) { notice = { type: 'ok', text: 'Token revoked for ' + id, at: Date.now() }; refresh(); if (window.meridianHeaderRefresh) window.meridianHeaderRefresh(); } else { notice = { type: 'err', text: (res.data && res.data.error) || 'Revoke failed', at: Date.now() }; if (lastData) render(lastData[0], lastData[1], lastData[2], lastData[3]); } })
      .catch(function(e) { opFailed(e, 'Could not reach the server'); });
  }

  function forgetToken() {
    setStoredToken('');
    showLoginScreen();
  }

  /* ==== Event delegation ==== */
  document.addEventListener('click', function(e) {
    var t = e.target.closest('[data-action]');
    if (!t) return;
    var a = t.getAttribute('data-action');
    if (a === 'switch') switchProfile(t.getAttribute('data-profile'));
    else if (a === 'login') startLogin(t.getAttribute('data-profile'));
    else if (a === 'login-complete') completeLogin();
    else if (a === 'login-cancel') cancelLogin();
    else if (a === 'refresh-token') refreshToken(t.getAttribute('data-profile'));
    else if (a === 'rename') startRename(t.getAttribute('data-profile'));
    else if (a === 'rename-save') saveRename(t.getAttribute('data-profile'));
    else if (a === 'rename-cancel') cancelRename();
    else if (a === 'remove') confirmRemove(t.getAttribute('data-profile'));
    else if (a === 'remove-confirm') doRemove(t.getAttribute('data-profile'));
    else if (a === 'remove-cancel') cancelRemove();
    else if (a === 'add') toggleAdd();
    else if (a === 'add-mode') setAddMode(t.getAttribute('data-mode'));
    else if (a === 'add-save') doAdd();
    else if (a === 'add-cancel') toggleAdd();
    else if (a === 'token-reveal') revealToken(t.getAttribute('data-profile'));
    else if (a === 'token-regenerate') regenerateToken(t.getAttribute('data-profile'));
    else if (a === 'token-revoke') revokeToken(t.getAttribute('data-profile'));
    else if (a === 'forget') forgetToken();
  });

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && e.target.id === 'tokenInput') { e.preventDefault(); submitToken(); }
    if (e.key === 'Enter' && e.target.id === 'login-code') { e.preventDefault(); completeLogin(); }
    if (e.key === 'Enter' && e.target.id === 'rename-input') { e.preventDefault(); saveRename(e.target.value.trim()); }
    if (e.key === 'Enter' && e.target.id === 'add-id') { e.preventDefault(); doAdd(); }
    if (e.key === 'Enter' && e.target.id === 'add-token') { e.preventDefault(); doAdd(); }
  });

  /* Start bootstrap */
  bootstrap();

  ${profileBarJs}
</script>
</body>
</html>`