/* ============================================================================
   GESTION DES DOSSIERS RH — FRONTEND (script.js)
   Communique EXCLUSIVEMENT avec le backend Google Apps Script (Code.gs)
   via des appels fetch() au format JSON. Aucun accès direct à Google Sheets.
   ============================================================================ */

// ============================================================================
// 1. CONFIGURATION
// ============================================================================

// URL de déploiement du Web App Apps Script (voir README.md pour l'obtenir)
const API_URL = 'https://script.google.com/macros/s/AKfycbyIMkA3ab9vH7PBDJOymEkcP4feV2lgchnB7PaOKazJotCCX3MgbMI4jR99zPqQN_lO/exec';

// Libellés et icônes de statut, utilisés partout dans l'UI
const STATUS_META = {
  complete:  { label: 'Complet',        color: 'complete', icon: 'fa-circle-check' },
  numeric:   { label: 'Manquant(s)',    color: 'numeric',  icon: 'fa-triangle-exclamation' },
  incorrect: { label: 'Non conforme',   color: 'incorrect',icon: 'fa-circle-xmark' },
  missing:   { label: 'Non fourni',     color: 'missing',  icon: 'fa-circle-xmark' },
  na:        { label: 'N/A',            color: 'na',       icon: 'fa-circle-minus' }
};

// État applicatif en mémoire
const state = {
  employees: [],       // liste résumée (vue recherche)
  filteredEmployees: [],
  currentEmployee: null, // fiche détaillée actuellement ouverte dans la modale
  pendingDocumentUpdates: {}
};

// ---------- AUTHENTIFICATION CLIENT (pré-définie + persistance) ----------
const PREDEFINED_CREDENTIALS = { username: 'gestiondossier', password: 'rhconnecteomdp' };
const AUTH_KEY = 'ri_auth'; // valeur '1' si connecté
const VIEW_KEY = 'ri_view'; // conserve la vue courante entre rafraîchissements
const SEARCH_STATE_KEY = 'ri_search_state'; // conserve la recherche et les filtres
let loginOverlayTimer = null;

function isAuthenticated() {
  return localStorage.getItem(AUTH_KEY) === '1';
}
function setAuthenticated(username) {
  if (loginOverlayTimer) {
    clearTimeout(loginOverlayTimer);
    loginOverlayTimer = null;
  }
  localStorage.setItem(AUTH_KEY, '1');
  localStorage.setItem('ri_user', username || '');
  updateAuthUI();
}
function clearAuth() {
  if (loginOverlayTimer) {
    clearTimeout(loginOverlayTimer);
    loginOverlayTimer = null;
  }
  localStorage.removeItem(AUTH_KEY);
  localStorage.removeItem('ri_user');
  updateAuthUI();
}
function updateAuthUI() {
  const overlay = document.getElementById('login-overlay');
  const logoutBtn = document.getElementById('logout-btn');
  const authenticated = isAuthenticated();

  if (overlay) {
    overlay.classList.toggle('hidden', authenticated);
    overlay.setAttribute('aria-hidden', authenticated ? 'true' : 'false');
    if (authenticated) {
      overlay.setAttribute('inert', '');
    } else {
      overlay.removeAttribute('inert');
    }
  }

  if (logoutBtn) {
    logoutBtn.classList.toggle('hidden', !authenticated);
  }
}

function showLoginOverlay() {
  const overlay = document.getElementById('login-overlay');
  if (overlay) {
    if (loginOverlayTimer) {
      clearTimeout(loginOverlayTimer);
      loginOverlayTimer = null;
    }
    overlay.classList.remove('hidden');
    overlay.setAttribute('aria-hidden', 'false');
    overlay.removeAttribute('inert');
    loginOverlayTimer = setTimeout(() => {
      const usernameInput = document.getElementById('login-username');
      if (usernameInput) usernameInput.focus();
      loginOverlayTimer = null;
    }, 50);
  }
}

function handleLogin() {
  const u = ((document.getElementById('login-username') || {}).value || '').trim();
  const p = ((document.getElementById('login-password') || {}).value || '').trim();
  if (u === PREDEFINED_CREDENTIALS.username && p === PREDEFINED_CREDENTIALS.password) {
    setAuthenticated(u);
    showToast('Connecté', 'success');
    const view = localStorage.getItem(VIEW_KEY) || 'dashboard-view';
    showView(view);
    setTimeout(() => {
      updateAuthUI();
      const activeView = document.querySelector('.view.active');
      if (activeView) activeView.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 0);
  } else {
    showToast('Identifiants incorrects', 'error');
  }
}

function handleLogout() {
  clearAuth();
  showToast('Déconnecté', 'info');
  showLoginOverlay();
}

function showView(viewId) {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === viewId));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === viewId));
  if (viewId === 'dashboard-view') loadDashboard();
  if (viewId === 'search-view' && state.employees.length === 0) loadEmployees();
  localStorage.setItem(VIEW_KEY, viewId);
}

