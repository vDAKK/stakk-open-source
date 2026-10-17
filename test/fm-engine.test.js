'use strict';

/**
 * Tests du moteur FM. Aucun réseau, aucun Dofus requis.
 *   node test/fm-engine.test.js
 */

const assert = require('assert');
const createFmEngine = require('../lib/fm-engine');

const engine = createFmEngine();

// Table de runes minimale (mêmes ids que dofusdb pour rester réaliste).
const TABLES = {
  runes: {
    118: [ // Force
      { id: 1519, name: 'Rune Fo', amount: 1 },
      { id: 1545, name: 'Rune Pa Fo', amount: 3 },
      { id: 1551, name: 'Rune Ra Fo', amount: 10 },
    ],
    125: [ // Vitalité
      { id: 1523, name: 'Rune Vi', amount: 5 },
      { id: 1548, name: 'Rune Pa Vi', amount: 15 },
      { id: 1554, name: 'Rune Ra Vi', amount: 50 },
    ],
    999: [ // stat sans rune côté item (sert de négatif)
      { id: 9990, name: 'Rune Zz', amount: 1 },
    ],
  },
  effects: { 118: { fr: 'Force' }, 125: { fr: 'Vitalité' } },
};

const ITEM = {
  id: 7340,
  name: 'Cape du Kitsou',
  stats: [
    { effectId: 125, from: 81, to: 100 },
    { effectId: 118, from: 7, to: 10 },
    { effectId: 4242, from: 1, to: 2 },   // pas de rune → doit être ignoré
  ],
};

const FULL_STOCK = { 1519: 99, 1545: 99, 1551: 99, 1523: 99, 1548: 99, 1554: 99 };

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

console.log('fm-engine');

test('buildPlan ne garde que les stats forgeables ET demandées', () => {
  const plan = engine.buildPlan(ITEM, TABLES, {
    targets: { 125: [100, 100], 4242: [2, 2] },
  });
  assert.strictEqual(plan.targets.length, 1);
  assert.strictEqual(plan.targets[0].effectId, 125);
  assert.strictEqual(plan.targets[0].label, 'Vitalité');
});

test('buildPlan lève si aucune stat exploitable', () => {
  assert.throws(() => engine.buildPlan(ITEM, TABLES, { targets: { 4242: [2, 2] } }));
});

test('buildPlan force ceiling >= goal', () => {
  const plan = engine.buildPlan(ITEM, TABLES, { targets: { 118: [10, 4] } });
  assert.strictEqual(plan.targets[0].ceiling, 10);
});

test('ceiling absent = infini', () => {
  const plan = engine.buildPlan(ITEM, TABLES, { targets: { 118: [10] } });
  assert.strictEqual(plan.targets[0].ceiling, Infinity);
});

test('pickRune prend le plus gros palier qui tient dans l\'écart', () => {
  const plan = engine.buildPlan(ITEM, TABLES, { targets: { 118: [30, 30] } });
  const t = plan.targets[0];
  assert.strictEqual(engine.pickRune(t, 7, FULL_STOCK).id, 1551);  // écart 23 → Ra(10)
  assert.strictEqual(engine.pickRune(t, 25, FULL_STOCK).id, 1545); // écart 5  → Pa(3)
  assert.strictEqual(engine.pickRune(t, 28, FULL_STOCK).id, 1519); // écart 2  → basique
  assert.strictEqual(engine.pickRune(t, 30, FULL_STOCK), null);    // atteint
  assert.strictEqual(engine.pickRune(t, 42, FULL_STOCK), null);    // dépassé
});

test('pickRune ne dépasse jamais le plafond', () => {
  const plan = engine.buildPlan(ITEM, TABLES, { targets: { 118: [30, 31] } });
  const t = plan.targets[0];
  // Depuis 21, la Ra (+10) atteint pile 31 : elle rentre, on la prend.
  assert.strictEqual(engine.pickRune(t, 21, FULL_STOCK).id, 1551);
  // Depuis 29, seule la rune fine tient sous 31.
  assert.strictEqual(engine.pickRune(t, 29, FULL_STOCK).id, 1519);
});

