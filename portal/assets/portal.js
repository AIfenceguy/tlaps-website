/* TLAPS Operations Portal — shared JS
 *
 * Auth: simple sessionStorage password gate (Phase 1).
 * Edits: persisted to localStorage as overrides on top of sku_mapping.json.
 */

const PORTAL_PASSWORD = 'tlaps2026';
const AUTH_KEY        = 'tlaps_auth';
const EMAIL_KEY       = 'tlaps_user_email';
const OVERRIDES_KEY   = 'tlaps_overrides';
const POS_KEY         = 'tlaps_pos';

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard',       icon: 'D', href: 'dashboard.html' },
  { id: 'products',  label: 'Products',         icon: 'P', href: 'products.html'  },
  { id: 'labels',    label: 'Labels',           icon: 'L', href: 'labels.html'    },
  { id: 'orders',    label: 'Orders',           icon: 'O', href: 'orders.html'    },
  { id: 'costs',     label: 'Costs',            icon: '$', href: 'costs.html'     },
  { id: 'media',     label: 'Media',            icon: 'M', href: 'media.html'     },
  { id: 'keywords',  label: 'Keywords',         icon: 'K', href: 'keywords.html'  }
];

/* ============ AUTH ============ */

function isAuthenticated() {
  return sessionStorage.getItem(AUTH_KEY) === 'true';
}
function login(email, password) {
  if (password === PORTAL_PASSWORD) {
    sessionStorage.setItem(AUTH_KEY, 'true');
    sessionStorage.setItem(EMAIL_KEY, email || '');
    return true;
  }
  return false;
}
function logout() {
  sessionStorage.removeItem(AUTH_KEY);
  sessionStorage.removeItem(EMAIL_KEY);
  window.location.href = 'index.html';
}
function requireAuth() {
  if (!isAuthenticated()) window.location.href = 'index.html';
}

/* ============ SIDEBAR ============ */

function renderSidebar(activeId) {
  const sidebar = document.querySelector('.sidebar');
  if (!sidebar) return;

  const userEmail = sessionStorage.getItem(EMAIL_KEY) || '';

  const itemsHtml = NAV_ITEMS.map(item => {
    const cls = [];
    if (item.id === activeId) cls.push('active');
    if (item.disabled) cls.push('disabled');
    const onClick = item.disabled
      ? `onclick="event.preventDefault();toast('${item.label} module coming soon','warning');return false"`
      : '';
    const soon = item.disabled
      ? '<span class="coming-soon-badge">Soon</span>'
      : '';
    return `
      <li class="${cls.join(' ')}">
        <a href="${item.href}" ${onClick}>
          <span class="icon">${item.icon}</span>
          <span>${item.label}</span>
          ${soon}
        </a>
      </li>
    `;
  }).join('');

  sidebar.innerHTML = `
    <div class="sidebar-brand">
      <img src="../images/tlaps_logo.png" alt="TLAPS">
      <div>
        <div class="name">TLAPS</div>
        <div class="sub">Operations</div>
      </div>
    </div>
    <ul class="sidebar-nav">${itemsHtml}</ul>
    <div class="sidebar-footer">
      <div class="user-email">${userEmail || 'Signed in'}</div>
      <button class="btn-logout" onclick="logout()">Sign out</button>
    </div>
  `;
}

/* ============ TOAST ============ */

function toast(msg, type) {
  type = type || 'info';
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity 0.3s, transform 0.3s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(20px)';
    setTimeout(() => el.remove(), 320);
  }, 3500);
}

/* ============ FILE UPLOAD ============ */

function setupDragDrop(zoneEl, fileInputEl, onFile) {
  zoneEl.addEventListener('click', () => fileInputEl.click());
  fileInputEl.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) onFile(e.target.files[0]);
  });
  zoneEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    zoneEl.classList.add('dragover');
  });
  zoneEl.addEventListener('dragleave', () => zoneEl.classList.remove('dragover'));
  zoneEl.addEventListener('drop', (e) => {
    e.preventDefault();
    zoneEl.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]);
  });
}
function markZoneFilled(zoneEl, file) {
  zoneEl.classList.add('has-file');
  const labelEl = zoneEl.querySelector('.uz-label');
  const hintEl = zoneEl.querySelector('.uz-hint');
  if (labelEl) labelEl.textContent = file.name;
  if (hintEl) hintEl.textContent = formatBytes(file.size);
}
function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

