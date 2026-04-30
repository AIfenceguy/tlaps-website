/* TLAPS Operations Portal — shared JS
 *
 * Auth: simple sessionStorage password gate (Phase 1).
 * Will be replaced with Supabase Auth in Phase 2.
 */

const PORTAL_PASSWORD = 'tlaps2026';
const AUTH_KEY = 'tlaps_auth';
const EMAIL_KEY = 'tlaps_user_email';

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard',       icon: 'D', href: 'dashboard.html', disabled: false },
  { id: 'products',  label: 'Products',         icon: 'P', href: 'products.html',  disabled: false },
  { id: 'labels',    label: 'Label Processor',  icon: 'L', href: 'labels.html',    disabled: false },
  { id: 'orders',    label: 'Orders',           icon: 'O', href: '#',              disabled: true  }
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
  if (!isAuthenticated()) {
    window.location.href = 'index.html';
  }
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
  zoneEl.addEventListener('dragleave', () => {
    zoneEl.classList.remove('dragover');
  });
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

/* ============ SKU MAPPING ============ */

let _skuMappingCache = null;
async function loadSkuMapping() {
  if (_skuMappingCache) return _skuMappingCache;
  const res = await fetch('../references/sku_mapping.json');
  if (!res.ok) throw new Error('SKU mapping not found (HTTP ' + res.status + ')');
  _skuMappingCache = await res.json();
  return _skuMappingCache;
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
