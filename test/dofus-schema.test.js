'use strict';

/**
 * Décodage guidé par le schéma — la forme exacte, sans rien deviner.
 *
 * L'enjeu de ces tests : prouver qu'un paquet Dofus 3 se décode INTÉGRALEMENT
 * à partir du seul `type_url`, sans capture préalable et sans gabarit appris.
 * C'est ce qui retire l'apprentissage du chemin nominal.
 *
 *   node test/dofus-schema.test.js
 */

const assert = require('assert');
const createDofusSchema = require('../lib/dofus-schema');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

// ─── Outils d'encodage, pour fabriquer des paquets de test ─────────────────

function varint(n) {
  const out = [];
  let v = Math.floor(n);
  do { const b = v % 128; v = Math.floor(v / 128); out.push(v ? b | 0x80 : b); } while (v);
  return Buffer.from(out);
}
const champVarint = (num, val) => Buffer.concat([varint(num * 8), varint(val)]);
const champBloc = (num, buf) => Buffer.concat([varint(num * 8 + 2), varint(buf.length), buf]);
const champTexte = (num, str) => champBloc(num, Buffer.from(str, 'utf8'));

// Un schéma miniature : on teste le décodeur, pas la table réelle.
const TABLE_TEST = {
  messages: {
    hhv: { 1: { n: 'flyz', t: 'hgi' }, 2: { n: 'flza', t: 'int32' } },
    jrw: {
      1: { n: 'map_id', t: 'int64' },
      2: { n: 'key_cells', t: 'int32', r: 1 },
      3: { n: 'fuum', t: 'bool' },
    },
    hha: { 1: { n: 'flwe', t: 'hgy' }, 2: { n: 'flwf', t: 'int64' } },
    hhf: { 5: { n: 'flws', t: 'hha', r: 1 }, 9: { n: 'flww', t: 'hgi' } },
    txt: { 1: { n: 'nom', t: 'string' }, 2: { n: 'signe', t: 'sint32' } },
  },
  enums: ['hgi', 'hgy'],
  scalaires: {
    int32: 'varint', int64: 'varint', bool: 'bool', string: 'string',
    bytes: 'bytes', sint32: 'zigzag', float: 'f32', double: 'f64',
  },
};

const schema = createDofusSchema({ table: TABLE_TEST });

// ─── Décodage ──────────────────────────────────────────────────────────────

test('un message plat rend ses champs nommés', () => {
  const buf = Buffer.concat([champVarint(1, 2), champVarint(2, 7)]);
  assert.deepStrictEqual(schema.decoder('hhv', buf), { flyz: 2, flza: 7 });
});

test('un bool se rend en booléen, pas en 0/1', () => {
  const buf = Buffer.concat([champVarint(1, 84279045), champVarint(3, 1)]);
  const d = schema.decoder('jrw', buf);
  assert.strictEqual(d.fuum, true);
  assert.strictEqual(d.map_id, 84279045);
});

test('un scalaire répété arrive en paquet et ressort en tableau', () => {
  // key_cells est `repeated int32` : protobuf le colle en un seul champ de
  // type 2. Le rendre tel quel donnerait un Buffer opaque au lieu du chemin.
  const cellules = Buffer.concat([varint(310), varint(325), varint(340)]);
  const buf = Buffer.concat([champVarint(1, 84279045), champBloc(2, cellules)]);
  assert.deepStrictEqual(schema.decoder('jrw', buf).key_cells, [310, 325, 340]);
});

test('un sous-message répété se décode récursivement', () => {
  const drapeau = (etat, map) => champBloc(5, Buffer.concat([champVarint(1, etat), champVarint(2, map)]));
  const buf = Buffer.concat([drapeau(1, 84279045), drapeau(0, 84279046), champVarint(9, 2)]);
  assert.deepStrictEqual(schema.decoder('hhf', buf), {
    flws: [{ flwe: 1, flwf: 84279045 }, { flwe: 0, flwf: 84279046 }],
    flww: 2,
  });
});

test('une chaîne et un sint32 se décodent selon leur type', () => {
  const buf = Buffer.concat([champTexte(1, 'Bonta'), champVarint(2, 9)]);
  assert.deepStrictEqual(schema.decoder('txt', buf), { nom: 'Bonta', signe: -5 });
});

