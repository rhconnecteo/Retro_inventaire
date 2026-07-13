/**
 * ============================================================================
 *  GESTION DES DOSSIERS RH — BACKEND (Google Apps Script)
 * ============================================================================
 *  Ce fichier est l'UNIQUE point d'accès aux données (Google Sheets).
 *  Le frontend (index.html / script.js) ne communique JAMAIS directement
 *  avec le Google Sheets : il passe systématiquement par les routes
 *  exposées ici via doGet(e) / doPost(e), qui répondent en JSON.
 *
 *  Routes disponibles :
 *    GET  ?action=getEmployees                -> liste résumée des collaborateurs
 *    GET  ?action=getEmployee&matricule=...    -> fiche complète d'un collaborateur
 *    GET  ?action=getDashboard                 -> statistiques globales
 *    POST { action: "updateScan" }             -> met à jour AG / AH / AI
 *    POST { action: "updateInventory" }        -> met à jour AF
 *    POST { action: "updateDocument" }         -> corrige un document (AK / AL / AJ)
 * ============================================================================
 */

// ============================================================================
// 1. CONFIGURATION
// ============================================================================

const CONFIG = {
  // ID du Google Sheets. De préférence défini via :
  // Extensions > Apps Script > Paramètres du projet > Propriétés du script (SHEET_ID)
  SHEET_ID: PropertiesService.getScriptProperties().getProperty('SHEET_ID') || 'REMPLACER_PAR_ID_DU_GOOGLE_SHEET',
  SHEET_NAME: 'Data',   // Nom de l'onglet contenant les données
  HEADER_ROW: 1          // Ligne des en-têtes (les données commencent à HEADER_ROW + 1)
};

// Colonnes "identité" et colonnes de gestion (index 1-based, comme dans Sheets)
const FIELDS = {
  MATRICULE: 1,               // A
  DATE_EMBAUCHE: 2,           // B
  NOM_PRENOMS: 3,              // C
  FONCTION: 4,                 // D
  RATTACHEMENT: 5,             // E
  INVENTAIRE: 32,               // AF
  SCAN: 33,                     // AG
  COMMENTAIRE_SCAN: 34,         // AH
  DATE_SCAN: 35,                // AI
  COMPLETUDE: 36,                // AJ
  COMMENTAIRE_COMPLETUDE: 37,    // AK
  DATE_COMPLETUDE: 38            // AL
};

// Liste ordonnée des documents à vérifier (colonnes F -> AE)
const DOCUMENTS = [
  { col: 6,  key: 'cin',              label: '02 CIN légal' },
  { col: 7,  key: 'residence',        label: '01 résidence' },
  { col: 8,  key: 'bulletin3',        label: '01 bulletin n°3' },
  { col: 9,  key: 'photos',           label: '03 photos' },
  { col: 10, key: 'acteNaissance',    label: '02 acte de naissance' },
  { col: 11, key: 'rib',              label: 'RIB' },
  { col: 12, key: 'diplome',          label: 'Diplôme et attestation' },
  { col: 13, key: 'certifTravail',    label: 'Certificat de travail / Attestation de stage' },
  { col: 14, key: 'bulletinsPaie',    label: '02 derniers bulletins de paie' },
  { col: 15, key: 'cnapsCopie',       label: 'Copie CNAPS' },
  { col: 16, key: 'certifMariage',    label: '02 certificats de mariage' },
  { col: 17, key: 'photosConjoint',   label: '03 photos conjoint(e)' },
  { col: 18, key: 'acteEnfant',       label: 'Actes de naissance + certificat de scolarité enfant' },
  { col: 19, key: 'certifVieEnfant',  label: 'Certificat de vie enfant' },
  { col: 20, key: 'photosEnfant',     label: '03 photos enfant' },
  { col: 21, key: 'ostie',            label: 'OSTIE' },
  { col: 22, key: 'cnaps',            label: 'CNAPS' },
  { col: 23, key: 'allianz',          label: 'ALLIANZ' },
  { col: 24, key: 'fpr',              label: 'FPR' },
  { col: 25, key: 'contratTravail',   label: 'Contrat de travail' },
  { col: 26, key: 'ficheDePoste',     label: 'Fiche de poste' },
  { col: 27, key: 'ficheIndiv',       label: 'Fiche individuelle' },
  { col: 28, key: 'lettreEngagement', label: "Lettre d'engagement" },
  { col: 29, key: 'charteSia',        label: 'Charte SIA' },
  { col: 30, key: 'charteConfid',     label: 'Charte de confidentialité' },
  { col: 31, key: 'paiementMvola',    label: 'Paiement Mvola' }
];

