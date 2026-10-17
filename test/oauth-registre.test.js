'use strict';

/**
 * Lecture du handler zaap:// avant de l'écraser.
 *
 * Le login OAuth par navigateur détourne le protocole zaap:// le temps de
 * récupérer le code d'autorisation, puis remet en place celui du launcher
 * Ankama. Mal lire la valeur d'origine revient à ne pas pouvoir la restaurer,
 * et l'utilisateur perd les liens zaap:// de son launcher.
 *
 * Le piège est linguistique : le nom de la valeur par défaut est traduit, et
 * la console Windows ne rend pas l'UTF-8 — l'accent de « (par défaut) » arrive
 * abîmé. Les échantillons ci-dessous sont des sorties réelles de `reg query`.
 *   node test/oauth-registre.test.js
 */

const assert = require('assert');
const { parseRegDefault } = require('../lib/oauth-browser')({ haapi: {} });

let passed = 0, total = 0;
function test(name, fn) {
  total++;
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

const LANCEUR = '"C:\\Program Files\\Ankama\\Ankama Launcher\\Ankama Launcher.exe" "%1"';

test('sortie réelle d\'un Windows français (accent abîmé par la console)', () => {
  // Capturée sur le poste : `(par d\ufffdfaut)`, pas `(Défaut)`.
  const out = '\r\nHKEY_CURRENT_USER\\Software\\Classes\\zaap\\shell\\open\\command\r\n'
    + '    (par d\ufffdfaut)    REG_SZ    ' + LANCEUR + '\r\n\r\n';
  assert.strictEqual(parseRegDefault(out), LANCEUR);
});

test('sortie d\'un Windows anglais', () => {
  const out = '\r\nHKEY_CURRENT_USER\\Software\\Classes\\zaap\\shell\\open\\command\r\n'
    + '    (Default)    REG_SZ    ' + LANCEUR + '\r\n\r\n';
  assert.strictEqual(parseRegDefault(out), LANCEUR);
});

test('sortie d\'un Windows allemand', () => {
  const out = '\r\nHKEY_CURRENT_USER\\Software\\Classes\\zaap\\shell\\open\\command\r\n'
    + '    (Standard)    REG_SZ    ' + LANCEUR + '\r\n\r\n';
  assert.strictEqual(parseRegDefault(out), LANCEUR);
});

test('le chemin garde ses espaces et ses guillemets', () => {
  const out = '    (par defaut)    REG_SZ    ' + LANCEUR + '\r\n';
  const v = parseRegDefault(out);
  assert.ok(v.startsWith('"C:\\Program Files\\'), 'le chemin doit rester intact : ' + v);
  assert.ok(v.endsWith('"%1"'), 'l\'argument %1 doit rester : ' + v);
});

test('clé absente : rien à restaurer', () => {
  assert.strictEqual(parseRegDefault(''), null);
  assert.strictEqual(parseRegDefault(null), null);
  assert.strictEqual(parseRegDefault('Erreur : cl\ufffd introuvable.'), null);
});

test('le nom de la clé ne doit pas être pris pour une valeur', () => {
  // La 1re ligne utile est le chemin de la clé ; seule la ligne REG_SZ compte.
  const out = '\r\nHKEY_CURRENT_USER\\Software\\Classes\\zaap\\shell\\open\\command\r\n'
    + '    (par defaut)    REG_SZ    ' + LANCEUR + '\r\n\r\n';
  assert.ok(!parseRegDefault(out).includes('HKEY_CURRENT_USER'));
});

console.log(`\n${passed}/${total} tests OK`);