test('les gros identifiants passent au-delà de 2^32 sans se corrompre', () => {
  // Un uid d'entité tourne autour de 1e10 : un décodeur qui accumule en OR
  // 32 bits le tronquerait en silence.
  const uid = 12345678901;
  const buf = champVarint(1, uid);
  assert.strictEqual(schema.decoder('jrw', buf).map_id, uid);
});

// ─── Robustesse : ce qui doit survivre à un patch ─────────────────────────

test('un champ hors schéma est rendu, pas perdu', () => {
  // Ankama ajoute des champs entre deux builds. Les jeter rendrait la dérive
  // invisible ; les rendre sous `?<numéro>` la met sous les yeux.
  const buf = Buffer.concat([champVarint(1, 2), champVarint(42, 99)]);
  assert.deepStrictEqual(schema.decoder('hhv', buf), { flyz: 2, '?42': 99 });
});

test('un message inconnu rend null au lieu d\'inventer', () => {
  assert.strictEqual(schema.decoder('zzz', champVarint(1, 1)), null);
  assert.strictEqual(schema.estConnu('zzz'), false);
  assert.strictEqual(schema.estConnu('hhv'), true);
});

test('un tampon tronqué rend null', () => {
  assert.strictEqual(schema.decoder('hhv', Buffer.from([0x08])), null);
  assert.strictEqual(schema.decoder('hhv', Buffer.from([0x12, 0x7f, 0x01])), null);
});

// ─── Enveloppe Any ─────────────────────────────────────────────────────────

test('le nom du message se lit dans le type_url', () => {
  assert.strictEqual(schema.nomDepuisTypeUrl('type.ankama.com/hhf'), 'hhf');
  assert.strictEqual(schema.nomDepuisTypeUrl('hhf'), 'hhf');
  assert.strictEqual(schema.nomDepuisTypeUrl(''), null);
});

test('un Any se décode de bout en bout sans rien avoir appris', () => {
  // Le cœur de l'affaire : le nom voyage AVEC le paquet, donc une seule
  // lecture suffit — pas de capture préalable, pas de gabarit ancré.
  const contenu = Buffer.concat([champVarint(1, 2), champVarint(2, 7)]);
  const any = Buffer.concat([
    champTexte(1, 'type.ankama.com/hhv'),
    champBloc(2, contenu),
  ]);
  const d = schema.decoderAny(any);
  assert.strictEqual(d.nom, 'hhv');
  assert.deepStrictEqual(d.contenu, { flyz: 2, flza: 7 });
});

test('un Any dont le message a été rebattu garde ses octets bruts', () => {
  // Après un patch, `zzz` n'est plus au schéma. Rendre null sur le contenu
  // tout en gardant `brut` laisse l'apprentissage prendre le relais.
  const any = Buffer.concat([
    champTexte(1, 'type.ankama.com/zzz'),
    champBloc(2, champVarint(1, 5)),
  ]);
  const d = schema.decoderAny(any);
  assert.strictEqual(d.nom, 'zzz');
  assert.strictEqual(d.contenu, null);
  assert.strictEqual(d.brut.length, 2);
});

test('un Any se retrouve dans un paquet CADRÉ, pas seulement nu', () => {
  // Sur le fil l'Any arrive enveloppé : longueur de trame, identifiant de
  // message, enveloppe Event. Décoder ce paquet à plat lisait le type_url
  // comme le premier champ du message — c'est ainsi qu'une récolte a pu
  // passer pour un événement de chasse.
  const recolte = Buffer.from(
    '2d122b0a1e0a13747970652e616e6b616d612e636f6d2f69776f120708ff09108c9c1e10ffffffffffffffffff01', 'hex');
  const reel = createDofusSchema();
  const any = reel.extraireAny(recolte);
  assert.strictEqual(any.nom, 'iwo');
  // iwo, c'est la récolte : un uid d'instance de skill et un élément.
  assert.deepStrictEqual(any.contenu, { skill_instance_uid: 1279, element_id: 495116 });
});

test('un paquet sans Any ne rend rien plutôt qu\'une lecture approximative', () => {
  assert.strictEqual(createDofusSchema().extraireAny(Buffer.from([0x08, 0x01])), null);
});

// ─── Encodage ──────────────────────────────────────────────────────────────

