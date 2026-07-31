/* TLAPS Email Command Center — portal/assets/email.js
 *
 * One hub, five identities:
 *  - Reads mail from the HUB gmail (rtsui.jlconcepts) via Gmail API (browser OAuth, no passwords stored)
 *  - All 5 accounts forward into the hub with acct/* labels
 *  - Replies go out via Gmail "Send mail as" verified aliases
 *  - Claude copilot = Supabase Edge Function (email-copilot); API key never touches the browser
 *  - HARD RULE: nothing sends without the human clicking through the confirm modal
 */

/* ================= CONFIG ================= */
const EC = {
  // Only these portal users may open the Email Center:
  ALLOWED_USERS: ['rtsui.jlconcepts@gmail.com'],
  // Google OAuth Client ID — pre-configured: "Web client 1" in GCP project tlaps-dhg-project
  // (Gmail API enabled; consent screen in Testing with all 5 accounts as test users;
  //  origins https://www.tlapspro.com + https://tlapspro.com added Jul 22, 2026)
  GOOGLE_CLIENT_ID: localStorage.getItem('tlaps_ec_gcid') || '640975272286-a6fcqegebspijfs0gbp4u364vsellue1.apps.googleusercontent.com',
  SCOPES: 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.settings.basic',
  COPILOT_URL: SUPABASE_URL + '/functions/v1/email-copilot',
  ACCOUNTS: ['acct/rickytsuiusa','acct/envisioninginc','acct/trucksadventures','acct/amazonkwan','acct/yeezyforever'],
  SYNC_WINDOW: 'newer_than:90d',
  PER_LABEL: 150
};

/* ================= PAGE GATE ================= */
requireAuth();
(function gate() {
  const who = (sessionStorage.getItem(EMAIL_KEY) || '').toLowerCase();
  if (EC.ALLOWED_USERS.length && !EC.ALLOWED_USERS.includes(who)) {
    alert('Email Center is restricted.');
    window.location.replace('dashboard.html');
  }
})();
renderSidebar('email');

/* ================= STATE ================= */
let gToken = null, gTokenExp = 0, tokenClient = null;
let queue = [];            // rows from supabase email_queue
let sel = null;            // selected queue row
let threadCache = {};      // threadId -> parsed messages
let sendAsList = [];       // verified aliases
let playbooks = [];
let vipList = [];          // rows from supabase email_vip ("always include")
let copHistory = [];       // {role, content}
let lastClaudeDraft = '';
let migrationPending = false;  // true if sql/09 columns are missing

const $ = id => document.getElementById(id);

// Hub aliases per forwarding label — used to auto-pick the From address.
const ACCT_EMAIL = {
  'acct/rickytsuiusa':   'rickytsuiusa@gmail.com',
  'acct/envisioninginc': 'envisioninginc@gmail.com',
  'acct/trucksadventures':'trucksadventures@gmail.com',
  'acct/amazonkwan':     'amazon.kwan@gmail.com',
  'acct/yeezyforever':   'yeezyforever1112@gmail.com'
};
function aliasFor(account) {
  const want = ACCT_EMAIL[account];
  if (want && sendAsList.some(a => a.sendAsEmail === want)) return want;
  const primary = sendAsList.find(a => a.isPrimary);
  return primary ? primary.sendAsEmail : '';
}

