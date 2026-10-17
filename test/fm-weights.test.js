'use strict';

/**
 * Tests des poids de forgemagie. La partie « table » est vérifiée contre les
 * vraies runes de dofusdb : si le coefficient est juste, le poids d'une rune
 * de base tombe sur les valeurs connues (1 pour Force, 1 pour Vitalité via
 * 5 × 0,2, 100 pour un PA…), et les paliers Pa/Ra pèsent 3× et 10× la base.
 *
 *   node test/fm-weights.test.js
 */

const assert = require('assert');
const createFmWeights = require('../lib/fm-weights');
const createFmData = require('../lib/fm-data');

const W = createFmWeights();

let passed = 0;
const async_ = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      async_.push(r.then(
        () => { passed++; console.log(`  ok  ${name}`); },
        e => { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }));
      return;
    }
    passed++; console.log(`  ok  ${name}`);
  } catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

console.log('fm-weights');

test('poids = points × coefficient', () => {
  assert.strictEqual(W.weightOf(118, 1), 1);      // Rune Fo
  assert.strictEqual(W.weightOf(118, 3), 3);      // Rune Pa Fo
  assert.strictEqual(W.weightOf(118, 10), 10);    // Rune Ra Fo
  assert.strictEqual(W.weightOf(125, 5), 1);      // Rune Vi  : 5 × 0,2
  assert.strictEqual(W.weightOf(125, 50), 10);    // Rune Ra Vi
  assert.strictEqual(W.weightOf(124, 1), 3);      // Rune Sa
  assert.strictEqual(W.weightOf(174, 10), 1);     // Rune Ini : 10 × 0,1
});

test('les exotiques portent leur coût connu', () => {
  assert.strictEqual(W.exoCost(111), 100);   // PA
  assert.strictEqual(W.exoCost(128), 90);    // PM
  assert.strictEqual(W.exoCost(117), 51);    // Portée
});

test('une caractéristique inconnue ne rend pas un poids inventé', () => {
  assert.strictEqual(W.weightOf(99999, 5), null);
  assert.strictEqual(W.coefOf(99999), null);
  assert.strictEqual(W.runeWeight(99999, { amount: 3 }), null);
});

test('les coefficients douteux sont signalés', () => {
  assert.strictEqual(W.isUncertain(118), false, 'Force marquée douteuse');
  assert.strictEqual(W.isUncertain(111), false, 'PA marqué douteux');
  assert.strictEqual(W.isUncertain(115), true, 'Coup Critique devrait être douteux');
  assert.strictEqual(W.isUncertain(242), true, '% Résistance devrait être douteuse');
});

test('marge d\'une ligne : plafond 101, sauf poids naturel supérieur', () => {
  // Force à 30 sur un item dont le jet max est 50 → plafond 101.
  assert.strictEqual(W.lineHeadroom(118, 30, 50), 71);
  // Une ligne déjà au plafond n'a plus de marge.
  assert.strictEqual(W.lineHeadroom(118, 101, 50), 0);
  // Poids naturel au-dessus de 101 : c'est lui qui sert de plafond.
  assert.strictEqual(W.lineHeadroom(118, 100, 150), 50);
  assert.strictEqual(W.lineHeadroom(99999, 10, 20), null);
});

test('reliquat = poids détruit − poids de la rune, jamais négatif', () => {
  assert.strictEqual(W.residualFrom(30, 10), 20);
  assert.strictEqual(W.residualFrom(51, 5), 46);
  assert.strictEqual(W.residualFrom(5, 20), 0, 'reliquat négatif');
  assert.strictEqual(W.residualFrom(NaN, 5), 0);
});

// ─── Confrontation aux vraies runes ────────────────────────────────────────

test('sur dofusdb : les paliers Pa et Ra pèsent 3× et 10× la rune de base', async () => {
  const data = createFmData({ log: () => {} });
  const { runes, effects } = await data.getTables();

  const checked = [];
  const anomalies = [];
  for (const [effectId, tiers] of Object.entries(runes)) {
    if (W.coefOf(Number(effectId)) === null) continue;   // pas dans la table
    if (tiers.length < 2) continue;
    const base = W.runeWeight(Number(effectId), tiers[0]);
    if (!base) continue;
    checked.push(effectId);
    for (let i = 1; i < tiers.length; i++) {
      const w = W.runeWeight(Number(effectId), tiers[i]);
      const ratio = w / base;
      const expected = i === 1 ? 3 : 10;
      if (Math.abs(ratio - expected) > 0.01) {
        anomalies.push(`${effects[effectId]?.fr || effectId}: ${tiers[i].name} pèse ${w} soit ×${ratio.toFixed(2)} (attendu ×${expected})`);
      }
    }
  }
  assert.ok(checked.length >= 15, `trop peu de caractéristiques vérifiées (${checked.length})`);
  assert.deepStrictEqual(anomalies, [], 'ratios de paliers incohérents');
  console.log(`       (${checked.length} caractéristiques confrontées à dofusdb)`);
});

test('sur dofusdb : les runes exotiques valent bien 100 / 90 / 51', async () => {
  const data = createFmData({ log: () => {} });
  const { runes } = await data.getTables();
  const cases = [[111, 100], [128, 90], [117, 51]];
  for (const [effectId, expected] of cases) {
    const tiers = runes[effectId];
    assert.ok(tiers && tiers.length, `pas de rune pour l'effet ${effectId}`);
    assert.strictEqual(W.runeWeight(effectId, tiers[0]), expected,
      `poids inattendu pour l'effet ${effectId}`);
  }
});

Promise.all(async_).then(() => {
  console.log(`\n${passed} tests OK${process.exitCode ? ' — DES TESTS ONT ÉCHOUÉ' : ''}`);
});
