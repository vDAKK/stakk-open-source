'use strict';

/**
 * Tests de la couche pure du socle protocole. Aucun Dofus, aucune I/O :
 * les paquets sont fabriqués ici avec un encodage protobuf réaliste.
 *   node test/protocol-learn.test.js
 */

const assert = require('assert');
const learn = require('../lib/protocol-learn')();

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

test('varint : aller-retour sur encodage minimal', () => {
  for (const v of [0, 1, 127, 128, 300, 682397037, 200000000001]) {
    const buf = learn.encodeVarIntPadded(v, learn.varIntSize(v));
    const read = learn.readVarInt(buf, 0);
    assert.strictEqual(read.value, v, `valeur ${v}`);
    assert.strictEqual(read.length, buf.length, `longueur ${v}`);
  }
});

test('varint rembourré : même valeur, longueur imposée', () => {
  // L'encodage non minimal est autorisé par protobuf. C'est ce qui permet de
  // substituer un uid sans décaler un octet du paquet.
  const buf = learn.encodeVarIntPadded(1, 5);
  assert.strictEqual(buf.length, 5);
  assert.strictEqual(learn.readVarInt(buf, 0).value, 1);
});

test('varint rembourré : refuse une valeur qui ne tient pas', () => {
  assert.throws(() => learn.encodeVarIntPadded(300, 1), /ne tient pas/);
});

test('tag de champ : un numéro supérieur à 15 fait l\'aller-retour', () => {
  // Le tag vaut (numéro << 3) | wireType : dès le champ 16 il dépasse 127 et
  // ne tient plus sur un octet. Écrit sur un seul octet, il débordait en
  // silence et le paquet devenait illisible sans qu'aucune erreur ne remonte.
  // Ankama réobfusque les numéros de champ à chaque build et dépasse
  // couramment 15 : c'est un cas courant, pas un cas limite.
  for (const num of [1, 15, 16, 31, 2000, 70000]) {
    const buf = learn.varIntField(num, 123456);
    const champ = learn.parseStructured(buf)
      .find(f => !f.node && f.wire === 0 && f.fieldNumber === num);
    assert.ok(champ, `champ varint ${num} illisible`);
    assert.strictEqual(champ.value, 123456, `valeur du champ ${num}`);

    const enveloppe = learn.lenPrefixed(num, learn.varIntField(3, 77));
    const noeud = learn.parseStructured(enveloppe).find(f => f.node && f.fieldNumber === num);
    assert.ok(noeud, `sous-message ${num} illisible`);
    const dedans = learn.parseStructured(enveloppe)
      .find(f => !f.node && f.wire === 0 && f.fieldNumber === 3);
    assert.ok(dedans && dedans.value === 77, `contenu du sous-message ${num}`);
  }
});

test('tag de champ : sous 16, les octets produits sont inchangés', () => {
  // Non-régression pour la forgemagie, qui est en production : sous 16, le tag
  // tient sur un octet et les octets produits doivent être identiques à avant.
  for (let num = 1; num <= 15; num++) {
    assert.deepStrictEqual(learn.varIntField(num, 5),
      Buffer.from([(num << 3) | 0, 5]), `varIntField(${num})`);
    assert.deepStrictEqual(learn.lenPrefixed(num, Buffer.from([9])),
      Buffer.from([(num << 3) | 2, 1, 9]), `lenPrefixed(${num})`);
  }
});

test('patchVarInt conserve la longueur totale du paquet', () => {
  const orig = Buffer.concat([Buffer.from([0x08]), learn.encodeVarIntPadded(1, 5)]);
  const out = learn.patchVarInt(orig, 1, 5, 682397037);
  assert.strictEqual(out.length, orig.length, 'longueur modifiée');
  assert.strictEqual(learn.readVarInt(out, 1).value, 682397037);
});