// ============================================================================
// 2. POINTS D'ENTRÉE HTTP
// ============================================================================

/**
 * Gère toutes les requêtes GET (lecture de données).
 */
function doGet(e) {
  try {
    const action = e && e.parameter ? e.parameter.action : null;

    switch (action) {
      case 'getEmployees':
        return jsonResponse({ success: true, data: getEmployees() });

      case 'getEmployee':
        return jsonResponse({ success: true, data: getEmployee(e.parameter.matricule) });

      case 'getDashboard':
        return jsonResponse({ success: true, data: getDashboard() });

      case 'ping':
        return jsonResponse({ success: true, message: 'API opérationnelle' });

      default:
        return jsonResponse({ success: false, error: 'Action GET inconnue ou manquante : ' + action }, 400);
    }
  } catch (err) {
    return jsonResponse({ success: false, error: err.message }, 500);
  }
}

/**
 * Gère toutes les requêtes POST (écriture / mise à jour de données).
 * Le corps est envoyé en texte brut (text/plain) contenant du JSON,
 * afin d'éviter les requêtes "preflight" CORS bloquées par Apps Script.
 */
function doPost(e) {
  try {
    const body = e && e.postData && e.postData.contents ? JSON.parse(e.postData.contents) : {};
    const action = body.action;

    switch (action) {
      case 'updateScan':
        return jsonResponse({ success: true, data: updateScan(body) });

      case 'updateInventory':
        return jsonResponse({ success: true, data: updateInventory(body) });

      case 'updateDocument':
        return jsonResponse({ success: true, data: updateDocument(body) });

      default:
        return jsonResponse({ success: false, error: 'Action POST inconnue ou manquante : ' + action }, 400);
    }
  } catch (err) {
    return jsonResponse({ success: false, error: err.message }, 500);
  }
}

// ============================================================================
// 3. ACCÈS À LA FEUILLE DE CALCUL
// ============================================================================

/**
 * Retourne l'onglet de données configuré.
 */
function getSheet() {
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    throw new Error('Onglet "' + CONFIG.SHEET_NAME + '" introuvable dans le Google Sheets.');
  }
  return sheet;
}

/**
 * Retourne le numéro de ligne (1-based) correspondant à un matricule donné.
 * Lève une erreur si le matricule n'existe pas.
 */
function findRowByMatricule(sheet, matricule) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= CONFIG.HEADER_ROW) return -1;

  const matriculeValues = sheet
    .getRange(CONFIG.HEADER_ROW + 1, FIELDS.MATRICULE, lastRow - CONFIG.HEADER_ROW, 1)
    .getValues();

  for (let i = 0; i < matriculeValues.length; i++) {
    if (String(matriculeValues[i][0]).trim() === String(matricule).trim()) {
      return CONFIG.HEADER_ROW + 1 + i;
    }
  }
  return -1;
}

// ============================================================================
// 4. LOGIQUE MÉTIER — STATUTS DES DOCUMENTS
// ============================================================================

/**
 * Détermine le statut d'un document à partir de sa valeur brute.
 * Retourne un objet { status, missingCount }.
 *   status : 'complete' | 'na' | 'numeric' | 'incorrect' | 'missing'
 */
function computeDocStatus(rawValue) {
  const value = (rawValue === null || rawValue === undefined) ? '' : String(rawValue).trim();

  if (value === '') {
    return { status: 'missing', missingCount: null };
  }
  if (value.toUpperCase() === 'X') {
    return { status: 'complete', missingCount: null };
  }
  if (value.toUpperCase() === 'N/A') {
    return { status: 'na', missingCount: null };
  }
  if (!isNaN(value) && value !== '') {
    return { status: 'numeric', missingCount: Number(value) };
  }
  // Toute autre valeur textuelle = document non conforme
  return { status: 'incorrect', missingCount: null };
}