/* ================= CLASSIFIER ================= */
const RX_URGENT = /(chargeback|charge-back|fraud|unauthorized|suspend|suspension|deactivat|funds (are )?on hold|past due|overdue|final notice|collections|immediate action|account.*(danger|risk)|security alert|verify your identity|violation notice|unauthorized seller)/i;
const RX_ACTION = /(action required|please (reply|respond|confirm|review)|invoice|payment request|refund|return|dispute|case #|request \d|deadline|respond by|confirm shipment|needs attention|item not received|cancel.*order|credit application|purchase order|po ?#|statement|quote|quotation)/i;
const RX_NOISE  = /(newsletter|unsubscribe|webinar|sale ends|% off|deal|promotion|digest|we found something|recommendations for you|now available on asap|new product spotlight)/i;
const NOISE_SENDERS = /(store-news@amazon|deals\.|selections\.|@e\.godaddy|stickermule|kalshi|snacks\.robinhood|patreon|skool\.com|hiltongrandvacations|emeritus|summithouse|marketing|noreply@ads\.)/i;
const RX_MONEY  = /(refund|chargeback|return|dispute|payment|invoice|past due|payout|credit|reimburs|funds)/i;

// Priority contacts + topics, hardcoded floor (roster as of Jul 29 2026).
// The editable email_vip table layers on top of these at the same precedence —
// these stay so the classifier still honors the roster if the table is missing
// or unreachable. Add NEW people via Settings → Priority contacts, not here.
// VIP roster (Jul 29 2026):
//   Laura Chung (finance/AP)              contact.jlconcepts@gmail.com
//   David Nelson / Dyntech (ERP support)  david@ / pete@ / servers@ dynenttech.com
//   Appaiah + Amazon account health       appsid@amazon.com, shaqbus@amazon.com
//   Majestic Realty (landlord)            DMoya@ / MRivera@ majesticrealty.com
//   WarehouseOS / WOS (WMS)               *@warehouseos.com, *@hoj.net
//   Connected Business / eShopCONNECT     connectedbusiness.com + "CB" keywords
//   Tierzero (internet, acct 439)         billing@tierzero.com
//   Parts Authority (WD supplier)         *@partsauthority.com - Lisa, Russell Chernick
//   DCi / LeadVenture (product data)      *@leadventure.com, *@dcinews.com - Craig, Brad
const VIP_SENDERS = /(contact\.jlconcepts|appsid@amazon|shaqbus@amazon|majesticrealty|dynenttech|warehouseos|@hoj\.net|tierzero|connectedbusiness|partsauthority|leadventure|dcinews)/i;
const RX_VIP    = /(laura\s*chung|contact\.jlconcepts|david\s*nelson|appsid@amazon|dyn\s*ent\s*tech|dyntech|majestic|warehouse\s*os|\bwos\b|warehouse mobile solutions|connected\s*business|connectedbusiness|eshopconnect|tier\s*zero|tierzero|parts\s*authority|partsauthority|chernick|leadventure|\bdci\b|vendor\s*manager|account\s*manager|account\s*health|health\s*rating|otdr|selling\s*privilege|brand\s*registry)/i;
const RX_DISRUPT= /(disrupt|interruption of service|service (interruption|down|will be|may be|is being)|servers? (are )?down|outage|stopped but should be running|will be (suspend|deactivat|disabl|terminat|paus|remov|shut)|shut\s?off|loss of (selling|buying) privilege|at risk of (deactivat|suspend|removal)|account (deactivat|suspend)|listing removed|going to be removed|past due|overdue|final notice|shut down)/i;
// Routine-but-wanted VIP mail (release notices, bills) -> queue as ACTION, not URGENT,
// so the urgent bucket stays meaningful.
const VIP_ROUTINE = /(release note|release notice|maintenance window|scheduled maintenance|invoice|statement|receipt|payment posted|upgrade|update)/i;
// Automated heartbeats from VIP senders that are not worth queueing at all
// (e.g. the daily servers@dynenttech.com "JLC Stock Totals *** SUCCESS ***").
const VIP_MUTE    = /(\*\*\* ?success ?\*\*\*|no issue found|nothing to report)/i;

/* --- editable inclusion list (email_vip) --- */
async function loadVips() {
  try {
    vipList = await sbGet('email_vip?select=*&active=is.true&order=kind.asc,value.asc');
  } catch (e) {
    vipList = [];
    console.warn('VIP list unavailable (run sql/09_email_vip_and_autodraft.sql?):', e.message);
  }
}
function rxEscape(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function emailOf(from) {
  const m = String(from || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(from || '')).trim().toLowerCase();
}
// Returns the matching email_vip row, or null.
function vipMatch(from, subject, snippet) {
  if (!vipList.length) return null;
  const addr = emailOf(from);
  const domain = addr.split('@')[1] || '';
  const hay = ((from || '') + ' ' + (subject || '') + ' ' + (snippet || '')).toLowerCase();
  for (const v of vipList) {
    const val = String(v.value || '').trim().toLowerCase();
    if (!val) continue;
    if (v.kind === 'sender') {
      if (addr === val || addr.includes(val) || (from || '').toLowerCase().includes(val)) return v;
    } else if (v.kind === 'domain') {
      const d = val.replace(/^@/, '');
      if (domain === d || domain.endsWith('.' + d)) return v;
    } else if (v.kind === 'keyword') {
      // word-boundary match so short tokens (ODR, MAP) don't fire inside other words
      if (new RegExp('(^|[^a-z0-9])' + rxEscape(val) + '([^a-z0-9]|$)', 'i').test(hay)) return v;
    }
  }
  return null;
}

// Returns { category, vip_reason } or null. Precedence:
//   service disruption -> VIP (mute -> routine -> urgent) -> noise -> urgent -> action.
// A VIP hit is never dropped by the noise filter.
function classify(from, subject, snippet) {
  const s = (subject || '') + ' ' + (snippet || '');
  const f = from || '';
  // Anything down, stopped, or about to be shut off outranks everything, any sender.
  if (RX_DISRUPT.test(s)) return { category: 'URGENT', vip_reason: 'service disruption / past due' };
  const vip = vipMatch(f, subject, snippet);
  if (vip) {
    if (VIP_MUTE.test(s)) return null;                                    // automated heartbeat
    const why = vip.label || (vip.kind + ': ' + vip.value);
    // A whole-company rule (sender/domain) still gets the routine tier: the daily
    // "Parts Authority Invoice/Credit" blast lands in ACTION, not URGENT. Topic
    // keywords (suspension, ODR, past due) keep whatever category the row sets.
    if ((vip.kind === 'sender' || vip.kind === 'domain') && (vip.category || 'URGENT') === 'URGENT' && VIP_ROUTINE.test(s)) {
      return { category: 'ACTION', vip_reason: why + ' — routine notice' };
    }
    return { category: vip.category || 'URGENT', vip_reason: why };
  }
  if (VIP_SENDERS.test(f) || RX_VIP.test(f) || RX_VIP.test(s)) {
    if (VIP_MUTE.test(s)) return null;                                    // automated heartbeat
    return VIP_ROUTINE.test(s)
      ? { category: 'ACTION', vip_reason: 'priority contact — routine notice' }
      : { category: 'URGENT', vip_reason: 'priority contact/topic' };
  }
  if (NOISE_SENDERS.test(f) || RX_NOISE.test(s)) return null;             // skip noise entirely
  if (RX_URGENT.test(s)) return { category: 'URGENT', vip_reason: null };
  if (RX_ACTION.test(s)) return { category: 'ACTION', vip_reason: null };
  return null;                                                            // FYI -> not queued (actionable-only v1)
}

// Platform cases (eBay/Amazon) are resolved in Seller Hub / Seller Central,
// not by replying to the notification email — so never auto-draft a reply.
const PLATFORM_SENDERS = /(@ebay\.com|@reply\.ebay\.com|@members\.ebay|@amazon\.com|@marketplace\.amazon|@sellercentral)/i;
const RX_CASE_LANG = /(case|claim|a-to-z|dispute|return request|item not received|seller hub|seller central|performance notification)/i;
function isPlatformCase(row) {
  return PLATFORM_SENDERS.test(row.sender || '') &&
         RX_CASE_LANG.test((row.subject || '') + ' ' + (row.snippet || ''));
}

/* ================= GOOGLE AUTH ================= */
function gmailReady() { return gToken && Date.now() < gTokenExp - 30000; }

function initGsi() {
  if (!EC.GOOGLE_CLIENT_ID) {
    $('setup-note').style.display = '';
    $('setup-note').innerHTML = 'One-time setup needed: open <b>Settings</b> and paste your <code>Google OAuth Client ID</code> (see EMAIL_CENTER_SETUP guide, step 3). Then click <b>Connect Gmail</b>.';
    return;
  }
  if (!(window.google && google.accounts && google.accounts.oauth2)) { setTimeout(initGsi, 400); return; }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: EC.GOOGLE_CLIENT_ID,
    scope: EC.SCOPES,
    callback: (resp) => {
      if (resp.error) { toast('Google auth failed: ' + resp.error, 'error'); return; }
      gToken = resp.access_token;
      gTokenExp = Date.now() + (resp.expires_in || 3600) * 1000;
      sessionStorage.setItem('tlaps_ec_tok', JSON.stringify({ t: gToken, e: gTokenExp }));
      onGmailConnected();
    }
  });
  // restore session token if still valid
  try {
    const s = JSON.parse(sessionStorage.getItem('tlaps_ec_tok') || 'null');
    if (s && Date.now() < s.e - 60000) { gToken = s.t; gTokenExp = s.e; onGmailConnected(); }
  } catch (e) {}
}

async function onGmailConnected() {
  $('btn-gmail').textContent = 'Gmail ✓';
  $('btn-gmail').classList.add('ok');
  $('btn-sync').disabled = false;
  toast('Gmail connected (hub)', 'success');
  await loadSendAs();
}