test('replaceVarIntGrow recalcule tous les préfixes englobants', () => {
  // Enveloppe Any complète, uid sur 1 octet, remplacé par un uid sur 5.
  const value = Buffer.concat([learn.varIntField(1, 1), learn.varIntField(3, 1)]);
  const packet = learn.anyEnvelope('abc', value);
  const sigEnd = packet.indexOf('type.ankama.com/abc') + 'type.ankama.com/abc'.length;
  const uidOffset = packet.indexOf(Buffer.from([0x08, 0x01]), sigEnd) + 1;

  const out = learn.replaceVarIntGrow(packet, uidOffset, 1, 682397037);
  assert.strictEqual(out.length, packet.length + 4, 'le paquet doit grandir de 4 octets');

  // Le préfixe de longueur de tête doit décrire le reste exactement.
  const head = learn.readVarInt(out, 0);
  assert.strictEqual(head.value, out.length - head.length,
    'préfixe de longueur de tête incohérent');
  // Et l'uid doit être relisible à sa nouvelle place. Une recherche d'octet
  // brut (indexOf(0x08, …)) n'est PAS fiable ici : avec ces valeurs précises,
  // le préfixe de longueur du sous-message englobant vaut lui aussi 8, donc
  // le même octet 0x08 — on passe par le décodage structurel, qui distingue
  // un tag d'une longueur en suivant la forme réelle du message.
  const uidField = learn.parseStructured(out).find(f => f.wire === 0 && f.fieldNumber === 1);
  assert.strictEqual(uidField && uidField.value, 682397037);
});

test('typeNameOf lit le nom de type de l\'enveloppe Any', () => {
  const packet = learn.anyEnvelope('kcj', learn.varIntField(1, 1));
  assert.strictEqual(learn.typeNameOf(packet), 'kcj');
  assert.strictEqual(learn.typeNameOf(Buffer.from('0801', 'hex')), null);
});

test('typeNameOf s\'arrête à la longueur déclarée, pas au premier octet illisible', () => {
  // Le nom fait 3 lettres et la chaîne porte sa longueur (0a 13 = 19 octets =
  // 16 de préfixe + 3). Une lecture qui s'arrête au premier octet non
  // imprimable avale le début de la payload dès qu'il tombe dans l'ASCII —
  // observé en capture : « lva) » au lieu de « lva », un type qui ne
  // correspond alors à rien et un paquet ignoré en silence.
  //   0a 15         champ 1, longueur 21
  //     0a 13       champ 1, longueur 19 = 16 (préfixe) + 3 (nom)
  //       "type.ankama.com/lva"
  //     29 …        payload, dont le premier octet vaut ')'
  // Octets relevés tels quels dans une capture réelle.
  const packet = Buffer.from(
    '0a150a13747970652e616e6b616d612e636f6d2f6c7661290a270a25', 'hex');
  assert.strictEqual(learn.typeNameOf(packet), 'lva');
});

test('scanVarIntFields ne retient que le wire type 0 et les numéros valides', () => {
  //   08 ac 02   champ 1, varint 300
  //   12 02 ...  champ 2, longueur-préfixé — son tag est à l'offset 3
  const buf = Buffer.concat([learn.varIntField(1, 300), learn.lenPrefixed(2, Buffer.from('xy'))]);
  const fields = learn.scanVarIntFields(buf);
  assert.strictEqual(buf[3], 0x12, 'le paquet témoin n’a pas la forme attendue');
  assert.ok(fields.some(f => f.fieldNumber === 1 && f.value === 300), 'champ varint manquant');
  // L'assertion doit viser l'offset du tag longueur-préfixé, soit 3 : la viser
  // à l'offset 0 ne testait rien, puisque l'offset 0 porte le champ 1.
  assert.ok(!fields.some(f => f.tagOffset === 3),
    'un champ longueur-préfixée a été pris pour un varint');
  // Le numéro de champ 0 n'existe pas en protobuf : un octet nul ne doit
  // jamais ouvrir un champ.
  assert.ok(!learn.scanVarIntFields(Buffer.from([0x00, 0x2a])).some(f => f.fieldNumber === 0),
    'un champ de numéro 0 a été retenu');
});