/**
 * Calcule la complétude d'une ligne (COMPLET si tous les documents
 * valent "X" ou "N/A", sinon INCOMPLET).
 */
function computeCompleteness(rowValues) {
  for (let i = 0; i < DOCUMENTS.length; i++) {
    const raw = rowValues[DOCUMENTS[i].col - 1];
    const { status } = computeDocStatus(raw);
    if (status !== 'complete' && status !== 'na') {
      return 'INCOMPLET';
    }
  }
  return 'COMPLET';
}

/**
 * Construit la liste des documents manquants / non conformes pour une ligne.
 */
function getMissingDocuments(rowValues) {
  const missing = [];
  DOCUMENTS.forEach(doc => {
    const raw = rowValues[doc.col - 1];
    const { status, missingCount } = computeDocStatus(raw);
    if (status !== 'complete' && status !== 'na') {
      missing.push({
        key: doc.key,
        label: doc.label,
        value: raw === null || raw === undefined ? '' : raw,
        status: status,
        missingCount: missingCount
      });
    }
  });
  return missing;
}

/**
 * Transforme une ligne brute de la feuille en objet "document" complet.
 */
function buildDocumentsList(rowValues) {
  return DOCUMENTS.map(doc => {
    const raw = rowValues[doc.col - 1];
    const { status, missingCount } = computeDocStatus(raw);
    return {
      key: doc.key,
      label: doc.label,
      col: doc.col,
      value: raw === null || raw === undefined ? '' : raw,
      status: status,
      missingCount: missingCount
    };
  });
}

/**
 * Transforme une ligne brute en objet "collaborateur" complet (fiche détaillée).
 */
function rowToEmployee(rowValues) {
  return {
    matricule: rowValues[FIELDS.MATRICULE - 1],
    dateEmbauche: formatDate(rowValues[FIELDS.DATE_EMBAUCHE - 1]),
    nomPrenoms: rowValues[FIELDS.NOM_PRENOMS - 1],
    fonction: rowValues[FIELDS.FONCTION - 1],
    rattachement: rowValues[FIELDS.RATTACHEMENT - 1],
    documents: buildDocumentsList(rowValues),
    missingDocuments: getMissingDocuments(rowValues),
    inventaire: rowValues[FIELDS.INVENTAIRE - 1] || '',
    scan: rowValues[FIELDS.SCAN - 1] === true,
    commentaireScan: rowValues[FIELDS.COMMENTAIRE_SCAN - 1] || '',
    dateScan: formatDate(rowValues[FIELDS.DATE_SCAN - 1]),
    completude: rowValues[FIELDS.COMPLETUDE - 1] || computeCompleteness(rowValues),
    commentaireCompletude: rowValues[FIELDS.COMMENTAIRE_COMPLETUDE - 1] || '',
    dateCompletude: formatDate(rowValues[FIELDS.DATE_COMPLETUDE - 1])
  };
}

/**
 * Formate une date pour l'affichage frontend (JJ/MM/AAAA), tolère les
 * valeurs vides ou déjà textuelles.
 */
function formatDate(value) {
  if (!value) return '';
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'dd/MM/yyyy');
  }
  return String(value);
}

// ============================================================================
// 5. ROUTES — LECTURE
// ============================================================================

/**
 * Retourne la liste résumée de tous les collaborateurs (pour le tableau
 * de recherche/liste principal du frontend).
 */
function getEmployees() {
  const sheet = getSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow <= CONFIG.HEADER_ROW) return [];

  const range = sheet.getRange(CONFIG.HEADER_ROW + 1, 1, lastRow - CONFIG.HEADER_ROW, FIELDS.DATE_COMPLETUDE);
  const values = range.getValues();

  return values
    .filter(row => String(row[FIELDS.MATRICULE - 1]).trim() !== '')
    .map(row => {
      const completude = row[FIELDS.COMPLETUDE - 1] || computeCompleteness(row);
      return {
        matricule: row[FIELDS.MATRICULE - 1],
        nomPrenoms: row[FIELDS.NOM_PRENOMS - 1],
        fonction: row[FIELDS.FONCTION - 1],
        rattachement: row[FIELDS.RATTACHEMENT - 1],
        completude: completude,
        scan: row[FIELDS.SCAN - 1] === true,
        inventaire: row[FIELDS.INVENTAIRE - 1] || ''
      };
    });
}

