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
  SYNC_WINDOW: 'newer_than:30d',
  PER_LABEL: 30
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
let copHistory = [];       // {role, content}
let lastClaudeDraft = '';

const $ = id => document.getElementById(id);

/* ================= CLASSIFIER ================= */
const RX_URGENT = /(chargeback|charge-back|fraud|unauthorized|suspend|suspension|deactivat|funds (are )?on hold|past due|overdue|final notice|collections|immediate action|account.*(danger|risk)|security alert|verify your identity|violation notice|unauthorized seller)/i;
const RX_ACTION = /(action required|please (reply|respond|confirm|review)|invoice|payment request|refund|return|dispute|case #|request \d|deadline|respond by|confirm shipment|needs attention|item not received|cancel.*order|credit application|purchase order|po ?#|statement|quote|quotation)/i;
const RX_NOISE  = /(newsletter|unsubscribe|webinar|sale ends|% off|deal|promotion|digest|we found something|recommendations for you|now available on asap|new product spotlight)/i;
const NOISE_SENDERS = /(store-news@amazon|deals\.|selections\.|@e\.godaddy|stickermule|kalshi|snacks\.robinhood|patreon|skool\.com|hiltongrandvacations|emeritus|summithouse|marketing|noreply@ads\.)/i;
const RX_MONEY  = /(refund|chargeback|return|dispute|payment|invoice|past due|payout|credit|reimburs|funds)/i;

function classify(from, subject, snippet) {
  const s = (subject||'') + ' ' + (snippet||'');
  if (NOISE_SENDERS.test(from||'') || RX_NOISE.test(s)) return null;      // skip noise entirely
  if (RX_URGENT.test(s)) return 'URGENT';
  if (RX_ACTION.test(s)) return 'ACTION';
  return null;                                                            // FYI -> not queued (actionable-only v1)
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
        const cat = classify(h.from, h.subject, md.snippet);
        if (!cat) continue;
        const row = {
          thread_id: m.threadId, source: 'hub', account: label, category: cat,
          subject: h.subject || '(no subject)', sender: h.from || '',
          snippet: (md.snippet || '').slice(0, 300),
          gmail_link: 'https://mail.google.com/mail/u/0/#all/' + m.threadId,
          money_flag: RX_MONEY.test((h.subject||'') + ' ' + (md.snippet||'')),
          status: 'new', last_activity: h.date ? new Date(h.date).toISOString() : new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        try { await sbUpsert('email_queue', row, 'thread_id'); added++; } catch (e) { console.warn('upsert', e); }
      }
    }
    await loadQueue();
    toast(`Sync done — ${added} new actionable item(s)`, added ? 'success' : 'info');
  } catch (e) { toast('Sync failed: ' + e.message, 'error'); }
  $('btn-sync').disabled = false; $('btn-sync').textContent = 'Sync inbox';
}

/* ================= QUEUE (Supabase) ================= */
async function loadQueue() {
  queue = await sbGet('email_queue?select=*&order=category.asc,last_activity.desc.nullslast&limit=400');
  renderQueue();
}

function activeFilters() {
  const chips = [...document.querySelectorAll('#filters .ec-chip.on')];
  return {
    cats: chips.filter(c => c.dataset.f === 'cat').map(c => c.dataset.v),
    sts:  chips.filter(c => c.dataset.f === 'st').map(c => c.dataset.v),
    acct: $('f-acct').value
  };
}

