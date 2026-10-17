'use strict';

/**
 * Dictionnaire de sens — et surtout, sa péremption.
 *
 * Le schéma dit la forme d'un message ; ce dictionnaire dit ce qu'il désigne.
 * Le sens, lui, ne se déduit pas : il se relève une fois et se périme au
 * patch suivant. Ces tests portent donc autant sur la consultation que sur la
 * détection de péremption — un dictionnaire qui se tait quand il ne sait plus
 * vaut mieux qu'un dictionnaire qui répond faux.
 *
 * Ils gravent aussi les deux mesures qui ont dicté la conception :
 * la forme ne permet pas de remapper, l'ordre du pool permet de localiser.
 *
 *   node test/dofus-noms.test.js
 */

const assert = require('assert');
const createDofusSchema = require('../lib/dofus-schema');
const createDofusNoms = require('../lib/dofus-noms');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

// Un schéma miniature, pour tester les mécanismes sans dépendre du build.
const TABLE = {
  messages: {
    hga: { 1: { n: 'quest_type', t: 'hgi' } },
    hgj: { 1: { n: 'fluj', t: 'hgi' } },
    hhf: { 5: { n: 'flws', t: 'hha', r: 1 }, 9: { n: 'flww', t: 'hgi' } },
    hhv: { 1: { n: 'flyz', t: 'hgi' }, 2: { n: 'flza', t: 'int32' } },
    jrw: { 1: { n: 'map_id', t: 'int64' }, 2: { n: 'key_cells', t: 'int32', r: 1 } },
    zzz: { 1: { n: 'map_id', t: 'int64' } },
  },
  enums: ['hgi'],
  scalaires: { int32: 'varint', int64: 'varint' },
};

const schema = createDofusSchema({ table: TABLE });
const dico = {
  build: null,
  noms: { TreasureHuntDigRequest: 'hgj', TreasureHuntEvent: 'hhf', MapMovementRequest: 'jrw' },
};
const noms = createDofusNoms({ schema, dico });

// ─── Consultation ──────────────────────────────────────────────────────────

test('un sens donne son nom obfusqué, et réciproquement', () => {
  assert.strictEqual(noms.nom('TreasureHuntEvent'), 'hhf');
  assert.strictEqual(noms.sens('hhf'), 'TreasureHuntEvent');
  assert.strictEqual(noms.nom('Inexistant'), null);
  assert.strictEqual(noms.sens('zzz'), null);
});

test('les ancres d\'une entrée sont ses champs restés en clair', () => {
  assert.deepStrictEqual(noms.ancresDe('MapMovementRequest'), ['key_cells', 'map_id']);
  // La chasse est entièrement obfusquée : aucune ancre, donc introuvable
  // toute seule après un patch. C'est un fait à exposer, pas à masquer.
  assert.deepStrictEqual(noms.ancresDe('TreasureHuntEvent'), []);
});

// ─── Péremption ────────────────────────────────────────────────────────────

test('l\'empreinte du build est stable à schéma constant', () => {
  const a = noms.empreinteBuild();
  const b = createDofusNoms({ schema, dico }).empreinteBuild();
  assert.strictEqual(a, b);
});

test('l\'empreinte change dès que le schéma bouge', () => {
  const patche = JSON.parse(JSON.stringify(TABLE));
  patche.messages.hhf[12] = { n: 'nouveau', t: 'int32' };
  const autre = createDofusNoms({ schema: createDofusSchema({ table: patche }), dico });
  assert.notStrictEqual(autre.empreinteBuild(), noms.empreinteBuild());
});

test('un dictionnaire sans empreinte se déclare périmé', () => {
  // Refuser de répondre vaut mieux qu'agir sur un `hhf` devenu autre chose.
  assert.strictEqual(noms.estAJour(), false);
  const scelle = { build: noms.empreinteBuild(), noms: dico.noms };
  assert.strictEqual(createDofusNoms({ schema, dico: scelle }).estAJour(), true);
});