function connectGmail() {
  if (!tokenClient) { initGsi(); if (!tokenClient) return; }
  tokenClient.requestAccessToken({ prompt: gToken ? '' : 'consent' });
}

/* ================= GMAIL REST ================= */
async function gm(path, opts) {
  if (!gmailReady()) { connectGmail(); throw new Error('Gmail token expired — reconnect and retry'); }
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/' + path, Object.assign({
    headers: { 'Authorization': 'Bearer ' + gToken, 'Content-Type': 'application/json' }
  }, opts || {}));
  if (res.status === 401) { gToken = null; connectGmail(); throw new Error('Gmail session expired'); }
  if (!res.ok) throw new Error('Gmail API ' + path.split('?')[0] + ' -> ' + res.status + ' ' + (await res.text()).slice(0, 200));
  return res.json();
}

async function loadSendAs() {
  try {
    const data = await gm('settings/sendAs');
    sendAsList = (data.sendAs || []).filter(a => a.verificationStatus === 'accepted' || a.isPrimary);
    const sel1 = $('c-from');
    sel1.innerHTML = sendAsList.map(a =>
      `<option value="${escapeHtml(a.sendAsEmail)}">${escapeHtml(a.displayName || '')} &lt;${escapeHtml(a.sendAsEmail)}&gt;${a.isPrimary?' (hub)':''}</option>`).join('');
    const missing = 5 - sendAsList.filter(a => !a.isPrimary).length;
    if (missing > 0) {
      $('setup-note').style.display = '';
      $('setup-note').innerHTML = `Send-as aliases verified: <b>${sendAsList.length - 1} of 5</b>. Finish the remaining ones in the hub's Gmail Settings → Accounts and Import → "Send mail as" (see setup guide step 2) to reply as every account.`;
    }
  } catch (e) { toast('Could not load send-as aliases: ' + e.message, 'error'); }
}