function renderQueue() {
  const f = activeFilters();
  const OPEN = ['new','in_progress','drafted'], DONE = ['sent','done','dismissed'];
  const rows = queue.filter(r => {
    if (f.cats.length && !f.cats.includes(r.category)) return false;
    const isOpen = OPEN.includes(r.status);
    if (!((f.sts.includes('open') && isOpen) || (f.sts.includes('done') && !isOpen))) return false;
    if (f.acct && r.account !== f.acct) return false;
    return true;
  });
  $('q-count').textContent = rows.length + ' item(s)';
  if (!rows.length) { $('queue').innerHTML = '<div class="ec-empty">Nothing here — sync, or loosen the filters.</div>'; return; }
  $('queue').innerHTML = rows.map(r => `
    <div class="qi ${sel && sel.id === r.id ? 'sel' : ''}" data-id="${r.id}">
      <div class="top">
        <span class="cat ${r.category}">${r.category}</span>
        <span class="acct-tag">${escapeHtml((r.account||'').replace('acct/',''))}</span>
        ${r.money_flag ? '<span class="money">💰</span>' : ''}
        <span class="st ${r.status}">${r.status}</span>
        <span style="margin-left:auto">${r.last_activity ? new Date(r.last_activity).toLocaleDateString('en-US',{month:'short',day:'numeric'}) : ''}</span>
      </div>
      <div class="subj">${escapeHtml(r.subject || '')}</div>
      <div class="snip">${escapeHtml((r.sender||'').replace(/<.*>/,''))} — ${escapeHtml(r.snippet || '')}</div>
    </div>`).join('');
  document.querySelectorAll('.qi').forEach(el => el.addEventListener('click', () => openItem(el.dataset.id)));
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

async function openItem(id) {
  sel = queue.find(r => String(r.id) === String(id));
  if (!sel) return;
  renderQueue();
  copHistory = []; lastClaudeDraft = '';
  $('cop-log').innerHTML = '<div class="ec-empty" style="padding:20px">Context loaded — ask away.</div>';
  $('money-banner').style.display = sel.money_flag ? '' : 'none';
  $('t-meta').innerHTML = `<a href="${sel.gmail_link}" target="_blank" style="color:var(--green)">open in Gmail ↗</a>`;

  // deadline sniffing
  const dl = ((sel.subject||'') + ' ' + (sel.snippet||'')).match(/(respond|reply|confirm|ship|by)\s+(by\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}/i);

  // composer prefill
  const senderEmail = ((sel.sender || '').match(/<([^>]+)>/) || [null, sel.sender])[1] || '';
  $('c-to').value = senderEmail;
  $('c-subj').value = /^re:/i.test(sel.subject || '') ? sel.subject : 'Re: ' + (sel.subject || '');
  $('c-body').value = sel.draft_body || '';
  // best-guess From: match account alias
  const acctEmailMap = {
    'acct/rickytsuiusa':'rickytsuiusa@gmail.com', 'acct/envisioninginc':'envisioninginc@gmail.com',
    'acct/trucksadventures':'trucksadventures@gmail.com', 'acct/amazonkwan':'amazon.kwan@gmail.com',
    'acct/yeezyforever':'yeezyforever1112@gmail.com'
  };
  const want = acctEmailMap[sel.account];
  if (want && [...$('c-from').options].some(o => o.value === want)) $('c-from').value = want;
  $('btn-send').disabled = false;

  // thread body
  if (!sel.thread_id) {
    $('thread').innerHTML = (dl?`<div class="deadline-banner">⏰ Possible deadline: “${escapeHtml(dl[0])}” — verify in the email.</div>`:'') +
      `<div class="ec-empty">Backlog item (lives outside the hub).<br><a target="_blank" href="${sel.gmail_link}" class="btn btn-secondary" style="margin-top:10px;display:inline-block">Open source account ↗</a></div>`;
    return;
  }
  $('thread').innerHTML = '<div class="ec-empty">Loading thread…</div>';
  try {
    let msgs = threadCache[sel.thread_id];
    if (!msgs) {
      const t = await gm('threads/' + sel.thread_id + '?format=full');
      msgs = (t.messages || []).map(m => {
        const h = {}; (m.payload.headers || []).forEach(x => h[x.name.toLowerCase()] = x.value);
        return { from: h.from||'', to: h.to||'', date: h.date||'', subject: h.subject||'',
                 msgId: h['message-id']||'', body: extractBody(m.payload) || m.snippet || '' };
      });
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
    if (sel.status === 'new') updateRow(sel.id, { status: 'in_progress' });
  } catch (e) {
    $('thread').innerHTML = `<div class="ec-empty">Could not load thread: ${escapeHtml(e.message)}<br><a target="_blank" href="${sel.gmail_link}">Open in Gmail ↗</a></div>`;
  }
}

async function updateRow(id, patch) {
  patch.updated_at = new Date().toISOString();
  const res = await fetch(SUPABASE_URL + '/rest/v1/email_queue?id=eq.' + id, {
    method: 'PATCH', headers: sbHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=representation' }),
    body: JSON.stringify(patch)
  });
  if (res.ok) { const [row] = await res.json(); const i = queue.findIndex(r => r.id === id);
    if (i >= 0) queue[i] = row; if (sel && sel.id === id) sel = row; renderQueue(); }
}
async function logAction(action, extra) {
  try {
    await fetch(SUPABASE_URL + '/rest/v1/email_actions', {
      method: 'POST', headers: sbHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(Object.assign({
        queue_id: sel ? sel.id : null, thread_id: sel ? sel.thread_id : null,
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
    toast('Sent ✓ as ' + $('c-from').value, 'success');
    $('send-modal').classList.remove('open');
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

  $('btn-gmail').addEventListener('click', connectGmail);
  $('btn-sync').addEventListener('click', syncInbox);
  document.querySelectorAll('#filters .ec-chip[data-f]').forEach(c =>
    c.addEventListener('click', () => { c.classList.toggle('on'); renderQueue(); }));
  $('f-acct').addEventListener('change', renderQueue);

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
      draft_subject: $('c-subj').value, draft_body: $('c-body').value });
    logAction('draft_saved', { subject: $('c-subj').value, body_preview: $('c-body').value.slice(0, 300) });
    toast('Draft saved', 'success');
  });
  $('btn-send').addEventListener('click', openSendModal);
  $('m-confirm').addEventListener('click', reallySend);

  $('btn-settings').addEventListener('click', () => {
    $('set-code').value = localStorage.getItem('tlaps_copilot_code') || '';
    $('set-gcid').value = localStorage.getItem('tlaps_ec_gcid') || '';
    $('set-modal').classList.add('open');
  });
  $('set-save').addEventListener('click', () => {
    localStorage.setItem('tlaps_copilot_code', $('set-code').value.trim());
    localStorage.setItem('tlaps_ec_gcid', $('set-gcid').value.trim());
    EC.GOOGLE_CLIENT_ID = $('set-gcid').value.trim();
    $('set-modal').classList.remove('open');
    toast('Settings saved', 'success');
    $('setup-note').style.display = 'none';
    initGsi();
  });
});