// C'est la place sous le plafond qui décide, pas l'écart à l'objectif. Viser
// exactement le plancher d'une plage 20–25 gâcherait le potentiel de l'item.
test('sur une plage, vise le haut plutôt que le plancher', () => {
  const plan = engine.buildPlan(ITEM, TABLES, { targets: { 118: [20, 25] } });
  const t = plan.targets[0];
  // À 19, l'objectif est à 1 — mais une Pa (+3 → 22) reste dans la plage.
  assert.strictEqual(engine.pickRune(t, 19, FULL_STOCK).id, 1545,
    'rune fine choisie alors qu\'une plus grosse tenait dans la plage');
  // À 15, la Ra (+10 → 25) tient pile sous le plafond.
  assert.strictEqual(engine.pickRune(t, 15, FULL_STOCK).id, 1551);
  // Une fois le plancher franchi, on s'arrête : la stat est dans la plage.
  assert.strictEqual(engine.pickRune(t, 22, FULL_STOCK), null);

  // Plafond serré : seule la rune fine tient encore.
  const tight = engine.buildPlan(ITEM, TABLES, { targets: { 118: [20, 21] } }).targets[0];
  assert.strictEqual(engine.pickRune(tight, 19, FULL_STOCK).id, 1519);
});

test('plage serrée : le grain minimum peut déborder, sinon on ne finit jamais', () => {
  // Objectif = plafond = 25, stat à 24 : aucune rune ne tombe pile sur 25
  // si la plus fine vaut +3. On tolère le débordement plutôt que bloquer.
  const tables = { ...TABLES, runes: { ...TABLES.runes, 118: [{ id: 1545, name: 'Rune Pa Fo', amount: 3 }] } };
  const plan = engine.buildPlan(ITEM, tables, { targets: { 118: [25, 25] } });
  assert.strictEqual(engine.pickRune(plan.targets[0], 24, { 1545: 5 }).id, 1545);
});

test('pickRune redescend d\'un palier si le stock manque', () => {
  const plan = engine.buildPlan(ITEM, TABLES, { targets: { 118: [30, 30] } });
  const t = plan.targets[0];
  assert.strictEqual(engine.pickRune(t, 7, { 1545: 5, 1519: 5 }).id, 1545);
  assert.strictEqual(engine.pickRune(t, 7, { 1519: 5 }).id, 1519);
  assert.strictEqual(engine.pickRune(t, 7, {}), null);
  assert.strictEqual(engine.pickRune(t, 7, { 1551: 0 }), null);
});

test('seuils utilisateur surchargent le montant de la rune', () => {
  const plan = engine.buildPlan(ITEM, TABLES, {
    targets: { 118: [40, 40] },
    thresholds: { 118: [10, 25] },   // Pa à partir de 10 d'écart, Ra à partir de 25
  });
  const t = plan.targets[0];
  assert.strictEqual(engine.pickRune(t, 7, FULL_STOCK).id, 1551);   // écart 33 ≥ 25
  assert.strictEqual(engine.pickRune(t, 20, FULL_STOCK).id, 1545);  // écart 20 ≥ 10
  assert.strictEqual(engine.pickRune(t, 35, FULL_STOCK).id, 1519);  // écart 5
});

test('nextAction: done quand tous les objectifs sont atteints', () => {
  const plan = engine.buildPlan(ITEM, TABLES, { targets: { 118: [10, 10], 125: [100, 100] } });
  const a = engine.nextAction(plan, { stats: { 118: 10, 125: 100 }, stock: FULL_STOCK });
  assert.strictEqual(a.type, 'done');
});

test('nextAction: blocked détaille ce qui manque', () => {
  const plan = engine.buildPlan(ITEM, TABLES, { targets: { 118: [10, 10] } });
  const a = engine.nextAction(plan, { stats: { 118: 7 }, stock: {} });
  assert.strictEqual(a.type, 'blocked');
  assert.strictEqual(a.reason, 'no-rune');
  assert.strictEqual(a.missing[0].effectId, 118);
  // Ra (+10) ferait 17 pour un plafond de 10 → pas proposée.
  assert.deepStrictEqual(a.missing[0].runes.map(r => r.id), [1519, 1545]);
});

