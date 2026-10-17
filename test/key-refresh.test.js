'use strict';

/**
 * Le plugin de refresh des clés HAAPI ne doit jamais tuer une clé.
 *
 * Trois règles se vérifient ici, et chacune correspond à une clé réellement
 * perdue en production :
 *
 *   1. Une clé qui porte un certificat ne se renouvelle pas. Le certificat
 *      Shield est rattaché à la clé qui l'a demandé : roter détache l'un de
 *      l'autre et le compte ne peut plus créer de token.
 *   2. `keyDead` se décide par une sonde directe (SignOnWithApiKey), jamais
 *      par la lecture d'un message d'erreur de refresh. Un échec réseau ou un
 *      endpoint qui refuse tout n'est pas une révocation.
 *   3. Toute écriture relit le fichier compte d'abord. Deux boucles de refresh
 *      tournent en parallèle ; celle qui écrit un objet lu au scan écrase la
 *      clé fraîche que l'autre vient de ranger.
 *
 * Aucun réseau : `https` est bouchonné et chaque harnais travaille dans son
 * propre dossier temporaire.
 *   node test/key-refresh.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;
const attente = [];
function test(name, fn) {
  attente.push(async () => {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
  });
}

const dossiers = [];

// ─── Harnais ───────────────────────────────────────────────────────────────
//
// `https` bouchonné : chaque appel est rangé dans `appels` puis servi par la
// fonction `repondre`, qui reçoit le chemin et décide du statut et du corps.
// C'est le seul point d'observation dont on a besoin — savoir QUELS endpoints
// le plugin tape est exactement ce que ces tests vérifient.

function makeHarness(opts = {}) {
  const routes = {};
  const listeners = {};
  const logs = [];
  const appels = [];
  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'stakk-keyrefresh-'));
  if (!opts.dir) dossiers.push(dir);

  const repondre = opts.repondre || (() => ({ status: 200, body: {} }));

  const https = {
    request(options, cb) {
      const chemin = options.path;
      appels.push({ path: chemin, host: options.hostname, apikey: (options.headers || {}).APIKEY });
      const r = repondre(chemin, options);
      setImmediate(() => {
        if (r.reseau) return; // erreur réseau : on déclenche 'error' plus bas
        const res = {
          statusCode: r.status,
          headers: {},
          on(ev, h) {
            if (ev === 'data') setImmediate(() => h(JSON.stringify(r.body === undefined ? {} : r.body)));
            if (ev === 'end') setImmediate(() => setImmediate(h));
          },
          pipe() {},
        };
        cb(res);
      });
      const req = {
        setTimeout() {},
        on(ev, h) { if (ev === 'error' && r.reseau) setImmediate(() => h(new Error('ECONNRESET'))); },
        write() {},
        end() {},
      };
      return req;
    },
  };

  const api = require('../lib/key-refresh')({
    fs, path, https,
    log: m => logs.push(String(m)),
    registerRoute: (m, p, h) => { routes[`${m} ${p}`] = h; },
    on: (ev, h) => { (listeners[ev] = listeners[ev] || []).push(h); },
    DATA_DIR: dir,
  });

  return { api, routes, listeners, logs, appels, dir };
}

function ecrireCompte(dir, id, champs) {
  fs.writeFileSync(path.join(dir, String(id)), JSON.stringify({
    accountId: id, login: 'compte' + id,
    key: 'cle-' + id, refreshToken: 'rt-' + id,
    refreshDate: Date.now() - 40 * 86400000, // largement au-delà du seuil 20j
    ...champs,
  }, null, 4));
}

function lireCompte(dir, id) {
  return JSON.parse(fs.readFileSync(path.join(dir, String(id)), 'utf8'));
}

const REFRESH = '/json/Ankama/v5/Api/RefreshApiKey';
const SIGNON = '/json/Ankama/v5/Account/SignOnWithApiKey';

// ─── 1. Les comptes à certificat ne sont jamais rotés ──────────────────────

test('un compte à certificat launcher n\'est pas renouvelé', async () => {
  const h = makeHarness();
  ecrireCompte(h.dir, 1, { certificate: { id: 42 }, hm1: 'abc', launcher: true });
  await h.routes['POST /api/key-refresh/now']({});
  const refreshs = h.appels.filter(a => a.path === REFRESH);
  assert.strictEqual(refreshs.length, 0, 'RefreshApiKey ne doit pas être appelé');
  assert.strictEqual(lireCompte(h.dir, 1).key, 'cle-1', 'la clé doit être intacte');
});

test('un compte customShield n\'est pas renouvelé', async () => {
  const h = makeHarness();
  ecrireCompte(h.dir, 2, { customShield: true, certificate: { id: 7 } });
  await h.routes['POST /api/key-refresh/now']({});
  assert.strictEqual(h.appels.filter(a => a.path === REFRESH).length, 0);
});

test('un compte sans certificat est bien renouvelé', async () => {
  const h = makeHarness({
    repondre: (p) => p === REFRESH
      ? { status: 200, body: { key: 'cle-neuve' } }
      : { status: 200, body: { account: { id: 3 } } },
  });
  ecrireCompte(h.dir, 3, {});
  await h.routes['POST /api/key-refresh/now']({});
  assert.strictEqual(lireCompte(h.dir, 3).key, 'cle-neuve');
});

// ─── 2. keyDead se décide par la sonde, pas par un message d'erreur ────────

test('keyDead posé quand la sonde répond 403', async () => {
  const h = makeHarness({
    repondre: (p) => p === SIGNON
      ? { status: 403, body: { status: 403, message: "Unauthorized service '\\Ankama\\Account'" } }
      : { status: 400, body: {} },
  });
  ecrireCompte(h.dir, 4, {});
  await h.routes['POST /api/key-refresh/now']({});
  assert.strictEqual(lireCompte(h.dir, 4).keyDead, true);
});

test('keyDead PAS posé quand la sonde échoue en réseau', async () => {
  const h = makeHarness({
    repondre: (p) => p === SIGNON ? { reseau: true } : { status: 500, body: {} },
  });
  ecrireCompte(h.dir, 5, {});
  await h.routes['POST /api/key-refresh/now']({});
  assert.strictEqual(lireCompte(h.dir, 5).keyDead, undefined,
    'une panne réseau n\'est pas une révocation');
});

test('keyDead PAS posé quand le refresh échoue mais que la clé vit', async () => {
  // Le cas qui a produit les faux positifs : RefreshApiKey renvoie
  // « Unauthorized service '\Ankama\Api' » alors que la clé est vivante.
  const h = makeHarness({
    repondre: (p) => p === SIGNON
      ? { status: 200, body: { account: { id: 6 } } }
      : { status: 403, body: { status: 403, message: "Unauthorized service '\\Ankama\\Api'" } },
  });
  ecrireCompte(h.dir, 6, {});
  await h.routes['POST /api/key-refresh/now']({});
  assert.strictEqual(lireCompte(h.dir, 6).keyDead, undefined);
});

test('keyDead retiré quand la clé re-vit', async () => {
  const h = makeHarness({
    repondre: (p) => p === SIGNON ? { status: 200, body: { account: { id: 7 } } } : { status: 500, body: {} },
  });
  ecrireCompte(h.dir, 7, { keyDead: true });
  await h.routes['POST /api/key-refresh/validate']({});
  assert.strictEqual(lireCompte(h.dir, 7).keyDead, undefined);
});

// ─── 3. Les écritures relisent le fichier avant d'écrire ───────────────────

test('l\'écriture de keyDead n\'écrase pas une modif concurrente', async () => {
  const h = makeHarness({
    repondre: (p) => {
      if (p === SIGNON) {
        // Simule l'autre boucle qui range une clé fraîche pendant la sonde.
        const f = lireCompte(h.dir, 8);
        f.key = 'cle-rangee-par-l-autre-boucle';
        f.persos = ['Dakk'];
        fs.writeFileSync(path.join(h.dir, '8'), JSON.stringify(f, null, 4));
        return { status: 403, body: { status: 403, message: 'Unauthorized service' } };
      }
      return { status: 400, body: {} };
    },
  });
  ecrireCompte(h.dir, 8, {});
  await h.routes['POST /api/key-refresh/now']({});
  const f = lireCompte(h.dir, 8);
  assert.strictEqual(f.keyDead, true, 'le drapeau doit être posé');
  assert.strictEqual(f.key, 'cle-rangee-par-l-autre-boucle', 'la clé fraîche doit survivre');
  assert.deepStrictEqual(f.persos, ['Dakk'], 'les champs voisins doivent survivre');
});

// ─── 4. L'import ne rote rien ──────────────────────────────────────────────

test('accounts-imported ne déclenche aucun renouvellement', async () => {
  const h = makeHarness({
    repondre: (p) => p === SIGNON ? { status: 200, body: { account: { id: 9 } } } : { status: 200, body: { key: 'NE-DOIT-PAS-ARRIVER' } },
  });
  // Compte tout frais : refreshDate maintenant, donc sous le seuil de toute façon.
  ecrireCompte(h.dir, 9, { refreshDate: Date.now() });
  await h.routes['POST /api/key-refresh/validate']({});
  assert.strictEqual(h.appels.filter(a => a.path === REFRESH).length, 0,
    'la validation d\'import est une sonde, pas un refresh');
  assert.ok(h.appels.some(a => a.path === SIGNON), 'elle doit sonder');
  assert.strictEqual(lireCompte(h.dir, 9).key, 'cle-9');
});

test('la validation sonde aussi les comptes à certificat', async () => {
  const h = makeHarness({
    repondre: () => ({ status: 403, body: { status: 403, message: 'Unauthorized service' } }),
  });
  ecrireCompte(h.dir, 10, { certificate: { id: 1 }, refreshDate: Date.now() });
  await h.routes['POST /api/key-refresh/validate']({});
  assert.strictEqual(lireCompte(h.dir, 10).keyDead, true,
    'le badge rouge doit marcher aussi pour un compte à certificat');
  assert.strictEqual(h.appels.filter(a => a.path === REFRESH).length, 0);
});

// ─── 5. La sonde reste clairsemée ──────────────────────────────────────────
//
// Le plugin est explicitement conçu pour ne pas marteler HAAPI (cf. son
// en-tête : « même compte refreshé depuis 2 IPs toutes les 30 min » est
// détectable côté Ankama). Or le démarrage déclenche deux validations à
// quelques secondes d'intervalle — l'import émet `accounts-imported`, puis le
// timer `ready` se déclenche. Sans garde, c'est 2 sondes par compte à chaque
// lancement de STAKK, pour une réponse qui n'a pas pu changer entre les deux.

test('deux validations rapprochées ne sondent qu\'une fois', async () => {
  const h = makeHarness({ repondre: () => ({ status: 200, body: { account: { id: 11 } } }) });
  ecrireCompte(h.dir, 11, {});
  await h.routes['POST /api/key-refresh/validate']({});
  const apres1 = h.appels.filter(a => a.path === SIGNON).length;
  await h.api._validateOnce(); // 2e passage interne, immédiat
  const apres2 = h.appels.filter(a => a.path === SIGNON).length;
  assert.strictEqual(apres1, 1, 'la première sonde doit avoir lieu');
  assert.strictEqual(apres2, 1, 'la seconde, immédiate, doit être court-circuitée');
});

test('la route reste utilisable pour forcer une re-sonde', async () => {
  const h = makeHarness({ repondre: () => ({ status: 200, body: { account: { id: 12 } } }) });
  ecrireCompte(h.dir, 12, {});
  await h.routes['POST /api/key-refresh/validate']({});
  await h.routes['POST /api/key-refresh/validate']({});
  assert.strictEqual(h.appels.filter(a => a.path === SIGNON).length, 2,
    'un clic explicite de l\'utilisateur doit toujours sonder');
});

(async () => {
  for (const t of attente) await t();
  for (const d of dossiers) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  console.log(`\n${passed}/${attente.length} tests OK`);
})();