// ============================================================================
// 2. COUCHE API (fetch)
// ============================================================================

/**
 * Effectue un appel GET vers l'API Apps Script.
 * @param {string} action - nom de l'action (paramètre ?action=...)
 * @param {Object} params - paramètres additionnels de la query string
 */
async function apiGet(action, params = {}) {
  const query = new URLSearchParams({ action, ...params }).toString();
  const response = await fetch(`${API_URL}?${query}`, { method: 'GET' });
  const json = await response.json();
  if (!json.success) throw new Error(json.error || 'Erreur API inconnue.');
  return json.data;
}

/**
 * Effectue un appel POST vers l'API Apps Script.
 * Le corps est envoyé en "text/plain" afin d'éviter le preflight CORS
 * (Apps Script ne gère pas les requêtes OPTIONS pour les Web Apps).
 * @param {string} action - nom de l'action
 * @param {Object} payload - données envoyées dans le corps
 */
async function apiPost(action, payload = {}) {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, ...payload })
  });
  const json = await response.json();
  if (!json.success) throw new Error(json.error || 'Erreur API inconnue.');
  return json.data;
}

// ============================================================================
// 3. UTILITAIRES UI : LOADER / TOAST
// ============================================================================

function showLoader() {
  const loader = document.getElementById('loader');
  if (loader) loader.classList.remove('hidden');
}
function hideLoader() {
  const loader = document.getElementById('loader');
  if (loader) loader.classList.add('hidden');
}

