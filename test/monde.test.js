'use strict';

/**
 * Graphe du monde — quelle carte est au sud, et par quelle case y aller.
 *
 * La donnée vient d'Ankama : le `world-graph` que le client Unity embarque,
 * extrait puis compilé. Ces tests vérifient qu'on la lit bien, et surtout
 * qu'on ne la remplace pas par un calcul sur les coordonnées — tentant, faux
 * une fois sur vingt-cinq, et faux précisément là où ça compte (intérieurs,
 * changements de niveau).
 *
 *   node test/monde.test.js
 */

const assert = require('assert');
const createMonde = require('../lib/monde');
const { DIRECTIONS } = createMonde;

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

// Un monde miniature : trois cartes alignées d'ouest en est, plus un intérieur
// qui ne bouge pas d'un pouce en coordonnées.
const TABLE = {
  sorties: {
    100: { [DIRECTIONS.EST]: [[200, 300], [200, 315]], [DIRECTIONS.SUD]: [[400, 500]] },
    200: { [DIRECTIONS.EST]: [[300, 42]], [DIRECTIONS.OUEST]: [[100, 26]] },
    // Deux destinations à l'est : la « pleine » porte deux cases, le recoin une.
    300: { [DIRECTIONS.EST]: [[900, 1], [400, 2], [400, 3]] },
    400: { [DIRECTIONS.NORD]: [[100, 7, 'quête finie']] },
  },
  coords: {
    100: [0, 0, 1], 200: [1, 0, 1], 300: [2, 0, 1],
    400: [0, 1, 1], 900: [0, 0, -1],
  },
};

const monde = createMonde({ table: TABLE });

// ─── Situer ────────────────────────────────────────────────────────────────

test('une carte se situe en coordonnées', () => {
  assert.deepStrictEqual(monde.coords(200), { x: 1, y: 0, monde: 1 });
  assert.strictEqual(monde.coords(999), null);
});

test('une carte inconnue se déclare inconnue', () => {
  assert.strictEqual(monde.estConnue(100), true);
  assert.strictEqual(monde.estConnue(999), false);
});

test('la distance se mesure en cartes, pas en cases', () => {
  assert.strictEqual(monde.distance(100, 300), 2);
  assert.strictEqual(monde.distance(100, 400), 1);
  assert.strictEqual(monde.distance(100, 999), null);
});

test('plusieurs cartes peuvent partager des coordonnées', () => {
  // Un intérieur occupe la même case du monde que l'extérieur : c'est
  // exactement ce qui interdit de naviguer par calcul sur (x, y).
  assert.deepStrictEqual(monde.cartesEn(0, 0).sort((a, b) => a - b), [100, 900]);
  assert.deepStrictEqual(monde.cartesEn(0, 0, 1), [100]);
});

// ─── Sortir ────────────────────────────────────────────────────────────────

test('les sorties d\'une direction sont rendues avec leurs cases', () => {
  assert.deepStrictEqual(monde.sorties(100, DIRECTIONS.EST), [
    { map: 200, cellule: 300, critere: null },
    { map: 200, cellule: 315, critere: null },
  ]);
});

test('une direction sans sortie rend une liste vide, pas une erreur', () => {
  assert.deepStrictEqual(monde.sorties(100, DIRECTIONS.NORD), []);
  assert.deepStrictEqual(monde.sorties(999, DIRECTIONS.EST), []);
  assert.strictEqual(monde.voisine(100, DIRECTIONS.NORD), null);
});

test('une sortie conditionnelle est écartée par défaut', () => {
  // L'emprunter sans savoir évaluer son critère ferait échouer le
  // déplacement, et le moteur croirait s'être déplacé.
  assert.deepStrictEqual(monde.sorties(400, DIRECTIONS.NORD), []);
  const avec = monde.sorties(400, DIRECTIONS.NORD, { avecCritere: true });
  assert.strictEqual(avec.length, 1);
  assert.strictEqual(avec[0].critere, 'quête finie');
});

test('la voisine retenue est celle qu\'atteignent le plus de cases', () => {
  // Un recoin accessible par une seule case de bord ne doit pas l'emporter
  // sur la voisine « pleine ».
  assert.deepStrictEqual(monde.voisine(300, DIRECTIONS.EST), { map: 400, cellules: [2, 3] });
});

test('la voisine rend toutes ses cases de sortie', () => {
  assert.deepStrictEqual(monde.voisine(100, DIRECTIONS.EST), { map: 200, cellules: [300, 315] });
});

// ─── Suivre une direction ──────────────────────────────────────────────────

test('suivre une direction enchaîne les cartes', () => {
  const chemin = monde.suivre(100, DIRECTIONS.EST, 2);
  assert.deepStrictEqual(chemin.map(e => e.map), [200, 300]);
});

test('suivre s\'arrête au bord du monde plutôt que d\'inventer', () => {
  const chemin = monde.suivre(100, DIRECTIONS.EST, 10);
  assert.deepStrictEqual(chemin.map(e => e.map), [200, 300, 400]);
});

test('suivre coupe court sur une boucle', () => {
  // Certaines zones se rebouclent : sans garde, suivre une direction
  // tournerait en rond jusqu'au nombre de pas demandé.
  const boucle = createMonde({
    table: { sorties: { 1: { 0: [[2, 10]] }, 2: { 0: [[1, 20]] } }, coords: {} },
  });
  assert.deepStrictEqual(boucle.suivre(1, 0, 10).map(e => e.map), [2]);
});

// ─── La table réelle ───────────────────────────────────────────────────────

test('le graphe compilé couvre le monde', () => {
  const reel = createMonde();
  assert.ok(reel.nbCartes() > 15000, `${reel.nbCartes()} cartes seulement`);
});

test('les directions du graphe concordent avec les coordonnées', () => {
  // Le contrôle qui a fixé la convention : est = x+1, sud = y+1. On échantillonne
  // large et on exige une écrasante majorité — pas l'unanimité, puisque les
  // intérieurs et les changements de niveau ne bougent pas les coordonnées.
  const reel = createMonde();
  const attendu = { 0: [1, 0], 2: [0, 1], 4: [-1, 0], 6: [0, -1] };
  let bons = 0, total = 0;
  for (const [map, c] of Object.entries({ ...sampleCartes(reel) })) {
    for (const [dir, delta] of Object.entries(attendu)) {
      const v = reel.voisine(Number(map), Number(dir));
      if (!v) continue;
      const b = reel.coords(v.map);
      if (!b) continue;
      total++;
      if (b.x - c.x === delta[0] && b.y - c.y === delta[1]) bons++;
    }
  }
  assert.ok(total > 500, `échantillon trop petit : ${total}`);
  assert.ok(bons / total > 0.9, `seulement ${(100 * bons / total).toFixed(1)} % de concordance`);
});

function sampleCartes(reel) {
  // Un échantillon déterministe : les cartes d'Amakna autour de l'origine.
  const out = {};
  for (let x = -10; x <= 10; x++) {
    for (let y = -10; y <= 10; y++) {
      for (const id of reel.cartesEn(x, y, 1)) out[id] = { x, y };
    }
  }
  return out;
}

console.log(`\n${passed} tests OK`);
