'use strict';

/**
 * Les deux overlays sont indépendants.
 *
 * C'est la propriété que ce module a d'abord ratée : la chasse au trésor
 * vivait comme un panneau greffé sous la grille des ressources, dans la même
 * fenêtre. On ne pouvait pas avoir l'une sans l'autre, et elles partageaient
 * position et taille.
 *
 * Ce sont maintenant deux sidecars distincts. Ce fichier verrouille ce qui les
 * sépare — processus, fichier de position, variante chargée, interrupteur —
 * parce que rien dans le code ne l'impose : c'est une décision, et une
 * refactorisation la reprendrait sans s'en apercevoir.
 *
 *   node test/overlay-sidecars.test.js
 */

const assert = require('assert');
const path = require('path');
const { EventEmitter } = require('events');
const createOverlayBackend = require('../lib/overlay-backend');

// Chaque montage pose un `process.on('exit')` pour tuer ses sidecars. En
// production il n'y a qu'une instance ; ici on en monte une par cas, et Node
// prévient au-delà de dix. Le seuil est relevé pour ce fichier seulement —
// masquer l'avertissement en production cacherait une vraie fuite.
process.setMaxListeners(50);

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

// Le binaire Electron et le bootstrap sont déclarés présents : ce qui est
// vérifié ici est le LANCEMENT, pas la résolution des chemins (couverte par
// overlay-electron.test.js).
const RACINE = '/app';
const BIN = path.join(RACINE, 'node_modules', 'electron', 'dist', 'electron.exe');
const BOOTSTRAP = path.join(RACINE, 'overlay', 'bootstrap.js');
const MAIN_RESSOURCES = path.join(RACINE, 'overlay', 'main.js');
const MAIN_CHASSE = path.join(RACINE, 'overlay', 'chasse-main.js');

function monter(options) {
  return monterAvec([BIN, BOOTSTRAP, MAIN_RESSOURCES, MAIN_CHASSE], options);
}

function monterAvec(presents) {
  const routes = {};
  const lances = [];
  let pidSuivant = 100;

  createOverlayBackend({
    fs: {
      existsSync: (p) => presents.includes(p),
      mkdirSync: () => {},
      readFileSync: () => { throw new Error('absent'); },
      writeFileSync: () => {},
    },
    path, os: require('os'), https: require('https'),
    log: () => {},
    registerRoute: (m, p, h) => { routes[`${m} ${p}`] = h; },
    APP_ROOT: RACINE,
    WEB_PORT: 3000,
    spawn: (bin, args, opts) => {
      const proc = new EventEmitter();
      proc.pid = pidSuivant++;
      proc.killed = false;
      proc.kill = () => { proc.killed = true; proc.emit('exit', 0, null); };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      lances.push({ bin, args, env: opts.env, proc });
      return proc;
    },
  });

  return {
    routes, lances,
    demarrerRessources: () => routes['POST /api/overlay/start'](),
    arreterRessources: () => routes['POST /api/overlay/stop'](),
    demarrerChasse: () => routes['POST /api/overlay/chasse/start'](),
    arreterChasse: () => routes['POST /api/overlay/chasse/stop'](),
    statut: () => routes['GET /api/overlay/status'](),
  };
}

// ─── L'indépendance ────────────────────────────────────────────────────────

test('la chasse a ses propres routes de demarrage et d arret', () => {
  const h = monter();
  assert.ok(h.routes['POST /api/overlay/chasse/start'], 'route de demarrage absente');
  assert.ok(h.routes['POST /api/overlay/chasse/stop'], 'route d arret absente');
});

test('demarrer la chasse ne lance PAS la grille des ressources', () => {
  // Le défaut d'origine, en une assertion : un seul processus doit partir.
  const h = monter();
  h.demarrerChasse();
  assert.strictEqual(h.lances.length, 1, `${h.lances.length} processus lances`);
  assert.strictEqual(h.statut().running, false, 'la grille des ressources est annoncee active');
  assert.strictEqual(h.statut().chasseRunning, true);
});

test('demarrer la grille ne lance PAS la chasse', () => {
  const h = monter();
  h.demarrerRessources();
  assert.strictEqual(h.lances.length, 1);
  assert.strictEqual(h.statut().chasseRunning, false);
  assert.strictEqual(h.statut().running, true);
});

test('les deux tournent ensemble, en deux processus', () => {
  const h = monter();
  h.demarrerRessources();
  h.demarrerChasse();
  assert.strictEqual(h.lances.length, 2);
  const s = h.statut();
  assert.strictEqual(s.running, true);
  assert.strictEqual(s.chasseRunning, true);
  assert.notStrictEqual(s.pid, s.chassePid, 'les deux overlays partagent un pid');
});

