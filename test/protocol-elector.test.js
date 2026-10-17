'use strict';

/**
 * Tests de l'électeur de champs. On ne lui donne que des candidats déjà
 * extraits : il ne fait que compter des preuves et décider — ou s'abstenir.
 *   node test/protocol-elector.test.js
 */

const assert = require('assert');
const learn = require('../lib/protocol-learn')();

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

function elector(over) {
  return learn.createFieldElector(Object.assign({
    roles: ['gid', 'uid', 'qty'], primary: ['gid', 'uid'],
    minPrimary: 3, minPackets: 2, maxMismatch: 3,
  }, over || {}));
}
// Un candidat = un sous-message où gid et uid se laissent désigner.
function cand(gidField, uidField, gid, uid, qtyField, qty) {
  const c = { gid: { field: gidField, value: gid }, uid: { field: uidField, value: uid } };
  if (qtyField) c.qty = [{ field: qtyField, value: qty }];
  return c;
}
// Variante à plusieurs candidats « qty » sur le même objet — sert à
// départager un champ figé d'un champ qui varie réellement.
function candMulti(gidField, uidField, gid, uid, qtyPairs) {
  return {
    gid: { field: gidField, value: gid }, uid: { field: uidField, value: uid },
    qty: qtyPairs.map(([field, value]) => ({ field, value })),
  };
}

test('n\'élit rien avant le quorum d\'objets', () => {
  const e = elector();
  assert.strictEqual(e.observe([cand(2, 1, 1519, 111), cand(2, 1, 1520, 222)]), null);
  assert.strictEqual(e.get(), null, 'élu avec 2 objets sur 3 requis');
});

test('n\'élit rien avant le quorum de paquets', () => {
  const e = elector();
  // Trois objets, mais un seul paquet : un lot ne prouve que sa propre forme.
  e.observe([cand(2, 1, 1519, 111), cand(2, 1, 1520, 222), cand(2, 1, 1521, 333)]);
  assert.strictEqual(e.get(), null, 'élu sur un seul paquet');
});

test('élit quand les deux quorums sont atteints', () => {
  const e = elector();
  e.observe([cand(2, 1, 1519, 111), cand(2, 1, 1520, 222)]);
  const r = e.observe([cand(2, 1, 1521, 333)]);
  assert.ok(r && r.learned, 'aucune élection');
  assert.deepStrictEqual(e.get(), { gid: 2, uid: 1, qty: null });
});

test('ne tranche pas entre deux dispositions également étayées', () => {
  const e = elector();
  const both = g => [cand(2, 1, g, g * 10), cand(4, 3, g, g * 10)];
  e.observe(both(1519)); e.observe(both(1520)); e.observe(both(1521));
  assert.strictEqual(e.get(), null, 'une égalité a été tranchée');
});

test('quantité : un champ figé est élu faute d\'alternative, mais cède devant un champ qui varie', () => {
  const e1 = elector();
  // Le champ 9 vaut toujours 1, mais rien ne le distingue d'une quantité :
  // un inventaire dont toutes les piles valent 1 reste légitime.
  e1.observe([cand(2, 1, 1519, 111, 9, 1), cand(2, 1, 1520, 222, 9, 1)]);
  e1.observe([cand(2, 1, 1521, 333, 9, 1)]);
  assert.strictEqual(e1.get().qty, 9, 'un champ figé sans alternative n\'a pas été élu quantité');

  const e2 = elector();
  // Un second champ, lui, varie réellement : c'est lui qui décrit la
  // quantité, pas le champ figé à côté.
  const dual = (gid, uid, qty) => candMulti(2, 1, gid, uid, [[9, 1], [10, qty]]);
  e2.observe([dual(1519, 111, 4), dual(1520, 222, 7)]);
  e2.observe([dual(1521, 333, 2)]);
  assert.strictEqual(e2.get().qty, 10, 'le champ figé l\'a emporté sur le champ qui varie');
});

test('abandonne le mapping après 3 discordances consécutives', () => {
  const e = elector();
  e.observe([cand(2, 1, 1519, 111), cand(2, 1, 1520, 222)]);
  e.observe([cand(2, 1, 1521, 333)]);
  assert.ok(e.get(), 'préalable : mapping élu');

  assert.strictEqual(e.observe([cand(4, 3, 1519, 111)]), null, 'lâché dès la 1re');
  assert.strictEqual(e.observe([cand(4, 3, 1520, 222)]), null, 'lâché dès la 2e');
  const r = e.observe([cand(4, 3, 1521, 333)]);
  assert.ok(r && r.lost, 'mapping non abandonné à la 3e discordance');
  assert.strictEqual(e.get(), null);
});

