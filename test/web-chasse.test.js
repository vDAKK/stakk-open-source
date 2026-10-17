'use strict';

/**
 * Ce que la carte Chasse affiche dans la page.
 *
 * Elle porte deux décisions qui trompent l'utilisateur si elles sont fausses :
 *
 *   - une carte vide doit dire POURQUOI. Entre « pas de chasse en cours »,
 *     « le jeu a été mis à jour » et « dofusdb injoignable », les gestes à
 *     faire diffèrent, et rien ne permet de deviner lequel s'applique.
 *   - un phorreur n'a pas de commande /travel. En afficher une enverrait le
 *     joueur à des coordonnées où il n'y a rien.
 *
 * `chasseVide` et `chasseCorps` sont extraites de `ui/index.html` et
 * exécutées telles quelles : les recopier ici ne prouverait rien.
 *
 *   node test/web-chasse.test.js
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

// `t` rend la clé elle-même : on vérifie QUELLE clé est choisie, pas sa
// traduction — celle-ci vit dans les cinq dictionnaires et changerait le test
// à chaque retouche de formulation.
//
// `fmEsc` en revanche est pris TEL QUEL dans la page : un stub qui n'échappe
// rien ferait passer les tests d'échappement pour une raison sans rapport avec
// le code testé.
const contexte = new Function(
  't',
  `${extraire('fmEsc')}\n${extraire('chasseVide')}\n${extraire('chasseCorps')}\n`
  + `${extraire('chasseDivergent')}\n${extraire('chasseSuivi')}\n`
  + 'return { chasseVide, chasseCorps, chasseDivergent, chasseSuivi, fmEsc };'
)((k) => k);

assert.strictEqual(contexte.fmEsc('<b>'), '&lt;b&gt;', "fmEsc extrait n'echappe pas");

const { chasseVide, chasseCorps, chasseDivergent, chasseSuivi } = contexte;

// ─── La carte vide dit pourquoi ───────────────────────────────────────────

test('sans chasse en cours, on le dit et on dit quoi faire', () => {
  const h = chasseVide({ protocoleConnu: true, resolveur: true, graphe: true });
  assert.ok(h.includes('chasseNoHunt'), 'ne dit pas qu aucune chasse ne tourne');
  assert.ok(h.includes('chasseNoHuntHint'), 'ne dit pas comment en lancer une');
});

test('un protocole non reconnu prend le pas sur le reste', () => {
  // Sans protocole, ni le résolveur ni le graphe n'ont d'objet : afficher
  // trois avertissements ferait chercher trois problèmes au lieu d'un.
  const h = chasseVide({ protocoleConnu: false, resolveur: false, graphe: false });
  assert.ok(h.includes('chasseNoProto'));
  assert.ok(!h.includes('chasseNoResolver'), 'avertissement secondaire affiché en plus');
  assert.ok(!h.includes('chasseNoGraph'), 'avertissement secondaire affiché en plus');
});

test('un resolveur absent est signale, sans masquer le reste', () => {
  const h = chasseVide({ protocoleConnu: true, resolveur: false, graphe: true });
  assert.ok(h.includes('chasseNoResolver'));
  assert.ok(h.includes('chasseNoHunt'));
});

test('un graphe absent est signale', () => {
  assert.ok(chasseVide({ protocoleConnu: true, resolveur: true, graphe: false }).includes('chasseNoGraph'));
});

test('tout va bien : aucun avertissement', () => {
  const h = chasseVide({ protocoleConnu: true, resolveur: true, graphe: true });
  assert.ok(!h.includes('chasseNoResolver') && !h.includes('chasseNoGraph'));
});

test('un etat absent ne fait pas planter la carte', () => {
  // L'API peut être injoignable au premier rendu : la carte doit s'afficher
  // quand même plutôt que de laisser la page à moitié rendue.
  assert.ok(chasseVide(null).includes('chasseNoHunt'));
  assert.ok(chasseVide(undefined).includes('chasseNoHunt'));
});

// ─── Le corps ─────────────────────────────────────────────────────────────

test('une cible resolue montre direction, cartes, position et commande', () => {
  const h = chasseCorps({
    directionNom: 'est', cartes: 5,
    cible: { x: 7, y: 9, nom: 'Panneau' }, travel: '/travel 7,9',
  });
  assert.ok(h.includes('est'), 'direction absente');
  assert.ok(h.includes('5 chasseMaps'), `pluriel attendu : ${h}`);
  assert.ok(h.includes('[7,9]'), 'position absente');
  assert.ok(h.includes('Panneau'), 'nom de l indice absent');
  assert.ok(h.includes('/travel 7,9'), 'commande absente');
});

test('une seule carte se dit au singulier', () => {
  assert.ok(chasseCorps({ directionNom: 'est', cartes: 1, cible: null }).includes('1 chasseMap'));
});

test('un nombre de cartes inconnu n est pas remplace par un chiffre', () => {
  const h = chasseCorps({ directionNom: 'est', cartes: null, cible: null });
  assert.ok(!/\d+ chasseMap/.test(h), `un compte a ete invente : ${h}`);
});

test('sans cible, on l annonce au lieu d afficher une case vide', () => {
  const h = chasseCorps({ directionNom: 'est', cartes: null, cible: null, travel: null });
  assert.ok(h.includes('chasseSearching'));
  assert.ok(!h.includes('/travel'), 'une commande est proposee sans cible');
});

// ─── Le phorreur ──────────────────────────────────────────────────────────

test('un phorreur n a jamais de commande travel', () => {
  // Même si l'état en portait une par erreur : un phorreur se déplace, la
  // commande enverrait le joueur là où il n'y a rien.
  const h = chasseCorps({
    directionNom: 'nord', cartes: 3, phorreur: 'Phorreur méfiant', phorreurIci: false,
    cible: { x: 3, y: 17, nom: 'faux' }, travel: '/travel 3,17',
  });
  assert.ok(!h.includes('/travel'), `commande affichee pour un phorreur : ${h}`);
});

test('un phorreur non vu renvoie a la recherche dans la direction', () => {
  const h = chasseCorps({ directionNom: 'nord', phorreur: 'Phorreur méfiant', phorreurIci: false });
  assert.ok(h.includes('chasseLookFor'), 'ne dit pas ou chercher');
  assert.ok(!h.includes('chasseHere'), 'annonce le phorreur present sans l avoir vu');
});

test('vu sur la carte, on l affirme', () => {
  const h = chasseCorps({ directionNom: 'nord', phorreur: 'Phorreur rusé', phorreurIci: true });
  assert.ok(h.includes('chasseHere'));
  assert.ok(!h.includes('chasseLookFor'));
});

test('le nom du phorreur est echappe', () => {
  // Il vient de dofusdb, donc d'un tiers : il ne doit pas pouvoir injecter de
  // balise dans la page.
  const h = chasseCorps({ directionNom: 'nord', phorreur: '<img src=x onerror=alert(1)>', phorreurIci: true });
  assert.ok(!h.includes('<img'), `balise injectee : ${h}`);
});

test('le nom de la cible est echappe lui aussi', () => {
  const h = chasseCorps({ directionNom: 'est', cartes: 1, cible: { x: 1, y: 2, nom: '<script>x</script>' } });
  assert.ok(!h.includes('<script>x'), `balise injectee : ${h}`);
});

// ─── L'avertissement de compte divergent ──────────────────────────────────

test('deux comptes differents pendant une chasse : on previent', () => {
  // Sans ça, on cherche pourquoi l'overlay « ne suit pas » alors qu'il suit
  // simplement un autre personnage.
  assert.strictEqual(chasseDivergent(11111111, 22222222, true), true);
});

test('hors chasse, aucun avertissement', () => {
  // Les deux cartes sont vides de toute façon : l'avertissement serait
  // l'élément le plus voyant du module pour ne rien signaler.
  assert.strictEqual(chasseDivergent(11111111, 22222222, false), false);
});

test('meme compte : rien a signaler', () => {
  assert.strictEqual(chasseDivergent(42, 42, true), false);
});

test('le compte suivi vient de map-state, pas du compte lie', () => {
  // Le compte lié (/api/overlay/link) est stocké et affiché, mais aucun
  // overlay ne s'en sert pour choisir : comparer à lui faisait apparaître
  // l'avertissement alors que les deux fenêtres montraient le même
  // personnage.
  assert.strictEqual(chasseSuivi({ '11111111': { mapId: 191104002 } }), 11111111);
  assert.strictEqual(chasseSuivi({}), null);
  assert.strictEqual(chasseSuivi(null), null);
  assert.strictEqual(chasseSuivi({ abc: {} }), null, 'une cle non numerique devient NaN');
});

test('un compte inconnu des deux cotes ne declenche rien', () => {
  // `null` = overlay non lié, il suit alors le compte actif : rien à dire.
  assert.strictEqual(chasseDivergent(null, 42, true), false);
  assert.strictEqual(chasseDivergent(42, null, true), false);
  assert.strictEqual(chasseDivergent(undefined, undefined, true), false);
});

console.log(`\n${passed} test(s) OK`);
