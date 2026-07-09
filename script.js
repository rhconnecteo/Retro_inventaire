/* ============================================================================
   GESTION DES DOSSIERS RH — FRONTEND (script.js)
   Communique EXCLUSIVEMENT avec le backend Google Apps Script (Code.gs)
   via des appels fetch() au format JSON. Aucun accès direct à Google Sheets.
   ============================================================================ */

// ============================================================================
// 1. CONFIGURATION
// ============================================================================

// URL de déploiement du Web App Apps Script (voir README.md pour l'obtenir)
const API_URL = 'https://script.google.com/macros/s/AKfycbxl17hh-fRNHB0d0zTJJqIAFLfit0-sjENykiPKzVHEUip2ox6nT6BklLARu-5B8ahq/exec';

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
  currentEmployee: null // fiche détaillée actuellement ouverte dans la modale
};

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
  document.getElementById('loader').classList.remove('hidden');
}
function hideLoader() {
  document.getElementById('loader').classList.add('hidden');
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
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));

      btn.classList.add('active');
      document.getElementById(btn.dataset.view).classList.add('active');

      if (btn.dataset.view === 'dashboard-view') loadDashboard();
      if (btn.dataset.view === 'search-view' && state.employees.length === 0) loadEmployees();
    });
  });
}

// ============================================================================
// 5. TABLEAU DE BORD
// ============================================================================

let completenessChart = null;
let missingDocsChart = null;

async function loadDashboard() {
  showLoader();
  try {
    const data = await apiGet('getDashboard');
    renderStatsCards(data);
    renderCompletenessChart(data);
    renderMissingDocsChart(data);
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    hideLoader();
  }
}