test('scanVarIntFields décode un tag de champ sur plusieurs octets', () => {
  // Le tag est un VARINT, pas un octet. Pour le champ 16 il vaut 80 01 :
  // le lire sur un octet fait tomber le numéro de champ juste par
  // coïncidence (0x80 >> 3 = 16) mais fait démarrer la valeur sur 0x01,
  // second octet du tag. La fonction rendait donc 1 au lieu de la vraie
  // valeur — une lecture fausse et silencieuse, pas une cécité.
  for (const [num, val] of [[1, 300], [15, 123456], [16, 123456], [2000, 999999]]) {
    const buf = learn.varIntField(num, val);
    const champs = learn.scanVarIntFields(buf);
    assert.ok(champs.some(f => f.tagOffset === 0 && f.fieldNumber === num && f.value === val),
      `champ ${num} mal lu`);
  }
});

test('scanVarIntFields ne rend plus le second octet du tag comme valeur', () => {
  // Le piège, nommément : champ 16, grande valeur. L'ancienne lecture
  // rendait la valeur 1 — le 0x01 du tag — avec le bon numéro de champ.
  const buf = learn.varIntField(16, 682397037);
  const faux = learn.scanVarIntFields(buf).find(f => f.tagOffset === 0);
  assert.ok(faux, 'aucun champ lu au début du paquet');
  assert.strictEqual(faux.fieldNumber, 16);
  assert.strictEqual(faux.value, 682397037, 'la valeur lue vient du tag, pas du champ');
});

test('findAnchoredTemplate ancre sur un champ de numéro supérieur à 15', () => {
  // L'apprentissage passif de la forgemagie passe par l'ancrage. Ankama
  // réobfusque les numéros de champ à chaque build : le jour où l'uid
  // atterrit sur un champ 20, l'ancrage doit continuer de fonctionner.
  const UID = 682397037;
  const packet = learn.anyEnvelope('kcj', Buffer.concat([
    learn.varIntField(20, UID), learn.varIntField(2000, 1),
  ]));
  const t = learn.findAnchoredTemplate(packet, new Set([UID]));
  assert.ok(t, 'ancre introuvable sur un champ 20');
  assert.strictEqual(t.uidFieldNumber, 20, 'mauvais numéro de champ');
  assert.strictEqual(t.anchor, UID);
  assert.strictEqual(learn.readVarInt(packet, t.uidOffset).value, UID,
    'uidOffset ne pointe pas sur la valeur');
  assert.strictEqual(learn.readVarInt(packet, t.uidOffset).length, t.uidLength);
});

test('findFollowUpCommand voit une ancre portée par un champ de numéro élevé', () => {
  // Symétrique : un paquet qui porte une valeur connue est une ACTION, pas
  // une confirmation. Si l'ancre passe inaperçue parce que son champ dépasse
  // 15, une action serait prise pour la commande qui la valide.
  const UID = 682397037;
  const action = learn.anyEnvelope('kcx', learn.varIntField(20, UID));
  assert.strictEqual(learn.findFollowUpCommand(action, 'kcj', new Set([UID])), null,
    'une action a été prise pour une confirmation');
});

test('findAnchoredTemplate retrouve l\'ancre et sa position', () => {
  const UID = 682397037;
  const value = Buffer.concat([
    learn.varIntField(1, UID), learn.varIntField(3, 1), learn.varIntField(6, 1),
  ]);
  const packet = learn.anyEnvelope('kcj', value);

  const found = learn.findAnchoredTemplate(packet, new Set([UID]));
  assert.ok(found, 'ancre non trouvée');
  assert.strictEqual(found.typeName, 'kcj');
  assert.strictEqual(found.uidFieldNumber, 1);
  assert.strictEqual(found.anchor, UID);
  assert.strictEqual(learn.readVarInt(packet, found.uidOffset).value, UID,
    'uidOffset ne pointe pas sur l\'ancre');
  assert.strictEqual(found.template, packet.toString('hex'));
});

