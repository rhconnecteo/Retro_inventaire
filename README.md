# Gestion des Dossiers RH — Application Web (Google Apps Script)

Application web complète de suivi de complétude des dossiers RH (pièces
justificatives, scan, inventaire), avec tableau de bord et fiche détaillée
par collaborateur.

## Architecture

```
/
├── index.html          # Structure de l'interface
├── styles.css           # Design (Material-inspired, responsive)
├── script.js             # Logique frontend + appels API (fetch)
├── README.md              # Ce fichier
└── App Script/
      └── Code.gs            # Backend (API REST : doGet / doPost)
```

Le frontend **ne communique jamais directement avec Google Sheets**. Toutes
les lectures et écritures passent par les routes exposées dans `Code.gs`,
qui répondent en JSON.

---

## 1. Préparer le Google Sheets

1. Créez un Google Sheets (ou utilisez l'existant) contenant un onglet nommé
   **`Data`** (modifiable dans `CONFIG.SHEET_NAME` de `Code.gs`).
2. La ligne 1 doit contenir les en-têtes, et les données commencent en ligne 2.
3. Respectez impérativement l'ordre des colonnes suivant :

   | Colonne | Contenu |
   |---|---|
   | A | Matricule |
   | B | Date d'embauche |
   | C | Nom et Prénoms |
   | D | Fonction |
   | E | Rattachement |
   | F → AE | Les 26 documents (CIN, résidence, bulletin n°3, photos, etc.) |
   | AF | INVENTAIRE (`OK` ou vide) |
   | AG | SCAN (`TRUE` / `FALSE`) |
   | AH | Commentaire Scan |
   | AI | Date Scan |
   | AJ | COMPLÉTUDE (`COMPLET` / `INCOMPLET`, calculée automatiquement) |
   | AK | Commentaire Complétude |
   | AL | Date Complétude |

4. Copiez l'**ID du Google Sheets** depuis son URL :
   `https://docs.google.com/spreadsheets/d/**ID_DU_SHEET**/edit`

---

## 2. Déployer le backend (Code.gs)

1. Ouvrez [script.google.com](https://script.google.com) → **Nouveau projet**.
2. Copiez le contenu de `App Script/Code.gs` dans l'éditeur.
3. Enregistrez l'ID du Sheets dans les propriétés du script (recommandé,
   évite de le coder en dur) :
   - Dans `Code.gs`, modifiez la fonction `setSheetId()` en collant votre ID.
   - Exécutez **une seule fois** cette fonction depuis l'éditeur Apps Script
     (menu **Exécuter**). Autorisez les accès demandés.
   - *(Alternative rapide : remplacez directement la valeur par défaut de
     `CONFIG.SHEET_ID` dans le code.)*
4. (Optionnel) Exécutez `recalculateAllCompleteness()` une fois pour
   initialiser la colonne AJ sur les données existantes.
5. **Déployer** → **Nouveau déploiement** :
   - Type : **Application Web**
   - Exécuter en tant que : **Moi**
   - Qui a accès : **Tout le monde** (ou selon votre politique interne)
6. Copiez l'**URL du Web App** générée (se termine par `/exec`).

---

## 3. Configurer le frontend

1. Ouvrez `script.js`.
2. Remplacez :
   ```js
   const API_URL = 'REMPLACER_PAR_URL_DU_WEB_APP';
   ```
   par l'URL copiée à l'étape précédente.
3. Ouvrez `index.html` (via l'extension **Live Server** de VS Code, ou tout
   serveur statique — évitez d'ouvrir le fichier en `file://` pour que les
   appels `fetch` fonctionnent correctement).

> **Remarque CORS** : les requêtes `POST` sont envoyées avec l'en-tête
> `Content-Type: text/plain` afin d'éviter le déclenchement d'une requête
> "preflight" (OPTIONS), qu'Apps Script ne gère pas nativement pour les
> Web Apps. Le corps JSON est ensuite parsé manuellement côté `Code.gs`.

---

## 4. Routes API disponibles

| Méthode | Action | Paramètres | Description |
|---|---|---|---|
| GET | `getEmployees` | — | Liste résumée de tous les collaborateurs |
| GET | `getEmployee` | `matricule` | Fiche complète d'un collaborateur |
| GET | `getDashboard` | — | Statistiques globales (tableau de bord) |
| POST | `updateScan` | `matricule, scan, commentaire` | Met à jour AG / AH / AI |
| POST | `updateInventory` | `matricule, value` | Met à jour AF (`OK` ou vide) |
| POST | `updateDocument` | `matricule, key, commentaire` | Force un document à `X`, recalcule AJ |

Toutes les réponses suivent le format :
```json
{ "success": true, "data": { ... } }
```
ou en cas d'erreur :
```json
{ "success": false, "error": "message d'erreur" }
```

---

## 5. Logique de complétude

- **`X`** → document complet (badge vert)
- **Valeur numérique** (ex. `2`) → il manque ce nombre d'éléments (badge orange)
- **`N/A`** → document non applicable (badge gris)
- **Toute autre valeur texte** → document non conforme (badge rouge)
- **Cellule vide** → document non fourni (badge rouge)

La colonne **AJ (COMPLÉTUDE)** est recalculée automatiquement à chaque
action de correction : le dossier est `COMPLET` seulement si **toutes** les
colonnes F→AE valent `X` ou `N/A`.

---

## 6. Fonctionnalités de l'interface

- 🔎 Recherche instantanée par **matricule** ou **nom**
- 📋 Fiche collaborateur avec badges colorés par document
- ✅ Case à cocher pour valider un document manquant (renseigne AK/AL et
  recalcule AJ automatiquement)
- 🖨️ Case à cocher **Scan** avec commentaire et horodatage
- 📦 Case à cocher **Inventaire**
- 📊 Tableau de bord : total collaborateurs, dossiers complets/incomplets,
  scans réalisés, inventaires réalisés, % de complétude
- 📈 Graphiques (Chart.js) : répartition complets/incomplets, documents les
  plus souvent manquants
- 🔔 Notifications toast, fenêtre modale, loader, design responsive
  (ordinateur et mobile)

---

## 7. Bonnes pratiques respectées

- Séparation stricte frontend / backend (aucun accès direct à Sheets)
- Verrouillage (`LockService`) sur les écritures pour éviter les
  conflits concurrents
- Code commenté et modulaire (fonctions à responsabilité unique)
- Échappement HTML systématique côté frontend (protection XSS basique)
- Gestion centralisée des erreurs API avec retour utilisateur (toast)
