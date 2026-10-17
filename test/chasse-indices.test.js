'use strict';

/**
 * Résolution des indices — où se trouve ce qu'on cherche.
 *
 * C'est la pièce qui manquait. Sans elle, la chasse avançait d'une carte et
 * posait un drapeau au hasard : sur une chasse réelle, l'indice 927 cherché
 * vers l'est depuis [2,9] se trouve CINQ cartes plus loin. Le drapeau sur la
 * première carte n'avait aucune chance d'aboutir.
 *
 * Ces tests tournent sur des réponses bouchonnées : aucun appel réseau, et le
 * comportement en cas d'API muette est vérifié pour ce qu'il est — un repli,
 * pas un arrêt.
 *
 *   node test/chasse-indices.test.js
 */

const assert = require('assert');
const createIndices = require('../lib/chasse-indices');

let passed = 0;
function test(name, fn) {
  const r = fn();
  const fini = () => { passed++; console.log(`  ok  ${name}`); };
  const rate = (e) => { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; };
  if (r && typeof r.then === 'function') return r.then(fini, rate);
  fini();
}

// Une réponse conforme à celle de l'API, réduite à ce qui nous sert.
const REPONSE = {
  data: [
    { id: 88081678, posX: 3, posY: 9, pois: [{ id: 875, name: { fr: 'Cairn' } }] },
    { id: 88082190, posX: 4, posY: 9, pois: [{ id: 1002, name: { fr: 'Rose noire' } }] },
    { id: 88083726, posX: 7, posY: 9, pois: [{ id: 927, name: { fr: "Gravure d'étoile" } }] },
  ],
};

function faux(reponse, compteur) {
  return {
    get(url, opts, cb) {
      if (compteur) compteur.n = (compteur.n || 0) + 1;
      const res = {
        statusCode: reponse ? 200 : 500,
        setEncoding() {}, resume() {},
        on(ev, f) {
          if (ev === 'data' && reponse) f(JSON.stringify(reponse));
          if (ev === 'end') setImmediate(f);
          return res;
        },
      };
      setImmediate(() => cb(res));
      return { setTimeout() {}, on() {}, destroy() {} };
    },
  };
}

const sansCache = (https) => createIndices({ https, fichier: null, log: () => {} });

test("l'indice cherché rend sa carte, pas la première venue", async () => {
  const r = await sansCache(faux(REPONSE)).resoudre(2, 9, 0, 927);
  assert.strictEqual(r.map, 88083726);
  assert.strictEqual(r.distance, 5, 'la distance doit refléter la position réelle');
  assert.strictEqual(r.nom, "Gravure d'étoile");
});

test('un indice absent de la direction rend null', async () => {
  // Le cas des phorreurs : mobiles, donc dans aucune liste. Rendre une carte
  // au hasard serait pire que ne rien rendre.
  assert.strictEqual(await sansCache(faux(REPONSE)).resoudre(2, 9, 0, 2673), null);
});

test('une API muette ne fait pas échouer la chasse, elle rend null', async () => {
  assert.strictEqual(await sansCache(faux(null)).resoudre(2, 9, 0, 927), null);
});

test('une réponse illisible rend null', async () => {
  assert.strictEqual(await sansCache(faux({ pasDeData: true })).resoudre(2, 9, 0, 927), null);
});

test('un indice non entier ne déclenche aucun appel', async () => {
  const c = {};
  assert.strictEqual(await sansCache(faux(REPONSE, c)).resoudre(2, 9, 0, null), null);
  assert.strictEqual(c.n, undefined, 'un appel réseau est parti pour rien');
});

test('la même direction depuis la même carte ne coûte qu un appel', async () => {
  const c = {};
  const r = sansCache(faux(REPONSE, c));
  await r.resoudre(2, 9, 0, 927);
  await r.resoudre(2, 9, 0, 1002);
  assert.strictEqual(c.n, 1, `${c.n} appels au lieu d'un`);
});

test("un échec n'est pas mis en cache", async () => {
  // Sinon une coupure réseau condamnerait la direction pour toute la session.
  const c = {};
  const r = sansCache(faux(null, c));
  await r.resoudre(2, 9, 0, 927);
  await r.resoudre(2, 9, 0, 927);
  assert.strictEqual(c.n, 2, 'un échec a été mémorisé');
});

setTimeout(() => console.log(`\n${passed} tests OK`), 50);
