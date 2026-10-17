'use strict';

/**
 * Tests du décodage protocole FM. Aucun Dofus : les paquets sont fabriqués
 * ici avec un encodage protobuf réaliste (enveloppe Any + sous-message).
 *   node test/fm-protocol.test.js
 */

const assert = require('assert');
const proto = require('../lib/fm-protocol')();

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

// ─── Fabrique de paquets ───────────────────────────────────────────────────

function varint(v) {
  const out = [];
  let n = Math.floor(v);
  do { const b = n % 128; n = Math.floor(n / 128); out.push(b | (n > 0 ? 0x80 : 0)); } while (n > 0);
  return Buffer.from(out);
}
function lenField(fieldNo, payload) {
  return Buffer.concat([Buffer.from([(fieldNo << 3) | 2]), varint(payload.length), payload]);
}
function varField(fieldNo, value) {
  return Buffer.concat([Buffer.from([(fieldNo << 3) | 0]), varint(value)]);
}
function header(msgId) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE((msgId << 2) & 0xffff, 0);
  return b;
}
// Format réel du canal : <varint longueur><message protobuf>.
function frame(payload) { return Buffer.concat([varint(payload.length), payload]); }

// Message « pose un objet dans l'échange » : Any(type_url) + sous-message
// { uid, quantité }.
function movePacket(msgId, uid, qty) {
  const inner = Buffer.concat([varField(1, uid), varField(2, qty)]);
  return frame(Buffer.concat([
    lenField(1, Buffer.from('type.ankama.com/xyz')),
    lenField(2, inner),
  ]));
}
function readyPacket(msgId) {
  return frame(lenField(1, Buffer.from('type.ankama.com/rdy')));
}
function line(dir, msgId, buf, ts) {
  return `${ts || '10:00:00.000'} ${dir.padEnd(3)} msgId=${msgId} len=${buf.length} hex=${buf.toString('hex')}`;
}

const MOVE_MSG = 4210, READY_MSG = 4211, NOISE_MSG = 9001;
const UID_A = 100000000000, UID_B = 100000000001;

function capture(opts) {
  opts = opts || {};
  const l = ['# STAKK FM capture — account=1', '#'];
  l.push(line('OUT', NOISE_MSG, Buffer.from('cafebabe', 'hex')));
  l.push(line('IN', 777, Buffer.from('00ff', 'hex')));
  l.push(line('OUT', MOVE_MSG, movePacket(MOVE_MSG, UID_A, 1)));
  if (!opts.noReady) l.push(line('OUT', READY_MSG, readyPacket(READY_MSG)));
  l.push(line('IN', 888, Buffer.from('0102030405', 'hex')));
  if (!opts.singleThrow) {
    l.push(line('OUT', MOVE_MSG, movePacket(MOVE_MSG, UID_B, 1)));
    if (!opts.noReady) l.push(line('OUT', READY_MSG, readyPacket(READY_MSG)));
  }
  return l.join('\n') + '\n';
}

console.log('fm-protocol');

// ─── Varints ───────────────────────────────────────────────────────────────

test('readVarInt gère les grands uid sans wrap 32 bits', () => {
  const buf = varint(100000000001);
  const r = proto.readVarInt(buf, 0);
  assert.strictEqual(r.value, 100000000001);
  assert.strictEqual(r.length, buf.length);
});

test('readVarInt renvoie null sur varint tronqué', () => {
  assert.strictEqual(proto.readVarInt(Buffer.from([0x80, 0x80]), 0), null);
});

test('encodeVarIntPadded produit la longueur demandée et se relit', () => {
  for (const len of [1, 2, 5, 8]) {
    const enc = proto.encodeVarIntPadded(5, len);
    assert.strictEqual(enc.length, len);
    const r = proto.readVarInt(enc, 0);
    assert.strictEqual(r.value, 5, `len=${len}`);
    assert.strictEqual(r.length, len);
  }
});

test('encodeVarIntPadded refuse une valeur trop grande pour la place', () => {
  assert.throws(() => proto.encodeVarIntPadded(100000, 1), /ne tient pas/);
  assert.throws(() => proto.encodeVarIntPadded(-1, 4), /invalide/);
});

test('varIntSize colle à l\'encodage minimal', () => {
  assert.strictEqual(proto.varIntSize(0), 1);
  assert.strictEqual(proto.varIntSize(127), 1);
  assert.strictEqual(proto.varIntSize(128), 2);
  assert.strictEqual(proto.varIntSize(100000000001), varint(100000000001).length);
});

test('patchVarInt conserve la longueur totale du paquet', () => {
  const p = movePacket(MOVE_MSG, UID_A, 1);
  const off = p.indexOf(varint(UID_A));
  const patched = proto.patchVarInt(p, off, varint(UID_A).length, 42);
  assert.strictEqual(patched.length, p.length);
  assert.strictEqual(proto.readVarInt(patched, off).value, 42);
  assert.notStrictEqual(patched, p);
  assert.strictEqual(proto.readVarInt(p, off).value, UID_A, 'buffer source muté');
});

// Cas réel : le gabarit appris portait un uid sur 4 octets, mais la rune
// visée en demandait 6. Il faut alors allonger le varint ET recalculer les
// longueurs de tous les messages englobants, trame comprise.
test('replaceVarIntGrow: uid plus large que la place initiale', () => {
  const inner = Buffer.concat([varField(1, 100), varField(4, 1)]);
  const body = Buffer.concat([
    lenField(1, Buffer.from('type.ankama.com/xyz')),
    lenField(2, inner),
  ]);
  const pkt = Buffer.concat([varint(body.length), body]);

  // Repère l'offset du varint « 100 » (champ 1 du sous-message).
  const uidOffset = pkt.indexOf(Buffer.from([0x08, 100])) + 1;
  const big = 143325921574;
  const out = proto.replaceVarIntGrow(pkt, uidOffset, 1, big);

  const frames = proto.splitFrames(out);
  assert.strictEqual(frames.complete, true, 'trame incohérente après agrandissement');
  const values = proto.parseStructured(out).filter(f => f.wire === 0).map(f => f.value);
  assert.ok(values.includes(big), 'nouvel uid absent');
  assert.ok(values.includes(1), 'quantité perdue');
  assert.ok(out.includes(Buffer.from('type.ankama.com/xyz')), 'type_url perdu');
  // La longueur déclarée de la trame doit correspondre à ce qui suit :
  // c'est le vrai critère, pas une taille calculée à la main.
  const f = frames.frames[0];
  assert.strictEqual(f.start + f.length, out.length, 'longueur de trame incohérente');
});