test('quorum : les objets distincts se comptent sur l\'identifiant, pas sur le couple gid:identifiant', () => {
  const e = elector();
  // Même identifiant (111) revu à côté d'un gid différent : ça reste UN seul
  // objet suivi, pas deux — sinon la paire (gid, identifiant) suffirait à
  // gonfler artificiellement le quorum avec un seul objet observé deux fois.
  e.observe([cand(2, 1, 1519, 111), cand(2, 1, 1520, 111)]);
  e.observe([cand(2, 1, 1521, 222)]);
  assert.strictEqual(e.get(), null, 'compté comme 3 objets distincts au lieu de 2');
});

// L'électeur compte des preuves ; il ne sait pas ce qu'un mapping VEUT DIRE.
// Le consommateur, lui, en connaît des formes inexploitables (deux rôles sur le
// même numéro de champ, par exemple). Son filtre doit donc s'appliquer avant le
// verrouillage : verrouiller puis filtrer à la sortie fige l'accumulation sur
// un mapping que toutes les lectures rejetteront, en silence.
const refuseDoublon = m => (m.gid === m.uid ? null : m);

test('normalize : un mapping refusé n\'est jamais verrouillé', () => {
  const e = elector({ normalize: refuseDoublon });
  e.observe([cand(2, 2, 1519, 111), cand(2, 2, 1520, 222)]);
  const r = e.observe([cand(2, 2, 1521, 333)]);
  assert.strictEqual(r, null, 'un mapping refusé a été annoncé comme appris');
  assert.strictEqual(e.get(), null, 'un mapping refusé a été verrouillé');
  // Et rien ne se fige : les observations suivantes restent recevables.
  assert.strictEqual(e.observe([cand(2, 2, 1522, 444)]), null);
  assert.strictEqual(e.get(), null);
});

test('normalize : ce qui est retenu est ce que le consommateur a rendu', () => {
  // Le filtre ne fait pas qu'accepter ou refuser : il peut corriger. C'est sa
  // sortie qui doit être retenue, sinon get() et l'état persisté rendraient une
  // forme brute que le consommateur n'a jamais validée.
  const e = elector({ normalize: m => ({ ...m, qty: null }) });
  e.observe([cand(2, 1, 1519, 111, 9, 1), cand(2, 1, 1520, 222, 9, 1)]);
  e.observe([cand(2, 1, 1521, 333, 9, 1)]);
  assert.deepStrictEqual(e.get(), { gid: 2, uid: 1, qty: null });
});

test('normalize : une disposition refusée ne stérilise pas le scrutin des suivantes', () => {
  // Le filtre écarte des CANDIDATES ; il n'arbitre pas après coup. Rien ne
  // retire une paire de l'accumulation — seul l'abandon d'un mapping verrouillé
  // vide le compteur — donc une paire refusée qui a atteint le quorum resterait
  // au scrutin à demeure : seule elle ne rendrait jamais rien, accompagnée d'une
  // disposition saine elle déclencherait la règle de non-arbitrage. La saine ne
  // serait plus jamais élue, et l'électeur resterait muet pour la session.
  const e = elector({ normalize: refuseDoublon });
  e.observe([cand(2, 2, 1519, 111), cand(2, 2, 1520, 222)]);
  e.observe([cand(2, 2, 1521, 333)]);
  assert.strictEqual(e.get(), null, 'préalable : la disposition dégénérée a été retenue');

  for (let i = 0; i < 8; i++) e.observe([cand(2, 1, 1600 + i, 500 + i)]);
  assert.deepStrictEqual(e.get(), { gid: 2, uid: 1, qty: null },
    'la disposition saine n\'a jamais pu être élue derrière une paire refusée');
});

test('normalize : un mapping rechargé du disque passe le même filtre', () => {
  const e = elector({ map: { gid: 2, uid: 2, qty: null }, normalize: refuseDoublon });
  assert.strictEqual(e.get(), null, 'un mapping refusé a survécu au rechargement');
});

test('une concordance remet le compteur de discordances à zéro', () => {
  const e = elector();
  e.observe([cand(2, 1, 1519, 111), cand(2, 1, 1520, 222)]);
  e.observe([cand(2, 1, 1521, 333)]);
  e.observe([cand(4, 3, 1519, 111)]);
  e.observe([cand(2, 1, 1519, 111)]);          // concordance : remise à zéro
  e.observe([cand(4, 3, 1520, 222)]);
  e.observe([cand(4, 3, 1521, 333)]);
  assert.ok(e.get(), 'mapping abandonné alors que le compteur avait été remis à zéro');
});

console.log(`\n${passed} test(s) OK`);
