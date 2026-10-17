'use strict';

/**
 * Quelle étape l'observateur suit-il, et d'où résout-il son indice ?
 *
 * Ce fichier existe à cause d'un défaut précis : le plugin lisait `genre`,
 * `direction` et `indice` À LA RACINE de l'événement de chasse. Ils n'y sont
 * pas — ils vivent dans chaque entrée de `etapes`. Les trois valaient donc
 * `undefined`, et l'overlay restait vide alors que les événements arrivaient
 * ET se décodaient parfaitement. Mesuré en jeu :
 *
 *     "lecture": { "paquets": 197, "enveloppes": 183, "chasse": 4, "lues": 4 }
 *
 * Quatre événements lus, zéro étape affichée. C'est ce que ces tests
 * verrouillent : la forme de l'événement, et le choix qu'on y fait.
 *
 *   node test/chasse-etape.test.js
 */

const assert = require('assert');
const { etapeCourante, origineDe } = require('../lib/chasse');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

// La forme que rend `chasse-protocol.lireEtape`. Les entrées de `etapes`
// portent ce que `lireVariante` produit.
const evenement = (etapes, drapeaux, depart) => ({
  questType: 2,
  depart: depart === undefined ? 88085249 : depart,
  drapeaux: drapeaux || [],
  etapes: etapes || [],
  etapeNum: 0, etapesTotal: 5, derniereEtape: false,
});
const etape = (indice, direction, genre) => ({
  genre: genre || 'aller', variante: 'flvw', direction,
  directionNom: null, indice, parametres: [indice], brut: {},
});

// ─── L'étape courante ─────────────────────────────────────────────────────

test('le dernier indice revele est celui a chercher', () => {
  // Vérifié en capture : chaque drapeau correct RÉVÈLE l'indice suivant.
  // 1 indice → drapeau bon → 2 indices. La liste est le compteur fiable.
  const ev = evenement([etape(927, 0), etape(965, 6)]);
  assert.strictEqual(etapeCourante(ev).indice, 965);
  assert.strictEqual(etapeCourante(ev).direction, 6);
});

test('une chasse a peine commencee a une seule etape', () => {
  assert.strictEqual(etapeCourante(evenement([etape(927, 2)])).indice, 927);
});

test('une chasse sans etape revelee ne rend rien', () => {
  assert.strictEqual(etapeCourante(evenement([])), null);
});

test('un evenement mal forme ne fait pas planter la lecture', () => {
  // Le gestionnaire de paquets tourne sur CHAQUE paquet : une exception y
  // couperait le trafic du joueur.
  for (const mauvais of [null, undefined, {}, { etapes: null }, { etapes: 'x' }]) {
    assert.strictEqual(etapeCourante(mauvais), null, `refuse : ${JSON.stringify(mauvais)}`);
  }
});

test('les champs ne sont PAS lus a la racine de l evenement', () => {
  // Le défaut d'origine, verrouillé : un événement dont la racine porterait
  // ces champs ne doit pas les faire passer pour l'étape courante.
  const piege = Object.assign(evenement([]), { genre: 'aller', direction: 4, indice: 999 });
  assert.strictEqual(etapeCourante(piege), null,
    'les champs de la racine sont pris pour une etape');
});

// ─── L'origine de l'étape ─────────────────────────────────────────────────

test('l origine est le dernier drapeau pose', () => {
  // Bon ou mauvais : le personnage y est allé, c'est de là qu'il repart.
  const ev = evenement([etape(965, 6)], [
    { valide: true, mapId: 88081665 },
    { valide: false, mapId: 88081670 },
  ]);
  assert.strictEqual(origineDe(ev), 88081670);
});

test('sans drapeau, l origine est la carte de depart de la chasse', () => {
  assert.strictEqual(origineDe(evenement([etape(927, 0)], [])), 88085249);
});

test('un drapeau sans carte lisible est ignore au profit du precedent', () => {
  const ev = evenement([etape(965, 6)], [
    { valide: true, mapId: 88081665 },
    { valide: true, mapId: null },
  ]);
  assert.strictEqual(origineDe(ev), 88081665);
});

test('sans drapeau ni depart, il n y a pas d origine', () => {
  // Mieux vaut ne rien résoudre que de résoudre depuis un endroit invente.
  assert.strictEqual(origineDe(evenement([etape(927, 0)], [], null)), null);
});

test('un evenement mal forme ne rend pas d origine', () => {
  for (const mauvais of [null, undefined, {}, { drapeaux: 'x' }]) {
    assert.strictEqual(origineDe(mauvais), null);
  }
});

test('l origine n est jamais la position du joueur', () => {
  // Entre le drapeau et maintenant, le joueur a pu marcher. Partir de sa
  // position ferait resoudre l'indice depuis un endroit qui n'a jamais servi
  // de point de depart — et l'API rendrait une carte fausse, pas une erreur.
  const ev = evenement([etape(965, 6)], [{ valide: true, mapId: 88081665 }]);
  assert.strictEqual(origineDe(ev), 88081665);
  assert.notStrictEqual(origineDe(ev), 190842882); // la carte ou le joueur etait
});

console.log(`\n${passed} test(s) OK`);