test('encoder puis décoder rend l\'objet de départ', () => {
  const objet = { flyz: 2, flza: 7 };
  assert.deepStrictEqual(schema.decoder('hhv', schema.encoder('hhv', objet)), objet);
});

test('un scalaire répété se ré-encode en paquet, comme le client officiel', () => {
  const objet = { map_id: 84279045, key_cells: [310, 325, 340], fuum: true };
  const buf = schema.encoder('jrw', objet);
  // Un seul champ 2 de type 2 (tag 0x12) portant les trois cellules sur six
  // octets — et donc AUCUN tag 0x10, qui trahirait trois champs séparés.
  assert.ok(buf.includes(Buffer.from([0x12, 0x06])), 'key_cells doit sortir en un paquet');
  assert.ok(!buf.includes(Buffer.from([0x10])), 'key_cells ne doit pas sortir dépaqueté');
  assert.deepStrictEqual(schema.decoder('jrw', buf), objet);
});

test('les sous-messages répétés se ré-encodent récursivement', () => {
  const objet = { flws: [{ flwe: 1, flwf: 84279045 }], flww: 2 };
  assert.deepStrictEqual(schema.decoder('hhf', schema.encoder('hhf', objet)), objet);
});

test('les champs émis sont dans l\'ordre croissant des numéros', () => {
  // Un paquet dont les champs sortiraient dans le désordre resterait valide
  // pour protobuf, mais se distinguerait de ceux du client.
  const buf = schema.encoder('jrw', { fuum: true, map_id: 5, key_cells: [1] });
  assert.strictEqual(buf[0], 0x08, 'map_id (champ 1) doit venir en premier');
});

test('une clé hors schéma est ignorée plutôt qu\'émise au hasard', () => {
  const buf = schema.encoder('hhv', { flyz: 1, inconnu: 42 });
  assert.deepStrictEqual(schema.decoder('hhv', buf), { flyz: 1 });
});

test('un message inconnu ne s\'encode pas', () => {
  assert.strictEqual(schema.encoder('zzz', { a: 1 }), null);
});

test('encoderAny produit un Any que decoderAny relit', () => {
  const any = schema.encoderAny('hhv', { flyz: 2, flza: 7 });
  assert.ok(any.includes(Buffer.from('type.ankama.com/hhv')));
  assert.deepStrictEqual(schema.decoderAny(any), {
    nom: 'hhv',
    brut: schema.encoder('hhv', { flyz: 2, flza: 7 }),
    contenu: { flyz: 2, flza: 7 },
  });
});

// ─── Recherche par forme : de quoi survivre à la réobfuscation ────────────

test('un message se retrouve par sa forme quand son nom a changé', () => {
  const trouves = schema.messagesDeForme({ 1: 'hgi', 2: 'int32' });
  assert.deepStrictEqual(trouves, ['hhv']);
});

// ─── Le schéma réel ────────────────────────────────────────────────────────

test('le schéma compilé couvre le protocole du build courant', () => {
  const reel = createDofusSchema();
  assert.ok(reel.nbMessages() > 2000, `seulement ${reel.nbMessages()} messages`);
  // Les trois messages de la chasse au trésor, relevés dans dofus-multi.
  for (const nom of ['hhf', 'hhv', 'hgj']) {
    assert.ok(reel.estConnu(nom), `message ${nom} absent du schéma`);
  }
  // Le déplacement, déjà établi par l'apprentissage : la table doit concorder.
  assert.strictEqual(reel.champsDe('jrw')['1'].n, 'map_id');
  assert.strictEqual(reel.champsDe('jrw')['2'].n, 'key_cells');
  assert.strictEqual(reel.champsDe('jrw')['2'].r, 1);
});

test('la chasse au trésor a bien la forme relevée dans dofus-multi', () => {
  const reel = createDofusSchema();
  // TreasureHuntFlagRequest : { questType, index }
  assert.deepStrictEqual(reel.champsDe('hhv'), {
    1: { n: 'flyz', t: 'hgi' },
    2: { n: 'flza', t: 'int32' },
  });
  // TreasureHuntEvent porte les drapeaux posés et les étapes.
  const hhf = reel.champsDe('hhf');
  assert.strictEqual(hhf['5'].r, 1, 'les drapeaux sont répétés');
  assert.strictEqual(hhf['10'].r, 1, 'les étapes sont répétées');
});

console.log(`\n${passed} tests OK`);