/* ================= SYNC ================= */
async function syncInbox() {
  $('btn-sync').disabled = true; $('btn-sync').textContent = 'Syncing…';
  try {
    await loadVips();   // always sweep with the latest inclusion list
    const existing = {}; queue.forEach(r => { if (r.thread_id) existing[r.thread_id] = r; });
    let added = 0, seen = new Set();
    for (const label of EC.ACCOUNTS) {
      const q = encodeURIComponent(`label:"${label}" ${EC.SYNC_WINDOW} -in:sent`);
      let data;
      try { data = await gm(`messages?q=${q}&maxResults=${EC.PER_LABEL}`); }
      catch (e) { console.warn(label, e); continue; }
      for (const m of (data.messages || [])) {
        if (seen.has(m.threadId) || existing[m.threadId]) { seen.add(m.threadId); continue; }
        seen.add(m.threadId);
        let md;
        try {
          md = await gm(`messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
        } catch (e) { continue; }
        const h = {}; (md.payload.headers || []).forEach(x => h[x.name.toLowerCase()] = x.value);
        const hit = classify(h.from, h.subject, md.snippet);
        if (!hit) continue;
        const row = {
          thread_id: m.threadId, source: 'hub', account: label, category: hit.category,
          subject: h.subject || '(no subject)', sender: h.from || '',
          snippet: (md.snippet || '').slice(0, 300),
          gmail_link: 'https://mail.google.com/mail/u/0/#all/' + m.threadId,
          money_flag: RX_MONEY.test((h.subject||'') + ' ' + (md.snippet||'')),
          vip_reason: hit.vip_reason,
          status: 'new', last_activity: h.date ? new Date(h.date).toISOString() : new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        row.no_autodraft = isPlatformCase(row);   // platform cases resolve in Seller Hub, not by email
        try {
          await sbUpsert('email_queue', row, 'thread_id'); added++;
        } catch (e) {
          // sql/09 not applied yet -> retry without the columns it adds
          if (/column|schema cache/i.test(e.message || '')) {
            const legacy = Object.assign({}, row);
            delete legacy.vip_reason; delete legacy.no_autodraft;
            try { await sbUpsert('email_queue', legacy, 'thread_id'); added++; migrationPending = true; }
            catch (e2) { console.warn('upsert', e2); }
          } else { console.warn('upsert', e); }
        }
      }
    }
    await loadQueue();
    toast(`Sync done — ${added} new actionable item(s)`, added ? 'success' : 'info');
    if (migrationPending) {
      $('setup-note').style.display = '';
      $('setup-note').innerHTML = 'Priority contacts + auto-draft need one migration: run <code>sql/09_email_vip_and_autodraft.sql</code> in the Supabase SQL editor. Classification still works from the built-in list until then.';
    }
  } catch (e) { toast('Sync failed: ' + e.message, 'error'); }
  $('btn-sync').disabled = false; $('btn-sync').textContent = 'Sync inbox';
}

/* ================= QUEUE (Supabase) ================= */
async function loadQueue() {
  queue = await sbGet('email_queue?select=*&order=category.asc,last_activity.desc.nullslast&limit=400');
  refreshAccountFilter();
  renderQueue();
}

function activeFilters() {
  const chips = [...document.querySelectorAll('#filters .ec-chip.on')];
  const sortEl = $('f-sort');
  return {
    cats: chips.filter(c => c.dataset.f === 'cat').map(c => c.dataset.v),
    sts:  chips.filter(c => c.dataset.f === 'st').map(c => c.dataset.v),
    acct: $('f-acct').value,
    sort: sortEl ? sortEl.value : 'action'
  };
}

/* Rebuild the mailbox dropdown from the rows that actually came back, so every
 * mailbox in the queue is selectable (the old hard-coded list silently omitted
 * any account that only ever appears on backlog rows) and each one carries its
 * own open-item count. The current selection is preserved across rebuilds. */
function refreshAccountFilter() {
  const el = $('f-acct');
  if (!el) return;
  const OPEN = ['new','in_progress','drafted'];
  const counts = {};
  queue.forEach(r => {
    const a = r.account || '(unassigned)';
    if (!counts[a]) counts[a] = { open: 0, total: 0 };
    counts[a].total++;
    if (OPEN.includes(r.status)) counts[a].open++;
  });
  const names = Object.keys(counts).sort((a, b) => counts[b].open - counts[a].open || a.localeCompare(b));
  const openAll = queue.filter(r => OPEN.includes(r.status)).length;
  const keep = el.value;
  el.innerHTML = `<option value="">All mailboxes (${openAll} open)</option>`
    + names.map(a => `<option value="${escapeHtml(a)}">${escapeHtml(a.replace('acct/',''))} — ${counts[a].open} open / ${counts[a].total}</option>`).join('');
  el.value = [...el.options].some(o => o.value === keep) ? keep : '';
}

function renderQueue() {
  const f = activeFilters();
  const OPEN = ['new','in_progress','drafted'], DONE = ['sent','done','dismissed'];
  const CATRANK = { URGENT: 0, ACTION: 1 };
  const rows = queue.filter(r => {
    if (f.cats.length && !f.cats.includes(r.category)) return false;
    const isOpen = OPEN.includes(r.status);
    if (!((f.sts.includes('open') && isOpen) || (f.sts.includes('done') && !isOpen))) return false;
    if (f.acct && (r.account || '(unassigned)') !== f.acct) return false;
    return true;
  });
  const ts = r => r.last_activity ? new Date(r.last_activity).getTime() : 0;
  if (f.sort === 'newest')      rows.sort((a, b) => ts(b) - ts(a));
  else if (f.sort === 'oldest') rows.sort((a, b) => ts(a) - ts(b));
  else if (f.sort === 'mailbox') rows.sort((a, b) =>
    String(a.account||'').localeCompare(String(b.account||''))
    || (CATRANK[a.category] ?? 9) - (CATRANK[b.category] ?? 9) || ts(b) - ts(a));
  else rows.sort((a, b) => (CATRANK[a.category] ?? 9) - (CATRANK[b.category] ?? 9) || ts(b) - ts(a));
  $('q-count').textContent = rows.length + ' item(s)'
    + (f.acct ? ' in ' + f.acct.replace('acct/','') : '');
  if (!rows.length) { $('queue').innerHTML = '<div class="ec-empty">Nothing here — sync, or loosen the filters.</div>'; return; }
  // group headers make a single mailbox readable at a glance; the numbering
  // stays continuous 1..N across the whole visible list either way
  const groupOf = r => f.sort === 'mailbox' ? (r.account || '(unassigned)').replace('acct/','')
    : f.sort === 'action' ? r.category : '';
  let lastGroup = null;
  $('queue').innerHTML = rows.map((r, i) => {
    const g = groupOf(r);
    const head = (g && g !== lastGroup) ? `<div class="qi-group">${escapeHtml(g)}</div>` : '';
    lastGroup = g;
    return head + `
    <div class="qi ${sel && sel.id === r.id ? 'sel' : ''}" data-id="${r.id}">
      <div class="top">
        <span class="qi-num">${i + 1}</span>
        <span class="cat ${r.category}">${r.category}</span>
        ${r.vip_reason ? `<span class="vip-tag" title="Priority: ${escapeHtml(r.vip_reason)}">★</span>` : ''}
        <span class="acct-tag">${escapeHtml((r.account||'').replace('acct/',''))}</span>
        ${r.money_flag ? '<span class="money">💰</span>' : ''}
        ${r.draft_body ? `<span class="draft-tag" title="${r.draft_source === 'claude' ? 'Claude drafted a suggested reply' : 'Draft saved'}">✎ ${r.draft_source === 'claude' ? 'Draft ready' : 'Draft'}</span>` : ''}
        <span class="st ${r.status}">${r.status}</span>
        <span style="margin-left:auto">${r.last_activity ? new Date(r.last_activity).toLocaleDateString('en-US',{month:'short',day:'numeric'}) : ''}</span>
        ${['done','dismissed'].includes(r.status) ? '' : `<button class="qi-done" data-done="${r.id}" title="Remove from the hub inbox (stays in All Mail) and mark done">Archive</button>`}
      </div>
      <div class="subj">${escapeHtml(r.subject || '')}</div>
      <div class="snip">${escapeHtml((r.sender||'').replace(/<.*>/,''))} — ${escapeHtml(r.snippet || '')}</div>
    </div>`;
  }).join('');
  document.querySelectorAll('.qi').forEach(el => el.addEventListener('click', () => openItem(el.dataset.id)));
  document.querySelectorAll('.qi-done').forEach(el => el.addEventListener('click', ev => {
    ev.stopPropagation(); markDone(el.dataset.done);
  }));
}

/* ================= THREAD VIEW ================= */
function b64urlDecode(s) {
  s = (s || '').replace(/-/g, '+').replace(/_/g, '/');
  try { return decodeURIComponent(escape(atob(s))); } catch (e) { try { return atob(s); } catch (e2) { return ''; } }
}
function extractBody(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) return b64urlDecode(payload.body.data);
  if (payload.mimeType === 'text/html' && payload.body && payload.body.data) {
    const doc = new DOMParser().parseFromString(b64urlDecode(payload.body.data), 'text/html');
    doc.querySelectorAll('style,script').forEach(n => n.remove());
    return (doc.body ? doc.body.innerText : '').replace(/\n{3,}/g, '\n\n').trim();
  }
  for (const part of (payload.parts || [])) { const t = extractBody(part); if (t) return t; }
  return '';
}
function parseThread(t) {
  return (t.messages || []).map(m => {
    const h = {}; (m.payload.headers || []).forEach(x => h[x.name.toLowerCase()] = x.value);
    return { from: h.from||'', to: h.to||'', date: h.date||'', subject: h.subject||'',
             msgId: h['message-id']||'', body: extractBody(m.payload) || m.snippet || '' };
  });
}

async function openItem(id) {
  sel = queue.find(r => String(r.id) === String(id));
  if (!sel) return;
  renderQueue();
  syncArchiveBtn();
  copHistory = []; lastClaudeDraft = '';
  $('cop-log').innerHTML = '<div class="ec-empty" style="padding:20px">Context loaded — ask away.</div>';
  $('money-banner').style.display = sel.money_flag ? '' : 'none';
  $('t-meta').innerHTML = `<a href="${sel.gmail_link}" target="_blank" style="color:var(--green)">open in Gmail ↗</a>`;
  $('c-noauto').checked = !!sel.no_autodraft;
  setDraftStatus(sel.draft_source === 'claude' && sel.draft_body
    ? '✎ Claude drafted this — review and edit before sending.' : '',
    'ok');

  // deadline sniffing
  const dl = ((sel.subject||'') + ' ' + (sel.snippet||'')).match(/(respond|reply|confirm|ship|by)\s+(by\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}/i);

  // composer prefill
  const senderEmail = ((sel.sender || '').match(/<([^>]+)>/) || [null, sel.sender])[1] || '';
  $('c-to').value = senderEmail;
  $('c-subj').value = /^re:/i.test(sel.subject || '') ? sel.subject : 'Re: ' + (sel.subject || '');
  $('c-body').value = sel.draft_body || '';
  // best-guess From: match account alias
  const want = aliasFor(sel.account);
  if (want && [...$('c-from').options].some(o => o.value === want)) $('c-from').value = want;
  $('btn-send').disabled = false;

  // thread body
  if (!sel.thread_id) {
    $('thread').innerHTML = (dl?`<div class="deadline-banner">⏰ Possible deadline: “${escapeHtml(dl[0])}” — verify in the email.</div>`:'') +
      `<div class="ec-empty">Backlog item (lives outside the hub).<br><a target="_blank" href="${sel.gmail_link}" class="btn btn-secondary" style="margin-top:10px;display:inline-block">Open source account ↗</a></div>`;
    maybeAutoDraft(sel, null);   // snippet-only draft for backlog rows
    return;
  }
  $('thread').innerHTML = '<div class="ec-empty">Loading thread…</div>';
  try {
    let msgs = threadCache[sel.thread_id];
    if (!msgs) {
      msgs = parseThread(await gm('threads/' + sel.thread_id + '?format=full'));
      threadCache[sel.thread_id] = msgs;
    }
    $('thread').innerHTML =
      (dl?`<div class="deadline-banner">⏰ Possible deadline: “${escapeHtml(dl[0])}” — verify in the email.</div>`:'') +
      msgs.map((m,i) => `
      <div class="msg ${i < msgs.length-1 ? 'collapsed' : ''}">
        <div class="mh" onclick="this.parentElement.classList.toggle('collapsed')">
          <b>${escapeHtml(m.from.replace(/<.*>/,'').trim())}</b><span>→ ${escapeHtml(m.to.replace(/<.*>/,'').trim())}</span>
          <span class="dt">${escapeHtml(m.date ? new Date(m.date).toLocaleString() : '')}</span>
        </div>
        <div class="mb">${escapeHtml(m.body)}</div>
      </div>`).join('');
    if (sel.status === 'new') await updateRow(sel.id, { status: 'in_progress' });
    maybeAutoDraft(sel, msgs);
  } catch (e) {
    $('thread').innerHTML = `<div class="ec-empty">Could not load thread: ${escapeHtml(e.message)}<br><a target="_blank" href="${sel.gmail_link}">Open in Gmail ↗</a></div>`;
  }
}

async function updateRow(id, patch) {
  patch.updated_at = new Date().toISOString();
  const put = body => fetch(SUPABASE_URL + '/rest/v1/email_queue?id=eq.' + id, {
    method: 'PATCH', headers: sbHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=representation' }),
    body: JSON.stringify(body)
  });
  let res = await put(patch);
  if (!res.ok) {
    const txt = await res.text();
    // sql/09 not applied yet -> retry without the columns it adds, so the rest still saves
    if (/column|schema cache/i.test(txt)) {
      const legacy = Object.assign({}, patch);
      delete legacy.draft_source; delete legacy.no_autodraft; delete legacy.vip_reason;
      migrationPending = true;
      res = await put(legacy);
    }
    if (!res.ok) { console.warn('updateRow', id, txt.slice(0, 200)); return; }
  }
  const [row] = await res.json();
  if (!row) return;
  const i = queue.findIndex(r => r.id === id);
  if (i >= 0) queue[i] = row;
  if (sel && sel.id === id) sel = row;
  renderQueue();
}
async function logAction(action, extra, row) {
  const r = row || sel;
  try {
    await fetch(SUPABASE_URL + '/rest/v1/email_actions', {
      method: 'POST', headers: sbHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(Object.assign({
        queue_id: r ? r.id : null, thread_id: r ? r.thread_id : null,
        action, actor: sessionStorage.getItem(EMAIL_KEY) || ''
      }, extra || {}))
    });
  } catch (e) { console.warn('logAction', e); }
}

/* ================= COPILOT ================= */
async function loadPlaybooks() {
  try {
    playbooks = await sbGet('email_playbooks?select=*&order=name.asc');
    $('playbook').innerHTML = '<option value="">No playbook</option>' +
      playbooks.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  } catch (e) { console.warn('playbooks', e); }
}

function copRender() {
  $('cop-log').innerHTML = copHistory.map(m => `
    <div class="cop-m ${m.role === 'user' ? 'user' : 'claude'}">
      <div class="who">${m.role === 'user' ? 'You' : 'Claude'}</div>
      <div class="bub">${escapeHtml(m.content)}</div>
    </div>`).join('') || '<div class="ec-empty" style="padding:20px">Ask away.</div>';
  $('cop-log').scrollTop = $('cop-log').scrollHeight;
}

async function copAsk(text) {
  if (!text.trim()) return;
  const code = localStorage.getItem('tlaps_copilot_code') || '';
  if (!code) { toast('Set the copilot access code in Settings first', 'warning'); $('set-modal').classList.add('open'); return; }
  copHistory.push({ role: 'user', content: text.trim() });
  copRender();
  $('cop-text').value = ''; $('cop-send').disabled = true; $('cop-send').textContent = '…';
  try {
    let emailCtx = null;
    if (sel) {
      let bodyTxt = sel.snippet || '';
      if (sel.thread_id && threadCache[sel.thread_id]) {
        bodyTxt = threadCache[sel.thread_id].map(m => `[${m.from} — ${m.date}]\n${m.body}`).join('\n\n---\n\n');
      }
      emailCtx = { account: sel.account, sender: sel.sender, subject: sel.subject,
                   category: sel.category, money_flag: sel.money_flag, body: bodyTxt, snippet: sel.snippet };
    }
    const pbId = $('playbook').value;
    const pb = playbooks.find(p => String(p.id) === pbId) || null;
    const res = await fetch(EC.COPILOT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY },
      body: JSON.stringify({ access_code: code, messages: copHistory, email: emailCtx,
                             playbook: pb ? { name: pb.name, instructions: pb.instructions } : null })
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || ('HTTP ' + res.status));
    copHistory.push({ role: 'assistant', content: data.reply || '(empty reply)' });
    lastClaudeDraft = data.reply || '';
    copRender();
  } catch (e) {
    copHistory.push({ role: 'assistant', content: '⚠ Copilot error: ' + e.message });
    copRender();
  }
  $('cop-send').disabled = false; $('cop-send').textContent = 'Ask';
}

function extractDraftBlock(text) {
  // take the last fenced block, or the text after the last '---' separator, else whole text
  const fence = text.match(/```(?:\w*\n)?([\s\S]*?)```(?![\s\S]*```)/);
  if (fence) return fence[1].trim();
  const parts = text.split(/\n-{3,}\n/);
  return (parts.length > 1 ? parts[parts.length - 1] : text).trim();
}

/* ================= PROACTIVE DRAFTS =================
 * Claude pre-writes a suggested reply so Ricky reviews/edits instead of
 * starting from a blank composer. STILL DRAFT-ONLY — this never sends, it
 * only fills draft_body and flips status to 'drafted'. Money items are
 * drafted as "needs your decision" and never commit to an amount.
 */
const AUTODRAFT_KEY = 'tlaps_ec_autodraft';
function autoDraftEnabled() { return localStorage.getItem(AUTODRAFT_KEY) !== 'off'; }

function setDraftStatus(msg, kind) {
  const el = $('draft-status');
  if (!el) return;
  el.textContent = msg || '';
  el.style.display = msg ? '' : 'none';
  el.className = 'draft-status' + (kind ? ' ' + kind : '');
}

// Best-effort playbook match so the draft follows the owner's handling rules.
function pickPlaybook(row) {
  if (!playbooks.length) return null;
  const hay = ((row.subject || '') + ' ' + (row.snippet || '') + ' ' + (row.sender || '')).toLowerCase();
  let best = null, bestScore = 0;
  for (const p of playbooks) {
    const tokens = ((p.name || '') + ' ' + (p.trigger_hint || ''))
      .toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 3);
    let score = 0; const seen = new Set();
    for (const t of tokens) { if (seen.has(t)) continue; seen.add(t); if (hay.includes(t)) score++; }
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return bestScore >= 2 ? best : null;   // require 2 hits so we don't misapply a playbook
}

function draftPrompt(money) {
  return [
    'Pre-draft a reply to this email so I can review and edit it — I have not read it yet.',
    money
      ? 'MONEY ITEM: this thread involves a refund / return / payment / chargeback. Do NOT approve, refuse, or commit to any amount. Draft it so it acknowledges the message and asks for anything still missing, and leave the actual decision to me — mark that spot inline as [MY DECISION: ...].'
      : '',
    'Return ONLY the reply body. No subject line, no preamble, no explanation, no markdown fences.',
    'Keep it short, plain and professional.',
    'If a fact is missing, leave a [BRACKETED PLACEHOLDER] rather than inventing it.'
  ].filter(Boolean).join('\n');
}

async function copilotDraft(row, bodyTxt) {
  const code = localStorage.getItem('tlaps_copilot_code') || '';
  if (!code) throw new Error('copilot access code not set');
  const pb = pickPlaybook(row);
  const res = await fetch(EC.COPILOT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY },
    body: JSON.stringify({
      access_code: code,
      messages: [{ role: 'user', content: draftPrompt(row.money_flag) }],
      email: {
        account: row.account, sender: row.sender, subject: row.subject,
        category: row.category, money_flag: row.money_flag,
        body: bodyTxt || row.snippet || '', snippet: row.snippet
      },
      playbook: pb ? { name: pb.name, instructions: pb.instructions } : null
    })
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || ('HTTP ' + res.status));
  return extractDraftBlock(data.reply || '');
}

// Generate + persist a suggested reply. Returns true if a draft was stored.
async function autoDraft(row, bodyTxt, force) {
  if (!row) return false;
  if (!force) {
    if (row.no_autodraft) return false;
    if (row.draft_body) return false;                                  // don't clobber existing work
    if (['sent', 'done', 'dismissed'].includes(row.status)) return false;
    if (isPlatformCase(row)) return false;                             // resolve in Seller Hub, not by email
  }
  const body = await copilotDraft(row, bodyTxt);
  if (!body) return false;
  const toAddr = ((row.sender || '').match(/<([^>]+)>/) || [null, row.sender])[1] || '';
  const subj = /^re:/i.test(row.subject || '') ? row.subject : 'Re: ' + (row.subject || '');
  await updateRow(row.id, {
    status: ['sent', 'done', 'dismissed'].includes(row.status) ? row.status : 'drafted',
    draft_body: body, draft_from: aliasFor(row.account), draft_to: toAddr,
    draft_subject: subj, draft_source: 'claude'
  });
  logAction('draft_autogenerated', { subject: subj, body_preview: body.slice(0, 300) }, row);
  return true;
}

// Fired when a thread is opened — silent no-op if prerequisites are missing.
async function maybeAutoDraft(row, msgs) {
  if (!row || !autoDraftEnabled()) return;
  if (row.no_autodraft || row.draft_body) return;
  if (['sent', 'done', 'dismissed'].includes(row.status)) return;
  if (!localStorage.getItem('tlaps_copilot_code')) return;   // settings not configured yet
  if (isPlatformCase(row)) {
    setDraftStatus('Platform case — handle it in Seller Hub / Seller Central. No reply drafted.', 'muted');
    return;
  }
  setDraftStatus('Claude is drafting a suggested reply…', 'busy');
  try {
    const ok = await autoDraft(row, threadText(msgs) || row.snippet);
    if (!sel || sel.id !== row.id) return;                   // user moved on — don't touch the composer
    if (ok) {
      if (!$('c-body').value.trim()) $('c-body').value = sel.draft_body || '';
      setDraftStatus('✎ Claude drafted this — review and edit before sending.', 'ok');
    } else { setDraftStatus(''); }
  } catch (e) {
    setDraftStatus('Auto-draft unavailable: ' + e.message, 'muted');
  }
}

function threadText(msgs) {
  if (!msgs || !msgs.length) return '';
  return msgs.map(m => `[${m.from} — ${m.date}]\n${m.body}`).join('\n\n---\n\n');
}

// Batch: pre-draft every open URGENT item that doesn't have one yet.
async function draftAllUrgent() {
  if (!localStorage.getItem('tlaps_copilot_code')) {
    toast('Set the copilot access code in Settings first', 'warning');
    $('set-modal').classList.add('open'); return;
  }
  const OPEN = ['new', 'in_progress', 'drafted'];
  const targets = queue.filter(r => r.category === 'URGENT' && OPEN.includes(r.status) &&
    !r.draft_body && !r.no_autodraft && !isPlatformCase(r));
  if (!targets.length) { toast('No urgent items need a draft', 'info'); return; }
  if (!confirm(`Pre-draft replies for ${targets.length} urgent item(s)?\n\nNothing is sent — drafts only.`)) return;

  const btn = $('btn-draftall');
  btn.disabled = true;
  let done = 0, failed = 0;
  for (let i = 0; i < targets.length; i++) {
    btn.textContent = `Drafting ${i + 1}/${targets.length}…`;
    try {
      let bodyTxt = targets[i].snippet || '';
      if (targets[i].thread_id && gmailReady()) {
        try {
          let msgs = threadCache[targets[i].thread_id];
          if (!msgs) {
            msgs = parseThread(await gm('threads/' + targets[i].thread_id + '?format=full'));
            threadCache[targets[i].thread_id] = msgs;
          }
          bodyTxt = threadText(msgs) || bodyTxt;
        } catch (e) { /* fall back to the snippet */ }
      }
      if (await autoDraft(targets[i], bodyTxt)) done++;
    } catch (e) { failed++; console.warn('autodraft', targets[i].id, e.message); }
  }
  btn.disabled = false; btn.textContent = '✎ Draft all urgent';
  toast(`Drafted ${done} item(s)` + (failed ? `, ${failed} failed` : ''), done ? 'success' : 'warning');
}

/* ================= PRIORITY CONTACTS EDITOR ================= */
function renderVips() {
  const el = $('vip-list');
  if (!el) return;
  if (!vipList.length) {
    el.innerHTML = '<div class="vip-empty">Nothing yet — add a person below, or run <code>sql/09_email_vip_and_autodraft.sql</code> to load the starting roster.</div>';
    return;
  }
  el.innerHTML = vipList.map(v => `
    <div class="vip-row">
      <span class="vip-kind">${escapeHtml(v.kind)}</span>
      <span class="vip-val">${escapeHtml(v.value)}</span>
      <span class="vip-lab">${escapeHtml(v.label || '')}</span>
      <span class="cat ${v.category}">${escapeHtml(v.category)}</span>
      <button class="vip-del" data-id="${escapeHtml(v.id)}" title="Remove">&times;</button>
    </div>`).join('');
  el.querySelectorAll('.vip-del').forEach(b => b.addEventListener('click', () => removeVip(b.dataset.id)));
}

async function addVip() {
  const value = $('vip-value').value.trim();
  if (!value) { toast('Enter an email, domain, or phrase', 'warning'); return; }
  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1/email_vip', {
      method: 'POST', headers: sbHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=representation' }),
      body: JSON.stringify({ kind: $('vip-kind').value, value,
        label: $('vip-label').value.trim() || null, category: $('vip-cat').value })
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(/duplicate key/i.test(txt) ? 'already on the list'
        : /relation .*email_vip.* does not exist/i.test(txt) ? 'run sql/09_email_vip_and_autodraft.sql first'
        : txt.slice(0, 160));
    }
    $('vip-value').value = ''; $('vip-label').value = '';
    await loadVips(); renderVips();
    toast('Added — applies on the next sync', 'success');
  } catch (e) { toast('Could not add: ' + e.message, 'error'); }
}