function setButtonLoading(buttonId, isLoading, label = 'Enregistrement...') {
  const button = document.getElementById(buttonId);
  if (!button) return;

  if (isLoading) {
    if (!button.dataset.originalHtml) {
      button.dataset.originalHtml = button.innerHTML;
    }
    button.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${label}`;
    button.disabled = true;
    return;
  }

  if (button.dataset.originalHtml) {
    button.innerHTML = button.dataset.originalHtml;
    delete button.dataset.originalHtml;
  }
  button.disabled = false;
}

function setModalBusy(isBusy) {
  const modal = document.getElementById('employee-modal');
  if (!modal) return;

  modal.classList.toggle('is-busy', isBusy);
  modal.querySelectorAll('button, input, textarea, select').forEach(control => {
    if (isBusy) {
      if (control.dataset.busyPrevDisabled === undefined) {
        control.dataset.busyPrevDisabled = control.disabled ? '1' : '0';
      }
      control.disabled = true;
      return;
    }

    if (control.dataset.busyPrevDisabled !== undefined) {
      control.disabled = control.dataset.busyPrevDisabled === '1';
      delete control.dataset.busyPrevDisabled;
    }
  });
}

/**
 * Affiche une notification toast temporaire.
 * @param {string} message
 * @param {'success'|'error'|'info'} type
 */
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const icons = { success: 'fa-circle-check', error: 'fa-circle-exclamation', info: 'fa-circle-info' };

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<i class="fa-solid ${icons[type] || icons.info}"></i><span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 250);
  }, 3200);
}

/** Échappe le HTML pour éviter toute injection lors de l'affichage de données. */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================================
// 4. NAVIGATION ENTRE VUES
// ============================================================================

function initNavigation() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      showView(view);
    });
  });
}

// ============================================================================
// 5. TABLEAU DE BORD
// ============================================================================

let completenessChart = null;
let missingDocsChart = null;
let polesChart = null;
let dashboardRefreshTimer = null;
let employeesRefreshTimer = null;
let lastDashboardLoad = 0;
let lastEmployeesLoad = 0;

async function loadDashboard() {
  lastDashboardLoad = Date.now();
  try {
    const data = await apiGet('getDashboard');
    renderStatsCards(data);
    renderPoleCards(data);
    renderPoleChart(data);
    renderMissingDocsChart(data);
  } catch (err) {
    showToast(err.message, 'error');
  } finally {}
}

function renderStatsCards(data) {
  const grid = document.getElementById('stats-grid');
  const cards = [
    { icon: 'fa-users', label: 'Collaborateurs', value: data.totalEmployees, cls: '' },
    { icon: 'fa-percent', label: 'Taux global de complétude', value: data.completionPercentage + ' %', cls: 'warning' },
    { icon: 'fa-scanner', label: 'Scans 1 réalisés', value: data.scansDone, cls: 'accent' },
    { icon: 'fa-barcode', label: 'Scans 2 réalisés', value: data.scans2Done, cls: 'accent' },
    { icon: 'fa-boxes-stacked', label: 'Inventaires réalisés', value: data.inventoriesDone, cls: 'success' }
  ];

  grid.innerHTML = cards.map(c => `
    <div class="stat-card ${c.cls}">
      <div class="stat-card__icon"><i class="fa-solid ${c.icon}"></i></div>
      <div>
        <div class="stat-card__value">${escapeHtml(c.value)}</div>
        <div class="stat-card__label">${escapeHtml(c.label)}</div>
      </div>
    </div>
  `).join('');
}

function renderPoleCards(data) {
  const grid = document.getElementById('poles-grid');
  const poles = data.poles || [];

  if (!grid) return;
  if (!poles.length) {
    grid.innerHTML = '<div class="pole-empty">Aucune donnée de pôle disponible.</div>';
    return;
  }

  grid.innerHTML = poles.map(pole => `
    <div class="pole-card">
      <div class="pole-card__head">
        <div>
          <div class="pole-card__title">${escapeHtml(pole.pole)}</div>
          <div class="pole-card__sub">${escapeHtml(pole.totalEmployees)} collaborateur(s)</div>
        </div>
      </div>
      <div class="pole-metrics">
        <div class="pole-metric"><span>Complétude</span><strong>${escapeHtml(pole.completionRate)}%</strong></div>
        <div class="pole-metric"><span>Scan 1</span><strong>${escapeHtml(pole.scan1Rate)}%</strong></div>
        <div class="pole-metric"><span>Scan 2</span><strong>${escapeHtml(pole.scan2Rate)}%</strong></div>
      </div>
    </div>
  `).join('');
}

function renderPoleChart(data) {
  const canvas = document.getElementById('chart-poles');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (polesChart) polesChart.destroy();

  const poles = data.poles || [];
  polesChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: poles.map(p => p.pole),
      datasets: [
        { label: 'Complétude', data: poles.map(p => p.completionRate), backgroundColor: '#0D9488', borderRadius: 8 },
        { label: 'Scan 1', data: poles.map(p => p.scan1Rate), backgroundColor: '#0EA5E9', borderRadius: 8 },
        { label: 'Scan 2', data: poles.map(p => p.scan2Rate), backgroundColor: '#16A34A', borderRadius: 8 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: { beginAtZero: true, max: 100, ticks: { callback: v => v + '%' } },
        x: { ticks: { maxRotation: 0, minRotation: 0 } }
      },
      plugins: { legend: { position: 'bottom' } }
    }
  });
}

function renderMissingDocsChart(data) {
  const ctx = document.getElementById('chart-missing-docs').getContext('2d');
  if (missingDocsChart) missingDocsChart.destroy();

  const top = (data.missingDocsFrequency || []).slice(0, 8);

  missingDocsChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: top.map(d => d.label),
      datasets: [{
        label: 'Occurrences',
        data: top.map(d => d.count),
        backgroundColor: '#EA580C',
        borderRadius: 6
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { x: { beginAtZero: true, ticks: { precision: 0 } } }
    }
  });
}

// ============================================================================
// 6. LISTE / RECHERCHE COLLABORATEURS
// ============================================================================

async function loadEmployees() {
  lastEmployeesLoad = Date.now();
  try {
    state.employees = await apiGet('getEmployees');
    state.filteredEmployees = state.employees;
    populateFilterOptions(state.employees);
    initFilters();
    restoreSearchState();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {}
}

function renderEmployeesTable(list) {
  const tbody = document.getElementById('employees-table-body');
  const noResults = document.getElementById('no-results');

  if (!list.length) {
    tbody.innerHTML = '';
    noResults.classList.remove('hidden');
    return;
  }
  noResults.classList.add('hidden');

  tbody.innerHTML = list.map(emp => {
    const completenessValue = String(emp.completude || '').toUpperCase();
    const isComplete = completenessValue === 'COMPLET';
    const completBadge = isComplete
      ? `<span class="badge complete"><span class="badge-dot"></span>Complet</span>`
      : completenessValue === 'INCOMPLET'
      ? `<span class="badge incorrect"><span class="badge-dot"></span>Incomplet</span>`
      : `<span class="badge warning"><span class="badge-dot"></span>${escapeHtml(completenessValue || 'À vérifier')}</span>`;

    const scanBadge = emp.scan
      ? `<span class="badge complete"><span class="badge-dot"></span>Scanné</span>`
      : `<span class="badge missing"><span class="badge-dot"></span>Non scanné</span>`;

    const inventoryBadge = String(emp.inventaire).toUpperCase() === 'OK'
      ? `<span class="badge complete"><span class="badge-dot"></span>OK</span>`
      : `<span class="badge na"><span class="badge-dot"></span>—</span>`;

    // couleur unique basée sur le nom du rattachement
    const color = colorFromString(emp.rattachement || '');
    const contrast = getContrastYIQ(color) === 'dark' ? 'light' : 'dark';

    return `
      <tr data-matricule="${escapeHtml(emp.matricule)}">
        <td>${escapeHtml(emp.matricule)}</td>
        <td>${escapeHtml(emp.nomPrenoms)}</td>
        <td>${escapeHtml(emp.fonction)}</td>
        <td><span class="rattachement-badge" style="--badge-color: ${color};" data-contrast="${contrast}">${escapeHtml(emp.rattachement)}</span></td>
        <td>${scanBadge}</td>
        <td>${inventoryBadge}</td>
        <td>${completBadge}</td>
        <td><i class="fa-solid fa-chevron-right"></i></td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('tr').forEach(row => {
    row.addEventListener('click', () => openEmployeeModal(row.dataset.matricule));
  });
}

function saveSearchState() {
  const payload = {
    term: (document.getElementById('search-input') || {}).value || '',
    fonction: (document.getElementById('filter-fonction') || {}).value || '',
    rattachement: (document.getElementById('filter-rattachement') || {}).value || '',
    inventaire: (document.getElementById('filter-inventaire') || {}).value || '',
    scan: (document.getElementById('filter-scan') || {}).value || ''
  };
  localStorage.setItem(SEARCH_STATE_KEY, JSON.stringify(payload));
}

function restoreSearchState() {
  try {
    const saved = JSON.parse(localStorage.getItem(SEARCH_STATE_KEY) || '{}');
    const input = document.getElementById('search-input');
    const fSel = document.getElementById('filter-fonction');
    const rSel = document.getElementById('filter-rattachement');
    const invSel = document.getElementById('filter-inventaire');
    const scSel = document.getElementById('filter-scan');

    if (input) input.value = saved.term || '';
    if (fSel) fSel.value = saved.fonction || '';
    if (rSel) rSel.value = saved.rattachement || '';
    if (invSel) invSel.value = saved.inventaire || '';
    if (scSel) scSel.value = saved.scan || '';
  } catch (err) {
    localStorage.removeItem(SEARCH_STATE_KEY);
  }
  applyFilters();
}

function initSearch() {
  const input = document.getElementById('search-input');
  const clearBtn = document.getElementById('search-clear');

  if (input) {
    input.addEventListener('input', () => {
      applyFilters();
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (input) input.value = '';
      const fSel = document.getElementById('filter-fonction');
      const rSel = document.getElementById('filter-rattachement');
      const invSel = document.getElementById('filter-inventaire');
      const scSel = document.getElementById('filter-scan');
      if (fSel) fSel.value = '';
      if (rSel) rSel.value = '';
      if (invSel) invSel.value = '';
      if (scSel) scSel.value = '';
      state.filteredEmployees = state.employees;
      renderEmployeesTable(state.filteredEmployees);
      saveSearchState();
    });
  }
}

// ============================================================================
// FILTRES & COULEURS
// ============================================================================

/** Retourne une couleur rgba basée sur une chaîne (hash simple) */
function colorFromString(str) {
  const palette = [
    '13,148,136', '14,165,233', '251,113,133', '168,85,247', '245,158,11', '34,197,94'
  ];
  if (!str) return 'rgba(13,148,136,0.9)';
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h << 5) - h + str.charCodeAt(i);
  const idx = Math.abs(h) % palette.length;
  return `rgba(${palette[idx]},0.92)`;
}