test('nextAction: priorise la stat proportionnellement la plus en retard', () => {
  const plan = engine.buildPlan(ITEM, TABLES, { targets: { 118: [10, 10], 125: [100, 100] } });
  // Force 7/10 = 30 % d'écart relatif ; Vita 95/100 = 5 % → Force d'abord
  const a = engine.nextAction(plan, { stats: { 118: 7, 125: 95 }, stock: FULL_STOCK });
  assert.strictEqual(a.type, 'throw');
  assert.strictEqual(a.effectId, 118);
  assert.strictEqual(a.runeId, 1545); // écart 3 → Pa
});

test('applyResult décrémente le stock et relit les stats observées', () => {
  const s0 = { stats: { 118: 7 }, stock: { 1545: 2 } };
  const s1 = engine.applyResult(s0, { runeId: 1545 }, { 118: 10 });
  assert.strictEqual(s1.stats[118], 10);
  assert.strictEqual(s1.stock[1545], 1);
  assert.strictEqual(s1.thrown, 1);
  const s2 = engine.applyResult(s1, { runeId: 1545 }, { 118: 10 });
  assert.strictEqual(s2.stock[1545], undefined); // épuisé → clé retirée
  assert.strictEqual(s2.thrown, 2);
  assert.strictEqual(s0.stock[1545], 2);         // état d'origine non muté
});

test('applyResult sur jet raté : stock -1, stats inchangées', () => {
  const s1 = engine.applyResult({ stats: { 118: 7 }, stock: { 1519: 3 } }, { runeId: 1519 }, { 118: 7 });
  assert.strictEqual(s1.stats[118], 7);
  assert.strictEqual(s1.stock[1519], 2);
});

test('applyResult encaisse une baisse de stat (FM qui casse)', () => {
  const s1 = engine.applyResult({ stats: { 118: 20, 125: 90 }, stock: { 1551: 1 } },
    { runeId: 1551 }, { 118: 25, 125: 60 });
  assert.strictEqual(s1.stats[125], 60);
});

test('boucle complète : converge et ne dépasse pas', () => {
  const plan = engine.buildPlan(ITEM, TABLES, { targets: { 118: [25, 25], 125: [130, 130] } });
  let state = { stats: { 118: 7, 125: 81 }, stock: { ...FULL_STOCK } };
  let steps = 0;
  for (;;) {
    const a = engine.nextAction(plan, state);
    if (a.type === 'done') break;
    assert.strictEqual(a.type, 'throw', `bloqué à l'étape ${steps}: ${JSON.stringify(a)}`);
    assert.ok(++steps < 500, 'boucle infinie');
    // Simulation optimiste : chaque jet passe.
    const observed = { [a.effectId]: state.stats[a.effectId] + a.amount };
    state = engine.applyResult(state, a, observed);
  }
  // Force tombe pile (paliers 1/3/10) ; Vita ne peut pas : le plus petit
  // palier vaut 5, donc on finit à 131 — dépassement borné, jamais plus.
  assert.strictEqual(state.stats[118], 25);
  assert.ok(state.stats[125] >= 130 && state.stats[125] < 135, `vita=${state.stats[125]}`);
  assert.ok(steps > 0 && steps < 40, `nombre de jets improbable: ${steps}`);
});

test('boucle avec échecs aléatoires : termine quand même', () => {
  const plan = engine.buildPlan(ITEM, TABLES, { targets: { 125: [120, 120] } });
  let state = { stats: { 125: 81 }, stock: { 1523: 999, 1548: 999, 1554: 999 } };
  let seed = 42;
  const rng = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let steps = 0;
  for (;;) {
    const a = engine.nextAction(plan, state);
    if (a.type === 'done') break;
    assert.strictEqual(a.type, 'throw', `bloqué: ${JSON.stringify(a)}`);
    assert.ok(++steps < 5000, 'ne converge pas avec 50 % d\'échecs');
    const hit = rng() > 0.5;
    const observed = { 125: state.stats[125] + (hit ? a.amount : 0) };
    state = engine.applyResult(state, a, observed);
  }
  assert.ok(state.stats[125] >= 120 && state.stats[125] < 125, `vita=${state.stats[125]}`);
});