test('replaceVarIntGrow: valeur plus courte, le paquet rétrécit proprement', () => {
  const inner = Buffer.concat([varField(1, 143325921574), varField(4, 1)]);
  const body = Buffer.concat([lenField(1, Buffer.from('type.ankama.com/xyz')), lenField(2, inner)]);
  const pkt = Buffer.concat([varint(body.length), body]);
  const uidOffset = pkt.indexOf(varint(143325921574));
  const out = proto.replaceVarIntGrow(pkt, uidOffset, proto.varIntSize(143325921574), 7);
  assert.strictEqual(proto.splitFrames(out).complete, true);
  const values = proto.parseStructured(out).filter(f => f.wire === 0).map(f => f.value);
  assert.ok(values.includes(7));
  assert.ok(out.length < pkt.length);
});

test('replaceVarIntGrow: même taille → chemin rapide, longueur inchangée', () => {
  const inner = Buffer.concat([varField(1, 1000), varField(4, 1)]);
  const body = Buffer.concat([lenField(2, inner)]);
  const pkt = Buffer.concat([varint(body.length), body]);
  const uidOffset = pkt.indexOf(varint(1000));
  const out = proto.replaceVarIntGrow(pkt, uidOffset, 2, 2000);
  assert.strictEqual(out.length, pkt.length);
  assert.strictEqual(proto.readVarInt(out, uidOffset).value, 2000);
});

test('patchVarInt refuse un offset hors limites', () => {
  assert.throws(() => proto.patchVarInt(Buffer.alloc(4), 3, 4, 1), /hors limites/);
});

// ─── Lecture de capture ────────────────────────────────────────────────────

test('parseCapture ignore commentaires et lignes invalides', () => {
  const txt = '# entête\n\nn\'importe quoi\n' + line('OUT', 5, Buffer.from('ab', 'hex')) + '\n';
  const pk = proto.parseCapture(txt);
  assert.strictEqual(pk.length, 1);
  assert.strictEqual(pk[0].msgId, 5);
  assert.strictEqual(pk[0].dir, 'OUT');
  assert.strictEqual(pk[0].buf.toString('hex'), 'ab');
});

test('parseCapture sur texte vide ne casse pas', () => {
  assert.deepStrictEqual(proto.parseCapture(''), []);
  assert.deepStrictEqual(proto.parseCapture(null), []);
});

// ─── Profil ────────────────────────────────────────────────────────────────

test('buildProfile identifie pose + forge et localise l\'uid', () => {
  const r = proto.buildProfile(capture());
  assert.ok(r.ok, r.detail);
  assert.strictEqual(r.profile.move.msgId, MOVE_MSG);
  assert.strictEqual(r.profile.ready.msgId, READY_MSG);
  assert.deepStrictEqual(r.profile.move.observedUids.sort((a, b) => a - b), [UID_A, UID_B]);
  assert.strictEqual(r.profile.move.uidLength, varint(UID_A).length);
  const tpl = Buffer.from(r.profile.move.template, 'hex');
  assert.strictEqual(proto.readVarInt(tpl, r.profile.move.uidOffset).value, UID_A);
});

test('buildProfile: rejeu sur un autre uid', () => {
  const r = proto.buildProfile(capture());
  const pkt = proto.buildMovePacket(r.profile, 999999);
  // L'uid est encodé au plus court, comme le ferait le vrai client : la
  // longueur du paquet suit donc celle de l'uid, et les préfixes englobants
  // sont recalculés en conséquence.
  assert.strictEqual(proto.splitFrames(pkt).complete, true, 'trame incohérente');
  assert.strictEqual(proto.readVarInt(pkt, r.profile.move.uidOffset).value, 999999);
  // Le reste du paquet est intact (type_url, quantité).
  assert.ok(pkt.includes(Buffer.from('type.ankama.com/xyz')));
  assert.ok(proto.parseStructured(pkt).filter(f => f.wire === 0).map(f => f.value).includes(1),
    'quantité perdue');
  const ready = proto.buildReadyPacket(r.profile);
  assert.strictEqual(ready.toString('hex'), readyPacket(READY_MSG).toString('hex'));
});