/* ============ SKU MAPPING + OVERRIDES ============ */

let _skuMappingCache = null;
async function loadSkuMapping(applyOverridesFlag) {
  if (_skuMappingCache) return applyOverridesFlag ? applyOverridesAll(_skuMappingCache) : _skuMappingCache;
  const res = await fetch('../references/sku_mapping.json');
  if (!res.ok) throw new Error('SKU mapping not found (HTTP ' + res.status + ')');
  _skuMappingCache = await res.json();
  return applyOverridesFlag ? applyOverridesAll(_skuMappingCache) : _skuMappingCache;
}
function isTlapsSku(sku) {
  return typeof sku === 'string' && sku.trim().toUpperCase().startsWith('TLAPS-');
}
function lookupDhgSku(i3Sku, mapping) {
  if (!i3Sku || !mapping) return null;
  const target = i3Sku.trim().toUpperCase();
  const item = mapping.products.find(p => p.i3_sku.toUpperCase() === target);
  return item ? item.dhg_sku : null;
}
function lookupProduct(i3Sku, mapping) {
  if (!i3Sku || !mapping) return null;
  const target = i3Sku.trim().toUpperCase();
  return mapping.products.find(p => p.i3_sku.toUpperCase() === target) || null;
}
function getProductByAsin(asin, mapping) {
  if (!asin || !mapping) return null;
  return mapping.products.find(p => p.asin === asin) || null;
}

function getAllOverrides() {
  try { return JSON.parse(localStorage.getItem(OVERRIDES_KEY) || '{}'); }
  catch (e) { return {}; }
}
function getOverrides(asin) {
  return getAllOverrides()[asin] || {};
}
function saveOverride(asin, path, value) {
  const all = getAllOverrides();
  if (!all[asin]) all[asin] = {};
  all[asin][path] = value;
  localStorage.setItem(OVERRIDES_KEY, JSON.stringify(all));
}
function saveOverrides(asin, partial) {
  const all = getAllOverrides();
  if (!all[asin]) all[asin] = {};
  Object.assign(all[asin], partial);
  localStorage.setItem(OVERRIDES_KEY, JSON.stringify(all));
}
function clearProductOverrides(asin) {
  const all = getAllOverrides();
  delete all[asin];
  localStorage.setItem(OVERRIDES_KEY, JSON.stringify(all));
}
function applyOverrides(product) {
  const o = getOverrides(product.asin);
  if (!Object.keys(o).length) return product;
  const merged = JSON.parse(JSON.stringify(product));
  Object.keys(o).forEach(path => setNested(merged, path, o[path]));
  return merged;
}
function applyOverridesAll(mapping) {
  const out = JSON.parse(JSON.stringify(mapping));
  out.products = out.products.map(applyOverrides);
  return out;
}
function setNested(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}
function getNested(obj, path) {
  return path.split('.').reduce((o, k) => (o ? o[k] : undefined), obj);
}

/* ============ COST CALC ============ */

function computeCosts(product) {
  const map = parseFloat(product.map_price) || 0;
  const coopRate = product.coop_rate != null ? parseFloat(product.coop_rate) : 0.22;
  const dhg = parseFloat(product.dhg_cost) || 0;
  const asp = parseFloat(product.amazon_selling_price) || 0;
  const colE = map * 0.78;
  const coopFee = colE * coopRate;
  const net = colE - coopFee;
  const profit = net - dhg;
  const marginPct = net > 0 ? (profit / net) * 100 : 0;
  const hasCost = dhg > 0;
  return {
    map, asp, colE, coopFee, net, dhg, profit, marginPct, coopRate, hasCost,
    fmt: {
      map:       money(map),
      asp:       asp ? money(asp) : '—',
      colE:      money(colE),
      coopFee:   money(coopFee),
      net:       money(net),
      dhg:       hasCost ? money(dhg) : '—',
      profit:    hasCost ? (profit >= 0 ? '' : '-') + money(Math.abs(profit)) : '—',
      marginPct: hasCost ? marginPct.toFixed(1) + '%' : '—'
    }
  };
}
function money(n) {
  if (n == null || isNaN(n)) return '—';
  return '$' + Number(n).toFixed(2);
}