/**
 * Retourne la fiche complète d'un collaborateur donné (recherche par matricule).
 */
function getEmployee(matricule) {
  if (!matricule) throw new Error('Le paramètre "matricule" est requis.');

  const sheet = getSheet();
  const rowIndex = findRowByMatricule(sheet, matricule);
  if (rowIndex === -1) throw new Error('Aucun collaborateur trouvé pour le matricule "' + matricule + '".');

  const rowValues = sheet.getRange(rowIndex, 1, 1, FIELDS.DATE_COMPLETUDE).getValues()[0];
  return rowToEmployee(rowValues);
}

/**
 * Calcule les statistiques globales pour le tableau de bord.
 */
function getDashboard() {
  const sheet = getSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow <= CONFIG.HEADER_ROW) {
    return {
      totalEmployees: 0, complete: 0, incomplete: 0,
      scansDone: 0, inventoriesDone: 0, completionPercentage: 0,
      missingDocsFrequency: []
    };
  }

  const values = sheet
    .getRange(CONFIG.HEADER_ROW + 1, 1, lastRow - CONFIG.HEADER_ROW, FIELDS.DATE_COMPLETUDE)
    .getValues()
    .filter(row => String(row[FIELDS.MATRICULE - 1]).trim() !== '');

  let complete = 0, incomplete = 0, scansDone = 0, inventoriesDone = 0;
  const missingFrequency = {}; // key -> count
  DOCUMENTS.forEach(doc => { missingFrequency[doc.key] = 0; });

  values.forEach(row => {
    const status = row[FIELDS.COMPLETUDE - 1] || computeCompleteness(row);
    if (status === 'COMPLET') complete++; else incomplete++;

    if (row[FIELDS.SCAN - 1] === true) scansDone++;
    if (String(row[FIELDS.INVENTAIRE - 1]).trim().toUpperCase() === 'OK') inventoriesDone++;

    DOCUMENTS.forEach(doc => {
      const raw = row[doc.col - 1];
      const { status: docStatus } = computeDocStatus(raw);
      if (docStatus !== 'complete' && docStatus !== 'na') {
        missingFrequency[doc.key]++;
      }
    });
  });

  const total = values.length;
  const missingDocsFrequency = DOCUMENTS
    .map(doc => ({ key: doc.key, label: doc.label, count: missingFrequency[doc.key] }))
    .sort((a, b) => b.count - a.count);

  return {
    totalEmployees: total,
    complete: complete,
    incomplete: incomplete,
    scansDone: scansDone,
    inventoriesDone: inventoriesDone,
    completionPercentage: total > 0 ? Math.round((complete / total) * 100) : 0,
    missingDocsFrequency: missingDocsFrequency
  };
}

// ============================================================================
// 6. ROUTES — ÉCRITURE
// ============================================================================

/**
 * Met à jour la validation du SCAN (colonne AG), le commentaire (AH)
 * et la date (AI). Utilise un verrou pour éviter les écritures concurrentes.
 * body attendu : { matricule, scan: true|false, commentaire }
 */
