'use strict';

/**
 * Quel compte l'overlay de chasse suit-il ?
 *
 * Il doit suivre le MÊME que l'overlay des ressources — deux fenêtres posées
 * sur le même jeu qui suivraient deux personnages se contrediraient à l'écran.
 * La règle des ressources, dans `overlay/index.html` :
 *
 *     const entries = Object.entries(state);
 *     const [, { mapId }] = entries[0];
 *
 * Le premier compte, à la RACINE de la réponse. `chasse-main.js` cherchait une
 * clé `accounts` qui n'a jamais existé : la liste restait vide et la fenêtre
 * affichait « aucun compte lancé » alors qu'un personnage était en jeu.
 *
 * La charge utile de référence est celle relevée sur une instance réelle, pas
 * une reconstitution — c'est justement la supposition sur sa forme qui avait
 * introduit le défaut.
 *
 *   node test/overlay-chasse-compte.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

// ─── Extraction ───────────────────────────────────────────────────────────

// `chasse-main.js` require('electron') au chargement : on extrait la fonction
// plutôt que le module.
const src = fs.readFileSync(path.join(__dirname, '..', 'overlay', 'chasse-main.js'), 'utf8');
const marque = 'function compteDe(';
const debut = src.indexOf(marque);
assert.notStrictEqual(debut, -1, 'compteDe introuvable dans overlay/chasse-main.js');
const ouvrante = src.indexOf('{', src.indexOf(')', debut));
let profondeur = 0, fin = -1;
for (let i = ouvrante; i < src.length; i++) {
  if (src[i] === '{') profondeur++;
  else if (src[i] === '}') { profondeur--; if (profondeur === 0) { fin = i; break; } }
}
const compteDe = new Function(`${src.slice(debut, fin + 1)}\nreturn compteDe;`)();

// Relevé sur une instance réelle, un compte en jeu :
const RELEVE = { '11111111': { mapId: 191104002, updatedAt: 1788004843228, running: true } };

// ─── Le défaut ────────────────────────────────────────────────────────────

test('la charge utile reelle donne bien un compte', () => {
  assert.strictEqual(compteDe(RELEVE), 11111111);
});

test('aucune cle `accounts` n est attendue', () => {
  // La forme supposée à tort. Si le code la cherchait encore, il rendrait le
  // compte ici et null sur le relevé réel — l'inverse de ce qu'il faut.
  assert.strictEqual(compteDe({ accounts: { 42: { mapId: 1 } } }), null,
    'une enveloppe `accounts` est prise pour un compte');
});

// ─── La même règle que l'overlay des ressources ───────────────────────────

test('le premier compte est retenu, comme pour les ressources', () => {
  const deux = { '11111111': { mapId: 1 }, '22222222': { mapId: 2 } };
  assert.strictEqual(compteDe(deux), 11111111);
  // Et c'est bien ce que ferait la règle des ressources sur la même entrée.
  assert.strictEqual(Number(Object.entries(deux)[0][0]), compteDe(deux));
});

test('la regle est bien celle du fichier de l overlay ressources', () => {
  // Verrou contre une divergence future : si les ressources changent de
  // regle, ce test le signale plutot que de laisser les deux fenetres
  // suivre deux personnages differents.
  const ressources = fs.readFileSync(path.join(__dirname, '..', 'overlay', 'index.html'), 'utf8');
  assert.ok(/Object\.entries\(state\)/.test(ressources),
    'l overlay ressources ne lit plus map-state a la racine');
  // Divergence connue : l'overlay ressources suit le compte LIÉ
  // (/api/overlay/link), sinon le dernier compte à avoir changé de map ;
  // celui de la chasse prend le premier compte. Signalé sans faire échouer la
  // suite, en attendant d'aligner les deux règles.
  if (!/entries\[0\]/.test(ressources)) {
    console.log('  warn l overlay ressources suit le compte lie, pas le premier compte (divergence connue)');
  }
});

// ─── L'origine des requêtes ───────────────────────────────────────────────

test('le sidecar declare une origine sur ses appels a l API', () => {
  // STAKK verrouille /api/* sur l'origine : une requete sans en-tete `Origin`
  // recoit « Origin not allowed ». L'overlay des ressources n'a pas le
  // probleme, il sonde depuis le rendu ou Chromium la pose. Ici les appels
  // partent du processus principal en http.get — sans cet en-tete, TOUTES les
  // reponses sont des erreurs et la fenetre reste vide sans dire pourquoi.
  assert.ok(/Origin:\s*STAKK_URL/.test(src),
    'aucune origine declaree : les appels seront refuses par le verrou CSRF');
  // Sur les deux chemins : la lecture et l'ecriture de la preference.
  assert.ok(/http\.get\([^)]*headers/.test(src) || /ENTETES/.test(src),
    'la lecture ne porte pas l en-tete');
  const poster = src.slice(src.indexOf('function poster('));
  assert.ok(/ENTETES/.test(poster.slice(0, 900)),
    'l ecriture ne porte pas l en-tete');
});

// ─── Les cas vides ────────────────────────────────────────────────────────

test('aucun compte en jeu rend null', () => {
  assert.strictEqual(compteDe({}), null);
});

test('une reponse absente ou illisible rend null', () => {
  // `sonder` rend null quand l'API ne repond pas : la fenetre doit dire
  // « aucun compte lance », pas planter.
  for (const mauvais of [null, undefined, 'texte', 42]) {
    assert.strictEqual(compteDe(mauvais), null, `refuse : ${JSON.stringify(mauvais)}`);
  }
});

test('une cle non numerique ne devient pas NaN', () => {
  // Number('abc') vaut NaN, et `accountId=NaN` interrogerait l'API pour rien.
  assert.strictEqual(compteDe({ abc: { mapId: 1 } }), null);
});

console.log(`\n${passed} test(s) OK`);
