'use strict';

/**
 * Chaque clé de traduction utilisée par le module Chasse existe dans les cinq
 * langues.
 *
 * Une clé manquante ne casse rien : `t()` rend la clé brute, ou `undefined`.
 * L'utilisateur voit `chasseNoHuntHint` au milieu de sa page et personne ne
 * s'en aperçoit avant qu'il le signale — d'autant qu'on ne lit soi-même
 * jamais la page en allemand ou en portugais.
 *
 *   node test/i18n-chasse.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');
const LANGUES = 5;

// Les clés réellement appelées dans le code de la page.
const utilisees = [...new Set([...html.matchAll(/t\('(chasse[A-Za-z]+)'\)/g)].map(m => m[1]))];

// Les clés déclarées, par nom, avec leur nombre d'occurrences : une par
// dictionnaire.
const declarees = new Map();
for (const m of html.matchAll(/^\s+(chasse[A-Za-z]+):'/gm)) {
  declarees.set(m[1], (declarees.get(m[1]) || 0) + 1);
}

test('le module utilise bien des cles de traduction', () => {
  // Garde-fou du test lui-même : si l'extraction ne trouve rien, tout le
  // reste passerait au vert sans rien vérifier.
  assert.ok(utilisees.length >= 10, `${utilisees.length} cle(s) trouvee(s), extraction douteuse`);
});

test('chaque cle utilisee est traduite dans les cinq langues', () => {
  const manquantes = utilisees.filter(k => (declarees.get(k) || 0) !== LANGUES);
  assert.deepStrictEqual(manquantes, [],
    manquantes.map(k => `${k} : ${declarees.get(k) || 0}/${LANGUES}`).join(', '));
});

test('aucune cle declaree n est orpheline', () => {
  // Une clé traduite dans cinq langues mais appelée nulle part est du travail
  // de traduction perdu, et un indice qu'on a retiré du code sans nettoyer.
  const vues = new Set(utilisees);
  const orphelines = [...declarees.keys()].filter(k => !vues.has(k));
  assert.deepStrictEqual(orphelines, [], orphelines.join(', '));
});

console.log(`\n${passed} test(s) OK`);
