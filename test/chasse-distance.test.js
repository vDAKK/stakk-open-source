'use strict';

/**
 * Le nombre de cartes jusqu'à la cible.
 *
 * Ce chiffre s'affiche sur l'overlay, et le joueur s'en sert pour juger si la
 * cible est plausible. Il se prend donc sur le graphe du monde, jamais sur les
 * coordonnées : sur les 25048 transitions cardinales, un millier ne bougent pas
 * d'une case en x/y — intérieurs, changements de niveau, décalages en diagonale.
 * Un `|Δx| + |Δy|` s'y trompe, et un chiffre faux est pire qu'un chiffre absent
 * parce que le joueur y croirait.
 *
 *   node test/chasse-distance.test.js
 */

const assert = require('assert');
const { cartesJusqua } = require('../lib/chasse');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

const mondeFactice = (chemins) => ({
  itineraire: (a, b) => (chemins[`${a}->${b}`] === undefined ? null : chemins[`${a}->${b}`]),
});

test('le compte est la longueur de l itineraire', () => {
  const m = mondeFactice({ '10->50': [{ map: 20 }, { map: 30 }, { map: 50 }] });
  assert.strictEqual(cartesJusqua(m, 10, 50), 3);
});

test('etre deja sur la cible vaut zero carte', () => {
  const m = mondeFactice({ '10->10': [] });
  assert.strictEqual(cartesJusqua(m, 10, 10), 0);
});

test('aucun chemin rend null, pas un chiffre invente', () => {
  const m = mondeFactice({});
  assert.strictEqual(cartesJusqua(m, 10, 99), null);
});

test('sans graphe on ne compte pas', () => {
  assert.strictEqual(cartesJusqua(null, 10, 50), null);
  assert.strictEqual(cartesJusqua({}, 10, 50), null);
});

test('une carte non entiere ne compte pas', () => {
  const m = mondeFactice({ '10->50': [{ map: 50 }] });
  assert.strictEqual(cartesJusqua(m, 10, null), null);
  assert.strictEqual(cartesJusqua(m, undefined, 50), null);
});

test('le plafond de sauts est transmis au graphe', () => {
  // Une étape de chasse ne traverse jamais vingt cartes : un itinéraire plus
  // long signale une cible mal résolue, pas un long voyage. Sans plafond, le
  // parcours en largeur balaierait les 8251 cartes du monde à chaque paquet.
  let vu = null;
  cartesJusqua({ itineraire: (a, b, max) => { vu = max; return []; } }, 10, 50);
  assert.strictEqual(typeof vu, 'number', 'aucun plafond transmis');
  assert.ok(vu > 0 && vu <= 20, `plafond invraisemblable : ${vu}`);
});

console.log(`\n${passed} test(s) OK`);
