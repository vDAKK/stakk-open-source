'use strict';

/**
 * Quand un connect() redirigé compte-t-il comme un échec ?
 *
 * Un correctif macOS a ajouté un garde dans `onLeave` : ne poursuivre que si
 * l'erreur est « connexion en cours ». Il lisait l'errno par
 * `__errno_location`, un symbole glibc qui n'existe pas sous Windows. La
 * lecture échouait donc, le code retombait sur -1, -1 n'était dans aucune
 * valeur tolérée, et le CONNECT ne partait jamais vers le proxy.
 *
 * Le symptôme n'était pas une erreur mais une absence : les comptes ne
 * lançaient plus. Le journal montrait exactement ça —
 *
 *     REDIRECT FAIL 34.247.205.111:5555 rv=-1 errno=-1
 *
 * où `rv=-1` est le retour NORMAL d'un socket non bloquant et `errno=-1` la
 * valeur de repli d'une lecture qui n'a pas eu lieu.
 *
 * Les deux fonctions sont extraites du script Frida — elles vivent dans un
 * gabarit de chaîne, jamais require()able — et jouées telles quelles.
 *
 *   node test/frida-connect.test.js
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

const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'frida-hook.js'), 'utf8');

function extraire(nom) {
  const marque = `function ${nom}(`;
  const debut = src.indexOf(marque);
  assert.notStrictEqual(debut, -1, `${nom} introuvable dans lib/frida-hook.js`);
  const ouvrante = src.indexOf('{', src.indexOf(')', debut));
  let profondeur = 0, fin = -1;
  for (let i = ouvrante; i < src.length; i++) {
    if (src[i] === '{') profondeur++;
    else if (src[i] === '}') { profondeur--; if (profondeur === 0) { fin = i; break; } }
  }
  assert.notStrictEqual(fin, -1, `accolades de ${nom} desequilibrees`);
  return src.slice(debut, fin + 1);
}

const { codesToleres, estUnEchec } = new Function(
  `${extraire('codesToleres')}\n${extraire('estUnEchec')}\n`
  + 'return { codesToleres, estUnEchec };'
)();

// ─── Le défaut, reproduit ─────────────────────────────────────────────────

test('un code illisible ne compte PAS comme un echec', () => {
  // LE bug. Windows n'expose pas `__errno_location` : la lecture rendait null,
  // et null etait traite comme une erreur inconnue donc fatale. Plus aucun
  // compte ne se lancait.
  assert.strictEqual(estUnEchec(-1, null, codesToleres('windows')), false,
    'un code illisible fait encore echouer la redirection');
  assert.strictEqual(estUnEchec(-1, undefined, codesToleres('windows')), false);
});

test('le cas exact du journal : rv=-1 sans code lisible', () => {
  // REDIRECT FAIL 34.247.205.111:5555 rv=-1 errno=-1
  const toleres = codesToleres('windows');
  assert.strictEqual(estUnEchec(-1, null, toleres), false);
});

test('un code 0 ne compte PAS comme un echec', () => {
  // Le second defaut, releve en jeu apres le premier correctif :
  //   REDIRECT FAIL 108.128.247.72:5555 rv=-1 err=0 (windows)
  // WSAGetLastError() rend 0 — « aucune erreur » — parce que le trampoline de
  // Frida s'intercale entre connect() et onLeave. Zero est l'absence
  // d'information, pas un verdict.
  for (const plateforme of ['windows', 'darwin', 'linux']) {
    assert.strictEqual(estUnEchec(-1, 0, codesToleres(plateforme)), false,
      `un code 0 fait encore echouer la redirection sur ${plateforme}`);
  }
});

// ─── Windows ──────────────────────────────────────────────────────────────

test('WSAEWOULDBLOCK est le cas normal, pas un echec', () => {
  // Ce que Windows rend pour un connect non bloquant qui se poursuit.
  assert.strictEqual(estUnEchec(-1, 10035, codesToleres('windows')), false);
});

test('les autres codes d attente Windows passent aussi', () => {
  const toleres = codesToleres('windows');
  for (const code of [10036, 10037, 10004]) {
    assert.strictEqual(estUnEchec(-1, code, toleres), false, `code ${code} rejete`);
  }
});

test('un vrai refus Windows reste un echec', () => {
  // WSAECONNREFUSED : le socket n'ira nulle part, envoyer le CONNECT dessus
  // le ferait echouer en silence.
  assert.strictEqual(estUnEchec(-1, 10061, codesToleres('windows')), true);
});

test('les codes errno ne sont pas confondus avec ceux de Winsock', () => {
  // 36 est EINPROGRESS sous Darwin ; sous Windows ce n'est rien de connu et
  // ne doit pas etre tolere par accident.
  assert.strictEqual(estUnEchec(-1, 36, codesToleres('windows')), true);
});

// ─── macOS : le correctif d'origine doit tenir ────────────────────────────

test('EINPROGRESS reste tolere sur macOS', () => {
  const toleres = codesToleres('darwin');
  for (const code of [36, 35, 4]) {
    assert.strictEqual(estUnEchec(-1, code, toleres), false, `code ${code} rejete`);
  }
});

test('un vrai echec macOS est toujours detecte', () => {
  // ECONNREFUSED = 61 sur Darwin. C'est ce que le correctif mac cherchait a
  // voir : sans lui, l'echec ne laissait aucune trace.
  assert.strictEqual(estUnEchec(-1, 61, codesToleres('darwin')), true);
});

test('Linux a ses propres valeurs', () => {
  // EINPROGRESS vaut 115 sous Linux, pas 36 : reprendre la table Darwin y
  // ferait rejeter le cas normal.
  assert.strictEqual(estUnEchec(-1, 115, codesToleres('linux')), false);
  assert.strictEqual(estUnEchec(-1, 111, codesToleres('linux')), true);
});

// ─── Le cas trivial ───────────────────────────────────────────────────────

test('un connect qui reussit n est jamais un echec', () => {
  for (const plateforme of ['windows', 'darwin', 'linux']) {
    assert.strictEqual(estUnEchec(0, null, codesToleres(plateforme)), false);
    assert.strictEqual(estUnEchec(0, 10061, codesToleres(plateforme)), false,
      'un code residuel a fait echouer un connect reussi');
  }
});

// ─── Les tables ───────────────────────────────────────────────────────────

test('chaque plateforme a sa propre table', () => {
  const win = codesToleres('windows');
  const mac = codesToleres('darwin');
  assert.notDeepStrictEqual(win, mac, 'Windows et macOS partagent la meme table');
  assert.ok(win.includes(10035), 'WSAEWOULDBLOCK absent de la table Windows');
  assert.ok(mac.includes(36), 'EINPROGRESS absent de la table macOS');
});

test('le code lit bien WSAGetLastError sous Windows', () => {
  // La table ne sert a rien si l'erreur est lue au mauvais endroit : sous
  // Windows les erreurs de socket ne passent pas par errno.
  assert.ok(/WSAGetLastError/.test(src), 'WSAGetLastError n est pas interroge');
  assert.ok(/IS_WIN\s*\?/.test(src) || /if \(IS_WIN\)/.test(src),
    'aucun aiguillage par plateforme pour la lecture du code');
});

console.log(`\n${passed} test(s) OK`);