async function removeVip(id) {
  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1/email_vip?id=eq.' + encodeURIComponent(id),
      { method: 'DELETE', headers: sbHeaders() });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    await loadVips(); renderVips();
    toast('Removed', 'success');
  } catch (e) { toast('Could not remove: ' + e.message, 'error'); }
}

/* ================= SEND ================= */
function b64urlEncode(str) {
  return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function buildRaw(from, to, subject, body, inReplyTo, references) {
  const alias = sendAsList.find(a => a.sendAsEmail === from);
  const fromHdr = alias && alias.displayName ? `${alias.displayName} <${from}>` : from;
  let h = `From: ${fromHdr}\r\nTo: ${to}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: 8bit\r\n`;
  if (inReplyTo) h += `In-Reply-To: ${inReplyTo}\r\n`;
  if (references) h += `References: ${references}\r\n`;
  return b64urlEncode(h + '\r\n' + body);
}

function openSendModal() {
  if (!$('c-to').value.trim() || !$('c-body').value.trim()) { toast('To + body required', 'warning'); return; }
  if (!$('c-from').value) { toast('Pick a From address (connect Gmail first)', 'warning'); return; }
  $('m-from').textContent = $('c-from').value;
  $('m-to').textContent = $('c-to').value;
  $('m-subj').textContent = $('c-subj').value;
  $('m-body').textContent = $('c-body').value;
  $('m-money').style.display = sel && sel.money_flag ? '' : 'none';
  $('send-modal').classList.add('open');
}

/* Archive a hub thread (drop the INBOX label). Returns true only if Gmail
 * confirmed it. Never throws — archiving is always a deliberate, separate action,
 * so a label failure is reported as a warning and nothing else is rolled back. */
async function archiveThread(threadId) {
  try {
    await gm('threads/' + threadId + '/modify',
      { method: 'POST', body: JSON.stringify({ removeLabelIds: ['INBOX'] }) });
    return true;
  } catch (e) {
    console.warn('archive', e);
    toast('Could not archive — the thread stayed in the hub inbox: ' + e.message, 'warning');
    return false;
  }
}

/* Styles for the per-item Archive button, the queue numbering and the group
 * headers. Injected from here so the whole feature lives in one file. */
(function () {
  const st = document.createElement('style');
  st.textContent = '.qi-done{border:1px solid #cfe0d4;background:#fff;color:#2f7d4f;border-radius:4px;'
    + 'font-size:10px;line-height:1;padding:3px 6px;margin-left:6px;cursor:pointer;flex:none;white-space:nowrap}'
    + '.qi-done:hover{background:#2f7d4f;color:#fff;border-color:#2f7d4f}'
    + '.qi-done:disabled{opacity:.45;cursor:default}'
    + '.qi-num{display:inline-block;min-width:20px;text-align:right;color:#9aa5a0;'
    + 'font-variant-numeric:tabular-nums;font-weight:600;flex:none}'
    + '.qi-group{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;'
    + 'color:#6b7a72;background:#f2f5f3;border-radius:4px;padding:4px 8px;margin:10px 0 4px}'
    + '.qi-group:first-child{margin-top:0}'
    + '#btn-archive{margin-left:8px}';
  document.head.appendChild(st);
})();

/* Archive one item out of the hub inbox and mark the queue row done. Nothing is
 * ever deleted — the thread only drops the INBOX label, stays in All Mail and
 * stays fully searchable, and the copy in the originating account is untouched.
 * Backlog rows have no hub thread, so they are just marked done. */
async function markDone(id) {
  const row = queue.find(r => String(r.id) === String(id));
  if (!row) return;
  const btn = document.querySelector('.qi-done[data-done="' + id + '"]');
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  const archived = row.thread_id ? await archiveThread(row.thread_id) : false;
  await updateRow(row.id, { status: 'done' });
  logAction('done', { subject: row.subject || '' }, row);
  if (archived) logAction('archived', { subject: row.subject || '' }, row);
  toast(archived ? 'Archived out of the hub inbox' : 'Cleared from the queue', 'success');
  syncArchiveBtn();
}

/* The Archive button in the Thread panel header mirrors the per-row one, so a
 * reply can be archived right after sending without hunting for the row. */
function syncArchiveBtn() {
  const b = $('btn-archive');
  if (!b) return;
  const DONEST = ['sent','done','dismissed'];
  if (!sel) { b.style.display = 'none'; return; }
  b.style.display = '';
  const already = ['done','dismissed'].includes(sel.status);
  b.disabled = already;
  b.textContent = already ? 'Archived' : 'Archive';
  b.title = sel.thread_id
    ? 'Remove this thread from the hub inbox (it stays in All Mail) and mark it done'
    : 'Backlog item — no hub copy to archive; this just clears it from the queue';
}

async function reallySend() {
  $('m-confirm').disabled = true; $('m-confirm').textContent = 'Sending…';
  try {
    let inReplyTo = '', references = '';
    if (sel && sel.thread_id && threadCache[sel.thread_id]) {
      const last = threadCache[sel.thread_id].slice(-1)[0];
      if (last && last.msgId) { inReplyTo = last.msgId; references = last.msgId; }
    }
    const payload = { raw: buildRaw($('c-from').value, $('c-to').value.trim(), $('c-subj').value, $('c-body').value, inReplyTo, references) };
    if (sel && sel.thread_id) payload.threadId = sel.thread_id;
    await gm('messages/send', { method: 'POST', body: JSON.stringify(payload) });
    $('send-modal').classList.remove('open');
    // Sending never archives. The thread stays in the hub inbox until the user
    // presses Archive, so keeping a thread visible after replying is the default.
    toast('Sent ✓ as ' + $('c-from').value + ' — use Archive when you want it out of the hub', 'success');
    if (sel) {
      await updateRow(sel.id, { status: 'sent', draft_from: $('c-from').value, draft_to: $('c-to').value,
        draft_subject: $('c-subj').value, draft_body: $('c-body').value });
      logAction('sent', { from_alias: $('c-from').value, to_addr: $('c-to').value,
        subject: $('c-subj').value, body_preview: $('c-body').value.slice(0, 300) });
    }
  } catch (e) { toast('Send failed: ' + e.message, 'error'); }
  $('m-confirm').disabled = false; $('m-confirm').textContent = 'Send now';
}

/* ================= WIRE-UP ================= */
document.addEventListener('DOMContentLoaded', () => {
  initGsi();
  loadQueue().catch(e => toast('Queue load failed (run the SQL migration?): ' + e.message, 'error'));
  loadPlaybooks();
  loadVips().then(renderVips);

  $('btn-gmail').addEventListener('click', connectGmail);
  $('btn-sync').addEventListener('click', syncInbox);
  $('btn-draftall').addEventListener('click', draftAllUrgent);
  document.querySelectorAll('#filters .ec-chip[data-f]').forEach(c =>
    c.addEventListener('click', () => { c.classList.toggle('on'); renderQueue(); }));
  $('f-acct').addEventListener('change', renderQueue);
  if ($('f-sort')) $('f-sort').addEventListener('change', renderQueue);
  if ($('btn-archive')) $('btn-archive').addEventListener('click', () => {
    if (sel) markDone(sel.id);
  });
  syncArchiveBtn();

  $('cop-send').addEventListener('click', () => copAsk($('cop-text').value));
  $('cop-text').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) copAsk($('cop-text').value); });
  document.querySelectorAll('.cop-quick button').forEach(b => b.addEventListener('click', () => copAsk(b.dataset.q)));

  $('btn-usedraft').addEventListener('click', () => {
    if (!lastClaudeDraft) { toast('No Claude draft yet — ask for one first', 'warning'); return; }
    $('c-body').value = extractDraftBlock(lastClaudeDraft);
    toast('Draft loaded into composer — edit freely', 'success');
  });
  $('btn-savedraft').addEventListener('click', async () => {
    if (!sel) { toast('Select an email first', 'warning'); return; }
    await updateRow(sel.id, { status: 'drafted', draft_from: $('c-from').value, draft_to: $('c-to').value,
      draft_subject: $('c-subj').value, draft_body: $('c-body').value, draft_source: 'human' });
    logAction('draft_saved', { subject: $('c-subj').value, body_preview: $('c-body').value.slice(0, 300) });
    setDraftStatus('');
    toast('Draft saved', 'success');
  });

  // force a fresh Claude draft for the selected item, overwriting what's there
  $('btn-draftnow').addEventListener('click', async () => {
    if (!sel) { toast('Select an email first', 'warning'); return; }
    if (!localStorage.getItem('tlaps_copilot_code')) {
      toast('Set the copilot access code in Settings first', 'warning');
      $('set-modal').classList.add('open'); return;
    }
    if ($('c-body').value.trim() && !confirm('Replace the current draft with a fresh one from Claude?')) return;
    const row = sel;
    $('btn-draftnow').disabled = true;
    setDraftStatus('Claude is drafting a suggested reply…', 'busy');
    try {
      const ok = await autoDraft(row, threadText(threadCache[row.thread_id]) || row.snippet, true);
      if (sel && sel.id === row.id && ok) {
        $('c-body').value = sel.draft_body || '';
        setDraftStatus('✎ Claude drafted this — review and edit before sending.', 'ok');
      }
    } catch (e) { setDraftStatus('Draft failed: ' + e.message, 'muted'); toast('Draft failed: ' + e.message, 'error'); }
    $('btn-draftnow').disabled = false;
  });

  // per-item opt-out (platform cases etc.)
  $('c-noauto').addEventListener('change', async () => {
    if (!sel) return;
    await updateRow(sel.id, { no_autodraft: $('c-noauto').checked });
    toast($('c-noauto').checked ? 'Auto-draft off for this item' : 'Auto-draft on for this item', 'info');
  });
  $('btn-send').addEventListener('click', openSendModal);
  $('m-confirm').addEventListener('click', reallySend);

  $('btn-settings').addEventListener('click', () => {
    $('set-code').value = localStorage.getItem('tlaps_copilot_code') || '';
    $('set-gcid').value = localStorage.getItem('tlaps_ec_gcid') || '';
    $('set-autodraft').checked = autoDraftEnabled();
    loadVips().then(renderVips);
    $('set-modal').classList.add('open');
  });
  $('vip-add').addEventListener('click', addVip);
  $('vip-value').addEventListener('keydown', e => { if (e.key === 'Enter') addVip(); });
  $('set-save').addEventListener('click', () => {
    localStorage.setItem('tlaps_copilot_code', $('set-code').value.trim());
    localStorage.setItem('tlaps_ec_gcid', $('set-gcid').value.trim());
    localStorage.setItem(AUTODRAFT_KEY, $('set-autodraft').checked ? 'on' : 'off');
    EC.GOOGLE_CLIENT_ID = $('set-gcid').value.trim();
    $('set-modal').classList.remove('open');
    toast('Settings saved', 'success');
    $('setup-note').style.display = 'none';
    initGsi();
  });
});
