'use strict';

/**
 * plugins.js — Chargeur local des plugins STAKK.
 *
 * Un plugin est un module qui exporte une FACTORY `(deps) => api`. La deps bag
 * (fs, frida, runningHandles, registerRoute, on(event,…), etc.) est fournie
 * par web-server.js ; le plugin s'en sert pour brancher des routes HTTP et des
 * handlers sur les events lifecycle (launch / detach / ready /
 * accounts-imported). Un plugin ne require() jamais ses voisins : tout ce dont
 * il a besoin arrive par la deps bag.
 *
 * Deux sources :
 *   1. Plugins intégrés — livrés dans lib/, listés dans BUILTIN ci-dessous.
 *   2. Plugins utilisateur — tout fichier `*.js` déposé dans `<APP_ROOT>/plugins/`.
 *      Le nom du plugin est le nom du fichier sans extension. Un plugin
 *      utilisateur qui porte le nom d'un plugin intégré le remplace.
 *
 * Sélection via `<APP_ROOT>/plugins.json` (optionnel) :
 *   { "disabled": ["sub-tracker"] }
 * désactive n'importe quel plugin (intégré ou utilisateur).
 *
 * Une factory qui throw est loguée mais ne bloque pas les autres plugins.
 */

const fs   = require('fs');
const path = require('path');

// Le bundle ncc (build Mac) réécrit require() : un chemin calculé à
// l'exécution n'y serait pas résolu. __non_webpack_require__ est le vrai
// require de Node dans ce cas ; ailleurs, require suffit.
// eslint-disable-next-line no-undef
const dynRequire = typeof __non_webpack_require__ === 'function' ? __non_webpack_require__ : require;

// require() statiques : pkg ne sait embarquer que ce qu'il voit littéralement.
const BUILTIN = {
  'organizer':       () => require('./organizer'),
  'sub-tracker':     () => require('./sub-tracker'),
  'click-broadcast': () => require('./click-broadcast'),
  'overlay-backend': () => require('./overlay-backend'),
  'key-refresh':     () => require('./key-refresh'),
  'fm':              () => require('./fm'),
  'chasse':          () => require('./chasse'),
};

// État observable par l'UI (GET /api/modules).
//   name → { source: 'builtin' | 'user', status: 'loaded' | 'disabled' | 'error', error? }
const state = {};

function getStatus() {
  return { plugins: JSON.parse(JSON.stringify(state)) };
}

function readDisabled(appRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(appRoot, 'plugins.json'), 'utf8'));
    return new Set(Array.isArray(raw.disabled) ? raw.disabled : []);
  } catch {
    return new Set();
  }
}

function listUserPlugins(appRoot) {
  const dir = path.join(appRoot, 'plugins');
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.js'))
      .map(f => ({ name: f.slice(0, -3), file: path.join(dir, f) }));
  } catch {
    return [];
  }
}

/**
 * @param {object} deps - bag fournie à chaque factory de plugin
 * @param {object} opts - { appRoot, log }
 * @returns {Promise<Array<{name, result?, error?}>>}
 */
async function loadPlugins(deps, { appRoot, log = console.log } = {}) {
  const disabled = readDisabled(appRoot);
  const candidates = new Map(); // name → { source, load }

  for (const [name, load] of Object.entries(BUILTIN)) {
    candidates.set(name, { source: 'builtin', load });
  }
  for (const { name, file } of listUserPlugins(appRoot)) {
    candidates.set(name, { source: 'user', load: () => dynRequire(file) });
  }

  const results = [];
  for (const [name, c] of candidates) {
    if (disabled.has(name)) {
      state[name] = { source: c.source, status: 'disabled' };
      continue;
    }
    try {
      const factory = c.load();
      if (typeof factory !== 'function') throw new Error('le module n\'exporte pas de factory');
      const api = await factory(deps);
      state[name] = { source: c.source, status: 'loaded' };
      results.push({ name, result: api });
      log(`[plugin] ${name} chargé (${c.source})`);
    } catch (e) {
      state[name] = { source: c.source, status: 'error', error: e.message };
      results.push({ name, error: e.message });
      log(`[plugin] ${name} en échec : ${e.message}`);
    }
  }
  return results;
}

module.exports = { loadPlugins, getStatus, BUILTIN };
