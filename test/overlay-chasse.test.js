'use strict';

/**
 * Ce que la fenêtre de chasse affiche.
 *
 * Quatre décisions s'y jouent, et chacune trompe le joueur si elle est fausse :
 *
 *   - la flèche pointe la direction de l'indice. Une rotation fausse envoie
 *     marcher à l'opposé ;
 *   - un nombre de cartes inconnu reste VIDE, jamais remplacé par un chiffre
 *     par défaut : c'est là-dessus qu'on juge si la cible est plausible ;
 *   - « ICI » ne s'affiche que si le phorreur a été vu parmi les acteurs de la
 *     carte, jamais sur la seule foi de l'indice ;
 *   - une fenêtre vide dit POURQUOI elle est vide.
 *
 * `rendre` est extraite de `overlay/chasse.html` et exécutée sur un DOM
 * minimal : la recopier ici ne prouverait rien.
 *
 *   node test/overlay-chasse.test.js
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

const html = fs.readFileSync(path.join(__dirname, '..', 'overlay', 'chasse.html'), 'utf8');
const script = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1];
assert.ok(script, 'aucun bloc script dans overlay/chasse.html');

// ─── DOM minimal ──────────────────────────────────────────────────────────

const IDS = ['fleche', 'cartes', 'cartes-unite', 'pos', 'indice', 'phorreur', 'etat'];

function element() {
  const classes = new Set();
  return {
    textContent: '',
    style: {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c),
      _set: classes,
    },
  };
}

function rendre(etat) {
  const els = {};
  for (const id of IDS) els[id] = element();
  const fenetre = { addEventListener: () => {}, __chasse: etat };
  const doc = {
    getElementById: (id) => els[id] || null,
    body: element(),
  };
  // Le script se termine par `rendre(null)` : on le laisse s'exécuter, puis on
  // rappelle `rendre` avec l'état voulu.
  const lancer = new Function('window', 'document', `${script}\nreturn rendre;`);
  lancer(fenetre, doc)(etat);
  return els;
}

const angle = (els) => els.fleche.style.transform;

// ─── La flèche ────────────────────────────────────────────────────────────

test('la fleche pointe le nord vers le haut', () => {
  // Le SVG est dessiné pointe en haut : nord = aucune rotation.
  assert.strictEqual(angle(rendre({ etape: 'aller', direction: 6 })), 'rotate(0deg)');
});

test('les huit directions Dofus ont leur angle', () => {
  // Convention vérifiée dans monde.js : 0 est, 2 sud, 4 ouest, 6 nord.
  const attendus = { 0: 90, 1: 135, 2: 180, 3: 225, 4: 270, 5: 315, 6: 0, 7: 45 };
  for (const [dir, deg] of Object.entries(attendus)) {
    assert.strictEqual(angle(rendre({ etape: 'aller', direction: Number(dir) })),
      `rotate(${deg}deg)`, `direction ${dir}`);
  }
});

test('sans direction, la fleche s eteint au lieu de pointer le nord', () => {
  // La faire disparaître ferait sauter toute la ligne à chaque étape.
  const els = rendre({ etape: 'aller', direction: null });
  assert.ok(els.fleche.classList.contains('muette'), 'la fleche reste allumee sans direction');
});

test('avec une direction, la fleche est allumee', () => {
  assert.ok(!rendre({ etape: 'aller', direction: 2 }).fleche.classList.contains('muette'));
});

// ─── Le nombre de cartes ──────────────────────────────────────────────────

test('le compte s affiche avec son unite', () => {
  const un = rendre({ etape: 'aller', direction: 0, cartes: 1 });
  assert.strictEqual(un.cartes.textContent, '1');
  assert.strictEqual(un['cartes-unite'].textContent, 'carte');
  const cinq = rendre({ etape: 'aller', direction: 0, cartes: 5 });
  assert.strictEqual(cinq.cartes.textContent, '5');
  assert.strictEqual(cinq['cartes-unite'].textContent, 'cartes');
});

test('un compte inconnu n est pas remplace par un chiffre', () => {
  const els = rendre({ etape: 'aller', direction: 0, cartes: null });
  assert.strictEqual(els.cartes.textContent, '—', 'un chiffre a ete invente');
  assert.strictEqual(els['cartes-unite'].textContent, '');
});

test('un phorreur n affiche aucun compte, pas meme un tiret', () => {
  // Il se déplace : aucune carte n'est visée, donc il n'y a rien à attendre.
  // Le tiret d'attente y resterait indéfiniment à côté de la flèche.
  const els = rendre({ etape: 'aller', direction: 6, phorreur: 'Phorreur méfiant', cartes: null });
  assert.strictEqual(els.cartes.textContent, '', `tiret affiche : ${els.cartes.textContent}`);
});

test('zero carte s affiche : on est arrive', () => {
  assert.strictEqual(rendre({ etape: 'aller', direction: 0, cartes: 0 }).cartes.textContent, '0');
});

// ─── La cible ─────────────────────────────────────────────────────────────

test('la cible donne sa position et son nom', () => {
  const els = rendre({ etape: 'aller', direction: 0, cartes: 5, cible: { x: 7, y: 9, nom: 'Panneau' } });
  assert.strictEqual(els.pos.textContent, '[7,9]');
  assert.strictEqual(els.indice.textContent, 'Panneau');
});

test('sans cible, ni position ni nom ne sont inventes', () => {
  const els = rendre({ etape: 'aller', direction: 0, cible: null });
  assert.strictEqual(els.pos.textContent, '');
  assert.strictEqual(els.indice.textContent, '');
});

// ─── Le phorreur ──────────────────────────────────────────────────────────

test('un phorreur non vu renvoie a la recherche sur place', () => {
  const els = rendre({ etape: 'aller', direction: 6, phorreur: 'Phorreur méfiant', phorreurIci: false });
  assert.ok(!els.phorreur.classList.contains('cache'), 'la ligne phorreur est masquee');
  assert.ok(!els.phorreur.classList.contains('ici'), 'la mise en avant ICI est appliquee a tort');
  assert.ok(!/ICI/.test(els.phorreur.textContent), 'ICI affiche sans avoir vu le phorreur');
  // Et surtout : rien qui affirme une position. On ne sait pas s'il est là.
  assert.ok(!/\bici\b/i.test(els.phorreur.textContent),
    `le texte affirme une position : ${els.phorreur.textContent}`);
});

test('vu sur la carte, on l affirme', () => {
  const els = rendre({ etape: 'aller', direction: 6, phorreur: 'Phorreur rusé', phorreurIci: true });
  assert.ok(els.phorreur.classList.contains('ici'));
  assert.ok(/ICI/.test(els.phorreur.textContent));
});

test('un indice ordinaire n affiche aucune ligne phorreur', () => {
  const els = rendre({ etape: 'aller', direction: 0, cible: { x: 1, y: 2, nom: 'Panneau' } });
  assert.ok(els.phorreur.classList.contains('cache'));
});

// ─── La ligne d'état ──────────────────────────────────────────────────────

test('hors chasse, la fenetre dit pourquoi elle est vide', () => {
  assert.strictEqual(rendre({}).etat.textContent, 'aucune chasse en cours');
  assert.strictEqual(rendre({ compte: false }).etat.textContent, 'aucun compte lancé');
  assert.strictEqual(rendre({ protocoleConnu: false }).etat.textContent, 'protocole non reconnu');
  assert.strictEqual(rendre({ resolveur: false }).etat.textContent, 'dofusdb injoignable');
});

test('un protocole non reconnu prend le pas sur le reste', () => {
  // Sans protocole, le résolveur n'a plus d'objet : deux messages feraient
  // chercher deux problèmes au lieu d'un.
  const els = rendre({ protocoleConnu: false, resolveur: false, compte: false });
  assert.strictEqual(els.etat.textContent, 'protocole non reconnu');
});

test('pendant une chasse, la ligne d etat se tait', () => {
  // La place est étroite : elle ne sert qu'à expliquer une fenêtre vide.
  assert.strictEqual(rendre({ etape: 'aller', direction: 0, cartes: 3, copie: true }).etat.textContent, '');
});

test('la copie coupee est signalee pendant la chasse', () => {
  assert.strictEqual(rendre({ etape: 'aller', direction: 0, copie: false }).etat.textContent,
    'copie /travel coupée');
});

test('un etat absent ne fait pas planter la fenetre', () => {
  // Le premier rendu a lieu avant le premier sondage.
  assert.doesNotThrow(() => rendre(null));
  assert.doesNotThrow(() => rendre(undefined));
});

console.log(`\n${passed} test(s) OK`);
