'use strict';

/**
 * La préférence de copie automatique du /travel.
 *
 * Elle vit dans overlay-backend et pas dans le plugin de chasse : celui-ci
 * n'expose qu'une route GET, et un test lui interdit toute route qui écrit.
 * C'est aussi l'endroit des autres préférences du sidecar — langue, compte
 * lié — et elle se persiste comme elles.
 *
 * Deux clients la lisent : la page web et le raccourci Ctrl+Shift+C de
 * l'overlay. Le serveur en est la seule source, sinon les deux afficheraient
 * chacun sa vérité.
 *
 *   node test/overlay-chasse-copie.test.js
 */

const assert = require('assert');
const path = require('path');
const createOverlayBackend = require('../lib/overlay-backend');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

// Faux disque : `fichiers` sert à la fois de contenu initial et de trace de ce
// qui a été écrit.
function monter(fichiers = {}) {
  const routes = {};
  const ecrits = {};
  createOverlayBackend({
    fs: {
      existsSync: () => false,
      mkdirSync: () => {},
      readFileSync: (p) => {
        const cle = path.basename(p);
        if (fichiers[cle] === undefined) throw new Error('absent');
        return fichiers[cle];
      },
      writeFileSync: (p, contenu) => { ecrits[path.basename(p)] = contenu; },
    },
    path, os: require('os'), https: require('https'),
    log: () => {},
    registerRoute: (m, p, h) => { routes[`${m} ${p}`] = h; },
    APP_ROOT: '/app',
    WEB_PORT: 3000,
  });
  return {
    routes, ecrits,
    statut: () => routes['GET /api/overlay/status'](),
    poser: (body) => routes['POST /api/overlay/chasse-copie'](body),
  };
}

test('la copie est active par defaut', () => {
  // Le cas courant est de vouloir la copie : c'est la raison d'être du module.
  assert.strictEqual(monter().statut().chasseCopie, true);
});

test('la preference se coupe et se rallume', () => {
  const h = monter();
  assert.deepStrictEqual(h.poser({ actif: false }), { ok: true, chasseCopie: false });
  assert.strictEqual(h.statut().chasseCopie, false);
  assert.deepStrictEqual(h.poser({ actif: true }), { ok: true, chasseCopie: true });
  assert.strictEqual(h.statut().chasseCopie, true);
});

test('elle est ecrite sur disque pour survivre au redemarrage', () => {
  const h = monter();
  h.poser({ actif: false });
  const ecrit = Object.entries(h.ecrits).find(([nom]) => /chasse/.test(nom));
  assert.ok(ecrit, `rien d ecrit : ${Object.keys(h.ecrits)}`);
  assert.deepStrictEqual(JSON.parse(ecrit[1]), { copie: false });
});

test('elle est relue au demarrage', () => {
  const h = monter({ 'chasse.json': JSON.stringify({ copie: false }) });
  assert.strictEqual(h.statut().chasseCopie, false, 'la preference sauvegardee a ete ignoree');
});

test('un fichier illisible retombe sur le defaut', () => {
  // Un JSON tronqué ne doit pas empêcher l'overlay de démarrer.
  const h = monter({ 'chasse.json': '{ pas du json' });
  assert.strictEqual(h.statut().chasseCopie, true);
});

test('une valeur qui n est pas un booleen est refusee', () => {
  // Sans ce garde, `actif: "false"` — ce que rend un formulaire — passerait
  // pour vrai et l'interrupteur mentirait.
  const h = monter();
  for (const mauvais of [{ actif: 'false' }, { actif: 1 }, {}, null]) {
    const r = h.poser(mauvais);
    assert.ok(r && r.error, `accepte : ${JSON.stringify(mauvais)}`);
  }
  assert.strictEqual(h.statut().chasseCopie, true, 'la preference a bouge sur une valeur refusee');
});

console.log(`\n${passed} test(s) OK`);
