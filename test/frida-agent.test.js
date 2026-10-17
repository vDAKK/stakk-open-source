'use strict';

/**
 * Le script injecté dans le jeu est-il du JavaScript valide ?
 *
 * Il vit dans un gabarit de chaîne : rien ne le vérifie au chargement du
 * module, et aucun autre test ne le lit comme du code. Une accolade en trop,
 * ou un simple backtick dans un commentaire — qui referme le gabarit — ne se
 * verrait qu'à l'injection, dans le jeu, chez l'utilisateur, sous la forme
 * d'un compte qui ne se lance pas.
 *
 * C'est arrivé en écrivant le correctif Windows de la redirection : un
 * `__errno_location` entre backticks dans un commentaire cassait tout le
 * module, et la suite restait verte parce qu'aucun test ne le require().
 *
 *   node test/frida-agent.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

const FICHIER = path.join(__dirname, '..', 'lib', 'frida-hook.js');
const src = fs.readFileSync(FICHIER, 'utf8');

/**
 * Le script tel qu'il sera injecté.
 *
 * Le gabarit est ÉVALUÉ, pas découpé au marqueur : il contient des gabarits
 * imbriqués (`${proxyPort > 0 ? ... : ...}`) qu'un remplacement par expression
 * régulière laisserait déséquilibrés — et ferait échouer le test pour une
 * raison sans rapport avec le code testé.
 */
function agent(proxyPort) {
  const debut = src.indexOf('return `', src.indexOf('function getSource'));
  assert.notStrictEqual(debut, -1, 'gabarit du script introuvable');
  const ouvrante = src.indexOf('`', debut);
  const fin = src.indexOf('\n`;', ouvrante);
  assert.notStrictEqual(fin, -1, 'fin du gabarit introuvable');
  const gabarit = src.slice(ouvrante, fin + 2);
  return new Function('proxyPort', 'spoof', 'fakeId', `return ${gabarit}`)(
    proxyPort, true, { hostname: 'DESKTOP-TEST' });
}

test('le module se charge', () => {
  // Un backtick égaré dans un commentaire du gabarit casse le fichier entier.
  assert.doesNotThrow(() => { delete require.cache[require.resolve(FICHIER)]; require(FICHIER); });
});

test('le script injecte avec proxy est du JS valide', () => {
  const s = agent(8103);
  assert.ok(s.length > 2000, `script suspicieusement court : ${s.length} caracteres`);
  assert.doesNotThrow(() => new Function(s), 'le script injecte ne parse pas');
});

test('le script injecte sans proxy est du JS valide', () => {
  // L'autre branche du gabarit, qu'un test sur le seul cas nominal raterait.
  assert.doesNotThrow(() => new Function(agent(0)));
});

test('le correctif de redirection est bien DANS le script injecte', () => {
  // Il pourrait vivre dans le module Node sans jamais atteindre le jeu : ce
  // qui compte est ce qui est injecte.
  const s = agent(8103);
  for (const attendu of ['codesToleres', 'estUnEchec', 'dernierCodeSocket', 'WSAGetLastError']) {
    assert.ok(s.includes(attendu), `${attendu} absent du script injecte`);
  }
});

test('le port du proxy est bien interpole', () => {
  // Garde-fou du test : si l'interpolation ne se faisait pas, tout le reste
  // verifierait un gabarit brut plutot que le script reel.
  assert.ok(agent(8103).includes('PROXY_PORT = 8103'), 'le port n est pas interpole');
});

console.log(`\n${passed} test(s) OK`);