function updateScan(body) {
  const { matricule, scan, commentaire } = body;
  if (!matricule) throw new Error('Le champ "matricule" est requis.');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = getSheet();
    const rowIndex = findRowByMatricule(sheet, matricule);
    if (rowIndex === -1) throw new Error('Collaborateur introuvable : ' + matricule);

    sheet.getRange(rowIndex, FIELDS.SCAN).setValue(scan === true);
    sheet.getRange(rowIndex, FIELDS.COMMENTAIRE_SCAN).setValue(commentaire || '');
    sheet.getRange(rowIndex, FIELDS.DATE_SCAN).setValue(scan === true ? new Date() : '');

    const rowValues = sheet.getRange(rowIndex, 1, 1, FIELDS.DATE_COMPLETUDE).getValues()[0];
    return rowToEmployee(rowValues);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Met à jour l'INVENTAIRE physique (colonne AF).
 * body attendu : { matricule, value: "OK" | "" }
 */
function updateInventory(body) {
  const { matricule, value } = body;
  if (!matricule) throw new Error('Le champ "matricule" est requis.');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = getSheet();
    const rowIndex = findRowByMatricule(sheet, matricule);
    if (rowIndex === -1) throw new Error('Collaborateur introuvable : ' + matricule);

    sheet.getRange(rowIndex, FIELDS.INVENTAIRE).setValue(value === 'OK' ? 'OK' : '');

    const rowValues = sheet.getRange(rowIndex, 1, 1, FIELDS.DATE_COMPLETUDE).getValues()[0];
    return rowToEmployee(rowValues);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Corrige un document manquant/non conforme : force sa valeur à "X",
 * enregistre le commentaire (AK) et la date (AL), puis recalcule
 * automatiquement la complétude globale (AJ).
 * body attendu : { matricule, key, commentaire }
 */
function updateDocument(body) {
  const { matricule, key, commentaire } = body;
  if (!matricule) throw new Error('Le champ "matricule" est requis.');
  if (!key) throw new Error('Le champ "key" (identifiant du document) est requis.');

  const doc = DOCUMENTS.find(d => d.key === key);
  if (!doc) throw new Error('Document inconnu : ' + key);

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = getSheet();
    const rowIndex = findRowByMatricule(sheet, matricule);
    if (rowIndex === -1) throw new Error('Collaborateur introuvable : ' + matricule);

    // 1. Validation du document -> "X"
    sheet.getRange(rowIndex, doc.col).setValue('X');

    // 2. Commentaire et date de complétude
    sheet.getRange(rowIndex, FIELDS.COMMENTAIRE_COMPLETUDE).setValue(commentaire || '');
    sheet.getRange(rowIndex, FIELDS.DATE_COMPLETUDE).setValue(new Date());

    // 3. Recalcul automatique de la complétude globale (AJ)
    const rowValues = sheet.getRange(rowIndex, 1, 1, FIELDS.DATE_COMPLETUDE).getValues()[0];
    const newStatus = computeCompleteness(rowValues);
    sheet.getRange(rowIndex, FIELDS.COMPLETUDE).setValue(newStatus);

    const updatedRow = sheet.getRange(rowIndex, 1, 1, FIELDS.DATE_COMPLETUDE).getValues()[0];
    return rowToEmployee(updatedRow);
  } finally {
    lock.releaseLock();
  }
}

// ============================================================================
// 7. UTILITAIRES
// ============================================================================

/**
 * Construit une réponse JSON standardisée (ContentService).
 * Remarque : Apps Script ne permet pas de définir un code HTTP personnalisé
 * pour un Web App ; le champ "success" du corps JSON sert donc d'indicateur
 * d'état pour le frontend.
 */
function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Fonction utilitaire à exécuter manuellement une fois depuis l'éditeur
 * Apps Script pour enregistrer l'ID du Google Sheets dans les propriétés
 * du script (évite de coder l'ID en dur dans CONFIG).
 */
function setSheetId() {
  const SHEET_ID = 'COLLER_ICI_L_ID_DU_GOOGLE_SHEET';
  PropertiesService.getScriptProperties().setProperty('SHEET_ID', SHEET_ID);
}

/**
 * Recalcule et écrit la colonne AJ (COMPLÉTUDE) pour toutes les lignes.
 * Utile à exécuter une fois après l'import initial des données,
 * ou périodiquement via un déclencheur (trigger) si besoin.
 */
function recalculateAllCompleteness() {
  const sheet = getSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow <= CONFIG.HEADER_ROW) return;

  const range = sheet.getRange(CONFIG.HEADER_ROW + 1, 1, lastRow - CONFIG.HEADER_ROW, FIELDS.DATE_COMPLETUDE);
  const values = range.getValues();

  values.forEach((row, i) => {
    if (String(row[FIELDS.MATRICULE - 1]).trim() === '') return;
    const status = computeCompleteness(row);
    sheet.getRange(CONFIG.HEADER_ROW + 1 + i, FIELDS.COMPLETUDE).setValue(status);
  });
}