// ─── Exo : ce qui n'est pas sur l'item se travaille APRÈS ──────────────────

test('une stat absente de l\'item est un exo, en phase 1 par défaut', () => {
  const plan = engine.buildPlan(ITEM, TABLES, {
    targets: { 118: [10, 10], 999: [1, 1] },   // 999 n'est pas sur l'item
  });
  const force = plan.targets.find(t => t.effectId === 118);
  const exo = plan.targets.find(t => t.effectId === 999);
  assert.strictEqual(force.phase, 0);
  assert.strictEqual(force.onItem, true);
  assert.strictEqual(exo.phase, 1);
  assert.strictEqual(exo.onItem, false);
  assert.strictEqual(exo.itemMin, 0);
});

test('l\'exo n\'est pas tenté tant que les stats de base ne sont pas atteintes', () => {
  const plan = engine.buildPlan(ITEM, TABLES, { targets: { 118: [10, 10], 999: [1, 1] } });
  const stock = { ...FULL_STOCK, 9990: 5 };

  // Force pas finie → on travaille Force, pas l'exo.
  let a = engine.nextAction(plan, { stats: { 118: 7, 999: 0 }, stock });
  assert.strictEqual(a.effectId, 118);
  assert.strictEqual(engine.currentPhase(plan, { stats: { 118: 7, 999: 0 } }), 0);

  // Force atteinte → l'exo devient la cible.
  a = engine.nextAction(plan, { stats: { 118: 10, 999: 0 }, stock });
  assert.strictEqual(a.effectId, 999);
  assert.strictEqual(a.exo, true);
  assert.strictEqual(a.phase, 1);
});

test('phase explicite : on peut forcer l\'ordre de travail', () => {
  const plan = engine.buildPlan(ITEM, TABLES, {
    targets: { 118: [10, 10], 125: [100, 100] },
    phases: { 125: 0, 118: 1 },              // vita d'abord, force ensuite
  });
  const stock = { ...FULL_STOCK };
  const a = engine.nextAction(plan, { stats: { 118: 7, 125: 81 }, stock });
  assert.strictEqual(a.effectId, 125, 'la phase explicite n\'est pas respectée');
  const b = engine.nextAction(plan, { stats: { 118: 7, 125: 100 }, stock });
  assert.strictEqual(b.effectId, 118);
});

test('blocage en phase 0 ne parle pas des exos non commencés', () => {
  const plan = engine.buildPlan(ITEM, TABLES, { targets: { 118: [10, 10], 999: [1, 1] } });
  const a = engine.nextAction(plan, { stats: { 118: 7, 999: 0 }, stock: {} });
  assert.strictEqual(a.type, 'blocked');
  assert.deepStrictEqual(a.missing.map(m => m.effectId), [118]);
});

test('done seulement quand exo compris', () => {
  const plan = engine.buildPlan(ITEM, TABLES, { targets: { 118: [10, 10], 999: [1, 1] } });
  const stock = { ...FULL_STOCK, 9990: 5 };
  assert.strictEqual(engine.nextAction(plan, { stats: { 118: 10, 999: 0 }, stock }).type, 'throw');
  assert.strictEqual(engine.nextAction(plan, { stats: { 118: 10, 999: 1 }, stock }).type, 'done');
  assert.strictEqual(engine.currentPhase(plan, { stats: { 118: 10, 999: 1 } }), null);
});

// ─── Limite de poids du jeu ────────────────────────────────────────────────

const WEIGHTS = {
  MAX_LINE_WEIGHT: 101,
  coefOf: (eid) => ({ 118: 1, 125: 0.2, 115: 10 }[eid] ?? null),
  isUncertain: (eid) => eid === 115,
};

test('refuse une rune qui ferait franchir la limite de poids', () => {
  const plan = engine.buildPlan(ITEM, TABLES, {
    targets: { 118: [200, 200] },     // objectif volontairement hors d'atteinte
    weights: WEIGHTS,
  });
  const t = plan.targets[0];
  assert.strictEqual(t.coef, 1);
  assert.strictEqual(t.weightCap, 101);

  // Force à 95 : la Ra (+10) ferait 105 de poids, refusée. La Pa (+3) passe.
  assert.strictEqual(engine.pickRune(t, 95, FULL_STOCK).id, 1545);
  // À 100, seule la rune fine tient sous 101.
  assert.strictEqual(engine.pickRune(t, 100, FULL_STOCK).id, 1519);
  // À 101, la ligne est pleine : plus rien ne passe.
  assert.strictEqual(engine.pickRune(t, 101, FULL_STOCK), null);
});