test('arreter l un laisse l autre tourner', () => {
  const h = monter();
  h.demarrerRessources();
  h.demarrerChasse();
  h.arreterChasse();
  const s = h.statut();
  assert.strictEqual(s.chasseRunning, false, 'la chasse tourne encore');
  assert.strictEqual(s.running, true, 'arreter la chasse a emporte la grille');
});

// ─── Ce qui distingue les deux processus ───────────────────────────────────

test('chaque sidecar charge sa propre variante', () => {
  const h = monter();
  h.demarrerRessources();
  h.demarrerChasse();
  const [grille, chasse] = h.lances;
  assert.strictEqual(grille.env.STAKK_OVERLAY_VARIANTE, 'ressources');
  assert.strictEqual(chasse.env.STAKK_OVERLAY_VARIANTE, 'chasse');
});

test('chaque sidecar a son propre fichier de position', () => {
  // Partager le fichier ferait sauter une fenêtre à la place de l'autre.
  const h = monter();
  h.demarrerRessources();
  h.demarrerChasse();
  const [grille, chasse] = h.lances;
  assert.ok(/overlay-bounds\.json$/.test(grille.env.STAKK_OVERLAY_BOUNDS),
    `bounds grille inattendu : ${grille.env.STAKK_OVERLAY_BOUNDS}`);
  assert.ok(/chasse-bounds\.json$/.test(chasse.env.STAKK_CHASSE_BOUNDS),
    `bounds chasse inattendu : ${chasse.env.STAKK_CHASSE_BOUNDS}`);
  assert.notStrictEqual(grille.env.STAKK_OVERLAY_BOUNDS, chasse.env.STAKK_CHASSE_BOUNDS);
});

test('la variante passe par l environnement, pas par argv', () => {
  // Electron 33+ traite tout argument supplémentaire comme un script d'entrée
  // de plus et sort en silence si ce n'en est pas un.
  const h = monter();
  h.demarrerChasse();
  const { args } = h.lances[0];
  assert.strictEqual(args.length, 2, `argv inattendu : ${JSON.stringify(args)}`);
  assert.ok(!args.some(a => /chasse/.test(String(a))), 'la variante est passee en argv');
});

// ─── Les garde-fous ────────────────────────────────────────────────────────

test('un second demarrage ne relance pas un processus', () => {
  const h = monter();
  const a = h.demarrerChasse();
  const b = h.demarrerChasse();
  assert.strictEqual(h.lances.length, 1, 'deux processus pour un seul overlay');
  assert.strictEqual(b.alreadyRunning, true);
  assert.strictEqual(b.pid, a.pid);
});

test('un exe trop ancien refuse la chasse au lieu d ouvrir la mauvaise fenetre', () => {
  // Le bootstrap et les `main` sont BUNDLÉS dans l'exe ; ce module-ci se met à
  // jour à chaud et arrive donc chez des exe plus anciens que lui. Sans ce
  // contrôle, un exe sans `chasse-main.js` lançait main.js — un SECOND overlay
  // des ressources à la place de celui demandé.
  const h = monterAvec([BIN, BOOTSTRAP, MAIN_RESSOURCES]);
  const r = h.demarrerChasse();
  assert.strictEqual(r.ok, false, 'la chasse a demarre sur un exe qui n en a pas le main');
  assert.strictEqual(r.majRequise, true);
  assert.ok(/jour/i.test(r.error), `message peu clair : ${r.error}`);
  assert.strictEqual(h.lances.length, 0, 'un processus a quand meme ete lance');
});

test('un exe trop ancien garde l overlay des ressources', () => {
  // Le contrôle ne doit pas déborder sur la fenêtre qui, elle, a toujours
  // existé.
  const h = monterAvec([BIN, BOOTSTRAP, MAIN_RESSOURCES]);
  assert.strictEqual(h.demarrerRessources().ok, true);
  assert.strictEqual(h.lances.length, 1);
});

test('arreter un overlay deja arrete ne casse rien', () => {
  const h = monter();
  assert.deepStrictEqual(h.arreterChasse(), { ok: true, wasRunning: false });
});

test('un overlay arrete peut redemarrer', () => {
  const h = monter();
  h.demarrerChasse();
  h.arreterChasse();
  assert.strictEqual(h.statut().chasseRunning, false);
  h.demarrerChasse();
  assert.strictEqual(h.statut().chasseRunning, true, 'impossible de relancer apres arret');
  assert.strictEqual(h.lances.length, 2);
});

console.log(`\n${passed} test(s) OK`);