/** Estime si la couleur est claire ou foncée (pour le contraste du texte) */
function getContrastYIQ(rgba) {
  // rgba format: 'rgba(r,g,b,a)'
  const m = rgba.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!m) return 'dark';
  const r = parseInt(m[1], 10), g = parseInt(m[2], 10), b = parseInt(m[3], 10);
  const yiq = (r*299 + g*587 + b*114) / 1000;
  return (yiq >= 128) ? 'light' : 'dark';
}

/** Remplit les options des selects de filtre avec les valeurs uniques */
function populateFilterOptions(list) {
  const fonctions = Array.from(new Set(list.map(e => e.fonction || '').filter(Boolean))).sort();
  const rattachements = Array.from(new Set(list.map(e => e.rattachement || '').filter(Boolean))).sort();

  const fSel = document.getElementById('filter-fonction');
  const rSel = document.getElementById('filter-rattachement');

  // vider puis ajouter
  fSel.innerHTML = '<option value="">Toutes les fonctions</option>' + fonctions.map(f => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join('');
  rSel.innerHTML = '<option value="">Tous les rattachements</option>' + rattachements.map(r => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join('');
}

function initFilters() {
  ['filter-fonction','filter-rattachement','filter-inventaire','filter-scan'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => {
      applyFilters();
    });
  });
}

