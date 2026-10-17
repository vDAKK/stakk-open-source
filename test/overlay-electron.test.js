'use strict';

/**
 * Où l'overlay cherche son binaire Electron.
 *
 * Le plugin ne cherchait que `electron.exe`. Sur macOS ce fichier n'existe
 * pas — le binaire est enfoui dans un bundle `Electron.app` — et l'overlay ne
 * démarrait donc jamais. Ça ne se voyait pas comme une panne : simplement une
 * fonctionnalité absente, sur toute une plateforme.
 *
 * Ces tests fixent les deux jeux de chemins, et le fait que la racine se
 * cherche aussi via `STAKK_APP_ROOT` — dans un bundle .app, `APP_ROOT` peut
 * pointer sur le dossier de l'exécutable et non sur la racine livrée. C'est le
 * même motif que la résolution de `.license`.
 *
 *   node test/overlay-electron.test.js
 */

const assert = require('assert');
const path = require('path');
const createOverlayBackend = require('../lib/overlay-backend');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

// Monte le plugin avec un faux fs : `presents` liste les chemins qui existent,
// `vus` enregistre tout ce qui a été cherché. Aucun processus n'est lancé — le
// spawn est remplacé, et les tests s'arrêtent avant de toute façon.
function monter({ plateforme, presents = [], appRoot = '/app', envRoot }) {
  const vus = [];
  const routes = {};
  const vraiePlateforme = process.platform;
  const vraiEnv = process.env.STAKK_APP_ROOT;
  Object.defineProperty(process, 'platform', { value: plateforme, configurable: true });
  if (envRoot) process.env.STAKK_APP_ROOT = envRoot;
  else delete process.env.STAKK_APP_ROOT;

  try {
    createOverlayBackend({
      fs: {
        existsSync: (p) => { vus.push(p); return presents.includes(p); },
        mkdirSync: () => {},
        readFileSync: () => { throw new Error('absent'); },
        writeFileSync: () => {},
      },
      path, os: require('os'), https: require('https'),
      log: () => {},
      registerRoute: (m, p, h) => { routes[`${m} ${p}`] = h; },
      APP_ROOT: appRoot,
      WEB_PORT: 3000,
    });
    const r = routes['POST /api/overlay/start']();
    return { vus, resultat: r };
  } finally {
    Object.defineProperty(process, 'platform', { value: vraiePlateforme, configurable: true });
    if (vraiEnv === undefined) delete process.env.STAKK_APP_ROOT;
    else process.env.STAKK_APP_ROOT = vraiEnv;
  }
}

const macRelease = path.join('/app', 'electron', 'Electron.app', 'Contents', 'MacOS', 'Electron');
const macDev = path.join('/app', 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
const winRelease = path.join('/app', 'electron', 'electron.exe');
const winDev = path.join('/app', 'node_modules', 'electron', 'dist', 'electron.exe');

test('sur macOS, le binaire est cherché dans le bundle Electron.app', () => {
  const { vus } = monter({ plateforme: 'darwin' });
  assert.ok(vus.includes(macRelease), `chemin release macOS jamais essayé\n       essayés : ${vus.join('\n                 ')}`);
  assert.ok(vus.includes(macDev), 'chemin node_modules macOS jamais essayé');
});

test('sur macOS, on ne cherche jamais un .exe', () => {
  const { vus } = monter({ plateforme: 'darwin' });
  assert.ok(!vus.some(p => p.endsWith('.exe')), `un .exe a ete cherche sur macOS : ${vus.filter(p => p.endsWith('.exe'))}`);
});

test('sur Windows, les chemins .exe sont conservés', () => {
  const { vus } = monter({ plateforme: 'win32' });
  assert.ok(vus.includes(winRelease), 'chemin release Windows jamais essayé');
  assert.ok(vus.includes(winDev), 'chemin node_modules Windows jamais essayé');
});

test('sur Windows, on ne cherche pas un bundle .app', () => {
  const { vus } = monter({ plateforme: 'win32' });
  assert.ok(!vus.some(p => p.includes('Electron.app')), 'un bundle .app a ete cherche sur Windows');
});

test('la racine STAKK_APP_ROOT est essayée aussi', () => {
  // Dans un bundle .app, APP_ROOT peut pointer sur le dossier de l'exécutable
  // et non sur la racine livrée : sans ce second essai, l'overlay ne trouve
  // rien alors que tout est là.
  const { vus } = monter({ plateforme: 'darwin', appRoot: '/ailleurs', envRoot: '/vraie-racine' });
  const attendu = path.join('/vraie-racine', 'electron', 'Electron.app', 'Contents', 'MacOS', 'Electron');
  assert.ok(vus.includes(attendu), 'STAKK_APP_ROOT jamais essayé');
});

test('binaire introuvable : le message nomme ce qui manque, par plateforme', () => {
  const mac = monter({ plateforme: 'darwin' }).resultat;
  assert.strictEqual(mac.ok, false);
  assert.ok(/Electron\.app/.test(mac.error), `message macOS inutile : ${mac.error}`);

  const win = monter({ plateforme: 'win32' }).resultat;
  assert.strictEqual(win.ok, false);
  assert.ok(/electron\.exe/.test(win.error), `message Windows inutile : ${win.error}`);
});

test('binaire trouvé mais bootstrap absent : le message dit lequel manque', () => {
  const r = monter({ plateforme: 'darwin', presents: [macRelease] }).resultat;
  assert.strictEqual(r.ok, false);
  assert.ok(/bootstrap/.test(r.error), `message inattendu : ${r.error}`);
});

console.log(`\n${passed} test(s) OK`);
