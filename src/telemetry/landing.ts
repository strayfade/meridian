/**
 * Meridian landing page.
 *
 * The at-a-glance dashboard: a short how-it-works intro, per-account cards
 * (usage + est. cost, click to switch the active profile), and a compact
 * 24h traffic strip. Site chrome (logo, nav, status) lives in the shared
 * header from profileBar.ts. Fetches /health, /telemetry/summary,
 * /v1/usage/quota/all, /profiles/list and /settings/api/routing client-side for live data.
 *
 * Authenticated fetches go through window.meridianApiFetch (the tab-scoped
 * dashboard key from profileBar.ts); a 401 renders the unlock card instead
 * of undefined metrics. Account cards carry management controls — web OAuth
 * login (/auth/claude/start + /auth/claude/exchange), token refresh
 * (/auth/refresh), rename, remove, and add (claude-max or --oauth-token) —
 * so a dead account is fixed where it is reported.
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
    font-family: Georgia, 'Times New Roman', serif; font-style: italic; font-size: 10px;
    font-weight: 700; line-height: 12px; text-align: center; cursor: help; }
  .prof-info:hover .prof-info-dot, .prof-info:focus-within .prof-info-dot {
    border-color: var(--accent); color: var(--accent); }
  .prof-info-dot:focus-visible { outline: none; border-color: var(--accent); color: var(--accent); }
  .prof-pop { position: absolute; top: calc(100% + 8px); left: -8px; z-index: 20;
    min-width: 256px; padding: 12px 14px; background: var(--surface2);
    border: 1px solid var(--border); border-radius: 10px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.35);
    opacity: 0; visibility: hidden; transition: opacity 0.12s;
    text-align: left; font-weight: 400; letter-spacing: 0; text-transform: none; cursor: default; }
  .prof-info:hover .prof-pop, .prof-info:focus-within .prof-pop { opacity: 1; visibility: visible; }
  .prof-pop-type { display: block; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;
    color: var(--accent2); margin-bottom: 8px; }
  .prof-pop-grid { display: grid; grid-template-columns: auto 1fr; gap: 5px 14px; font-size: 11px; }
  .prof-pop-label { color: var(--muted); white-space: nowrap; }
  .prof-pop-value { font-family: 'SF Mono', SFMono-Regular, Consolas, monospace; word-break: break-word; }
  .prof-pop-value.status-ok { color: var(--green); }
  .prof-pop-value.status-err { color: var(--red); }
  .profile-sub { font-size: 11px; color: var(--muted); text-align: right; margin-bottom: 12px; }
  .usage-row { display: flex; align-items: center; gap: 10px; font-size: 12px; padding: 4px 0; }
  .usage-row .w-label { color: var(--muted); width: 64px; flex-shrink: 0; }
  .usage-row .w-bar { flex: 1; height: 6px; background: var(--surface2); border-radius: 3px; overflow: hidden; }
  .usage-row .w-fill { height: 100%; border-radius: 3px; }
  .pace-row { border-top: 1px solid var(--border); margin-top: 4px; padding-top: 8px; }
  .pace-row .w-bar { overflow: visible; position: relative; }
  .pace-marker { position: absolute; top: -3px; bottom: -3px; width: 2px; background: var(--text); opacity: 0.55; border-radius: 1px; }
  .pace-row .w-pct { font-weight: 600; }
  .pool-chip { font-size: 10px; padding: 2px 8px; border-radius: 10px; background: var(--surface2); color: var(--muted); margin-left: 6px; vertical-align: middle; }
  .pool-chip.exhausted { color: var(--red); background: rgba(248,81,73,0.12); }
  .plan-chip { font-size: 10px; padding: 2px 8px; border-radius: 10px; background: var(--surface2);
    color: var(--accent2); margin-left: 6px; vertical-align: middle; font-variant-numeric: tabular-nums; }
  .spent-banner { font-size: 12px; line-height: 1.45; color: var(--text); margin-bottom: 10px;
    padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(248,81,73,0.35); background: rgba(248,81,73,0.1); }
  .spent-banner strong { color: var(--red); }
  .spent-banner-sub { font-size: 11px; color: var(--muted); margin-top: 2px; }
  .usage-row .w-pct { width: 38px; text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
  .usage-row .w-reset { color: var(--muted); font-size: 11px; width: 76px; text-align: right; }
  .no-usage { font-size: 12px; color: var(--muted); padding: 4px 0; }

  /* Traffic strip — one compact surface */
  .strip { display: flex; flex-wrap: wrap; background: var(--surface); border: 1px solid var(--border);
    border-radius: 12px; padding: 14px 4px; margin-bottom: 24px; }
  .strip-item { flex: 1; min-width: 120px; padding: 2px 18px; border-right: 1px solid var(--border); }
  .strip-item:last-child { border-right: none; }
  .strip-label { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; }
  .strip-value { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; margin-top: 2px; }
  .strip-value.green { color: var(--green); }
  .strip-value.red { color: var(--red); }
  .strip-detail { font-size: 11px; color: var(--muted); }
  .strip-detail.red { color: var(--red); }

  .section { margin-bottom: 24px; }
  .section-title { font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase;
    letter-spacing: 1px; margin-bottom: 12px; }

  /* Tabs rather than a dropdown: the current order stays legible without
     opening anything, which is the whole job of this page. */
  .section-head { display: flex; align-items: baseline; justify-content: space-between;
    gap: 12px; margin-bottom: 12px; }
  .section-head .section-title { margin-bottom: 0; }
  .section-actions { display: flex; gap: 8px; align-items: center; flex-shrink: 0; }
  .sort-tabs { display: flex; gap: 2px; flex-shrink: 0; }
  .sort-tab { background: none; border: none; border-bottom: 2px solid transparent;
    color: var(--muted); font-family: inherit; font-size: 11px; font-weight: 500;
    letter-spacing: 0.3px; padding: 2px 8px 3px; cursor: pointer; }
  .sort-tab:hover { color: var(--text); }
  .sort-tab.active { color: var(--accent); border-bottom-color: var(--accent); }
  .sort-tab:focus-visible { outline: none; color: var(--accent); border-bottom-color: var(--accent); }

  .footer { margin-top: 48px; padding-top: 24px; border-top: 1px solid var(--border);
    font-size: 11px; color: var(--muted); text-align: center; }
  .footer a { color: var(--accent); text-decoration: none; }

  /* Account controls — card action rows, unlock card, login panel, add form.
     Buttons follow the shared vocabulary: surface2 fill, accent text, hover
     is a blue tint. Destructive actions earn red the same way pills do. */
  .card-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px;
    padding-top: 12px; border-top: 1px solid var(--border); }
  .btn { background: var(--surface2); border: 1px solid var(--accent); color: var(--accent);
    font-family: inherit; font-size: 11px; font-weight: 600; letter-spacing: 0.3px;
    border-radius: 8px; padding: 5px 12px; cursor: pointer; transition: background 0.15s; }
  .btn:hover { background: rgba(88,166,255,0.12); }
  .btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .btn:disabled { opacity: 0.5; cursor: default; }
  .btn-danger { border-color: rgba(248,81,73,0.35); color: var(--red); }
  .btn-danger:hover { background: rgba(248,81,73,0.12); }
  .btn-quiet { border-color: var(--border); color: var(--muted); }
  .btn-quiet:hover { color: var(--text); background: var(--surface2); }
  .text-input { background: var(--surface2); border: 1px solid var(--border); color: var(--text);
    font-family: inherit; font-size: 12px; border-radius: 8px; padding: 6px 10px; }
  .text-input:focus { outline: none; border-color: var(--accent); }
  .text-input.mono { font-family: 'SF Mono', SFMono-Regular, Consolas, monospace; }
  .panel-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
    padding: 18px 20px; margin-bottom: 24px; }
  .panel-card h3 { font-size: 13px; font-weight: 600; margin-bottom: 6px; }
  .panel-card p { font-size: 12px; color: var(--muted); margin-bottom: 10px; max-width: 640px; }
  .panel-card a { color: var(--accent); text-decoration: none; }
  .panel-card a:hover { text-decoration: underline; }
  .panel-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .panel-row .text-input { flex: 1; min-width: 200px; }
  .login-steps { font-size: 12px; color: var(--muted); margin: 0 0 10px 18px; }
  .login-steps li { margin-bottom: 4px; }
  .inline-err { font-size: 12px; color: var(--red); margin-top: 8px; }
  .inline-ok { font-size: 12px; color: var(--green); margin-top: 8px; }
  .notice-bar { font-size: 12px; padding: 8px 12px; border-radius: 8px; margin-bottom: 12px; }
  .notice-bar.ok { color: var(--green); background: rgba(63,185,80,0.1);
    border: 1px solid rgba(63,185,80,0.35); }
  .notice-bar.err { color: var(--red); background: rgba(248,81,73,0.1);
    border: 1px solid rgba(248,81,73,0.35); }
  .forget-key { background: none; border: none; color: var(--muted); font-family: inherit;
    font-size: 11px; cursor: pointer; padding: 2px 4px; }
  .forget-key:hover { color: var(--text); text-decoration: underline; }