test('la limite tient compte du poids naturel supérieur à 101', () => {
  // Vitalité : coefficient 0,2. Un jet max de 100 pèse 20, donc la limite
  // reste 101 de poids, soit 505 points de vitalité.
  const plan = engine.buildPlan(ITEM, TABLES, {
    targets: { 125: [600, 600] }, weights: WEIGHTS,
  });
  const t = plan.targets[0];
  assert.strictEqual(t.weightCap, 101);
  assert.ok(engine.pickRune(t, 400, FULL_STOCK), 'bloqué trop tôt');
  assert.strictEqual(engine.pickRune(t, 505, FULL_STOCK), null, 'limite non appliquée');
});

test('coefficient douteux ou inconnu : aucune interdiction', () => {
  // 115 est marqué douteux dans la table : on n'interdit rien sur sa foi.
  const tables = {
    runes: { 115: [{ id: 7433, name: 'Rune Cri', amount: 1 }] },
    effects: { 115: { fr: 'Coup Critique' } },
  };
  const item = { id: 1, name: 'X', stats: [{ effectId: 115, from: 1, to: 5 }] };
  const plan = engine.buildPlan(item, tables, { targets: { 115: [999, 999] }, weights: WEIGHTS });
  assert.strictEqual(plan.targets[0].coef, null);
  assert.strictEqual(plan.targets[0].weightCap, null);
  assert.ok(engine.pickRune(plan.targets[0], 500, { 7433: 9 }), 'interdit sur un coefficient douteux');
});

test('sans table de poids, le moteur se comporte comme avant', () => {
  const plan = engine.buildPlan(ITEM, TABLES, { targets: { 118: [200, 200] } });
  assert.strictEqual(plan.targets[0].coef, null);
  assert.ok(engine.pickRune(plan.targets[0], 150, FULL_STOCK));
});

test('progress va de 0 à 1', () => {
  const plan = engine.buildPlan(ITEM, TABLES, { targets: { 118: [10, 10] } });
  assert.strictEqual(engine.progress(plan, { stats: { 118: 7 } }), 0);
  assert.strictEqual(engine.progress(plan, { stats: { 118: 10 } }), 1);
  assert.strictEqual(engine.progress(plan, { stats: { 118: 99 } }), 1);
  assert.ok(Math.abs(engine.progress(plan, { stats: { 118: 8 } }) - 1 / 3) < 1e-9);
});

test('throwDelay reste dans la fourchette et gère l\'ordre inversé', () => {
  assert.strictEqual(engine.throwDelay([500, 1000], () => 0), 500);
  assert.strictEqual(engine.throwDelay([500, 1000], () => 1), 1000);
  assert.strictEqual(engine.throwDelay([1000, 500], () => 0), 500);
  assert.strictEqual(engine.throwDelay(undefined, () => 0.5), 750);
  assert.strictEqual(engine.throwDelay([0, 0], () => 0.7), 0);
});

test('defaultTargets et axisMax pré-remplissent l\'UI', () => {
  const d = engine.defaultTargets(ITEM, TABLES);
  // Par défaut, la fourchette naturelle de l'item : on voit ce qu'il peut
  // donner sans overmax, et on relève ensuite ce qu'on veut vraiment.
  assert.deepStrictEqual(d[125], [81, 100]);
  assert.deepStrictEqual(d[118], [7, 10]);
  assert.strictEqual(d[4242], undefined);
  assert.strictEqual(engine.axisMax({ from: 81, to: 100 }), 200);
  assert.strictEqual(engine.axisMax({ from: 7, to: 10 }), 40);
  assert.strictEqual(engine.axisMax({ from: 200, to: 300 }), 390);
});

console.log(`\n${passed} tests OK${process.exitCode ? ' — DES TESTS ONT ÉCHOUÉ' : ''}`);
