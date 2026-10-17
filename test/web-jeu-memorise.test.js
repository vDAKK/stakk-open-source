'use strict';

/**
 * Le canal de jeu choisi doit survivre à un rechargement de la page.
 *
 * Le piège est un ordre d'exécution. Les canaux secondaires (beta,
 * experimental) ne sont pas dans le HTML : `syncGameOptions()` les ajoute
 * après un aller-retour réseau. Or la restauration inline s'exécute avant, sur
 * un select qui n'a pas encore l'option — et affecter une valeur absente d'un
 * `<select>` met `value` à la chaîne vide, pas à la valeur demandée.
 *
 * `onGameChange()` est appelé dans la foulée au chargement. S'il persiste ce
 * `value` vide, il efface le choix de l'utilisateur avant même que
 * `syncGameOptions` ait la chance de le restaurer : le select retombe sur
 * Dofus 3 à chaque démarrage. Reproduit dans Chrome avant correction.
 *
 * `onGameChange` est extraite de `ui/index.html` et exécutée telle quelle.
 *   node test/web-jeu-memorise.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, total = 0;
function test(name, fn) {
  total++;
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');

function extraire(nom) {
  const marque = `function ${nom}(`;
  const debut = html.indexOf(marque);
  assert.notStrictEqual(debut, -1, `${nom} introuvable dans ui/index.html`);
  const ouvrante = html.indexOf('{', html.indexOf(')', debut));
  let profondeur = 0, fin = -1;
  for (let i = ouvrante; i < html.length; i++) {
    if (html[i] === '{') profondeur++;
    else if (html[i] === '}') { profondeur--; if (profondeur === 0) { fin = i; break; } }
  }
  assert.notStrictEqual(fin, -1, `accolades de ${nom} déséquilibrées`);
  return html.slice(debut, fin + 1);
}

// Bouchons minimaux : onGameChange ne touche qu'au select, à localStorage, à
// document.body.classList et à quelques fonctions de rendu optionnelles — que
// l'on laisse absentes, la page les teste avec `typeof`.
function contexte(valeurDuSelect) {
  const stockage = {};
  const localStorage = {
    getItem: k => (k in stockage ? stockage[k] : null),
    setItem: (k, v) => { stockage[k] = String(v); },
    removeItem: k => { delete stockage[k]; },
  };
  const select = { value: valeurDuSelect };
  const document = {
    getElementById: id => (id === 'game' ? select : null),
    body: { classList: { toggle() {} } },
    querySelectorAll: () => [],
  };
  const $ = id => document.getElementById(id);
  const fn = new Function('document', 'localStorage', 'window', '$',
    `${extraire('onGameChange')}\nreturn onGameChange;`)(document, localStorage, {}, $);
  return { fn, stockage, select };
}

test('un choix réel est bien mémorisé', () => {
  const c = contexte('experimental');
  c.fn();
  assert.strictEqual(c.stockage.game, 'experimental');
  assert.strictEqual(c.stockage.gamePrevPc, 'experimental');
});

test('un select vide n\'efface pas le choix mémorisé', () => {
  // L'état exact du chargement : l'option n'existe pas encore, donc le select
  // vaut ''. C'est ce cas qui faisait perdre le canal à chaque rechargement.
  const c = contexte('');
  c.stockage.game = 'experimental';
  c.stockage.gamePrevPc = 'experimental';
  c.fn();
  assert.strictEqual(c.stockage.game, 'experimental',
    'le choix a été écrasé par une chaîne vide');
  assert.strictEqual(c.stockage.gamePrevPc, 'experimental');
});

test('l\'appel au chargement ne persiste rien', () => {
  // Au chargement, le select affiche encore le défaut du HTML (dofus3) : son
  // option existe, elle, donc le garde sur la chaîne vide ne suffit pas.
  // Persister à ce moment-là écrase le canal mémorisé par « dofus3 ».
  const c = contexte('dofus3');
  c.stockage.game = 'experimental';
  c.stockage.gamePrevPc = 'experimental';
  c.fn({ persist: false });
  assert.strictEqual(c.stockage.game, 'experimental',
    'le choix a été écrasé par la valeur par défaut du select');
  assert.strictEqual(c.stockage.gamePrevPc, 'experimental');
});

test('Dofus Touch ne devient pas le dernier jeu PC', () => {
  const c = contexte('touch');
  c.stockage.gamePrevPc = 'experimental';
  c.fn();
  assert.strictEqual(c.stockage.game, 'touch');
  assert.strictEqual(c.stockage.gamePrevPc, 'experimental',
    'gamePrevPc doit rester le dernier jeu PC');
});

console.log(`\n${passed}/${total} tests OK`);