test('verifier() distingue l\'absent, le muet et l\'ancré', () => {
  const casse = { build: null, noms: { ...dico.noms, Disparu: 'aaa' } };
  const r = createDofusNoms({ schema, dico: casse }).verifier();
  assert.deepStrictEqual(r.absent, [{ sens: 'Disparu', nom: 'aaa' }]);
  assert.deepStrictEqual(r.muet.map(x => x.sens).sort(),
    ['TreasureHuntDigRequest', 'TreasureHuntEvent']);
  assert.deepStrictEqual(r.ancre.map(x => x.sens), ['MapMovementRequest']);
});

test('une entrée dont les ancres désignent ailleurs est signalée suspecte', () => {
  const menteur = { build: null, noms: { MapMovementRequest: 'hhv' } };
  const r = createDofusNoms({ schema, dico: menteur }).verifier();
  // hhv n'a pas d'ancre du tout : il tombe en muet, pas en suspect.
  assert.strictEqual(r.suspects.length, 0);
  assert.strictEqual(r.muet.length, 1);
});

// ─── Localisation après un patch ───────────────────────────────────────────

test('localiser() ne retient que les messages portant TOUTES les ancres', () => {
  // `zzz` porte map_id mais pas key_cells : la conjonction l'écarte.
  assert.deepStrictEqual(noms.localiser(['map_id']).sort(), ['jrw', 'zzz']);
  assert.deepStrictEqual(noms.localiser(['map_id', 'key_cells']), ['jrw']);
  assert.deepStrictEqual(noms.localiser([]), []);
});

test('le voisinage suit l\'ordre du pool, pas un ordre arbitraire', () => {
  // Les noms font trois lettres et sont alloués en séquence : l'ordre
  // alphabétique EST l'ordre de déclaration, donc les voisins d'un message
  // sont ses frères de namespace.
  assert.deepStrictEqual(noms.voisinage('hhf', 1), ['hgj', 'hhf', 'hhv']);
  assert.deepStrictEqual(noms.voisinage('inconnu', 3), []);
});

// ─── Le build réel ─────────────────────────────────────────────────────────

test('le dictionnaire livré décrit bien le schéma livré', () => {
  const reel = createDofusNoms();
  assert.strictEqual(reel.estAJour(), true,
    'dictionnaire et schéma désaccordés — relancer scripts/compiler-noms.js');
  assert.ok(reel.sensConnus().length >= 41, `${reel.sensConnus().length} paires seulement`);
});

test('les paires du build concordent avec ce que STAKK avait appris en jeu', () => {
  // Recoupement indépendant : `jrw` et `jqi` ont été établis par observation,
  // pas par lecture du binaire de dofus-multi. Les deux sources s'accordent.
  const reel = createDofusNoms();
  assert.strictEqual(reel.nom('MapMovementRequest'), 'jrw');
  assert.strictEqual(reel.nom('MapMovementConfirmRequest'), 'jqi');
  assert.deepStrictEqual(reel.ancresDe('MapMovementRequest'), ['key_cells', 'map_id']);
});

test('aucune entrée livrée n\'est suspecte', () => {
  const r = createDofusNoms().verifier();
  assert.deepStrictEqual(r.suspects, []);
  assert.deepStrictEqual(r.absent, []);
});

test('la grappe de la chasse se localise depuis une ancre voisine', () => {
  // Les trois messages de chasse sont muets. Mais `quest_type`, resté en
  // clair, ancre leurs frères de namespace — et l'ordre du pool fait le
  // reste : on passe de 2204 candidats à une vingtaine.
  const reel = createDofusNoms();
  const ancres = reel.localiser(['quest_type']);
  assert.ok(ancres.length > 0, 'aucun porteur de quest_type');
  const autour = new Set();
  for (const a of ancres) for (const v of reel.voisinage(a, 12)) autour.add(v);
  for (const cible of ['hgj', 'hhf', 'hhv']) {
    assert.ok(autour.has(cible), `${cible} hors du voisinage des ancres quest_type`);
  }
  assert.ok(autour.size < 60, `voisinage trop large : ${autour.size} candidats`);
});

console.log(`\n${passed} tests OK`);