/* ============ STATUS BADGES ============ */

function badge(text, kind) {
  const map = {
    pending: 'badge-pending',
    processing: 'badge-processing',
    done: 'badge-done',
    error: 'badge-error',
    tlaps: 'badge-tlaps',
    neutral: 'badge-non-tlaps'
  };
  return `<span class="badge ${map[kind] || 'badge-non-tlaps'}">${text}</span>`;
}
function videoBadge(status) {
  const m = {
    'uploaded':                    ['Uploaded',     'done'],
    'pending_upload':              ['Pending',      'pending'],
    'regenerated_pending_upload':  ['Re-gen Pend.', 'pending'],
    'needs_redo':                  ['Needs Redo',   'error'],
    'not_uploaded':                ['Not Up.',      'error'],
    'not_started':                 ['—',            'neutral'],
    '':                            ['—',            'neutral']
  };
  const [text, kind] = m[status] || ['Unknown', 'neutral'];
  return badge(text, kind);
}
function aplusBadge(status) {
  const m = {
    'live':         ['Live',         'done'],
    'submitted':    ['Submitted',    'processing'],
    'in_progress': ['In Progress',  'pending'],
    'not_started':  ['Not Started',  'neutral'],
    'blocked':      ['Blocked',      'error'],
    'not_eligible': ['Not Eligible', 'error'],
    '':             ['—',            'neutral']
  };
  const [text, kind] = m[status] || ['—', 'neutral'];
  return badge(text, kind);
}

/* ============ TABS ============ */

function initTabs(rootSel) {
  const root = typeof rootSel === 'string' ? document.querySelector(rootSel) : rootSel;
  if (!root) return;
  const buttons = root.querySelectorAll('[data-tab]');
  const panels = root.querySelectorAll('[data-tab-panel]');
  function activate(id) {
    buttons.forEach(b => b.classList.toggle('active', b.dataset.tab === id));
    panels.forEach(p => p.style.display = (p.dataset.tabPanel === id ? '' : 'none'));
  }
  buttons.forEach(b => b.addEventListener('click', () => activate(b.dataset.tab)));
  if (buttons[0]) activate(buttons[0].dataset.tab);
}

/* ============ EXCEL HELPERS (used by orders.html, labels.html) ============ */

// Parses an Amazon Stocking PO sheet into normalised rows.
//   po_code   = col[2]   (Excel C)
//   ship_to   = col[4]   (Excel E)
//   item_name = col[16]  (Excel Q)
//   quantity  = col[17]  (Excel R)
function parseStockingPOExcel(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = (e) => {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        const items = [];
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i] || [];
          const poRaw = row[2];
          if (!poRaw) continue;
          const po = String(poRaw).trim();
          if (!/^[A-Z0-9]{6,16}$/i.test(po)) continue;
          const itemName = String(row[16] || '').trim();
          const qty = parseInt(row[17], 10);
          if (!itemName || !qty || qty <= 0) continue;
          items.push({
            po_code: po.toUpperCase(),
            ship_to: String(row[4] || '').trim(),
            item_name: itemName,
            quantity: qty,
            row: i
          });
        }
        resolve(items);
      } catch (err) { reject(err); }
    };
    r.onerror = () => reject(new Error('Could not read Excel'));
    r.readAsArrayBuffer(file);
  });
}

/* ============ DOM HELPERS ============ */

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(
      () => toast('Copied to clipboard', 'success'),
      () => toast('Copy failed', 'error')
    );
  } else {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('Copied to clipboard', 'success'); }
    catch (e) { toast('Copy failed', 'error'); }
    ta.remove();
  }
}