function renderStatsCards(data) {
  const grid = document.getElementById('stats-grid');
  const cards = [
    { icon: 'fa-users', label: 'Collaborateurs', value: data.totalEmployees, cls: '' },
    { icon: 'fa-circle-check', label: 'Dossiers complets', value: data.complete, cls: 'success' },
    { icon: 'fa-triangle-exclamation', label: 'Dossiers incomplets', value: data.incomplete, cls: 'danger' },
    { icon: 'fa-scanner', label: 'Scans réalisés', value: data.scansDone, cls: 'accent' },
    { icon: 'fa-boxes-stacked', label: 'Inventaires réalisés', value: data.inventoriesDone, cls: 'accent' },
    { icon: 'fa-percent', label: 'Taux de complétude', value: data.completionPercentage + ' %', cls: 'warning' }
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

function renderCompletenessChart(data) {
  const ctx = document.getElementById('chart-completeness').getContext('2d');
  if (completenessChart) completenessChart.destroy();

  completenessChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Complets', 'Incomplets'],
      datasets: [{
        data: [data.complete, data.incomplete],
        backgroundColor: ['#16A34A', '#DC2626'],
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
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
  showLoader();
  try {
    state.employees = await apiGet('getEmployees');
    state.filteredEmployees = state.employees;
    renderEmployeesTable(state.filteredEmployees);
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    hideLoader();
  }
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
    const isComplete = emp.completude === 'COMPLET';
    const completBadge = isComplete
      ? `<span class="badge complete"><span class="badge-dot"></span>Complet</span>`
      : `<span class="badge incorrect"><span class="badge-dot"></span>Incomplet</span>`;

    const scanBadge = emp.scan
      ? `<span class="badge complete"><span class="badge-dot"></span>Scanné</span>`
      : `<span class="badge missing"><span class="badge-dot"></span>Non scanné</span>`;

    const inventoryBadge = String(emp.inventaire).toUpperCase() === 'OK'
      ? `<span class="badge complete"><span class="badge-dot"></span>OK</span>`
      : `<span class="badge na"><span class="badge-dot"></span>—</span>`;

    return `
      <tr data-matricule="${escapeHtml(emp.matricule)}">
        <td>${escapeHtml(emp.matricule)}</td>
        <td>${escapeHtml(emp.nomPrenoms)}</td>
        <td>${escapeHtml(emp.fonction)}</td>
        <td>${escapeHtml(emp.rattachement)}</td>
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

function initSearch() {
  const input = document.getElementById('search-input');
  const clearBtn = document.getElementById('search-clear');

  input.addEventListener('input', () => {
    const term = input.value.trim().toLowerCase();
    state.filteredEmployees = state.employees.filter(emp =>
      String(emp.matricule).toLowerCase().includes(term) ||
      String(emp.nomPrenoms).toLowerCase().includes(term)
    );
    renderEmployeesTable(state.filteredEmployees);
  });

  clearBtn.addEventListener('click', () => {
    input.value = '';
    state.filteredEmployees = state.employees;
    renderEmployeesTable(state.filteredEmployees);
  });
}

// ============================================================================
// 7. MODALE — FICHE COLLABORATEUR
// ============================================================================

async function openEmployeeModal(matricule) {
  showLoader();
  try {
    const employee = await apiGet('getEmployee', { matricule });
    state.currentEmployee = employee;
    renderEmployeeModal(employee);
    document.getElementById('employee-modal').classList.remove('hidden');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    hideLoader();
  }
}

function closeEmployeeModal() {
  document.getElementById('employee-modal').classList.add('hidden');
  state.currentEmployee = null;
}

function renderEmployeeModal(emp) {
  document.getElementById('modal-employee-name').textContent = emp.nomPrenoms || '—';
  document.getElementById('modal-employee-sub').textContent =
    `Matricule ${emp.matricule} · ${emp.fonction || '—'}`;

  // Infos générales
  const infoItems = [
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

  // Alerte de complétude (carte "Annulé"-style bien visible)
  const isComplete = emp.completude === 'COMPLET';
  const alertEl = document.getElementById('modal-completeness-alert');
  alertEl.className = `completeness-alert ${isComplete ? 'complete' : 'incomplete'}`;
  alertEl.innerHTML = isComplete
    ? `<i class="fa-solid fa-circle-check"></i> <div>Dossier <strong>COMPLET</strong> — tous les documents requis sont fournis.</div>`
    : `<i class="fa-solid fa-triangle-exclamation"></i> <div>Dossier <strong>INCOMPLET</strong> — ${emp.missingDocuments.length} document(s) à régulariser.</div>`;

  // Bloc SCAN
  const scanCheckbox = document.getElementById('scan-checkbox');
  scanCheckbox.checked = emp.scan === true;
  document.getElementById('scan-status-label').textContent = emp.scan ? 'Scanné' : 'Non scanné';
  document.getElementById('scan-comment').value = emp.commentaireScan || '';
  document.getElementById('scan-date-meta').textContent = emp.dateScan
    ? `Dernière mise à jour : ${emp.dateScan}` : '';

  // Bloc INVENTAIRE
  const inventoryCheckbox = document.getElementById('inventory-checkbox');
  inventoryCheckbox.checked = String(emp.inventaire).toUpperCase() === 'OK';
  document.getElementById('inventory-status-label').textContent =
    inventoryCheckbox.checked ? 'Réalisé (OK)' : 'Non réalisé';

  // Liste des documents
  renderDocumentsList(emp);
}

function renderDocumentsList(emp) {
  const container = document.getElementById('documents-list');

  container.innerHTML = emp.documents.map(doc => {
    const meta = STATUS_META[doc.status] || STATUS_META.missing;
    const needsAction = doc.status !== 'complete' && doc.status !== 'na';

    const valueDisplay = doc.status === 'missing'
      ? 'Non renseigné'
      : (doc.status === 'numeric' ? `Manque ${doc.value}` : doc.value);

    return `
      <div class="document-row ${needsAction ? 'needs-action' : ''}" data-key="${escapeHtml(doc.key)}">
        <div>
          <div class="document-row__name">${escapeHtml(doc.label)}</div>
          <div class="document-row__value">${escapeHtml(valueDisplay)}</div>
        </div>
        <span class="badge ${meta.color}"><span class="badge-dot"></span>${meta.label}</span>
        ${needsAction ? `
          <label class="switch doc-fix-toggle">
            <input type="checkbox" class="doc-fix-checkbox" />
            <span class="switch__slider"></span>
          </label>
        ` : `<span></span>`}
        ${needsAction ? `
          <div class="document-row__actions">
            <input type="text" class="doc-comment-input" placeholder="Commentaire (optionnel)" />
            <button class="btn btn-success btn-doc-save" disabled>
              <i class="fa-solid fa-check"></i> Valider
            </button>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');

  // Interactions : cocher un document manquant révèle le champ commentaire + bouton
  container.querySelectorAll('.document-row').forEach(row => {
    const checkbox = row.querySelector('.doc-fix-checkbox');
    if (!checkbox) return;

    const saveBtn = row.querySelector('.btn-doc-save');

    checkbox.addEventListener('change', () => {
      row.classList.toggle('expanded', checkbox.checked);
      saveBtn.disabled = !checkbox.checked;
    });

    saveBtn.addEventListener('click', () => handleDocumentFix(row));
  });
}

/**
 * Valide un document manquant : appelle l'API pour forcer sa valeur à "X",
 * enregistre le commentaire, puis rafraîchit la fiche collaborateur.
 */
async function handleDocumentFix(row) {
  const key = row.dataset.key;
  const commentaire = row.querySelector('.doc-comment-input').value.trim();
  const matricule = state.currentEmployee.matricule;

  showLoader();
  try {
    const updated = await apiPost('updateDocument', { matricule, key, commentaire });
    state.currentEmployee = updated;
    renderEmployeeModal(updated);
    showToast('Document validé avec succès.', 'success');
    refreshEmployeeInList(updated);
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
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

  document.getElementById('inventory-checkbox').addEventListener('change', handleInventoryToggle);
}

async function handleScanSave() {
  const matricule = state.currentEmployee.matricule;
  const scan = document.getElementById('scan-checkbox').checked;
  const commentaire = document.getElementById('scan-comment').value.trim();

  showLoader();
  try {
    const updated = await apiPost('updateScan', { matricule, scan, commentaire });
    state.currentEmployee = updated;
    renderEmployeeModal(updated);
    showToast('Statut de scan enregistré.', 'success');
    refreshEmployeeInList(updated);
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    hideLoader();
  }
}

async function handleInventoryToggle(e) {
  const matricule = state.currentEmployee.matricule;
  const value = e.target.checked ? 'OK' : '';

  showLoader();
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
    hideLoader();
  }
}

// ============================================================================
// 9. INITIALISATION
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
  if (API_URL.includes('REMPLACER_PAR_URL_DU_WEB_APP')) {
    showToast('Configurez API_URL dans script.js avant utilisation (voir README.md).', 'error');
  }

  initNavigation();
  initSearch();
  initModalActions();

  loadDashboard();
});
