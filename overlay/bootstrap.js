'use strict';

/**
 * STAKK overlay bootstrap.
 *
 * Point d'entrée Electron des deux overlays (ressources et chasse). Choisit le
 * main correspondant, appelle ce qui doit l'être avant app-ready, puis le
 * `require()` pour exécuter la logique dans le main process Electron (app,
 * BrowserWindow, globalShortcut, etc.).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Quel overlay démarre-t-on ? Les deux sont des sidecars distincts — fenêtre,
// position et interrupteur propres — et ce bootstrap les sert tous les deux.
//
// Le nom arrive par l'environnement plutôt que par argv : Electron 33+ traite
// tout argument supplémentaire comme un script d'entrée de plus et sort en
// silence si ce n'en est pas un.
const VARIANTE = process.env.STAKK_OVERLAY_VARIANTE === 'chasse' ? 'chasse' : 'ressources';
const FICHIER  = VARIANTE === 'chasse' ? 'chasse-main.js' : 'main.js';
const TARGET   = path.join(__dirname, FICHIER);

// Log de diagnostic partagé avec le main correspondant. Un fichier par
// variante : les deux processus tournent en même temps, et un log commun
// s'entrelacerait.
const DEBUG_LOG = path.join(os.tmpdir(),
  VARIANTE === 'chasse' ? 'stakk-chasse-debug.log' : 'stakk-overlay-debug.log');
function dbg(msg) {
  try { fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] [bootstrap] ${msg}\n`); }
  catch {}
}

try { fs.unlinkSync(DEBUG_LOG); } catch {}
dbg(`boot argv=${JSON.stringify(process.argv.slice(2))}`);

// Expose le dossier du bootstrap pour que main.js retrouve preload.js.
process.env.STAKK_OVERLAY_BUNDLED_DIR = __dirname;

// disableHardwareAcceleration() doit être appelé AVANT app-ready.
try {
  const { app } = require('electron');
  app.disableHardwareAcceleration();
  dbg('disableHardwareAcceleration OK');
} catch (e) { dbg(`disableHardwareAcceleration KO: ${e.message}`); }

dbg(`loading ${TARGET}`);
try {
  require(TARGET);
} catch (e) {
  dbg(`require FAILED: ${e.stack || e.message}`);
  process.exit(5);
}