test('findAnchoredTemplate ignore un champ court qui vaut une ancre', () => {
  // Le piège réel : la quantité vaut 1, et 1 est dans les ancres connues.
  // Sans le garde-fou de taille, on fabriquerait un gabarit faux.
  const value = Buffer.concat([learn.varIntField(1, 1), learn.varIntField(3, 1)]);
  const packet = learn.anyEnvelope('kcj', value);
  assert.strictEqual(learn.findAnchoredTemplate(packet, new Set([1])), null);
});

test('findAnchoredTemplate refuse un paquet sans enveloppe Any', () => {
  const UID = 682397037;
  const packet = learn.varIntField(1, UID);
  assert.strictEqual(learn.findAnchoredTemplate(packet, new Set([UID])), null);
});

test('findAnchoredTemplate rend null sans ancre connue', () => {
  const packet = learn.anyEnvelope('kcj', learn.varIntField(1, 682397037));
  assert.strictEqual(learn.findAnchoredTemplate(packet, new Set()), null);
});

test('findFollowUpCommand retient une commande d\'un autre type sans ancre', () => {
  const cmd = learn.anyEnvelope('kqo', learn.varIntField(2, 1));
  const found = learn.findFollowUpCommand(cmd, 'kcj', new Set([682397037]));
  assert.ok(found, 'commande non reconnue');
  assert.strictEqual(found.typeName, 'kqo');
  assert.strictEqual(found.packet, cmd.toString('hex'));
});

test('findFollowUpCommand écarte un paquet du même type que l\'action', () => {
  const same = learn.anyEnvelope('kcj', learn.varIntField(2, 1));
  assert.strictEqual(learn.findFollowUpCommand(same, 'kcj', new Set()), null);
});

test('findFollowUpCommand écarte un paquet qui porte une ancre', () => {
  // Deux poses de suite : la seconde n'est pas la confirmation de la première.
  const UID = 682397037;
  const autre = learn.anyEnvelope('kcx', learn.varIntField(1, UID));
  assert.strictEqual(learn.findFollowUpCommand(autre, 'kcj', new Set([UID])), null);
});

test('createPairLearner apparie l\'action et sa confirmation', () => {
  const UID = 682397037;
  let t = 1000;
  const pair = learn.createPairLearner({ windowMs: 20000, now: () => t });
  const move = learn.anyEnvelope('kcj', Buffer.concat([
    learn.varIntField(1, UID), learn.varIntField(3, 1),
  ]));
  assert.strictEqual(pair.feed(move, new Set([UID])), null, 'appariée trop tôt');
  t += 500;
  const done = pair.feed(learn.anyEnvelope('kqo', learn.varIntField(2, 1)), new Set([UID]));
  assert.ok(done && done.move && done.ready, 'paire non formée');
  assert.strictEqual(done.move.typeName, 'kcj');
  assert.strictEqual(done.ready.typeName, 'kqo');
});

test('createPairLearner oublie l\'action passé la fenêtre', () => {
  const UID = 682397037;
  let t = 1000;
  const pair = learn.createPairLearner({ windowMs: 20000, now: () => t });
  pair.feed(learn.anyEnvelope('kcj', learn.varIntField(1, UID)), new Set([UID]));
  t += 20001;
  assert.strictEqual(
    pair.feed(learn.anyEnvelope('kqo', learn.varIntField(2, 1)), new Set([UID])), null,
    'une commande arrivée 20 s après a été appariée');
});

test('createPairLearner remplace l\'action si une seconde arrive', () => {
  const A = 682397037, B = 682397038;
  let t = 1000;
  const pair = learn.createPairLearner({ windowMs: 20000, now: () => t });
  pair.feed(learn.anyEnvelope('kcj', learn.varIntField(1, A)), new Set([A, B]));
  pair.feed(learn.anyEnvelope('kcj', learn.varIntField(1, B)), new Set([A, B]));
  const done = pair.feed(learn.anyEnvelope('kqo', learn.varIntField(2, 1)), new Set([A, B]));
  assert.strictEqual(done.move.anchor, B, 'la confirmation a été rattachée à l\'action périmée');
});

console.log(`\n${passed} test(s) OK`);