/** Applique les filtres et la recherche sur la liste d'employés */
function applyFilters() {
  const term = ((document.getElementById('search-input') || {}).value || '').trim().toLowerCase();
  const f = (document.getElementById('filter-fonction') || {}).value || '';
  const r = (document.getElementById('filter-rattachement') || {}).value || '';
  const inv = (document.getElementById('filter-inventaire') || {}).value || ''; // 'realise' / 'non_realise' / ''
  const sc = (document.getElementById('filter-scan') || {}).value || ''; // 'realise' / 'non_realise' / ''

  state.filteredEmployees = state.employees.filter(emp => {
    if (term) {
      const ok = String(emp.matricule).toLowerCase().includes(term) || String(emp.nomPrenoms).toLowerCase().includes(term);
      if (!ok) return false;
    }
    if (f && String(emp.fonction || '') !== f) return false;
    if (r && String(emp.rattachement || '') !== r) return false;
    if (inv === 'realise' && String(emp.inventaire).toUpperCase() !== 'OK') return false;
    if (inv === 'non_realise' && String(emp.inventaire).toUpperCase() === 'OK') return false;
    if (sc === 'realise' && !emp.scan) return false;
    if (sc === 'non_realise' && emp.scan) return false;
    return true;
  });
  renderEmployeesTable(state.filteredEmployees);
  saveSearchState();
}

function scheduleDashboardRefresh(delay = 250) {
  if (dashboardRefreshTimer) clearTimeout(dashboardRefreshTimer);
  dashboardRefreshTimer = setTimeout(() => {
    if (document.getElementById('dashboard-view').classList.contains('active')) {
      loadDashboard();
    }
  }, delay);
}

function scheduleEmployeesRefresh(delay = 250) {
  if (employeesRefreshTimer) clearTimeout(employeesRefreshTimer);
  employeesRefreshTimer = setTimeout(() => {
    if (document.getElementById('search-view').classList.contains('active')) {
      loadEmployees();
    }
  }, delay);
}

function refreshVisibleData() {
  if (document.visibilityState !== 'visible') return;
  const now = Date.now();
  if (document.getElementById('dashboard-view').classList.contains('active') && now - lastDashboardLoad > 5000) {
    loadDashboard();
  }
  if (document.getElementById('search-view').classList.contains('active') && now - lastEmployeesLoad > 5000) {
    loadEmployees();
  }
}

// ============================================================================
// 7. MODALE — FICHE COLLABORATEUR
// ============================================================================

async function openEmployeeModal(matricule) {
  state.currentEmployee = { matricule, loading: true };
  renderEmployeeModal(state.currentEmployee);
  document.getElementById('employee-modal').classList.remove('hidden');

  try {
    const employee = await apiGet('getEmployee', { matricule });
    state.currentEmployee = employee;
    renderEmployeeModal(employee);
  } catch (err) {
    state.currentEmployee = { matricule, loading: false, error: err.message };
    renderEmployeeModal(state.currentEmployee);
    showToast(err.message, 'error');
  }
}

function closeEmployeeModal() {
  document.getElementById('employee-modal').classList.add('hidden');
  state.currentEmployee = null;
  state.pendingDocumentUpdates = {};
}