` + profileBarCss + `
</style>
</head>
<body>
` + profileBarHtml + `
<div class="container">
  <div id="content"><div style="color:var(--muted);padding:40px;text-align:center">Loading…</div></div>
  ${reorderLiveRegionHtml}
</div>
<script>
` + profileFactsJs + `
function ms(v){if(v==null||v===0)return '—';return v<1000?v+'ms':(v/1000).toFixed(1)+'s'}
function esc(s){return String(s).replace(/[&<>"']/g,function(ch){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[ch]})}
function usd(v){if(v==null)return '—';if(v>0&&v<0.01)return '$'+v.toFixed(4);if(v<100)return '$'+v.toFixed(2);return '$'+Math.round(v).toLocaleString()}

var WIN_LABELS={five_hour:'5h',seven_day:'7d',seven_day_opus:'7d Opus',seven_day_sonnet:'7d Sonnet',seven_day_fable:'7d Fable',seven_day_oauth_apps:'7d Apps',seven_day_cowork:'7d Cowork',seven_day_omelette:'7d Omelette'};
function winLabel(t){if(WIN_LABELS[t])return WIN_LABELS[t];return t.replace(/^seven_day_/,'7d ').replace(/_/g,' ').replace(/\\b\\w/g,function(c){return c.toUpperCase()})}
function utilColor(u){return u>=0.85?'var(--red)':u>=0.6?'var(--yellow)':'var(--green)'}
// Mirrors computeWeeklyPace in src/telemetry/profileUsage.ts (unit-tested
// there): actual vs expected (even) consumption at this point in the 7-day
// window, with the dashboard's over-promotion when the projection hits 100%.
function weeklyPace(u,resetsAt){
  var WEEK=7*86400000;
  if(u==null||resetsAt==null)return null;
  var el=Math.max(0,Math.min(1,(Date.now()-(resetsAt-WEEK))/WEEK));
  var actual=Math.round(Math.max(0,u)*100);
  var expected=Math.round(el*100);
  var delta=actual-expected;
  var proj=el>=0.1?Math.round((Math.max(0,u)/el)*100):null;
  var st=delta>7?'ahead':delta<-7?'under':'on';
  if(proj!=null&&proj>=100)st='over';
  return {actual:actual,expected:expected,delta:delta,proj:proj,status:st};
}
function paceText(pc){
  if(pc.status==='over')return 'on track to run out';
  if(pc.status==='ahead')return '+'+pc.delta+'% ahead of pace';
  if(pc.status==='under')return Math.abs(pc.delta)+'% under pace';
  return 'on pace';
}
function paceColor(pc){return pc.status==='over'?'var(--red)':pc.status==='ahead'?'var(--yellow)':'var(--green)'}

function resetIn(ts){if(ts==null)return '';var d=ts-Date.now();if(d<=0)return 'resetting…';var m=Math.ceil(d/60000);if(m<60)return 'in '+m+'m';var h=Math.floor(m/60);if(h<24)return 'in '+h+'h'+(m%60?' '+(m%60)+'m':'');var days=Math.floor(h/24);return 'in '+days+'d'+(h%24?' '+(h%24)+'h':'')}

// Inlined from src/telemetry/profileSpent.ts, unit-tested in
// profile-spent.test.ts — same arrangement as weeklyPace above.
var GENERAL_WINDOW_TYPES=${JSON.stringify(GENERAL_WINDOW_TYPES)};
var FADE_FROM=${FADE_FROM};
var SPENT_AT=${SPENT_AT};
function isUnusable(p){if(p.loggedIn===false)return true;return p.error==='no_token'}
function generalUtilization(windows){
  var worst=null;
  for(var i=0;i<(windows||[]).length;i++){
    var w=windows[i];
    if(GENERAL_WINDOW_TYPES.indexOf(w.type)<0)continue;
    if(w.utilization==null||!isFinite(w.utilization))continue;
    var c=Math.max(0,Math.min(1,w.utilization));
    if(worst==null||c>worst)worst=c;
  }
  return worst;
}
function computeProfileSpend(p){
  if(isUnusable(p))return {fraction:1,state:'spent',fade:0,reason:'unusable'};
  var f=generalUtilization(p.windows);
  if(f==null)return {fraction:null,state:'unknown',fade:0,reason:null};
  if(f>=SPENT_AT)return {fraction:f,state:'spent',fade:1,reason:'usage'};
  if(f>=FADE_FROM)return {fraction:f,state:'fading',fade:(f-FADE_FROM)/(SPENT_AT-FADE_FROM),reason:null};
  return {fraction:f,state:'available',fade:0,reason:null};
}

// Inlined from src/telemetry/profileSort.ts, unit-tested in
// profile-sort.test.ts.
var PROFILE_SORT_MODES=${JSON.stringify(PROFILE_SORT_MODES)};
var viewSort=${JSON.stringify(DEFAULT_PROFILE_SORT)};
function sortProfilesForView(items,mode,spentOf){
  var list=items.slice();
  if(mode==='configured')return list;
  var direction=mode==='spent-desc'?-1:1;
  return list
    .map(function(item,index){return {item:item,index:index,spent:spentOf(item)}})
    .sort(function(a,b){
      if(a.spent==null||b.spent==null){
        if(a.spent==null&&b.spent==null)return a.index-b.index;
        return a.spent==null?1:-1;
      }
      if(a.spent!==b.spent)return (a.spent-b.spent)*direction;
      return a.index-b.index;
    })
    .map(function(entry){return entry.item});
}
function sortTabs(count){
  if(count<2)return '';
  var out='';
  for(var i=0;i<PROFILE_SORT_MODES.length;i++){
    var m=PROFILE_SORT_MODES[i];var on=m.id===viewSort;
    out+='<button type="button" class="sort-tab'+(on?' active':'')+'" data-sort="'+esc(m.id)+'"'
      +' title="'+esc(m.title)+'" aria-pressed="'+(on?'true':'false')+'">'+esc(m.label)+'</button>';
  }
  return '<div class="sort-tabs" role="group" aria-label="Sort accounts">'+out+'</div>';
}

// Re-sorting must not wait for the next 10s poll, so the last payload is
// kept and re-rendered from memory. The choice is a view preference and is
// never sent to the server — the saved pool order (/settings) is untouched.
var SORT_STORAGE_KEY='meridian.accountSort';
var lastData=null;
function readStoredSort(){
  try{
    var stored=localStorage.getItem(SORT_STORAGE_KEY);
    for(var i=0;i<PROFILE_SORT_MODES.length;i++)if(PROFILE_SORT_MODES[i].id===stored)return stored;
  }catch(_){/* storage blocked (private mode) — the default is fine */}
  return null;
}
function setViewSort(mode){
  if(mode===viewSort)return;
  var refocus=!!(document.activeElement&&document.activeElement.closest&&document.activeElement.closest('.sort-tab'));
  viewSort=mode;
  try{localStorage.setItem(SORT_STORAGE_KEY,mode)}catch(_){/* a lost preference is not worth failing over */}
  if(lastData)render(lastData[0],lastData[1],lastData[2],lastData[3]);
  if(refocus){var el=document.querySelector('.sort-tab[data-sort="'+mode+'"]');if(el)el.focus()}
}

${reorderClientJs}

function introSection(h){
  var meta=[];
  if(h.auth&&h.auth.loggedIn)meta.push(esc(h.auth.email||'')+(h.auth.subscriptionType?' ('+esc(h.auth.subscriptionType)+')':''));
  meta.push(h.mode||'internal');
  meta.push('port '+location.port);
  return '<div class="intro">'
    +'<h2>Claude &amp; Antigravity, in your tools.</h2>'
    +'<p>This page manages Claude accounts. Use <a href="/providers">Providers</a> to connect Claude or Antigravity. For Claude, point your supported client’s <code>ANTHROPIC_BASE_URL</code> at <code>http://'+esc(location.host)+'</code> and every request routes through the active account below. Setup guides for each agent live in the <a href="https://github.com/rynfar/meridian/blob/main/docs/agents.md">Agent Setup guide</a>.</p>'
    +'<div class="intro-meta">'+meta.join(' · ')+'</div>'
    +'</div>';
}

function infoIcon(entry,type){
  var facts=profileFacts(entry);
  var rows='';
  for(var i=0;i<facts.length;i++){
    var f=facts[i];
    var tone=f.tone==='ok'?' status-ok':f.tone==='err'?' status-err':'';
    rows+='<span class="prof-pop-label">'+esc(f.label)+'</span>'
      +'<span class="prof-pop-value'+tone+'">'+esc(f.value)+'</span>';
  }
  return '<span class="prof-info">'
    +'<span class="prof-info-dot" tabindex="0" role="button" aria-label="Details for '+esc(entry.id)+'">i</span>'
    +'<span class="prof-pop" role="tooltip">'
    +'<span class="prof-pop-type">'+esc(type||'claude-max')+'</span>'
    +'<span class="prof-pop-grid">'+rows+'</span>'
    +'</span></span>';
}

// An open overlay is the hovered or focused element, so this needs no state of
// its own and cannot be left stuck by an event that never arrives.
function infoPopOpen(){
  return !!document.querySelector('.prof-info:hover, .prof-info:focus-within');
}

function profileSection(q,s,pl,h){
  var byProfile=(s&&s.costEstimate&&s.costEstimate.byProfile)||{};
  var quotaByProfile={};
  var spentByProfile={};
  if(q&&Array.isArray(q.profiles))for(var i=0;i<q.profiles.length;i++){var qid=q.profiles[i].id||q.profiles[i].profile||'default';quotaByProfile[qid]=q.profiles[i];if(q.profiles[i].spent)spentByProfile[qid]=q.profiles[i].spent}
  var profs=[];var seen={};
  var configured=(pl&&Array.isArray(pl.profiles))?pl.profiles:[];
  var multi=configured.length>1;
  if(configured.length>0){\n    // Real profiles exist: show exactly those. Traffic that predates
    // per-profile attribution (the synthetic "default" bucket) still
    // counts in the totals strip but doesn't render as a fake account.
    // The whole entry rides along so the details overlay reads it directly —
    // a copied field list here would have to grow every time profileFacts does.
    for(var i=0;i<configured.length;i++){var p=configured[i];profs.push({id:p.id,label:p.id,type:p.type,isActive:!!p.isActive,loggedIn:p.loggedIn,configured:true,allowance:p.allowance,planLabel:p.planLabel,rateLimitTier:p.rateLimitTier,entry:p});seen[p.id]=1}
  }else{
    // Single-account setup: one card, labeled with the logged-in email.
    var email=(h&&h.auth&&h.auth.loggedIn&&h.auth.email)||'';
    for(var k in quotaByProfile){profs.push({id:k,label:k==='default'?(email||'account'):k,configured:false});seen[k]=1}
    for(var k in byProfile){if(!seen[k])profs.push({id:k,label:k==='default'?(email||'account'):k,configured:false});seen[k]=1}
  }
  if(profs.length===0)return '';
  // The persisted order is the base order everywhere. /profiles writes it;
  // this page read config order instead, so the two disagreed after a drag.
  profs=meridianReorder.sortProfiles(profs);
  function spentOf(p){
    var quota=quotaByProfile[p.id]||{};
    return computeProfileSpend({windows:quota.windows,error:quota.error,loggedIn:p.loggedIn}).fraction;
  }
  profs=sortProfilesForView(profs,viewSort,spentOf);
  var reorderable=multi&&!meridianReorder.envPinned()&&viewSort==='configured';
  var cards='';
  var pos=0;
  for(var i=0;i<profs.length;i++){
    var p=profs[i];var cost=byProfile[p.id];
    var quota=quotaByProfile[p.id]||{};
    var wins=(quota.windows||[]).filter(function(w){return w.utilization!=null});
    var spend=computeProfileSpend({windows:quota.windows,error:quota.error,loggedIn:p.loggedIn});
    if(!p.configured&&wins.length===0&&!cost)continue;
    var rows='';
    for(var j=0;j<wins.length;j++){
      var w=wins[j];var pct=Math.round(w.utilization*100);
      rows+='<div class="usage-row"><span class="w-label">'+esc(winLabel(w.type))+'</span>'
        +'<div class="w-bar"><div class="w-fill" style="width:'+Math.min(pct,100)+'%;background:'+utilColor(w.utilization)+'"></div></div>'
        +'<span class="w-pct" style="color:'+utilColor(w.utilization)+'">'+pct+'%</span>'
        +'<span class="w-reset">'+resetIn(w.resetsAt)+'</span></div>';
    }
    var weekly=null;
    for(var j=0;j<wins.length;j++){if(wins[j].type==='seven_day')weekly=wins[j]}
    var pc=weekly?weeklyPace(weekly.utilization,weekly.resetsAt):null;
    if(pc){\n      // Visual actual-vs-expected: fill = actual usage (status-colored),
      // tick marker = where even pace would be. The gap IS the pace.
      var paceTip=paceText(pc)+' · '+pc.actual+'% used vs '+pc.expected+'% expected'+(pc.proj!=null?' · ~'+pc.proj+'% by reset':'');
      var deltaLabel=pc.status==='over'?(pc.proj!=null?pc.proj+'%':'100%'):(pc.delta>=0?'+':'−')+Math.abs(pc.delta)+'%';
      rows+='<div class="usage-row pace-row" title="'+paceTip+'"><span class="w-label">pace</span>'
        +'<div class="w-bar"><div class="w-fill" style="width:'+Math.min(pc.actual,100)+'%;background:'+paceColor(pc)+'"></div>'
        +'<div class="pace-marker" style="left:'+Math.min(pc.expected,100)+'%" title="expected at even pace ('+pc.expected+'%)"></div></div>'
        +'<span class="w-pct" style="color:'+paceColor(pc)+'">'+deltaLabel+'</span>'
        +'<span class="w-reset">'+(pc.status==='over'?'runs out before reset':pc.proj!=null?'~'+pc.proj+'% by reset':'')+'</span></div>';
    }
    if(!rows)rows='<div class="no-usage">no usage data yet</div>';
    var isPriority=pl&&pl.routing==='priority';
    // active+priority keeps the active profile meaningful - switching it is how
    // you move traffic, so the card stays clickable, unlike in pure priority.
    var isActivePriority=pl&&pl.routing==='active+priority';
    var follow=pl&&pl.follow;
    var switchable=multi&&p.configured&&!p.isActive&&!isPriority&&!follow;
    var badge=isPriority?'':p.isActive?'<span class="active-pill">Active</span>':switchable?'<span class="switch-hint">Click to activate</span>':'';
    if(follow&&p.isActive)badge+=' <span class="pool-chip">'+(follow.activeProfile?'following '+esc(follow.url):'local — '+esc(follow.url)+' unreachable')+(follow.stale?' · stale':'')+'</span>';
    // Sits beside the name because it qualifies the percentages below it: 70%
    // of a 20x account is several times the work left in 70% of a 5x one.
    if(p.allowance)badge+='<span class="plan-chip" title="'+esc((p.planLabel||'')+(p.rateLimitTier?' · '+p.rateLimitTier:''))+'">'+esc(p.allowance)+'</span>';
    if(isPriority||isActivePriority){
      var orderIdx=(pl.profileOrder||[]).indexOf(p.id);
      if(orderIdx>=0)badge+='<span class="pool-chip">'+(isActivePriority?'#'+(orderIdx+1)+' fallback':'#'+(orderIdx+1)+' in pool')+'</span>';      var exh=(pl.exhausted||[]).filter(function(e){return e.id===p.id})[0];
      // Suppressed when a refusal is being reported below: both say the same
      // thing, and the banner says it better.
      if(exh&&!spentByProfile[p.id]){\n        // A billing refusal has no reset to wait for — the pool re-probes on the
        // same timer, but nothing changes until a human fixes the account.
        // Showing it as 'resets in 9m' promises a recovery that never comes.
        badge+=exh.reason==='billing_error'
          ?' <span class="pool-chip exhausted" title="Subscription or payment refused — this does not clear on its own">subscription refused</span>'
          :' <span class="pool-chip exhausted">exhausted · resets '+resetIn(exh.until)+'</span>';
      }
    }
    var sp=spentByProfile[p.id];
    var spentBanner='';
    if(sp){\n      var spBucket=(sp.diagnosis&&sp.diagnosis.bucket)?winLabel(sp.diagnosis.bucket):'its limit';
      var spGuess=(sp.diagnosis&&sp.diagnosis.reported)?'':' (guess)';
      badge+=' <span class="pool-chip exhausted">out of '+esc(spBucket+spGuess)+'</span>';
      // A full-width line immediately above the usage bars, not a chip beside
      // the name: measured in review, a 10px chip wraps to four lines in a
      // narrow card and loses to the large "67%" rendered right below it -
      // which is the exact misreading this whole feature exists to stop.
      spentBanner='<div class="spent-banner" title="'+esc((sp.diagnosis&&sp.diagnosis.rationale)||'')+'">'
        +'<strong>⚠ Anthropic is refusing this account</strong> - out of '+esc(spBucket+spGuess)
        +(sp.until?', back '+resetIn(sp.until):'')
        +'<div class="spent-banner-sub">figures below are the last successful read, not live</div></div>';
    }
    if(spend.reason==='unusable')badge+=' <span class="spend-pill needs-login">needs login</span>';
    else if(spend.state==='spent')badge+=' <span class="spend-pill">spent</span>';
    var spendClass=spend.reason==='unusable'?' needs-login':spend.fade>0?' spend-'+spend.state:'';
    var spendStyle=spend.fade>0?' style="--spend-fade:'+spend.fade.toFixed(2)+'"':'';
    var spendTip=spend.reason==='unusable'?' title="Cannot serve requests \u2014 run: meridian profile login '+esc(p.id)+'"'
      :spend.fraction!=null&&spend.fade>0?' title="'+Math.round(spend.fraction*100)+'% of this account\u2019s 5h / 7d allowance is used"':'';
    var draggable=reorderable&&p.configured;
    cards+='<div class="profile-card'+(p.isActive?' active':'')+(switchable?' switchable':'')+spendClass+'"'+spendStyle+spendTip
      +(p.configured?' data-id="'+esc(p.id)+'" data-index="'+pos+'"':'')
      +(switchable?' data-profile="'+esc(p.id)+'" role="button" tabindex="0"':'')+'>'
      +'<div class="profile-head"><span class="profile-name">'+(draggable?meridianReorder.handleHtml(p.id,pos,profs.length):'')+'<span class="prof-dot"></span>'+(p.entry?infoIcon(p.entry,p.type):'')+''+esc(p.label||p.id)+' '+badge+'</span>'
      +'<span class="profile-cost">'+usd(cost?cost.estimatedUsd:0)+'</span></div>'
      +'<div class="profile-sub">'+(cost?cost.requests+' request'+(cost.requests===1?'':'s')+' · est. API value · 24h':'no traffic · 24h')+'</div>'
      +spentBanner+rows+cardActions(p,spend)+'</div>';
    if(p.configured)pos++;
  }
  if(!cards)return '';
  return '<div class="section"><div class="section-head"><div class="section-title">'+(profs.length===1?'Account':'Accounts')+'</div>'
    +'<div class="section-actions">'+sortTabs(profs.length)+'<button type="button" class="btn" data-action="add">Add account</button></div></div>'
    +(multi?meridianReorder.noteHtml(reorderable):'')
    +'<div class="profile-grid">'+cards+'</div></div>';
}

function strip(items){
  var o='<div class="strip">';
  for(var i=0;i<items.length;i++){var it=items[i];
    o+='<div class="strip-item"><div class="strip-label">'+it[0]+'</div><div class="strip-value '+(it[2]||'')+'">'+it[1]+'</div>'+(it[3]?'<div class="strip-detail '+(it[4]||'')+'">'+it[3]+'</div>':'')+'</div>';
  }
  return o+'</div>';
}

// Dashboard account management state. Notices are transient (dropped after
// 30s in render); the login/add/rename forms hold their own input, so the
// 10s auto-refresh pauses while any of them is open.
var keyLocked=false;
var unlockError=null;
var notice=null;
var loginState=null;
var adding=false;
var addMode='claude';
var addError=null;
var renaming=null;
var confirmingRemove=null;

async function refresh(){
  try{
    const [health,stats,quota,profiles,routing]=await Promise.all([
      fetch('/health').then(r=>r.json()),
      apiGet('/telemetry/summary?window=86400000').catch(markLocked),
      apiGet('/v1/usage/quota/all').catch(markLocked),
      apiGet('/profiles/list').catch(markLocked),
      apiGet('/settings/api/routing').catch(markLocked)
    ]);
    meridianReorder.adopt(routing);
    render(health,stats,quota,profiles);
  }catch(e){document.getElementById('content').innerHTML='<div style="color:var(--red);padding:40px;text-align:center">Could not connect</div>'}
}

// Authenticated fetches. A 401 means the server requires MERIDIAN_API_KEY
// and the browser isn't sending it (or it's wrong) — flag locked so the
// page renders the unlock card instead of undefined metrics.
//
// window.meridianApiFetch lives in the shared header script, which is
// appended AFTER this script in the page — so the first refresh() runs
// before it exists. Fall back to bare fetch until the header loads; the
// 10s poll and every click handler run long after, on the real helper.
function apiFetch(url,opts){
  return (window.meridianApiFetch||fetch)(url,opts);
}
function storedKey(){return window.meridianApiKey?window.meridianApiKey():''}
function apiGet(url){
  return apiFetch(url).then(function(r){
    if(r.status===401){var e=new Error('unauthorized');e.locked=true;throw e}
    return r.json();
  });
}
function apiPost(url,body,headers){
  var h={'Content-Type':'application/json'};
  if(headers){for(var k in headers)h[k]=headers[k]}
  return apiFetch(url,{method:'POST',headers:h,body:JSON.stringify(body)}).then(function(r){
    if(r.status===401){var e=new Error('unauthorized');e.locked=true;throw e}
    return r.json().then(function(data){return {status:r.status,data:data}});
  });
}
// A mutation that 401s unlocks nothing — it reveals the lock. Anything else
// becomes a transient notice under the accounts section.
function opFailed(e,fallback){
  if(e&&e.locked){keyLocked=true}
  else{notice={type:'err',text:fallback,at:Date.now()}}
  if(lastData)render(lastData[0],lastData[1],lastData[2],lastData[3]);
}

function markLocked(e){if(e&&e.locked)keyLocked=true;return null}

function tokens(v){if(v==null)return '—';if(v>=1e6)return (v/1e6).toFixed(1)+'M';if(v>=1e3)return (v/1e3).toFixed(1)+'k';return String(v)}

// The API-key unlock card. Shown whenever an authenticated fetch 401s: the
// server has MERIDIAN_API_KEY set and the browser sent none (or a wrong
// one). The key lives in sessionStorage — this tab only, never on disk.
function unlockCard(){
  return '<div class="panel-card"><h3>Dashboard locked</h3>'
    +'<p>This server requires its API key (<code>MERIDIAN_API_KEY</code> from the server environment). Enter it once to unlock accounts, usage and controls in this tab.</p>'
    +'<div class="panel-row"><input type="password" id="api-key-input" class="text-input mono" placeholder="API key" autocomplete="off">'
    +'<button type="button" class="btn" data-action="unlock">Unlock</button></div>'
    +(unlockError?'<div class="inline-err">'+esc(unlockError)+'</div>':'')
    +'</div>';
}

function noticeHtml(){
  if(!notice||Date.now()-notice.at>30000)return '';
  return '<div class="notice-bar '+notice.type+'">'+esc(notice.text)+'</div>';
}

// Per-card account controls. Clicks here must not switch the profile, so the
// content click/keydown handlers bail out on [data-action] (same opt-out the
// info icon already has).
function cardActions(p,spend){
  var o='<div class="card-actions">';
  if(spend.reason==='unusable'){
    o+='<button type="button" class="btn" data-action="login" data-profile="'+esc(p.id)+'">Log in</button>';
  }else if(p.type==='claude-max'||!p.type){
    o+='<button type="button" class="btn btn-quiet" data-action="refresh-token" data-profile="'+esc(p.id)+'">Refresh token</button>';
  }
  if(renaming===p.id){
    o+='<input id="rename-input" class="text-input" value="'+esc(p.id)+'" maxlength="64">'
      +'<button type="button" class="btn" data-action="rename-save" data-profile="'+esc(p.id)+'">Save</button>'
      +'<button type="button" class="btn btn-quiet" data-action="rename-cancel">Cancel</button>';
  }else{
    o+='<button type="button" class="btn btn-quiet" data-action="rename" data-profile="'+esc(p.id)+'">Rename</button>';
  }
  if(confirmingRemove===p.id){
    o+='<button type="button" class="btn btn-danger" data-action="remove-confirm" data-profile="'+esc(p.id)+'">Confirm remove</button>'
      +'<button type="button" class="btn btn-quiet" data-action="remove-cancel">Keep</button>';
  }else{
    o+='<button type="button" class="btn btn-quiet" data-action="remove" data-profile="'+esc(p.id)+'">Remove</button>';
  }
  return o+'</div>';
}

// The OAuth login panel: step 1 opens the Claude authorize link (started
// server-side, PKCE verifier held there for 10 minutes), step 2 pastes the
// code back for POST /auth/claude/exchange.
function loginPanel(){
  if(!loginState)return '';
  var o='<div class="panel-card"><h3>Log in — '+esc(loginState.profile)+'</h3>';
  if(loginState.busy&&!loginState.authorizeUrl){
    o+='<p>Starting login…</p></div>';
    return o;
  }
  if(!loginState.authorizeUrl){
    o+='<div class="inline-err">'+esc(loginState.error||'Login could not start.')+'</div>'
      +'<div class="panel-row" style="margin-top:10px"><button type="button" class="btn btn-quiet" data-action="login-cancel">Close</button></div></div>';
    return o;
  }
  o+='<ol class="login-steps"><li>Open the Claude login link (sign into the <strong>'+esc(loginState.profile)+'</strong> account in that browser tab):<br>'
    +'<a href="'+esc(loginState.authorizeUrl)+'" target="_blank" rel="noopener">Open Claude login</a></li>'
    +'<li>Paste the code Claude shows below and complete the login.</li></ol>'
    +'<div class="panel-row"><input id="login-code" class="text-input mono" placeholder="Paste code or callback URL" autocomplete="off">'
    +'<button type="button" class="btn" data-action="login-complete"'+(loginState.busy?' disabled':'')+'>'
    +(loginState.busy?'Working…':'Complete login')+'</button>'
    +'<button type="button" class="btn btn-quiet" data-action="login-cancel">Cancel</button></div>'
    +(loginState.error?'<div class="inline-err">'+esc(loginState.error)+'</div>':'')
    +'</div>';
  return o;
}

// The add-account form: a Claude browser login, or a "claude setup-token"
// value for headless/CI profiles.
function addPanel(){
  if(!adding)return '';
  var o='<div class="panel-card"><h3>Add account</h3>'
    +'<div class="panel-row" style="margin-bottom:10px">'
    +'<button type="button" class="btn'+(addMode==='claude'?'':' btn-quiet')+'" data-action="add-mode" data-mode="claude">Claude login</button>'
    +'<button type="button" class="btn'+(addMode==='token'?'':' btn-quiet')+'" data-action="add-mode" data-mode="token">OAuth token</button></div>'
    +'<div class="panel-row"><input id="add-id" class="text-input" placeholder="Account name (letters, numbers, - _)">'
    +(addMode==='token'?'<input id="add-token" type="password" class="text-input mono" placeholder="claude setup-token value" autocomplete="off">':'')
    +'<button type="button" class="btn" data-action="add-save">Add'+(addMode==='claude'?' &amp; log in':'')+'</button>'
    +'<button type="button" class="btn btn-quiet" data-action="add-cancel">Cancel</button></div>'
    +(addMode==='token'?'<p style="margin-top:8px">Generate the value with <code>claude setup-token</code> on a machine signed into that account.</p>':'')
    +(addError?'<div class="inline-err">'+esc(addError)+'</div>':'')
    +'</div>';
  return o;
}

function render(h,s,q,pl){
  lastData=[h,s,q,pl];
  s=s||{};
  var refocusId=meridianReorder.focusAnchor();
  let o='';
  if(keyLocked)o+=unlockCard();
  else if(storedKey())o+='<div style="text-align:right;margin-bottom:12px"><button type="button" class="forget-key" data-action="forget">dashboard key set · forget</button></div>';
  o+=introSection(h);

  // Accounts — per-profile usage + est cost; click a card to switch.
  // Management (login, refresh, rename, remove, add) lives here too, so a
  // dead account is fixed where it is reported instead of in a terminal.
  o+=noticeHtml();
  o+=loginPanel();
  o+=addPanel();
  var accounts=profileSection(q,s,pl,h);
  if(!accounts&&!keyLocked){
    accounts='<div class="section"><div class="section-head"><div class="section-title">Accounts</div>'
      +'<div><button type="button" class="btn" data-action="add">Add account</button></div></div>'
      +'<div class="panel-card"><p>No accounts yet. Add one to route requests through your Claude subscription.</p></div></div>';
  }
  o+=accounts;

  // Last 24 hours — meaningful signals only. Errors and envelope
  // violations appear only when there is something to report.
  var tu=s.tokenUsage||{};
  var cache=tu.avgCacheHitRate!=null?Math.round(tu.avgCacheHitRate*100)+'%':'—';
  // Null-safe: with the dashboard locked the summary never arrives, and the
  // strip must read "locked", not "undefined" or a crash.
  var reqTotal=s.totalRequests==null?'—':String(s.totalRequests);
  var errLine=s.errorCount>0?s.errorCount+' error'+(s.errorCount===1?'':'s'):(s.totalRequests==null?'locked':'no errors');
  var items=[\n    // The big number is the TOTAL — never error-colored (a red 1714 reads as
    // 1714 failures). The error signal lives on the detail line only.
    ['Requests',reqTotal,'',errLine,s.errorCount>0?'red':''],
    ['Tokens Out',tokens(tu.totalOutputTokens),'',tokens(tu.totalInputTokens)+' in'],
    ['Cache Hit',cache,tu.avgCacheHitRate>=0.5?'green':'','prompt cache'],
    ['Est. API Value',usd(s.costEstimate&&s.costEstimate.totalUsd),'','list prices'],
    ['Median Response',ms(s.totalDuration&&s.totalDuration.p50),'','p95 '+ms(s.totalDuration&&s.totalDuration.p95)]
  ];
  if(s.envelopeViolationCount>0)items.push(['Envelope',String(s.envelopeViolationCount),'red','wire-contract violations']);
  o+='<div class="section"><div class="section-title">Last 24 Hours</div>'+strip(items)+'</div>';

  o+='<div class="footer">Meridian · <a href="https://github.com/rynfar/meridian">GitHub</a> · Built on the <a href="https://github.com/anthropics/claude-agent-sdk-typescript">Claude Agent SDK</a></div>';
  document.getElementById('content').innerHTML=o;
  meridianReorder.restoreFocus(refocusId);
}

function switchProfile(id){
  apiPost('/profiles/active',{profile:id})
    .then(function(res){
      if(res.data&&res.data.success){refresh();if(window.meridianHeaderRefresh)window.meridianHeaderRefresh()}
      else{notice={type:'err',text:(res.data&&(res.data.error||res.data.message))||'Switch failed',at:Date.now()};if(lastData)render(lastData[0],lastData[1],lastData[2],lastData[3])}
    })
    .catch(function(e){opFailed(e,'Could not reach the server')});
}

function unlockDashboard(){
  var input=document.getElementById('api-key-input');
  var key=input?input.value.trim():'';
  if(!key){unlockError='Enter the server API key to unlock.';if(lastData)render(lastData[0],lastData[1],lastData[2],lastData[3]);return}
  if(window.meridianSetApiKey)window.meridianSetApiKey(key);
  unlockError=null;keyLocked=false;
  refresh();if(window.meridianHeaderRefresh)window.meridianHeaderRefresh();
}

function startLogin(id){
  loginState={profile:id,busy:true,error:null,authorizeUrl:null,state:null};
  if(lastData)render(lastData[0],lastData[1],lastData[2],lastData[3]);
  apiFetch('/auth/claude/start?profile='+encodeURIComponent(id))
    .then(function(r){return r.json().then(function(d){return {status:r.status,d:d}})})
    .then(function(res){
      if(res.status===200&&res.d.authorizeUrl){
        loginState={profile:id,authorizeUrl:res.d.authorizeUrl,state:res.d.state,busy:false,error:null};
      }else{
        loginState={profile:id,busy:false,error:(res.d&&res.d.error&&res.d.error.message)||'Login could not start.',authorizeUrl:null,state:null};
      }
      if(lastData)render(lastData[0],lastData[1],lastData[2],lastData[3]);
    })
    .catch(function(e){
      if(e&&e.locked){keyLocked=true;loginState=null}
      else{loginState={profile:id,busy:false,error:'Could not reach the server.',authorizeUrl:null,state:null}}
      if(lastData)render(lastData[0],lastData[1],lastData[2],lastData[3]);
    });
}

function completeLogin(){
  if(!loginState||loginState.busy)return;
  var input=document.getElementById('login-code');
  var code=input?input.value:'';
  if(!code.trim()){loginState.error='Paste the code Claude shows after sign-in.';if(lastData)render(lastData[0],lastData[1],lastData[2],lastData[3]);return}
  loginState.busy=true;loginState.error=null;
  if(lastData)render(lastData[0],lastData[1],lastData[2],lastData[3]);
  apiPost('/auth/claude/exchange',{profile:loginState.profile,code:code,state:loginState.state})
    .then(function(res){
      if(res.status===200&&res.data&&res.data.success){
        notice={type:'ok',text:'Account "'+loginState.profile+'" logged in.',at:Date.now()};
        loginState=null;refresh();if(window.meridianHeaderRefresh)window.meridianHeaderRefresh();
      }else{
        loginState.error=(res.data&&res.data.error&&res.data.error.message)||'Login failed.';
        loginState.busy=false;
        if(lastData)render(lastData[0],lastData[1],lastData[2],lastData[3]);
      }
    })
    .catch(function(e){
      if(e&&e.locked){keyLocked=true;loginState=null;if(lastData)render(lastData[0],lastData[1],lastData[2],lastData[3])}
      else{loginState.error='Could not reach the server.';loginState.busy=false;if(lastData)render(lastData[0],lastData[1],lastData[2],lastData[3])}
    });
}

function refreshToken(id){
  apiPost('/auth/refresh',{}, {'x-meridian-profile':id})
    .then(function(res){
      if(res.data&&res.data.success){notice={type:'ok',text:'Token refreshed for "'+id+'".',at:Date.now()}}
      else{notice={type:'err',text:(res.data&&(res.data.message||res.data.error))||'Refresh failed — the account may need a fresh login.',at:Date.now()}}
      refresh();if(window.meridianHeaderRefresh)window.meridianHeaderRefresh();
    })
    .catch(function(e){opFailed(e,'Could not reach the server')});
}

function saveRename(id){
  var input=document.getElementById('rename-input');
  var to=input?input.value.trim():'';
  if(!to||to===id){renaming=null;if(lastData)render(lastData[0],lastData[1],lastData[2],lastData[3]);return}
  apiPost('/profiles/rename',{from:id,to:to})
    .then(function(res){
      renaming=null;
      if(res.data&&res.data.success){notice={type:'ok',text:'Renamed "'+id+'" to "'+to+'".',at:Date.now()}}
      else{notice={type:'err',text:(res.data&&res.data.error)||'Rename failed.',at:Date.now()}}
      refresh();if(window.meridianHeaderRefresh)window.meridianHeaderRefresh();
    })
    .catch(function(e){renaming=null;opFailed(e,'Could not reach the server')});
}

function confirmRemove(id){
  apiPost('/profiles/remove',{id:id})
    .then(function(res){
      confirmingRemove=null;
      if(res.data&&res.data.success){notice={type:'ok',text:'Account "'+id+'" removed.',at:Date.now()}}
      else{notice={type:'err',text:(res.data&&res.data.error)||'Remove failed.',at:Date.now()}}
      refresh();if(window.meridianHeaderRefresh)window.meridianHeaderRefresh();
    })
    .catch(function(e){confirmingRemove=null;opFailed(e,'Could not reach the server')});
}

function saveAdd(){
  var idInput=document.getElementById('add-id');
  var id=idInput?idInput.value.trim():'';
  if(!id){addError='Enter a name for the account.';if(lastData)render(lastData[0],lastData[1],lastData[2],lastData[3]);return}
  if(addMode==='token'){
    var tokenInput=document.getElementById('add-token');
    var token=tokenInput?tokenInput.value:'';
    if(!token.trim()){addError='Paste the "claude setup-token" value.';if(lastData)render(lastData[0],lastData[1],lastData[2],lastData[3]);return}
    apiPost('/profiles/add-oauth-token',{id:id,token:token})
      .then(function(res){
        if(res.data&&res.data.success){
          adding=false;addError=null;
          notice={type:'ok',text:'Account "'+id+'" added.',at:Date.now()};
          refresh();if(window.meridianHeaderRefresh)window.meridianHeaderRefresh();
        }else{addError=(res.data&&res.data.error)||'Add failed.';if(lastData)render(lastData[0],lastData[1],lastData[2],lastData[3])}
      })
      .catch(function(e){opFailed(e,'Could not reach the server')});
    return;
  }
  apiPost('/profiles/add',{id:id})
    .then(function(res){
      if(res.data&&res.data.success){
        adding=false;addError=null;
        notice={type:'ok',text:'Account "'+id+'" added — complete its login below.',at:Date.now()};
        refresh();startLogin(id);
      }else{addError=(res.data&&res.data.error)||'Add failed.';if(lastData)render(lastData[0],lastData[1],lastData[2],lastData[3])}
    })
    .catch(function(e){opFailed(e,'Could not reach the server')});
}

// Every management button routes through here. Action controls opt out of
// the card-as-switch-button, so this runs before any card logic below.
function handleAction(el){
  var action=el.dataset.action;
  var profile=el.dataset.profile;
  if(action==='unlock'){unlockDashboard();return}
  if(action==='forget'){if(window.meridianSetApiKey)window.meridianSetApiKey('');keyLocked=false;refresh();if(window.meridianHeaderRefresh)window.meridianHeaderRefresh();return}
  if(action==='login'&&profile){startLogin(profile);return}
  if(action==='login-complete'){completeLogin();return}
  if(action==='login-cancel'){loginState=null;refresh();return}
  if(action==='refresh-token'&&profile){refreshToken(profile);return}
  if(action==='rename'&&profile){renaming=profile;confirmingRemove=null;if(lastData)render(lastData[0],lastData[1],lastData[2],lastData[3]);return}
  if(action==='rename-save'&&profile){saveRename(profile);return}
  if(action==='rename-cancel'){renaming=null;if(lastData)render(lastData[0],lastData[1],lastData[2],lastData[3]);return}
  if(action==='remove'&&profile){confirmingRemove=profile;renaming=null;if(lastData)render(lastData[0],lastData[1],lastData[2],lastData[3]);return}
  if(action==='remove-confirm'&&profile){confirmRemove(profile);return}
  if(action==='remove-cancel'){confirmingRemove=null;if(lastData)render(lastData[0],lastData[1],lastData[2],lastData[3]);return}
  if(action==='add'){adding=true;addError=null;loginState=null;if(lastData)render(lastData[0],lastData[1],lastData[2],lastData[3]);return}
  if(action==='add-mode'){addMode=el.dataset.mode==='token'?'token':'claude';addError=null;if(lastData)render(lastData[0],lastData[1],lastData[2],lastData[3]);return}
  if(action==='add-save'){saveAdd();return}
  if(action==='add-cancel'){adding=false;addError=null;if(lastData)render(lastData[0],lastData[1],lastData[2],lastData[3]);return}
}
// The handle sits inside a card that is itself a switch button, so without
// this every grab of the handle would also change the active account.
function onHandle(e){return !!(e.target.closest&&e.target.closest('.drag-handle'))}
document.getElementById('content').addEventListener('click',function(e){
  if(onHandle(e))return;
  var act=e.target.closest('[data-action]');
  if(act){handleAction(act);return}
  // The card is itself the switch button, so the icon inside one has to opt
  // out of it or reading an account would move all traffic to that account.
  if(e.target.closest('.prof-info'))return;
  var tab=e.target.closest('.sort-tab');
  if(tab&&tab.dataset.sort){setViewSort(tab.dataset.sort);return}
  var card=e.target.closest('.profile-card.switchable');
  if(card&&card.dataset.profile)switchProfile(card.dataset.profile);
});
document.getElementById('content').addEventListener('keydown',function(e){
  // Typing in a control is never a card action; Enter submits the open form.
  if(e.target.closest('input,textarea')){
    if(e.key==='Enter'){
      var id=e.target.id;
      if(id==='login-code')completeLogin();
      else if(id==='api-key-input')unlockDashboard();
      else if(id==='add-id')saveAdd();
      else if(id==='rename-input'){var btn=e.target.closest('.card-actions');var save=btn?btn.querySelector('[data-action="rename-save"]'):null;if(save)saveRename(save.dataset.profile)}
    }
    return;
  }
  if(e.key!=='Enter'&&e.key!==' ')return;
  if(onHandle(e))return;
  if(e.target.closest('[data-action]'))return;
  if(e.target.closest('.prof-info'))return;
  var card=e.target.closest('.profile-card.switchable');
  if(card&&card.dataset.profile){e.preventDefault();switchProfile(card.dataset.profile)}
});
viewSort=readStoredSort()||viewSort;
meridianReorder.init({onSaved:refresh});
refresh();
// A form holding typed input must not be wiped by the poll — same reason the
// drag and the info popover already pause it.
setInterval(function(){if(!meridianReorder.dragging() && !infoPopOpen() && !loginState && !adding && !renaming)refresh()},10000);
` + profileBarJs + `
</script>
</body>
</html>`