test('buildProfile: un seul jet → diagnostic explicite, pas de profil', () => {
  const r = proto.buildProfile(capture({ singleThrow: true }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no-move');
  assert.match(r.detail, /DEUX runes/);
});

test('buildProfile: pas de paquet de validation → no-ready', () => {
  const r = proto.buildProfile(capture({ noReady: true }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no-ready');
});

// Cas rencontré en vrai : l'utilisateur pose deux runes puis ne clique
// Forger qu'une seule fois. Le paquet de forge n'apparaît alors qu'UNE fois
// et la règle « répété à l'identique » le ratait.
test('buildProfile: une seule forge → profil déduit, marqué en confiance faible', () => {
  const txt = [
    line('OUT', MOVE_MSG, movePacket(MOVE_MSG, UID_A, 1)),
    line('OUT', MOVE_MSG, movePacket(MOVE_MSG, UID_B, 1)),
    line('IN', 888, Buffer.from('0102', 'hex')),
    line('OUT', READY_MSG, readyPacket(READY_MSG)),
  ].join('\n');
  const r = proto.buildProfile(txt);
  assert.ok(r.ok, r.detail);
  assert.strictEqual(r.profile.ready.msgId, READY_MSG);
  assert.strictEqual(r.profile.ready.confidence, 'low');
  assert.strictEqual(r.stats.readyGuessed, true);
  assert.strictEqual(r.profile.ready.packet, readyPacket(READY_MSG).toString('hex'));
});

test('buildProfile: le repli ignore les paquets de service', () => {
  // Un paquet sans enveloppe Any (keepalive) ne doit pas être pris pour la forge.
  const keepAlive = Buffer.concat([header(1234), Buffer.from('0801', 'hex')]);
  const txt = [
    line('OUT', MOVE_MSG, movePacket(MOVE_MSG, UID_A, 1)),
    line('OUT', MOVE_MSG, movePacket(MOVE_MSG, UID_B, 1)),
    line('OUT', 1234, keepAlive),
    line('OUT', READY_MSG, readyPacket(READY_MSG)),
  ].join('\n');
  const r = proto.buildProfile(txt);
  assert.ok(r.ok, r.detail);
  assert.strictEqual(r.profile.ready.msgId, READY_MSG, 'keepalive pris pour la forge');
});

// Séquence réellement capturée : pose, pose, pose, FORGE, pose. La forge
// existe mais elle est suivie d'une pose — chercher seulement après la
// DERNIÈRE pose la ratait.
test('buildProfile: forge suivie d\'une autre pose', () => {
  const txt = [
    line('OUT', MOVE_MSG, movePacket(MOVE_MSG, UID_A, 1)),
    line('OUT', MOVE_MSG, movePacket(MOVE_MSG, UID_B, 1)),
    line('OUT', MOVE_MSG, movePacket(MOVE_MSG, UID_A + 7, 1)),
    line('OUT', READY_MSG, readyPacket(READY_MSG)),
    line('OUT', MOVE_MSG, movePacket(MOVE_MSG, UID_B + 9, 1)),
  ].join('\n');
  const r = proto.buildProfile(txt);
  assert.ok(r.ok, r.detail);
  assert.strictEqual(r.profile.move.msgId, MOVE_MSG);
  assert.strictEqual(r.profile.ready.msgId, READY_MSG);
  assert.strictEqual(r.profile.ready.confidence, 'low');
});

test('buildProfile: privilégie la commande qui suit immédiatement une pose', () => {
  const chat = Buffer.concat([header(4444), lenField(1, Buffer.from('type.ankama.com/cht'))]);
  const txt = [
    line('OUT', MOVE_MSG, movePacket(MOVE_MSG, UID_A, 1)),
    line('OUT', 4444, chat),                                    // suit une pose aussi…
    line('OUT', MOVE_MSG, movePacket(MOVE_MSG, UID_B, 1)),
    line('OUT', READY_MSG, readyPacket(READY_MSG)),             // …mais celle-ci aussi
  ].join('\n');
  const r = proto.buildProfile(txt);
  assert.ok(r.ok, r.detail);
  // Les deux suivent une pose : à égalité, le premier gagne. On vérifie
  // surtout qu'un candidat plausible est retenu et signalé comme déduit.
  assert.strictEqual(r.profile.ready.confidence, 'low');
  assert.ok([4444, READY_MSG].includes(r.profile.ready.msgId));
});

test('buildProfile: le repli ignore ce qui précède la première pose', () => {
  const other = Buffer.concat([header(7777), lenField(1, Buffer.from('type.ankama.com/zzz'))]);
  const txt = [
    line('OUT', 7777, other),                                  // avant les poses
    line('OUT', MOVE_MSG, movePacket(MOVE_MSG, UID_A, 1)),
    line('OUT', MOVE_MSG, movePacket(MOVE_MSG, UID_B, 1)),
    line('OUT', READY_MSG, readyPacket(READY_MSG)),
  ].join('\n');
  const r = proto.buildProfile(txt);
  assert.ok(r.ok, r.detail);
  assert.strictEqual(r.profile.ready.msgId, READY_MSG);
});

// Cas réel : la capture démarre juste après une forge, donc le flux commence
// par un paquet de forge « orphelin » avant la première pose. Dater le
// candidat sur sa PREMIÈRE occurrence le faisait rejeter, et on retombait à
// tort sur le repli en confiance faible.
test('buildProfile: une forge antérieure à la 1re pose n\'invalide pas le candidat', () => {
  const txt = [
    line('OUT', READY_MSG, readyPacket(READY_MSG)),   // reliquat du jet précédent
    line('OUT', MOVE_MSG, movePacket(MOVE_MSG, UID_A, 1)),
    line('OUT', MOVE_MSG, movePacket(MOVE_MSG, UID_B, 1)),
    line('OUT', READY_MSG, readyPacket(READY_MSG)),
  ].join('\n');
  const r = proto.buildProfile(txt);
  assert.ok(r.ok, r.detail);
  assert.strictEqual(r.profile.ready.msgId, READY_MSG);
  assert.strictEqual(r.profile.ready.confidence, 'high', 'retombé sur le repli alors que la forge se répète');
  assert.strictEqual(r.stats.readyGuessed, false);
});

test('buildProfile: une forge UNIQUEMENT avant les poses reste rejetée', () => {
  const txt = [
    line('OUT', READY_MSG, readyPacket(READY_MSG)),
    line('OUT', READY_MSG, readyPacket(READY_MSG)),
    line('OUT', MOVE_MSG, movePacket(MOVE_MSG, UID_A, 1)),
    line('OUT', MOVE_MSG, movePacket(MOVE_MSG, UID_B, 1)),
  ].join('\n');
  const r = proto.buildProfile(txt);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no-ready');
});

test('buildProfile: deux forges répétées restent en confiance haute', () => {
  const r = proto.buildProfile(capture());
  assert.strictEqual(r.profile.ready.confidence, 'high');
  assert.strictEqual(r.stats.readyGuessed, false);
});

test('buildProfile: capture vide → empty', () => {
  const r = proto.buildProfile('# rien\n');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'empty');
});

test('buildProfile ignore un « forge » antérieur à la pose', () => {
  // Deux paquets identiques AVANT la pose ne doivent pas être pris pour la
  // validation : sinon le rejeu enverrait forge → pose.
  const early = Buffer.concat([header(NOISE_MSG), Buffer.from('11223344', 'hex')]);
  const txt = [
    line('OUT', NOISE_MSG, early),
    line('OUT', NOISE_MSG, early),
    line('OUT', MOVE_MSG, movePacket(MOVE_MSG, UID_A, 1)),
    line('OUT', READY_MSG, readyPacket(READY_MSG)),
    line('OUT', MOVE_MSG, movePacket(MOVE_MSG, UID_B, 1)),
    line('OUT', READY_MSG, readyPacket(READY_MSG)),
  ].join('\n');
  const r = proto.buildProfile(txt);
  assert.ok(r.ok, r.detail);
  assert.strictEqual(r.profile.ready.msgId, READY_MSG);
});

test('buildMovePacket refuse un profil incomplet', () => {
  assert.throws(() => proto.buildMovePacket(null, 1), /incomplet/);
  assert.throws(() => proto.buildReadyPacket({}), /incomplet/);
});

// ─── Inventaire ────────────────────────────────────────────────────────────

// Paquet « contenu de l'inventaire » : liste d'objets { uid, gid, quantité }.
function inventoryPacket(items) {
  const entries = items.map(it => lenField(3, Buffer.concat([
    varField(1, it.uid), varField(2, it.gid), varField(3, it.qty),
  ])));
  return Buffer.concat([header(6000), lenField(1, Buffer.from('type.ankama.com/inv')), ...entries]);
}

test('scanObjectEntries retrouve gid/uid/quantité des runes connues', () => {
  const buf = inventoryPacket([
    { uid: 200000000001, gid: 1519, qty: 42 },
    { uid: 200000000002, gid: 1545, qty: 7 },
    { uid: 200000000003, gid: 9999, qty: 3 },   // objet non recherché
  ]);
  const found = proto.scanObjectEntries(buf, [1519, 1545]);
  const byGid = {};
  for (const e of found) if (e.confidence === 'high') byGid[e.gid] = e;
  assert.ok(byGid[1519], 'rune 1519 non trouvée');
  assert.strictEqual(byGid[1519].uid, 200000000001);
  assert.strictEqual(byGid[1519].quantity, 42);
  assert.strictEqual(byGid[1545].uid, 200000000002);
  assert.strictEqual(byGid[1545].quantity, 7);
  assert.ok(!found.some(e => e.gid === 9999), 'gid non demandé remonté');
});

test('scanObjectEntries: aucun gid connu → rien', () => {
  const buf = inventoryPacket([{ uid: 200000000001, gid: 1519, qty: 1 }]);
  assert.deepStrictEqual(proto.scanObjectEntries(buf, []), []);
  assert.deepStrictEqual(proto.scanObjectEntries(Buffer.alloc(0), [1519]), []);
  assert.deepStrictEqual(proto.scanObjectEntries(buf, [4242]), []);
});

// Le serveur signale un changement de pile par un message minimal
// { identifiant, nouvelle quantité } — sans gid, donc invisible pour
// scanObjectEntries. C'est ce qui permet de retirer une pile consommée.
test('scanQuantityUpdates lit les mises à jour des piles connues', () => {
  const buf = Buffer.concat([header(6200),
    lenField(1, Buffer.from('type.ankama.com/qty')),
    lenField(3, Buffer.concat([varField(1, 200000000001), varField(2, 12)])),
    lenField(3, Buffer.concat([varField(1, 200000000002), varField(2, 0)])),
  ]);
  const got = proto.scanQuantityUpdates(buf, [200000000001, 200000000002]);
  assert.deepStrictEqual(got.sort((a, b) => a.uid - b.uid), [
    { uid: 200000000001, quantity: 12 },
    { uid: 200000000002, quantity: 0 },
  ]);
});

test('scanQuantityUpdates ignore les identifiants inconnus', () => {
  const buf = Buffer.concat([header(6200),
    lenField(3, Buffer.concat([varField(1, 200000000001), varField(2, 12)]))]);
  assert.deepStrictEqual(proto.scanQuantityUpdates(buf, [999]), []);
  assert.deepStrictEqual(proto.scanQuantityUpdates(buf, []), []);
  assert.deepStrictEqual(proto.scanQuantityUpdates(null, [200000000001]), []);
});

test('scanQuantityUpdates ignore les sous-messages ambigus', () => {
  // 3 varints : c'est un objet complet, pas une mise à jour de quantité.
  const buf = Buffer.concat([header(6200),
    lenField(3, Buffer.concat([varField(1, 200000000001), varField(2, 1545), varField(3, 12)]))]);
  assert.deepStrictEqual(proto.scanQuantityUpdates(buf, [200000000001]), []);
});

// Une pile ENTIÈREMENT consommée n'est pas annoncée à zéro : le serveur envoie
// un message de suppression qui ne porte qu'un seul champ, l'identifiant. Il
// échappe donc à scanQuantityUpdates, qui en exige deux.
const deletionPacket = uids => Buffer.concat([header(6300),
  lenField(1, Buffer.from('type.ankama.com/del')),
  ...uids.map(uid => lenField(3, varField(1, uid)))]);

test('scanObjectDeletions repère un identifiant supprimé', () => {
  const buf = deletionPacket([200000000001]);
  assert.deepStrictEqual(proto.scanObjectDeletions(buf, [200000000001, 200000000002]),
    [200000000001]);
});

test('scanObjectDeletions ne confond pas une mise à jour de quantité', () => {
  // Les deux mécanismes ne doivent pas se marcher dessus : { uid, quantité }
  // est une mise à jour, { uid } seul est une suppression.
  const update = Buffer.concat([header(6200),
    lenField(1, Buffer.from('type.ankama.com/qty')),
    lenField(3, Buffer.concat([varField(1, 200000000001), varField(2, 12)]))]);
  assert.deepStrictEqual(proto.scanObjectDeletions(update, [200000000001]), []);
  assert.deepStrictEqual(proto.scanQuantityUpdates(deletionPacket([200000000001]), [200000000001]), []);
});

test('scanObjectDeletions ignore un identifiant inconnu', () => {
  assert.deepStrictEqual(proto.scanObjectDeletions(deletionPacket([200000000001]), [999999999999]), []);
  assert.deepStrictEqual(proto.scanObjectDeletions(deletionPacket([200000000001]), []), []);
  assert.deepStrictEqual(proto.scanObjectDeletions(null, [200000000001]), []);
});

test('scanObjectDeletions ignore un sous-message qui porte autre chose', () => {
  // { uid, effets… } décrit un objet, pas sa disparition.
  const buf = Buffer.concat([header(6300),
    lenField(3, Buffer.concat([
      varField(1, 200000000001),
      lenField(5, Buffer.concat([varField(1, 125), varField(2, 12)])),
    ]))]);
  assert.deepStrictEqual(proto.scanObjectDeletions(buf, [200000000001]), []);
});

test('buildStock agrège et écarte les lectures douteuses', () => {
  const entries = [
    { gid: 1519, uid: 200000000001, quantity: 10, confidence: 'high' },
    { gid: 1519, uid: 200000000009, quantity: 5, confidence: 'high' },
    { gid: 1545, uid: 12, quantity: 3, confidence: 'low' },
  ];
  const { stock, uids } = proto.buildStock(entries);
  assert.strictEqual(stock[1519], 15);
  assert.strictEqual(stock[1545], undefined, 'lecture low retenue');
  assert.deepStrictEqual(uids[1519], [200000000001, 200000000009]);
  const relaxed = proto.buildStock(entries, { acceptLow: true });
  assert.strictEqual(relaxed.stock[1545], 3);
});

test('scanObjectEntries marque « low » un uid trop petit pour être crédible', () => {
  const buf = Buffer.concat([header(1), varField(1, 1519), varField(2, 20)]);
  const found = proto.scanObjectEntries(buf, [1519]);
  assert.ok(found.length === 0 || found.every(e => e.confidence === 'low'));
});

// ─── Effets de l'item ──────────────────────────────────────────────────────

// Paquet « l'item posé a changé » : liste d'effets { actionId, valeur }.
function effectsPacket(effects, extra) {
  const entries = effects.map(e => lenField(4, Buffer.concat([
    varField(1, e.id), varField(2, e.value),
  ])));
  const tail = extra ? [extra] : [];
  return Buffer.concat([header(6100), lenField(1, Buffer.from('type.ankama.com/eff')), ...entries, ...tail]);
}

test('scanEffects lit les valeurs des effets attendus', () => {
  const buf = effectsPacket([
    { id: 125, value: 104 },
    { id: 118, value: 12 },
    { id: 999, value: 7 },       // effet non demandé
  ]);
  const got = proto.scanEffects(buf, [125, 118]);
  assert.deepStrictEqual(got, { 125: 104, 118: 12 });
});

test('scanEffects ignore un sous-message ambigu', () => {
  // 3 varints dans le même sous-message → impossible de désigner la valeur.
  const ambiguous = lenField(4, Buffer.concat([
    varField(1, 125), varField(2, 80), varField(3, 100),
  ]));
  const buf = Buffer.concat([header(6100), ambiguous]);
  assert.deepStrictEqual(proto.scanEffects(buf, [125]), {});
});

test('scanEffects écarte les valeurs invraisemblables', () => {
  const buf = effectsPacket([{ id: 125, value: 5000000 }]);
  assert.deepStrictEqual(proto.scanEffects(buf, [125]), {});
  assert.deepStrictEqual(proto.scanEffects(buf, [125], 1e7), { 125: 5000000 });
});

test('scanEffects sur paquet non structuré ou sans cible → {}', () => {
  assert.deepStrictEqual(proto.scanEffects(Buffer.from('ffffffff', 'hex'), [125]), {});
  assert.deepStrictEqual(proto.scanEffects(effectsPacket([{ id: 125, value: 3 }]), []), {});
  assert.deepStrictEqual(proto.scanEffects(null, [125]), {});
});

test('scanEffects garde la dernière occurrence d\'un même effet', () => {
  const buf = effectsPacket([{ id: 125, value: 81 }, { id: 125, value: 96 }]);
  assert.deepStrictEqual(proto.scanEffects(buf, [125]), { 125: 96 });
});

// ─── Profil intégré ────────────────────────────────────────────────────────
//
// Les octets de référence viennent d'une capture RÉELLE du client Dofus 3
// (août 2026). Si le profil intégré s'en écarte d'un seul octet, le serveur
// reçoit autre chose que ce qu'un vrai client enverrait.
//
// Le build de juillet utilisait une tout autre disposition (types kdr/kqm,
// enveloppe field3, uid en field2) : elle est conservée plus bas comme cas de
// non-régression de l'APPRENTISSAGE, qui doit rattraper ce genre de bascule
// sans qu'on touche au code.
const REAL_MOVE_UID = 505496099;
const REAL_MOVE_HEX =
  '30122e0a210a13747970652e616e6b616d612e636f6d2f6b636a120a08a38485f101180130011' +
  '0ffffffffffffffffff01';
const REAL_READY_HEX =
  '2812260a190a13747970652e616e6b616d612e636f6d2f6b716f1202100110ffffffffffffffffff01';

// Build de juillet 2026 — sert aux tests d'apprentissage.
const JULY_MOVE_UID = 182089732;
const JULY_MOVE_HEX =
  '2f1a2d08ffffffffffffffffff0112200a13747970652e616e6b616d612e636f6d2f6b64721209080110' +
  '84f0e9562001';
const JULY_READY_HEX =
  '281a2608ffffffffffffffffff0112190a13747970652e616e6b616d612e636f6d2f6b716d12020801';

// ─── Apprentissage passif ──────────────────────────────────────────────────
//
// Le scénario que ces tests verrouillent : Ankama change ses signatures, le
// gabarit intégré ne répond plus, mais le joueur pose une rune à la main et
// STAKK doit en déduire le nouveau format tout seul.

test('apprentissage : déduit le gabarit de pose d\'un paquet contenant un uid connu', () => {
  const buf = Buffer.from(REAL_MOVE_HEX, 'hex');
  const move = proto.learnMove(buf, new Set([REAL_MOVE_UID, 1, 2]));
  assert.ok(move, 'la pose doit être reconnue');
  assert.strictEqual(move.typeName, 'kcj');
  assert.strictEqual(move.uidLength, 5);
  assert.deepStrictEqual(move.observedUids, [REAL_MOVE_UID]);
  // Le gabarit appris doit reproduire le paquet du client pour un autre uid.
  const rebuilt = proto.buildMovePacket({ move }, REAL_MOVE_UID);
  assert.strictEqual(rebuilt.toString('hex'), REAL_MOVE_HEX);
});

test('apprentissage : marche aussi sur la disposition de juillet (autre enveloppe)', () => {
  const move = proto.learnMove(Buffer.from(JULY_MOVE_HEX, 'hex'), new Set([JULY_MOVE_UID]));
  assert.ok(move, 'une disposition inconnue doit rester apprenable');
  assert.strictEqual(move.typeName, 'kdr');
  assert.strictEqual(proto.buildMovePacket({ move }, JULY_MOVE_UID).toString('hex'), JULY_MOVE_HEX);
});

test('apprentissage : un uid inconnu ne déclenche rien', () => {
  assert.strictEqual(proto.learnMove(Buffer.from(REAL_MOVE_HEX, 'hex'), new Set([42])), null);
});

test('apprentissage : la commande de forge n\'est pas confondue avec une pose', () => {
  const uids = new Set([REAL_MOVE_UID]);
  const ready = Buffer.from(REAL_READY_HEX, 'hex');
  assert.strictEqual(proto.learnMove(ready, uids), null);
  const learned = proto.learnReady(ready, 'kcj', uids);
  assert.ok(learned);
  assert.strictEqual(learned.typeName, 'kqo');
  assert.strictEqual(learned.packet, REAL_READY_HEX);
});

test('apprentissage : la pose n\'est pas prise pour une forge', () => {
  const uids = new Set([REAL_MOVE_UID]);
  assert.strictEqual(proto.learnReady(Buffer.from(REAL_MOVE_HEX, 'hex'), 'kcj', uids), null);
});

test('apprentissage : sameProfile ne réécrit rien quand le format est inchangé', () => {
  const a = proto.defaultProfile();
  const b = proto.defaultProfile();
  assert.strictEqual(proto.sameProfile(a, b), true);
  assert.strictEqual(proto.sameProfile(a, proto.defaultProfile({ move: 'zzz' })), false);
});

test('profil intégré : reproduit exactement les octets du vrai client', () => {
  const p = proto.defaultProfile();
  assert.strictEqual(proto.buildMovePacket(p, REAL_MOVE_UID).toString('hex'), REAL_MOVE_HEX);
  assert.strictEqual(proto.buildReadyPacket(p).toString('hex'), REAL_READY_HEX);
});

test('profil intégré : utilisable sans aucune capture, et signale sa source', () => {
  const p = proto.defaultProfile();
  assert.strictEqual(p.source, 'builtin');
  assert.deepStrictEqual(p.codes, proto.DEFAULT_CODES);
  assert.ok(p.move.template && p.ready.packet);
});

test('profil intégré : suit un changement de signature Ankama', () => {
  const p = proto.defaultProfile({ move: 'abc', ready: 'xyz' });
  const move = proto.buildMovePacket(p, 12345);
  assert.ok(move.includes(Buffer.from('type.ankama.com/abc')));
  assert.ok(proto.buildReadyPacket(p).includes(Buffer.from('type.ankama.com/xyz')));
  assert.strictEqual(proto.splitFrames(move).complete, true);
  assert.ok(proto.parseStructured(move).filter(f => f.wire === 0).map(f => f.value).includes(12345));
});

test('profil intégré : encaisse les uid larges', () => {
  const p = proto.defaultProfile();
  for (const uid of [1, 268435455, 268435456, 143325921574, 34359738368]) {
    const pkt = proto.buildMovePacket(p, uid);
    assert.strictEqual(proto.splitFrames(pkt).complete, true, `trame cassée pour uid=${uid}`);
    const values = proto.parseStructured(pkt).filter(f => f.wire === 0).map(f => f.value);
    assert.ok(values.includes(uid), `uid ${uid} absent`);
    assert.ok(values.includes(1), `quantité perdue pour uid=${uid}`);
  }
});

// ─── Cadrage réel : suite de <varint longueur><message> ────────────────────

test('splitFrames découpe plusieurs messages dans un même chunk', () => {
  const m1 = Buffer.concat([varField(1, 42)]);
  const m2 = Buffer.concat([lenField(1, Buffer.from('abc')), varField(2, 7)]);
  const chunk = Buffer.concat([varint(m1.length), m1, varint(m2.length), m2]);
  const r = proto.splitFrames(chunk);
  assert.strictEqual(r.complete, true);
  assert.strictEqual(r.frames.length, 2);
  assert.strictEqual(r.frames[0].length, m1.length);
  assert.strictEqual(r.frames[1].length, m2.length);
});

test('splitFrames signale un chunk coupé par TCP', () => {
  const m = Buffer.concat([varField(1, 42)]);
  const chunk = Buffer.concat([varint(50), m]);        // annonce 50, en donne 2
  const r = proto.splitFrames(chunk);
  assert.strictEqual(r.complete, false);
  assert.strictEqual(r.frames.length, 0);
});

test('parseStructured lit un chunk multi-messages', () => {
  const m1 = Buffer.concat([varField(1, 111)]);
  const m2 = Buffer.concat([varField(1, 222)]);
  const chunk = Buffer.concat([varint(m1.length), m1, varint(m2.length), m2]);
  const values = proto.parseStructured(chunk).filter(f => f.wire === 0).map(f => f.value);
  assert.ok(values.includes(111) && values.includes(222), JSON.stringify(values));
});

// ─── Scope par item ────────────────────────────────────────────────────────

const objectMsg = (uid, gid, effs) => lenField(3, Buffer.concat([
  varField(1, uid), varField(2, gid),
  ...effs.map(e => lenField(5, Buffer.concat([varField(1, e.id), varField(2, e.value)]))),
]));

test('scanItemEffects ne retient que les effets de l\'item visé', () => {
  const buf = Buffer.concat([header(6100),
    lenField(1, Buffer.from('type.ankama.com/eff')),
    objectMsg(900000000001, 2425, [{ id: 125, value: 81 }, { id: 118, value: 12 }]),
    objectMsg(200000000001, 1548, [{ id: 125, value: 15 }]),   // Rune Pa Vi
  ]);
  assert.deepStrictEqual(proto.scanItemEffects(buf, 2425, [125, 118]), { 125: 81, 118: 12 });
  assert.deepStrictEqual(proto.scanItemEffects(buf, 1548, [125]), { 125: 15 });
  assert.deepStrictEqual(proto.scanItemEffects(buf, 999999, [125, 118]), {});
  // Sans scope, l'effet de la rune écrase celui de l'item.
  assert.strictEqual(proto.scanEffects(buf, [125])[125], 15);
});

test('scanItemEffects sans gid ou sans effets → {}', () => {
  const buf = Buffer.concat([header(6100), objectMsg(1, 2425, [{ id: 125, value: 81 }])]);
  assert.deepStrictEqual(proto.scanItemEffects(buf, 0, [125]), {});
  assert.deepStrictEqual(proto.scanItemEffects(buf, 2425, []), {});
  assert.deepStrictEqual(proto.scanItemEffects(null, 2425, [125]), {});
});

// ─── Numéros de champs ancrés sur les gid connus ───────────────────────────
//
// L'heuristique devine le rôle des champs d'après leur taille : « le plus grand
// varint est l'uid », « le plus petit est la quantité ». Deux erreurs vécues en
// production en découlent — un identifiant fantôme fabriqué à partir d'un champ
// voisin, et un déplacement d'objet lu comme une quantité nulle. L'ancrage sur
// les gid connus donne les VRAIS numéros de champs et supprime les deux.

// Sous-message d'objet du build courant : { 1 uid, 2 gid, 3 quantité }.
const objEntry = o => lenField(3, Buffer.concat([
  varField(1, o.uid), varField(2, o.gid), varField(3, o.qty),
  ...(o.extra ? [varField(4, o.extra)] : []),
]));
const objPacket = items => Buffer.concat([header(6000),
  lenField(1, Buffer.from('type.ankama.com/inv')), ...items.map(objEntry)]);

const FM_GIDS = [1519, 1545, 1551];

test('champs d\'inventaire : appris sur des objets concordants', () => {
  const l = proto.createFieldMapLearner();
  assert.strictEqual(l.map(), null, 'mapping avant toute observation');
  assert.strictEqual(l.observe(objPacket([
    { uid: 633330678, gid: 1519, qty: 4 },
    { uid: 633330799, gid: 1545, qty: 7 },
  ]), FM_GIDS), null, 'conclu dès le premier message');
  const news = l.observe(objPacket([{ uid: 634000000, gid: 1551, qty: 2 }]), FM_GIDS);
  assert.ok(news && news.learned, 'mapping non appris malgré trois objets sur deux messages');
  assert.deepStrictEqual(l.map(), { gid: 2, uid: 1, qty: 3 });
  const state = l.state();
  assert.deepStrictEqual(state.map, { gid: 2, uid: 1, qty: 3 });
  assert.ok(state.sample, 'aucun message de référence conservé pour le diagnostic');
});

test('champs d\'inventaire : jamais appris sur une observation unique', () => {
  // Un seul message, même chargé : ça reste UNE observation du fil.
  const one = proto.createFieldMapLearner();
  assert.strictEqual(one.observe(objPacket([
    { uid: 633330678, gid: 1519, qty: 4 },
    { uid: 633330799, gid: 1545, qty: 7 },
    { uid: 634000000, gid: 1551, qty: 2 },
    { uid: 634100000, gid: 1519, qty: 1 },
  ]), FM_GIDS), null);
  assert.strictEqual(one.map(), null, 'mapping tiré d\'un seul message');

  // Deux messages mais deux objets : sous le seuil d'objets distincts.
  const two = proto.createFieldMapLearner();
  two.observe(objPacket([{ uid: 633330678, gid: 1519, qty: 4 }]), FM_GIDS);
  assert.strictEqual(two.observe(objPacket([{ uid: 633330799, gid: 1545, qty: 7 }]), FM_GIDS), null);
  assert.strictEqual(two.map(), null, 'mapping tiré de deux objets');
});

test('champs d\'inventaire : un gid coïncident isolé ne déclenche rien', () => {
  // Un message quelconque où un gid connu tombe par hasard à côté d'un grand
  // nombre. Répété tant qu'on veut, il ne décrit toujours qu'UN objet.
  const fluke = Buffer.concat([header(7000),
    lenField(2, Buffer.concat([varField(5, 1519), varField(6, 700000000)]))]);
  const l = proto.createFieldMapLearner();
  for (let i = 0; i < 5; i++) l.observe(fluke, FM_GIDS);
  assert.strictEqual(l.map(), null, 'mapping fondé sur une coïncidence');

  // Et il ne détourne pas l'apprentissage : les vrais objets l'emportent.
  const m = proto.createFieldMapLearner();
  m.observe(fluke, FM_GIDS);
  m.observe(objPacket([
    { uid: 633330678, gid: 1519, qty: 4 },
    { uid: 633330799, gid: 1545, qty: 7 },
  ]), FM_GIDS);
  m.observe(fluke, FM_GIDS);
  m.observe(objPacket([{ uid: 634000000, gid: 1551, qty: 2 }]), FM_GIDS);
  assert.deepStrictEqual(m.map(), { gid: 2, uid: 1, qty: 3 });
});

test('champs d\'inventaire : un numéro de champ répété ne verrouille pas un mapping impossible', () => {
  // Sous-message où le gid et l'identifiant portent le MÊME numéro de champ.
  // L'élection y arrive — les deux rôles sont désignés sans ambiguïté dans
  // chaque objet — mais le mapping obtenu est inexploitable : le lire ancrerait
  // gid et identifiant sur le même champ.
  const dup = items => Buffer.concat([header(6000),
    lenField(1, Buffer.from('type.ankama.com/inv')),
    ...items.map(o => lenField(3, Buffer.concat([
      varField(2, o.uid), varField(2, o.gid), varField(3, o.qty)])))]);

  const l = proto.createFieldMapLearner();
  assert.strictEqual(l.observe(dup([
    { uid: 633330678, gid: 1519, qty: 4 },
    { uid: 633330799, gid: 1545, qty: 7 },
  ]), FM_GIDS), null, 'conclu dès le premier message');
  // Le quorum est atteint ici. Rien ne doit être annoncé ni retenu : sans ça
  // observe() rend `{ learned: null }` — ni « appris » ni « abandonné », donc
  // rien au journal — pendant que map() et state() livrent le mapping bancal
  // aux lecteurs d'inventaire et le rangent sur disque.
  const r = l.observe(dup([{ uid: 634000000, gid: 1551, qty: 2 }]), FM_GIDS);
  assert.strictEqual(r, null, 'un mapping impossible a été annoncé');
  assert.strictEqual(l.map(), null, 'un mapping impossible a été verrouillé');
  assert.strictEqual(l.state().map, null, 'un mapping impossible serait persisté');
  // Et la disposition SAINE qui arrive ensuite doit encore pouvoir être élue :
  // une disposition refusée cesse d'être candidate, elle ne reste pas au
  // scrutin à bloquer toutes les autres jusqu'à la fin de la session.
  l.observe(objPacket([
    { uid: 700000000, gid: 1519, qty: 4 },
    { uid: 700000001, gid: 1545, qty: 7 },
  ]), FM_GIDS);
  const sain = l.observe(objPacket([{ uid: 700000002, gid: 1551, qty: 2 }]), FM_GIDS);
  assert.ok(sain && sain.learned, 'la disposition saine n\'a jamais été élue');
  assert.deepStrictEqual(l.map(), { gid: 2, uid: 1, qty: 3 });
});

test('champs d\'inventaire : un mapping qui ne concorde plus est lâché', () => {
  // Nouveau build : gid et identifiant ont changé de numéro.
  const patched = items => Buffer.concat([header(6000),
    lenField(1, Buffer.from('type.ankama.com/inv')),
    ...items.map(o => lenField(3, Buffer.concat([
      varField(4, o.uid), varField(7, o.gid), varField(8, o.qty)])))]);
  const stale = patched([{ uid: 633330678, gid: 1519, qty: 4 }]);

  const l = proto.createFieldMapLearner({ map: { gid: 2, uid: 1, qty: 3 } });
  assert.strictEqual(l.observe(stale, FM_GIDS), null, 'lâché dès la première contradiction');
  assert.strictEqual(l.observe(stale, FM_GIDS), null);
  const news = l.observe(stale, FM_GIDS);
  assert.ok(news && news.lost, 'mapping périmé conservé');
  assert.strictEqual(l.map(), null);

  // Une concordance efface l'ardoise : deux messages de numérotations
  // différentes qui alternent ne doivent pas faire lâcher un mapping valide.
  const k = proto.createFieldMapLearner({ map: { gid: 2, uid: 1, qty: 3 } });
  for (let i = 0; i < 4; i++) {
    k.observe(stale, FM_GIDS);
    assert.strictEqual(k.observe(objPacket([{ uid: 633330678, gid: 1519, qty: 4 }]), FM_GIDS), null);
  }
  assert.ok(k.map(), 'mapping valide lâché à cause d\'un message étranger');
});

test('champs d\'inventaire : un paquet discordant sous le seuil n\'écrase pas l\'échantillon', () => {
  // Même paquet « nouveau build » que le test précédent : gid et identifiant
  // ont changé de numéro, donc discordant avec le mapping retenu.
  const patched = items => Buffer.concat([header(6000),
    lenField(1, Buffer.from('type.ankama.com/inv')),
    ...items.map(o => lenField(3, Buffer.concat([
      varField(4, o.uid), varField(7, o.gid), varField(8, o.qty)])))]);
  const stale = patched([{ uid: 633330678, gid: 1519, qty: 4 }]);
  const goodSample = objPacket([{ uid: 633330678, gid: 1519, qty: 4 }]).toString('hex');

  const l = proto.createFieldMapLearner({ map: { gid: 2, uid: 1, qty: 3 }, sample: goodSample });
  // 1re et 2e discordance : sous le seuil d'abandon (3), le mapping reste actif.
  // L'échantillon ne doit PAS être remplacé par un paquet qui ne concorde plus.
  l.observe(stale, FM_GIDS);
  assert.strictEqual(l.state().sample, goodSample,
    'un paquet discordant a écrasé l\'échantillon de référence');
  l.observe(stale, FM_GIDS);
  assert.strictEqual(l.state().sample, goodSample,
    'un paquet discordant a écrasé l\'échantillon de référence');
});

test('scanObjectEntries ancré : le champ voisin n\'est plus pris pour l\'identifiant', () => {
  // Relevé en production : les 72 uid du joueur tenaient entre 633 330 678 et
  // 635 117 570, et un intrus 225 fois au-dessus s'était glissé dans le miroir.
  const BOGUS = 143325921574, REAL = 633330678;
  const buf = objPacket([{ uid: REAL, gid: 1519, qty: 4, extra: BOGUS }]);

  const heuristic = proto.scanObjectEntries(buf, [1519]);
  assert.strictEqual(heuristic[0].uid, BOGUS, 'le cas de régression ne se reproduit plus');

  const anchored = proto.scanObjectEntries(buf, [1519], { fieldMap: { gid: 2, uid: 1, qty: 3 } });
  assert.deepStrictEqual(anchored.map(e => ({ gid: e.gid, uid: e.uid, quantity: e.quantity })),
    [{ gid: 1519, uid: REAL, quantity: 4 }]);
  assert.strictEqual(anchored[0].confidence, 'high');
});

test('scanQuantityUpdates ancré : un déplacement n\'est plus lu comme une quantité nulle', () => {
  const uid = 633330678;
  const map = { gid: 2, uid: 1, qty: 3 };
  // Déplacement d'objet : { identifiant, position }. Même forme exactement
  // qu'une mise à jour de quantité — c'est ce qui vidait les piles en pleine
  // forge, une position 0 valant « quantité 0 ».
  const moved = Buffer.concat([header(6400),
    lenField(1, Buffer.from('type.ankama.com/mov')),
    lenField(3, Buffer.concat([varField(1, uid), varField(2, 0)]))]);
  assert.deepStrictEqual(proto.scanQuantityUpdates(moved, [uid]), [{ uid, quantity: 0 }],
    'le cas de régression ne se reproduit plus');
  assert.deepStrictEqual(proto.scanQuantityUpdates(moved, [uid], { fieldMap: map }), []);

  // La vraie mise à jour, elle, porte sa quantité au champ appris.
  const updated = Buffer.concat([header(6200),
    lenField(1, Buffer.from('type.ankama.com/qty')),
    lenField(3, Buffer.concat([varField(1, uid), varField(3, 5)]))]);
  assert.deepStrictEqual(proto.scanQuantityUpdates(updated, [uid], { fieldMap: map }),
    [{ uid, quantity: 5 }]);
});

test('scanObjectDeletions ancré : un champ isolé ailleurs n\'est pas une suppression', () => {
  const uid = 633330678;
  const at = f => Buffer.concat([header(6300),
    lenField(1, Buffer.from('type.ankama.com/del')), lenField(3, varField(f, uid))]);
  const map = { gid: 2, uid: 1, qty: 3 };
  assert.deepStrictEqual(proto.scanObjectDeletions(at(1), [uid], { fieldMap: map }), [uid]);
  assert.deepStrictEqual(proto.scanObjectDeletions(at(6), [uid], { fieldMap: map }), []);
  assert.deepStrictEqual(proto.scanObjectDeletions(at(6), [uid]), [uid], 'repli heuristique modifié');
});

test('champs d\'inventaire : sans mapping, l\'heuristique est intacte', () => {
  const buf = objPacket([{ uid: 200000000001, gid: 1519, qty: 4 }]);
  const ref = proto.scanObjectEntries(buf, [1519]);
  assert.deepStrictEqual(proto.scanObjectEntries(buf, [1519], {}), ref);
  assert.deepStrictEqual(proto.scanObjectEntries(buf, [1519], { fieldMap: null }), ref);
  // Un mapping mal formé n'est pas un mapping : on ne s'appuie pas dessus.
  assert.deepStrictEqual(proto.scanObjectEntries(buf, [1519], { fieldMap: { gid: 2 } }), ref);
  assert.deepStrictEqual(proto.scanObjectEntries(buf, [1519], { fieldMap: { gid: 2, uid: 2 } }), ref);
  assert.strictEqual(ref[0].uid, 200000000001);

  const upd = Buffer.concat([header(6200),
    lenField(3, Buffer.concat([varField(1, 200000000001), varField(2, 12)]))]);
  assert.deepStrictEqual(proto.scanQuantityUpdates(upd, [200000000001], { fieldMap: null }),
    [{ uid: 200000000001, quantity: 12 }]);
  // Mapping sans champ quantité identifié : la lecture reste heuristique.
  assert.deepStrictEqual(proto.scanQuantityUpdates(upd, [200000000001], { fieldMap: { gid: 2, uid: 1 } }),
    [{ uid: 200000000001, quantity: 12 }]);
});

// ─── Socle partagé ─────────────────────────────────────────────────────────

test('fm-protocol lève quand le socle protocol-learn lui manque', () => {
  const createFmProtocol = require('../lib/fm-protocol');
  // `null` explicite = l'exe sait qu'il ne l'a pas. Le require de repli est
  // alors coupé, comme il l'est de fait sur le chemin hot où ce fichier vit
  // seul dans ~/.stakk/hot-modules. Sans socle il n'y a ni varints, ni parcours
  // protobuf, ni élection : on lève plutôt que de rendre une API creuse dont
  // chaque appel casserait plus loin, au milieu d'un run.
  assert.throws(() => createFmProtocol({ createProtocolLearn: null }),
    /protocol-learn/, 'le socle absent est passé sans bruit');
  // Et le socle fourni par la deps bag suffit : c'est le seul chemin disponible
  // en hot.
  const ok = createFmProtocol({ createProtocolLearn: require('../lib/protocol-learn') });
  assert.strictEqual(typeof ok.buildMovePacket, 'function');
});

console.log(`\n${passed} tests OK${process.exitCode ? ' — DES TESTS ONT ÉCHOUÉ' : ''}`);