function renderEmployeeModal(emp) {
  state.pendingDocumentUpdates = {};
  const isLoading = emp && emp.loading === true;
  const isError = emp && emp.error;

  const completenessValue = isLoading || isError ? '' : String(emp.completude || '').toUpperCase();
  const isComplete = completenessValue === 'COMPLET';
  const showSelectionControls = !isLoading && !isError && completenessValue !== 'COMPLET';

  document.getElementById('modal-employee-name').textContent = isLoading ? 'Chargement…' : (emp.nomPrenoms || '—');
  document.getElementById('modal-employee-sub').textContent = isLoading
    ? 'Récupération des informations du collaborateur…'
    : `Matricule ${emp.matricule} · ${emp.fonction || '—'}`;

  // Infos générales
  const infoItems = isLoading
    ? [
        { label: 'Matricule', value: emp.matricule },
        { label: 'Statut', value: 'Chargement des données…' }
      ]
    : [
        { label: 'Matricule', value: emp.matricule },
        { label: "Date d'embauche", value: emp.dateEmbauche },
        { label: 'Fonction', value: emp.fonction },
        { label: 'Rattachement', value: emp.rattachement }
      ];
  document.getElementById('modal-info-grid').innerHTML = infoItems.map(item => `
    <div class="info-item">
      <div class="info-item__label">${escapeHtml(item.label)}</div>
      <div class="info-item__value">${escapeHtml(item.value) || '—'}</div>
    </div>
  `).join('');

  // Alerte de complétude
  const alertEl = document.getElementById('modal-completeness-alert');
  if (isLoading) {
    alertEl.className = 'completeness-alert incomplete';
    alertEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><div><div>Chargement des informations…</div></div>';
  } else if (isError) {
    alertEl.className = 'completeness-alert incomplete';
    alertEl.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i><div><div>${escapeHtml(emp.error || 'Impossible de charger les informations.')}</div></div>`;
  } else {
    const missingList = (emp.missingDocuments || []).length
      ? `<ul class="completeness-alert__list">${(emp.missingDocuments || []).map(doc => `<li>${escapeHtml(doc.label)}</li>`).join('')}</ul>`
      : '';
    alertEl.className = `completeness-alert ${isComplete ? 'complete' : 'incomplete'}`;
    alertEl.innerHTML = isComplete
      ? `<i class="fa-solid fa-circle-check"></i><div><div>Dossier <strong>COMPLET</strong> — aucun document à régulariser.</div>${missingList}</div>`
      : `<i class="fa-solid fa-triangle-exclamation"></i><div><div>Dossier <strong>INCOMPLET</strong> — ${(emp.missingDocuments || []).length} document(s) à régulariser.</div>${missingList}</div>`;
  }

  document.getElementById('document-validation-comment').value = isLoading || isError ? '' : (emp.commentaireCompletude || '');

  // Bloc SCAN
  const scanCheckbox = document.getElementById('scan-checkbox');
  scanCheckbox.checked = isLoading || isError ? false : emp.scan === true;
  scanCheckbox.disabled = isLoading || isError || emp.scan === true;
  document.getElementById('scan-status-label').textContent = isLoading || isError ? 'Chargement…' : (emp.scan ? 'Scanné (non modifiable)' : 'Non scanné');
  document.getElementById('scan-comment').value = isLoading || isError ? '' : (emp.commentaireScan || '');
  document.getElementById('scan-date-meta').textContent = isLoading || isError ? '' : (emp.dateScan ? `Dernière mise à jour : ${emp.dateScan}` : '');

  const scan2Checkbox = document.getElementById('scan2-checkbox');
  scan2Checkbox.checked = isLoading || isError ? false : emp.scan2 === true;
  scan2Checkbox.disabled = isLoading || isError || emp.scan2 === true;
  document.getElementById('scan2-status-label').textContent = isLoading || isError ? 'Chargement…' : (emp.scan2 ? 'Scanné 2 (non modifiable)' : 'Non scanné 2');
  document.getElementById('scan2-comment').value = isLoading || isError ? '' : (emp.commentaireScan2 || '');
  document.getElementById('scan2-date-meta').textContent = isLoading || isError ? '' : (emp.dateScan2 ? `Dernière mise à jour : ${emp.dateScan2}` : '');

  // Bloc INVENTAIRE
  const inventoryCheckbox = document.getElementById('inventory-checkbox');
  inventoryCheckbox.checked = isLoading || isError ? false : String(emp.inventaire).toUpperCase() === 'OK';
  inventoryCheckbox.disabled = isLoading || isError;
  document.getElementById('inventory-status-label').textContent = isLoading || isError ? 'Chargement…' : (inventoryCheckbox.checked ? 'Réalisé (OK)' : 'Non réalisé');

  // Liste des documents
  if (isLoading) {
    document.getElementById('documents-list').innerHTML = '<div class="document-row document-row--readonly"><div><div class="document-row__name">Chargement des documents…</div><div class="document-row__value">Veuillez patienter.</div></div></div>';
  } else {
    renderDocumentsList(emp, showSelectionControls);
  }
  updatePendingDocumentsSummary();

  const validationSection = document.getElementById('document-validation-section');
  if (validationSection) {
    validationSection.classList.toggle('hidden', !showSelectionControls);
  }
}

function renderDocumentsList(emp, showSelectionControls = true) {
  const container = document.getElementById('documents-list');

  container.innerHTML = emp.documents.map(doc => {
    const meta = STATUS_META[doc.status] || STATUS_META.missing;
    const pendingStatus = state.pendingDocumentUpdates[doc.key] || '';
    const needsAction = doc.status !== 'complete' && doc.status !== 'na';

    const valueDisplay = doc.status === 'missing'
      ? 'Non renseigné'
      : (doc.status === 'numeric' ? `Manque ${doc.value}` : doc.value);

    return `
      <div class="document-row ${pendingStatus ? 'pending' : ''} ${showSelectionControls ? '' : 'document-row--readonly'}" data-key="${escapeHtml(doc.key)}">
        <div>
          <div class="document-row__name">${escapeHtml(doc.label)}</div>
          <div class="document-row__value">${escapeHtml(valueDisplay)}</div>
        </div>
        <span class="badge ${meta.color}"><span class="badge-dot"></span>${meta.label}</span>
        ${showSelectionControls && needsAction ? `
          <div class="document-row__toggles">
            <label class="chip-toggle chip-toggle--na">
              <input type="checkbox" class="doc-status-checkbox" data-status="N/A" />
              <span>N/A</span>
            </label>
            <label class="chip-toggle chip-toggle--cx">
              <input type="checkbox" class="doc-status-checkbox" data-status="CX" />
              <span>CX</span>
            </label>
          </div>
        ` : ''}
        <span class="document-row__pending ${pendingStatus ? '' : 'hidden'}">En attente : ${escapeHtml(pendingStatus)}</span>
      </div>
    `;
  }).join('');

  if (!showSelectionControls) return;

  container.querySelectorAll('.document-row').forEach(row => {
    row.querySelectorAll('.doc-status-checkbox').forEach(checkbox => {
      checkbox.addEventListener('change', () => handleDocumentCheckboxChange(row, checkbox));
    });
  });
}

function handleDocumentCheckboxChange(row, checkbox) {
  const key = row.dataset.key;
  const status = checkbox.dataset.status;
  const otherStatus = status === 'CX' ? 'N/A' : 'CX';
  const otherCheckbox = row.querySelector(`.doc-status-checkbox[data-status="${otherStatus}"]`);

  if (checkbox.checked) {
    if (otherCheckbox) otherCheckbox.checked = false;
    state.pendingDocumentUpdates[key] = status;
  } else if (state.pendingDocumentUpdates[key] === status) {
    delete state.pendingDocumentUpdates[key];
  }

  row.classList.toggle('pending', Boolean(state.pendingDocumentUpdates[key]));
  const pendingBadge = row.querySelector('.document-row__pending');
  if (pendingBadge) {
    pendingBadge.textContent = state.pendingDocumentUpdates[key]
      ? `En attente : ${state.pendingDocumentUpdates[key]}`
      : '';
    pendingBadge.classList.toggle('hidden', !state.pendingDocumentUpdates[key]);
  }

  updatePendingDocumentsSummary();
}

function updatePendingDocumentsSummary() {
  const count = Object.keys(state.pendingDocumentUpdates).length;
  const summary = document.getElementById('document-pending-count');
  const validateBtn = document.getElementById('validate-documents-btn');
  if (summary) {
    summary.textContent = count > 0
      ? `${count} document(s) prêt(s) à valider.`
      : 'Aucun document sélectionné.';
  }
  if (validateBtn) {
    validateBtn.disabled = count === 0;
  }
}

function clearPendingDocumentSelections() {
  state.pendingDocumentUpdates = {};
  renderDocumentsList(state.currentEmployee);
  updatePendingDocumentsSummary();
}

async function handleValidateDocuments() {
  const matricule = state.currentEmployee.matricule;
  const updates = Object.entries(state.pendingDocumentUpdates).map(([key, status]) => ({ key, status }));
  const commentaire = document.getElementById('document-validation-comment').value.trim();

  if (!updates.length) {
    showToast('Sélectionnez au moins un document à valider.', 'info');
    return;
  }

  showLoader();
  setButtonLoading('validate-documents-btn', true);
  setModalBusy(true);
  try {
    const updated = await apiPost('updateDocumentsBatch', { matricule, updates, commentaire });
    state.currentEmployee = updated;
    renderEmployeeModal(updated);
    showToast('Validation groupée enregistrée.', 'success');
    refreshEmployeeInList(updated);
    scheduleDashboardRefresh();
    scheduleEmployeesRefresh();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    setModalBusy(false);
    setButtonLoading('validate-documents-btn', false);
    hideLoader();
  }
}

/** Met à jour l'entrée correspondante dans la liste résumée sans recharger toute la table. */
function refreshEmployeeInList(updatedEmployee) {
  const idx = state.employees.findIndex(e => String(e.matricule) === String(updatedEmployee.matricule));
  if (idx === -1) return;
  state.employees[idx] = {
    ...state.employees[idx],
    completude: updatedEmployee.completude,
    scan: updatedEmployee.scan,
    scan2: updatedEmployee.scan2,
    inventaire: updatedEmployee.inventaire
  };
  renderEmployeesTable(state.filteredEmployees);
}

// ============================================================================
// 8. ACTIONS : SCAN & INVENTAIRE
// ============================================================================

function initModalActions() {
  document.getElementById('modal-close').addEventListener('click', closeEmployeeModal);
  document.getElementById('employee-modal').addEventListener('click', (e) => {
    if (e.target.id === 'employee-modal') closeEmployeeModal();
  });

  document.getElementById('scan-checkbox').addEventListener('change', (e) => {
    document.getElementById('scan-status-label').textContent =
      e.target.checked ? 'Scanné' : 'Non scanné';
  });

  document.getElementById('scan-save-btn').addEventListener('click', handleScanSave);

  document.getElementById('scan2-checkbox').addEventListener('change', (e) => {
    document.getElementById('scan2-status-label').textContent =
      e.target.checked ? 'Scanné 2' : 'Non scanné 2';
  });

  document.getElementById('scan2-save-btn').addEventListener('click', handleScan2Save);

  document.getElementById('inventory-checkbox').addEventListener('change', handleInventoryToggle);

  document.getElementById('validate-documents-btn').addEventListener('click', handleValidateDocuments);
  document.getElementById('clear-document-selection-btn').addEventListener('click', clearPendingDocumentSelections);
}

async function handleScanSave() {
  const matricule = state.currentEmployee.matricule;
  const scan = document.getElementById('scan-checkbox').checked;
  const commentaire = document.getElementById('scan-comment').value.trim();

  // Empêcher de décocher un scan déjà validé
  if (state.currentEmployee.scan === true && scan === false) {
    showToast('Impossible de décocher un scan déjà enregistré. Veuillez contacter l\'administrateur.', 'error');
    return;
  }

  showLoader();
  setButtonLoading('scan-save-btn', true);
  setModalBusy(true);
  try {
    const updated = await apiPost('updateScan', { matricule, scan, commentaire });
    state.currentEmployee = updated;
    renderEmployeeModal(updated);
    showToast('Statut de scan enregistré.', 'success');
    refreshEmployeeInList(updated);
    scheduleDashboardRefresh();
    scheduleEmployeesRefresh();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    setModalBusy(false);
    setButtonLoading('scan-save-btn', false);
    hideLoader();
  }
}

async function handleScan2Save() {
  const matricule = state.currentEmployee.matricule;
  const scan2 = document.getElementById('scan2-checkbox').checked;
  const commentaire = document.getElementById('scan2-comment').value.trim();

  // Empêcher de décocher un scan 2 déjà validé
  if (state.currentEmployee.scan2 === true && scan2 === false) {
    showToast('Impossible de décocher un second scan déjà enregistré. Veuillez contacter l\'administrateur.', 'error');
    return;
  }

  showLoader();
  setButtonLoading('scan2-save-btn', true);
  setModalBusy(true);
  try {
    const updated = await apiPost('updateScan2', { matricule, scan2, commentaire });
    state.currentEmployee = updated;
    renderEmployeeModal(updated);
    showToast('Second scan enregistré.', 'success');
    refreshEmployeeInList(updated);
    scheduleDashboardRefresh();
    scheduleEmployeesRefresh();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    setModalBusy(false);
    setButtonLoading('scan2-save-btn', false);
    hideLoader();
  }
}

async function handleInventoryToggle(e) {
  const matricule = state.currentEmployee.matricule;
  const value = e.target.checked ? 'OK' : '';

  showLoader();
  setModalBusy(true);
  try {
    const updated = await apiPost('updateInventory', { matricule, value });
    state.currentEmployee = updated;
    document.getElementById('inventory-status-label').textContent =
      updated.inventaire === 'OK' ? 'Réalisé (OK)' : 'Non réalisé';
    showToast('Inventaire mis à jour.', 'success');
    refreshEmployeeInList(updated);
  } catch (err) {
    showToast(err.message, 'error');
    e.target.checked = !e.target.checked; // rollback visuel en cas d'erreur
  } finally {
    setModalBusy(false);
    hideLoader();
  }
  scheduleDashboardRefresh();
  scheduleEmployeesRefresh();
}

// ============================================================================
// 9. INITIALISATION
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
  if (API_URL.includes('REMPLACER_PAR_URL_DU_WEB_APP')) {
    showToast('Configurez API_URL dans script.js avant utilisation (voir README.md).', 'error');
  }

  // attache les handlers généraux
  initNavigation();
  initSearch();
  initModalActions();

  // login / logout
  const loginForm = document.getElementById('login-form');
  const loginBtn = document.getElementById('login-btn');
  if (loginForm) {
    loginForm.addEventListener('submit', (event) => {
      event.preventDefault();
      handleLogin();
    });
  }
  if (loginBtn) {
    loginBtn.addEventListener('click', (event) => {
      event.preventDefault();
      handleLogin();
    });
  }
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) logoutBtn.addEventListener('click', handleLogout);

  // restaurer l'état (auth + vue)
  updateAuthUI();
  const savedView = localStorage.getItem(VIEW_KEY) || 'dashboard-view';
  if (isAuthenticated()) {
    showView(savedView);
  } else {
    // afficher le login après un bref délai pour laisser l'accueil se charger
    loginOverlayTimer = setTimeout(() => showLoginOverlay(), 500);
    // laisser la vue visible en dessous mais bloquée par l'overlay
  }

  document.addEventListener('visibilitychange', refreshVisibleData);
  setInterval(refreshVisibleData, 30000);
});
