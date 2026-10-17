'use strict';

/**
 * Tests du transport live. Le canal de jeu est un bouchon : on vérifie les
 * octets réellement envoyés et le comportement face aux réponses (ou à leur
 * absence). Aucun Dofus.
 *   node test/fm-live.test.js
 */

const assert = require('assert');
const proto = require('../lib/fm-protocol')();
const createFmLive = require('../lib/fm-live');

// ─── Fabrique de paquets ───────────────────────────────────────────────────

function vi(v) { const o = []; let n = v; do { const b = n % 128; n = Math.floor(n / 128); o.push(b | (n > 0 ? 0x80 : 0)); } while (n > 0); return Buffer.from(o); }
const lenF = (f, p) => Buffer.concat([Buffer.from([(f << 3) | 2]), vi(p.length), p]);
const varF = (f, v) => Buffer.concat([Buffer.from([(f << 3) | 0]), vi(v)]);
const hdr = id => { const b = Buffer.alloc(2); b.writeUInt16BE((id << 2) & 0xffff, 0); return b; };
const movePkt = uid => Buffer.concat([hdr(4210),
  lenF(1, Buffer.from('type.ankama.com/xyz')),
  lenF(2, Buffer.concat([varF(1, uid), varF(2, 1)]))]);
const readyPkt = Buffer.concat([hdr(4211), lenF(1, Buffer.from('type.ankama.com/rdy'))]);
// Second jeu de signatures : ce qu'Ankama sert après avoir rebattu les cartes.
// Le type_url est plus long, donc l'uid ne tombe pas au même offset — un
// paquet construit avec le mauvais profil est reconnaissable à coup sûr.
const movePktB = uid => Buffer.concat([hdr(4310),
  lenF(1, Buffer.from('type.ankama.com/abcdef')),
  lenF(2, Buffer.concat([varF(1, uid), varF(2, 1)]))]);
const readyPktB = Buffer.concat([hdr(4311), lenF(1, Buffer.from('type.ankama.com/rd2'))]);
const inventoryPkt = items => Buffer.concat([hdr(6000),
  lenF(1, Buffer.from('type.ankama.com/inv')),
  ...items.map(it => lenF(3, Buffer.concat([varF(1, it.uid), varF(2, it.gid), varF(3, it.qty)])))]);
// Forme réelle : les effets vivent DANS le sous-message de l'objet, à côté de
// son gid (vérifié sur capture Dofus 3). Les runes présentes dans le même
// paquet portent aussi leurs propres effets — d'où le scope par gid.
const ITEM_GID = 2425;
const objectMsg = (uid, gid, effs) => lenF(3, Buffer.concat([
  varF(1, uid), varF(2, gid),
  ...effs.map(e => lenF(5, Buffer.concat([varF(1, e.id), varF(2, e.value)]))),
]));
const effectsPkt = (effs, extraObjects) => Buffer.concat([hdr(6100),
  lenF(1, Buffer.from('type.ankama.com/eff')),
  objectMsg(900000000001, ITEM_GID, effs),
  ...(extraObjects || [])]);

function buildTestProfile(move, ready, moveId, readyId) {
  const capture = [
    `10:00:00.000 OUT msgId=${moveId} len=${move(100000000000).length} hex=${move(100000000000).toString('hex')}`,
    `10:00:00.100 OUT msgId=${readyId} len=${ready.length} hex=${ready.toString('hex')}`,
    `10:00:01.000 OUT msgId=${moveId} len=${move(100000000001).length} hex=${move(100000000001).toString('hex')}`,
    `10:00:01.100 OUT msgId=${readyId} len=${ready.length} hex=${ready.toString('hex')}`,
  ].join('\n');
  const r = proto.buildProfile(capture);
  assert.ok(r.ok, 'profil de test invalide: ' + r.detail);
  return r.profile;
}
const PROFILE = buildTestProfile(movePkt, readyPkt, 4210, 4211);
const PROFILE_B = buildTestProfile(movePktB, readyPktB, 4310, 4311);

const RUNE_GIDS = [1519, 1545, 1551];
const EFFECT_IDS = [125, 118];

function makeLive(over) {
  const sent = [];
  const channel = { sendToServer: b => { sent.push(Buffer.from(b)); return true; } };
  const live = createFmLive({ protocol: proto }).create(Object.assign({
    profile: PROFILE, channel,
    runeGids: RUNE_GIDS, effectIds: EFFECT_IDS, itemGid: ITEM_GID,
    readyDelayMs: 0, throwTimeoutMs: 200,
  }, over || {}));
  return { live, sent, channel };
}

let passed = 0, pending = 0;
const failures = [];
function test(name, fn) {
  pending++;
  return Promise.resolve().then(fn)
    .then(() => { passed++; console.log(`  ok  ${name}`); })
    .catch(e => { failures.push(name); console.error(`  FAIL ${name}\n       ${e.message}`); });
}

(async () => {
  console.log('fm-live');

  await test('refuse une construction sans profil, canal ou effets', () => {
    const f = createFmLive({ protocol: proto });
    assert.throws(() => f.create({ channel: { sendToServer() {} }, effectIds: [1] }), /profil/);
    assert.throws(() => f.create({ profile: PROFILE, effectIds: [1] }), /canal/);
    assert.throws(() => f.create({ profile: PROFILE, channel: { sendToServer() {} }, effectIds: [] }), /effet/);
    assert.throws(() => createFmLive({}), /protocol requis/);
  });

  await test('pas prêt tant qu\'aucun effet n\'a été observé', async () => {
    const { live, sent } = makeLive();
    assert.strictEqual(live.ready(), false);
    assert.match(live.diagnostic(), /pose l'item/);
    await assert.rejects(() => live.readStats(), /pose l'item/);
    await assert.rejects(() => live.throwRune(1545), /pose l'item/);
    assert.strictEqual(sent.length, 0, 'des paquets ont été envoyés sans observation');
  });

  await test('observe() alimente stock et stats', async () => {
    const { live } = makeLive();
    live.observe(inventoryPkt([
      { uid: 200000000001, gid: 1545, qty: 12 },
      { uid: 200000000002, gid: 1551, qty: 3 },
    ]));
    live.observe(effectsPkt([{ id: 125, value: 81 }, { id: 118, value: 7 }]));
    assert.strictEqual(live.ready(), true);
    assert.deepStrictEqual(await live.readStock(), { 1545: 12, 1551: 3 });
    assert.deepStrictEqual(await live.readStats(), { 125: 81, 118: 7 });
  });

  await test('observe() fusionne l\'inventaire au lieu de l\'écraser', async () => {
    const { live } = makeLive();
    live.observe(inventoryPkt([{ uid: 200000000001, gid: 1545, qty: 12 }]));
    live.observe(inventoryPkt([{ uid: 200000000002, gid: 1551, qty: 4 }]));
    assert.deepStrictEqual(await live.readStock(), { 1545: 12, 1551: 4 });
  });

  // Le message décrit l'item en entier : une ligne détruite en disparaît. La
  // fusionner avec l'état précédent la laissait « vivante », STAKK croyait la
  // phase de base finie et enchaînait sur l'exo.
  await test('une ligne détruite retombe à zéro, elle ne reste pas figée', async () => {
    const { live } = makeLive();
    live.observe(effectsPkt([{ id: 125, value: 81 }, { id: 118, value: 9 }]));
    assert.deepStrictEqual(await live.readStats(), { 125: 81, 118: 9 });

    // La Force saute : elle n'est plus dans le message.
    live.observe(effectsPkt([{ id: 125, value: 81 }]));
    assert.deepStrictEqual(await live.readStats(), { 125: 81, 118: 0 },
      'la ligne détruite a gardé son ancienne valeur');
  });

  // Régression issue d'une capture Dofus 3 réelle : le paquet d'échange
  // décrit l'item ET les runes, chaque rune portant son propre effet. Lu sans
  // scope, « Vitalité 15 » d'une Rune Pa Vi passait pour la stat de l'item.
  await test('observe() ne confond pas l\'effet d\'une rune avec la stat de l\'item', async () => {
    const { live } = makeLive();
    const runeObj = objectMsg(200000000001, 1548, [{ id: 125, value: 15 }]); // Rune Pa Vi
    live.observe(effectsPkt([{ id: 125, value: 81 }], [runeObj]));
    // 118 vaut 0 : absent du message, donc ligne inexistante sur l'item.
    assert.deepStrictEqual(await live.readStats(), { 125: 81, 118: 0 },
      'la valeur de la rune a été prise pour celle de l\'item');
  });

  await test('observe() ignore un paquet qui ne parle pas de l\'item', async () => {
    const { live } = makeLive();
    const onlyRune = Buffer.concat([hdr(6100), lenF(1, Buffer.from('type.ankama.com/eff')),
      objectMsg(200000000001, 1548, [{ id: 125, value: 15 }])]);
    live.observe(onlyRune);
    assert.strictEqual(live.ready(), false, 'un paquet sans l\'item a suffi à se déclarer prêt');
  });

  // Le miroir doit suivre les mises à jour de quantité { uid, nouvelle
  // quantité } — le message que le serveur envoie quand une pile change et
  // qui ne porte PAS de gid. Sans lui, une pile consommée resterait
  // éternellement « disponible » et on jouerait un identifiant mort.
  const qtyUpdatePkt = (uid, qty) => Buffer.concat([hdr(6200),
    lenF(1, Buffer.from('type.ankama.com/qty')),
    lenF(3, Buffer.concat([varF(1, uid), varF(2, qty)]))]);

  await test('miroir : une mise à jour de quantité fait baisser le stock', async () => {
    const { live } = makeLive();
    live.observe(inventoryPkt([{ uid: 200000000001, gid: 1545, qty: 40 }]));
    assert.strictEqual((await live.readStock())[1545], 40);
    live.observe(qtyUpdatePkt(200000000001, 12));
    assert.strictEqual((await live.readStock())[1545], 12, 'quantité non suivie');
  });

  await test('miroir : une pile tombée à zéro sort de l\'inventaire', async () => {
    const { live } = makeLive();
    live.observe(inventoryPkt([{ uid: 200000000001, gid: 1545, qty: 3 }]));
    live.observe(effectsPkt([{ id: 125, value: 81 }]));
    live.observe(qtyUpdatePkt(200000000001, 0));
    assert.ok(!((await live.readStock())[1545] > 0), 'pile vide encore annoncée');
    await assert.rejects(() => live.throwRune(1545, { effectId: 125, amount: 15 }),
      /aucun identifiant fiable/);
  });

  await test('miroir : le stock d\'un gid est la somme de ses piles', async () => {
    const { live } = makeLive();
    live.observe(inventoryPkt([
      { uid: 200000000001, gid: 1545, qty: 10 },
      { uid: 200000000002, gid: 1545, qty: 5 },
    ]));
    assert.strictEqual((await live.readStock())[1545], 15);
    live.observe(qtyUpdatePkt(200000000002, 0));
    assert.strictEqual((await live.readStock())[1545], 10, 'pile retirée mal décomptée');
  });

  await test('miroir : une quantité inconnue au miroir est ignorée', async () => {
    const { live } = makeLive();
    live.observe(qtyUpdatePkt(999999999, 50));
    assert.deepStrictEqual(await live.readStock(), {}, 'objet inventé à partir d\'une mise à jour');
  });

  // Une pile ENTIÈREMENT consommée n'est pas annoncée à zéro : le serveur
  // envoie un message de suppression qui ne porte que l'identifiant. Sans lui,
  // la pile morte restait au miroir et STAKK finissait par jouer un
  // identifiant que le serveur ignore en silence.
  const deletePkt = uid => Buffer.concat([hdr(6300),
    lenF(1, Buffer.from('type.ankama.com/del')),
    lenF(3, varF(1, uid))]);

  await test('miroir : une pile supprimée par le serveur sort de l\'inventaire', async () => {
    const { live } = makeLive();
    live.observe(inventoryPkt([
      { uid: 200000000001, gid: 1545, qty: 3 },
      { uid: 200000000009, gid: 1545, qty: 5 },
    ]));
    assert.strictEqual((await live.readStock())[1545], 8);
    live.observe(deletePkt(200000000001));
    assert.strictEqual((await live.readStock())[1545], 5, 'pile supprimée encore annoncée');
  });

  // Même garde-fou que sur les refus serveur : une suppression lue à tort qui
  // emporterait la SEULE pile connue d'une rune bloquerait tout le run.
  await test('miroir : une suppression ne retire pas la dernière pile connue', async () => {
    const { live } = makeLive();
    live.observe(inventoryPkt([
      { uid: 200000000001, gid: 1545, qty: 3 },
      { uid: 200000000009, gid: 1545, qty: 5 },
    ]));
    live.observe(deletePkt(200000000001));
    assert.strictEqual((await live.readStock())[1545], 5, 'pile supprimée encore annoncée');
    // Il ne reste qu'une pile : on la garde. Si elle est vraiment morte, les
    // refus serveur successifs l'écarteront.
    live.observe(deletePkt(200000000009));
    assert.strictEqual((await live.readStock())[1545], 5, 'dernière pile retirée');
  });

  // La pose de rune part VERS le serveur et porte l'identifiant joué. C'est le
  // câblage qui protège : observe() n'est branché que sur le flux
  // serveur→client. Sinon STAKK effacerait la pile qu'il vient de jouer.
  await test('suppression : rien de ce qui sort ne touche le miroir', async () => {
    const { live, sent } = makeLive();
    live.observe(inventoryPkt([
      { uid: 200000000001, gid: 1545, qty: 3 },
      { uid: 200000000009, gid: 1545, qty: 5 },
    ]));
    live.observe(effectsPkt([{ id: 125, value: 81 }]));

    const p = live.throwRune(1545, { effectId: 125, amount: 15 });
    setTimeout(() => live.observe(effectsPkt([{ id: 125, value: 96 }])), 20);
    await p;

    assert.strictEqual(sent.length, 2);
    // Ni par la forme (la pose porte aussi la quantité)…
    assert.deepStrictEqual(proto.scanObjectDeletions(sent[0], [200000000009]), []);
    // …ni par le miroir : les deux piles sont toujours là.
    assert.deepStrictEqual(live._state().uids[1545].slice().sort((a, b) => a - b),
      [200000000001, 200000000009]);

    // Le même identifiant, cette fois annoncé supprimé par le SERVEUR, sort
    // bien du miroir : c'est la direction qui fait toute la différence.
    live.observe(deletePkt(200000000009));
    assert.deepStrictEqual(live._state().uids[1545], [200000000001]);
  });

  // ─── Identifiants invraisemblables ───────────────────────────────────────
  //
  // Relevé sur le miroir réel d'un joueur : 72 piles entre 633 330 678 et
  // 635 117 570, plus un intrus 225 fois au-dessus. Ce n'est pas un objet mais
  // un champ voisin pris pour un uid. Le serveur le refusait systématiquement,
  // la rune concernée échouait à tous les coups, et le run s'arrêtait sur un
  // diagnostic trompeur (« le format d'échange a changé »).
  const REAL_UID_MIN = 633330678, REAL_UID_MAX = 635117570;
  const BOGUS_UID = 143325921574;
  const realUids = (n) => {
    const step = Math.floor((REAL_UID_MAX - REAL_UID_MIN) / (n - 1));
    return Array.from({ length: n }, (_, i) => (i === n - 1 ? REAL_UID_MAX : REAL_UID_MIN + i * step));
  };

  await test('miroir : un identifiant hors de proportion n\'entre pas', async () => {
    const { live } = makeLive();
    live.observe(inventoryPkt([
      ...realUids(3).map(uid => ({ uid, gid: 1545, qty: 4 })),
      { uid: BOGUS_UID, gid: 1551, qty: 3 },
    ]));
    assert.strictEqual((await live.readStock())[1545], 12);
    assert.strictEqual((await live.readStock())[1551], undefined,
      'identifiant invraisemblable enregistré au miroir');
  });

  await test('miroir : les 72 identifiants de la plage réelle sont tous acceptés', async () => {
    const { live } = makeLive();
    const items = realUids(72).map(uid => ({ uid, gid: 1545, qty: 1 }));
    live.observe(inventoryPkt([...items, { uid: BOGUS_UID, gid: 1551, qty: 3 }]));
    assert.strictEqual((await live.readStock())[1545], 72,
      'un identifiant légitime de la plage réelle a été rejeté');
    assert.strictEqual((await live.readStock())[1551], undefined, 'intrus enregistré');
  });

  // Le miroir réel est rechargé du disque avec l'intrus dedans : c'est le
  // chemin par lequel il revenait à chaque démarrage.
  await test('miroir : un identifiant hors de proportion rechargé du disque est écarté', async () => {
    const { live } = makeLive();
    const seed = realUids(10).map(uid => ({ uid, gid: 1545, qty: 2 }));
    // En tête de lot, donc évalué quand le miroir est encore vide : c'est le
    // lot lui-même qui doit servir de référence.
    live.seedObjects([{ uid: BOGUS_UID, gid: 1551, qty: 3 }, ...seed]);
    assert.strictEqual((await live.readStock())[1545], 20);
    assert.strictEqual((await live.readStock())[1551], undefined, 'intrus rechargé du disque');
  });

  await test('miroir : le premier objet observé n\'est pas bloqué faute de référence', async () => {
    const { live } = makeLive();
    // Miroir vide : aucune médiane, on ne peut rien juger — l'objet entre.
    live.observe(inventoryPkt([{ uid: REAL_UID_MIN, gid: 1545, qty: 4 }]));
    assert.strictEqual((await live.readStock())[1545], 4, 'premier objet rejeté sans référence');
    live.observe(inventoryPkt([{ uid: REAL_UID_MIN + 1, gid: 1545, qty: 4 }]));
    live.observe(inventoryPkt([{ uid: REAL_UID_MAX, gid: 1545, qty: 4 }]));
    assert.strictEqual((await live.readStock())[1545], 12);
    // La plage est maintenant connue : l'intrus, lui, est écarté.
    live.observe(inventoryPkt([{ uid: BOGUS_UID, gid: 1551, qty: 3 }]));
    assert.strictEqual((await live.readStock())[1551], undefined, 'intrus accepté malgré la référence');
  });

  // ─── Champs d'inventaire ancrés sur les gid connus ───────────────────────
  //
  // Le transport ne devine plus le rôle des champs d'après leur taille : dès
  // que trois objets vus dans deux messages s'accordent, il connaît les
  // NUMÉROS du gid, de l'identifiant et de la quantité, et lit à ces
  // numéros-là. Tant que rien n'est appris, l'heuristique reste en place.

  await test('champs d\'inventaire : appris en observant, signalés à l\'appelant', async () => {
    let learned = null;
    const { live } = makeLive({ onFieldMapLearned: s => { learned = s; } });
    live.observe(inventoryPkt([
      { uid: 633330678, gid: 1545, qty: 4 },
      { uid: 633400000, gid: 1551, qty: 7 },
    ]));
    assert.strictEqual(live.fieldMap(), null, 'conclu dès le premier message');
    live.observe(inventoryPkt([{ uid: 634000000, gid: 1519, qty: 2 }]));
    assert.deepStrictEqual(live.fieldMap(), { gid: 2, uid: 1, qty: 3 });
    assert.ok(learned && learned.map, 'apprentissage non remonté pour la sauvegarde');
  });

  await test('miroir : l\'identifiant aberrant ne remplace plus le vrai une fois les champs appris', async () => {
    const { live } = makeLive({ fieldMap: { gid: 2, uid: 1, qty: 3 } });
    // Sous-message d'objet portant, à côté du vrai identifiant, un champ voisin
    // 225 fois plus grand — celui que l'heuristique prenait pour l'uid, et que
    // le serveur refusait ensuite à chaque jet.
    live.observe(Buffer.concat([hdr(6000), lenF(1, Buffer.from('type.ankama.com/inv')),
      lenF(3, Buffer.concat([
        varF(1, REAL_UID_MIN), varF(2, 1545), varF(3, 4), varF(4, BOGUS_UID)]))]));
    assert.deepStrictEqual(live._state().uids[1545], [REAL_UID_MIN],
      'identifiant aberrant entré au miroir');
    assert.strictEqual((await live.readStock())[1545], 4);
  });

  await test('miroir : une fois les champs appris, un déplacement ne vide plus la pile', async () => {
    const { live } = makeLive({ fieldMap: { gid: 2, uid: 1, qty: 3 } });
    live.observe(inventoryPkt([{ uid: 200000000001, gid: 1545, qty: 12 }]));
    assert.strictEqual((await live.readStock())[1545], 12);

    // Déplacement d'objet : { identifiant, position 0 }, indiscernable d'une
    // mise à jour de quantité sur la seule forme.
    live.observe(Buffer.concat([hdr(6400), lenF(1, Buffer.from('type.ankama.com/mov')),
      lenF(3, Buffer.concat([varF(1, 200000000001), varF(2, 0)]))]));
    assert.strictEqual((await live.readStock())[1545], 12,
      'pile vidée par un simple déplacement d\'objet');

    // La vraie mise à jour, au champ appris, passe toujours.
    live.observe(Buffer.concat([hdr(6200), lenF(1, Buffer.from('type.ankama.com/qty')),
      lenF(3, Buffer.concat([varF(1, 200000000001), varF(3, 2)]))]));
    assert.strictEqual((await live.readStock())[1545], 2, 'mise à jour de quantité perdue');
  });

  // Le reliquat est affiché par le jeu mais rien ne dit quel champ le porte.
  // On l'apprend par sa valeur, une fois, puis on le suit tout seul.
  const withReliquat = (statValue, reliquatValue) => Buffer.concat([hdr(6100),
    lenF(1, Buffer.from('type.ankama.com/eff')),
    objectMsg(900000000001, ITEM_GID, [{ id: 125, value: statValue }]),
    lenF(7, Buffer.concat([varF(3, reliquatValue)]))]);

  await test('reliquat : appris par sa valeur, puis suivi', async () => {
    const { live } = makeLive();
    live.observe(withReliquat(81, 47));
    assert.strictEqual(live.reliquat(), null, 'reliquat connu sans apprentissage');

    const r = live.learnReliquat(47);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.ok(r.path, 'chemin non retenu');
    assert.strictEqual(live.reliquat(), 47);

    // Une nouvelle observation doit mettre la valeur à jour toute seule.
    live.observe(withReliquat(96, 120));
    assert.strictEqual(live.reliquat(), 120, 'reliquat non suivi après apprentissage');
  });

  await test('reliquat : refuse d\'apprendre sur une valeur ambiguë ou absente', async () => {
    const { live } = makeLive();
    live.observe(withReliquat(81, 47));
    const absent = live.learnReliquat(9999);
    assert.strictEqual(absent.ok, false);
    assert.strictEqual(absent.reason, 'not-found');
    // 81 est à la fois la stat et rien d'autre ici : on vérifie surtout qu'une
    // valeur présente à plusieurs endroits est rejetée.
    const dup = live.learnReliquat(1);   // 1 apparaît dans plusieurs champs
    if (!dup.ok) assert.ok(['ambiguous', 'not-found'].includes(dup.reason), dup.reason);
    assert.strictEqual(live.reliquat(), null, 'reliquat retenu malgré un échec');
  });

  // Traque automatique : un jet raté détruit du poids, et ce poids part en
  // reliquat. Le champ qui monte du bon montant, deux fois de suite, c'est
  // lui — sans que l'utilisateur ait rien à saisir.
  await test('reliquat : repéré tout seul sur deux chutes de stats', async () => {
    const learned = [];
    const { live } = makeLive({
      // Vitalité : 0,2 par point, comme dans la vraie table.
      weightOf: (eid, pts) => (eid === 125 ? pts * 0.2 : null),
      onReliquatLearned: (path, value) => learned.push({ path, value }),
    });

    live.observe(withReliquat(300, 0));
    // 1re chute : −100 de vitalité = 20 de poids détruit → reliquat 20.
    live.observe(withReliquat(200, 20));
    assert.strictEqual(live.reliquat(), null, 'conclu sur une seule chute');
    // 2e chute : −50 = 10 de poids → reliquat 30.
    live.observe(withReliquat(150, 30));

    assert.ok(live.reliquatPath(), 'reliquat non repéré');
    assert.strictEqual(live.reliquat(), 30);
    assert.strictEqual(learned.length, 1, 'apprentissage non signalé');
  });

  // Un ou deux points de poids détruits ne prouvent rien : n'importe quel
  // compteur qui s'incrémente collerait.
  await test('reliquat : ne conclut pas sur une chute insignifiante', async () => {
    const { live } = makeLive({ weightOf: (eid, pts) => (eid === 125 ? pts * 0.2 : null) });
    live.observe(withReliquat(100, 0));
    live.observe(withReliquat(95, 1));    // 1 de poids détruit
    live.observe(withReliquat(90, 2));    // 1 de plus
    assert.strictEqual(live.reliquatPath(), null, 'conclu sur des miettes');
  });

  await test('reliquat : une hausse hors de proportion est rejetée', async () => {
    const { live } = makeLive({
      weightOf: (eid, pts) => (eid === 125 ? pts * 0.2 : null),
    });
    live.observe(withReliquat(300, 0));
    live.observe(withReliquat(200, 20));
    // Le champ bondit de 900 alors que 10 de poids seulement ont été détruits.
    live.observe(withReliquat(150, 920));
    assert.strictEqual(live.reliquatPath(), null, 'champ incohérent retenu');
  });

  // Auto-correction : si le champ retenu ne bouge plus alors que du poids
  // part, c'est qu'on s'est trompé.
  await test('reliquat : relâché si le champ reste figé malgré une destruction', async () => {
    const lost = [];
    const { live } = makeLive({
      weightOf: (eid, pts) => (eid === 125 ? pts * 0.2 : null),
      onReliquatLost: () => lost.push(1),
    });
    live.observe(withReliquat(300, 0));
    live.observe(withReliquat(200, 20));
    live.observe(withReliquat(150, 30));
    assert.ok(live.reliquatPath(), 'reliquat non repéré au départ');

    // Grosse destruction, mais le champ ne bouge pas.
    live.observe(withReliquat(100, 30));
    assert.strictEqual(live.reliquatPath(), null, 'champ contredit mais conservé');
    assert.strictEqual(lost.length, 1);
  });

  await test('reliquat : sans table de poids, la traque ne se déclenche pas', async () => {
    const { live } = makeLive();      // pas de weightOf
    live.observe(withReliquat(100, 0));
    live.observe(withReliquat(80, 4));
    live.observe(withReliquat(70, 6));
    assert.strictEqual(live.reliquatPath(), null);
  });

  await test('reliquat : sans paquet d\'atelier, on refuse d\'apprendre', async () => {
    const { live } = makeLive();
    const r = live.learnReliquat(47);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'no-packet');
  });

  await test('observe() ignore les paquets illisibles', async () => {
    const { live } = makeLive();
    live.observe(Buffer.from('ffffffffff', 'hex'));
    live.observe(Buffer.alloc(0));
    live.observe(null);
    assert.strictEqual(live.ready(), false);
  });

  await test('throwRune envoie pose(uid) + forge, dans cet ordre', async () => {
    const { live, sent } = makeLive();
    live.observe(inventoryPkt([{ uid: 200000000001, gid: 1545, qty: 12 }]));
    live.observe(effectsPkt([{ id: 125, value: 81 }]));

    const p = live.throwRune(1545);
    // Le serveur répond : la stat monte.
    setTimeout(() => live.observe(effectsPkt([{ id: 125, value: 96 }])), 20);
    const r = await p;

    assert.strictEqual(sent.length, 2, 'nombre de paquets envoyés');
    assert.strictEqual(sent[0].length, Buffer.from(PROFILE.move.template, 'hex').length,
      'le paquet de pose a changé de longueur');
    assert.strictEqual(proto.readVarInt(sent[0], PROFILE.move.uidOffset).value, 200000000001,
      'uid de rune non substitué');
    assert.strictEqual(sent[1].toString('hex'), PROFILE.ready.packet, 'paquet de forge incorrect');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.stats[125], 96);
    assert.strictEqual((await live.readStock())[1545], 11, 'stock non décrémenté');
  });

  // Observé sur le vrai jeu : le serveur répond d'abord avec les valeurs
  // INCHANGÉES, puis envoie la nouvelle valeur. S'arrêter au premier paquet
  // faisait compter « raté » tous les jets qui avaient pourtant réussi.
  await test('réponse en deux temps : le jet est compté réussi', async () => {
    const { live } = makeLive({ graceMs: 400 });
    live.observe(inventoryPkt([{ uid: 200000000001, gid: 1545, qty: 4 }]));
    live.observe(effectsPkt([{ id: 125, value: 81 }]));
    const p = live.throwRune(1545, { effectId: 125, amount: 15 });
    setTimeout(() => live.observe(effectsPkt([{ id: 125, value: 81 }])), 15);   // écho
    setTimeout(() => live.observe(effectsPkt([{ id: 125, value: 96 }])), 90);   // vraie valeur
    const r = await p;
    assert.strictEqual(r.ok, true, 'jet réussi compté comme raté');
    assert.strictEqual(r.stats[125], 96);
  });

  await test('jet raté : le serveur répond mais rien ne bouge', async () => {
    const { live } = makeLive();
    live.observe(inventoryPkt([{ uid: 200000000001, gid: 1545, qty: 2 }]));
    live.observe(effectsPkt([{ id: 125, value: 81 }]));
    const p = live.throwRune(1545);
    setTimeout(() => live.observe(effectsPkt([{ id: 125, value: 81 }])), 20);
    const r = await p;
    assert.strictEqual(r.ok, false, 'un jet sans changement compté comme réussi');
    assert.strictEqual(r.stats[125], 81);
  });

  // Le serveur refuse une rune dont l'identifiant est périmé (« objet ciblé
  // pas disponible dans la quantité demandée »). Ce n'est PAS un échec de
  // forgemagie : la rune n'est jamais partie, et rejouer le même identifiant
  // ne ferait que répéter le refus.
  // Un refus isolé ne prouve rien : supprimer la seule pile connue d'une rune
  // bloquerait tout le run. Il en faut trois d'affilée.
  await test('refus serveur : mis de côté d\'abord, retiré au troisième', async () => {
    const { live } = makeLive();
    live.observe(inventoryPkt([{ uid: 200000000001, gid: 1545, qty: 5 }]));
    live.observe(effectsPkt([{ id: 125, value: 81 }]));

    const first = await live.throwRune(1545, { effectId: 125, amount: 15 });
    assert.strictEqual(first.rejected, true, 'refus non détecté');
    assert.ok(!first.dropped, 'retiré dès le premier refus');
    assert.ok((await live.readStock())[1545] > 0, 'rune perdue dès le premier refus');

    await live.throwRune(1545, { effectId: 125, amount: 15 });
    const third = await live.throwRune(1545, { effectId: 125, amount: 15 });
    assert.strictEqual(third.dropped, true, 'jamais retiré malgré trois refus');
    assert.ok(!((await live.readStock())[1545] > 0));
  });

  // Ankama rebat les signatures en cours de session : STAKK réapprend le
  // gabarit pendant que l'observateur est ARMÉ. Figer le profil à l'armement
  // faisait continuer à émettre l'ancien format jusqu'au réarmement — la
  // forge restait muette alors que le bon profil était déjà connu.
  await test('profil réappris en cours de route : le jet suivant part avec le nouveau gabarit', async () => {
    let current = PROFILE;
    const { live, sent } = makeLive({ profile: PROFILE, getProfile: () => current });
    live.observe(inventoryPkt([{ uid: 200000000001, gid: 1545, qty: 4 }]));
    live.observe(effectsPkt([{ id: 125, value: 81 }]));

    current = PROFILE_B;                       // réapprentissage
    const p = live.throwRune(1545, { effectId: 125, amount: 15 });
    setTimeout(() => live.observe(effectsPkt([{ id: 125, value: 96 }])), 20);
    await p;

    assert.strictEqual(sent.length, 2);
    assert.strictEqual(sent[0].length, Buffer.from(PROFILE_B.move.template, 'hex').length,
      'la pose est partie avec l\'ancien gabarit');
    assert.strictEqual(proto.readVarInt(sent[0], PROFILE_B.move.uidOffset).value, 200000000001,
      'uid non substitué dans le nouveau gabarit');
    assert.strictEqual(sent[1].toString('hex'), PROFILE_B.ready.packet,
      'la forge est partie avec l\'ancien gabarit');
  });

  // Les refus encaissés sous un mauvais gabarit n'ont rien prouvé sur les
  // identifiants : une fois le bon profil connu, leur ardoise doit repartir de
  // zéro, sinon le premier vrai refus suffit à écarter une pile saine.
  await test('clearRejects() remet les ardoises à zéro', async () => {
    const { live } = makeLive();
    live.observe(inventoryPkt([{ uid: 200000000001, gid: 1545, qty: 5 }]));
    live.observe(effectsPkt([{ id: 125, value: 81 }]));

    await live.throwRune(1545, { effectId: 125, amount: 15 });
    await live.throwRune(1545, { effectId: 125, amount: 15 });
    live.clearRejects();
    const third = await live.throwRune(1545, { effectId: 125, amount: 15 });
    assert.ok(!third.dropped, 'ardoise non remise à zéro : la pile a été écartée');
    assert.ok((await live.readStock())[1545] > 0, 'pile perdue malgré la remise à zéro');
  });

  // Sans ça, retrouver le bon gabarit ne servait à rien : le moteur n'avait
  // plus une seule pile à jouer et le run mourait sur « plus de rune jetable ».
  await test('clearRejects() réinjecte les piles déjà retirées', async () => {
    const { live } = makeLive();
    live.observe(inventoryPkt([{ uid: 200000000001, gid: 1545, qty: 5 }]));
    live.observe(effectsPkt([{ id: 125, value: 81 }]));

    await live.throwRune(1545, { effectId: 125, amount: 15 });
    await live.throwRune(1545, { effectId: 125, amount: 15 });
    const third = await live.throwRune(1545, { effectId: 125, amount: 15 });
    assert.strictEqual(third.dropped, true, 'pile jamais retirée');
    assert.ok(!((await live.readStock())[1545] > 0), 'pile encore là après trois refus');

    // Un jet refusé ne consomme rien : la pile revient intacte.
    assert.strictEqual(live.clearRejects(), 1, 'aucune pile réinjectée');
    assert.strictEqual((await live.readStock())[1545], 5, 'pile non rendue au miroir');
  });

  // Une forgemagie ratée ne fait pas toujours bouger une stat : la rune part,
  // le serveur répond, et rien ne change à l'écran. Le compter comme un refus
  // serveur faisait sortir du miroir des piles parfaitement saines au bout de
  // trois échecs de FM ordinaires.
  await test('FM ratée sans changement de stat : pas un refus serveur', async () => {
    const { live } = makeLive();
    live.observe(inventoryPkt([{ uid: 200000000001, gid: 1545, qty: 5 }]));
    live.observe(effectsPkt([{ id: 125, value: 81 }]));

    const p = live.throwRune(1545, { effectId: 125, amount: 15 });
    // Le jeu répond — mêmes valeurs. C'est la preuve que le jet est arrivé.
    setTimeout(() => live.observe(effectsPkt([{ id: 125, value: 81 }])), 20);
    const r = await p;

    assert.strictEqual(r.ok, false, 'un jet sans changement compté comme réussi');
    assert.ok(!r.rejected, 'une FM ratée comptée comme un refus serveur');
    assert.ok((await live.readStock())[1545] > 0, 'pile écartée sur un simple échec de FM');
  });

  // L'atelier redécrit l'item en continu. En réarmant la grâce à chaque paquet,
  // chaque jet allait au bout du délai d'attente — 2,1 s mesurées en vrai,
  // pour un serveur qui répond en 35 ms.
  await test('cadence : la grâce ne se réarme pas à chaque paquet d\'atelier', async () => {
    const { live } = makeLive({ graceMs: 60, throwTimeoutMs: 1000 });
    live.observe(inventoryPkt([{ uid: 200000000001, gid: 1545, qty: 5 }]));
    live.observe(effectsPkt([{ id: 125, value: 81 }]));

    const beat = setInterval(() => live.observe(effectsPkt([{ id: 125, value: 81 }])), 20);
    const t0 = Date.now();
    const r = await live.throwRune(1545, { effectId: 125, amount: 15 });
    const ms = Date.now() - t0;
    clearInterval(beat);

    assert.ok(!r.rejected, 'compté comme refus alors que le jeu répond');
    assert.ok(ms < 500, `jet de ${ms} ms : la grâce se réarme à chaque paquet`);
  });

  // Le cas le plus courant de la forgemagie, et le plus mal diagnostiqué :
  // la rune part, elle est consommée, elle mange du reliquat, et AUCUNE stat
  // ne bouge. Rien de ce que le transport surveille ne change — ni effet suivi,
  // ni écho de pile — donc ça ressemblait trait pour trait à un paquet ignoré.
  // Résultat : STAKK vidait son miroir de piles saines puis arrêtait le run sur
  // « protocole périmé », alors que le jeu avait forgé quatre secondes plus tôt.
  // Un gabarit PROUVÉ tranche : s'il obtient des réponses, la rune est partie.
  await test('gabarit prouvé : une rune consommée sans effet est un échec de FM, pas un refus', async () => {
    const { live } = makeLive({ isProfileProven: () => true });
    live.observe(inventoryPkt([{ uid: 200000000001, gid: 1545, qty: 5 }]));
    live.observe(effectsPkt([{ id: 125, value: 81 }]));

    // Aucune réponse exploitable : le serveur ne parle que du reliquat, que le
    // transport ne suit pas.
    const r = await live.throwRune(1545, { effectId: 125, amount: 15 });

    assert.ok(!r.rejected, 'échec de FM compté comme un refus serveur');
    assert.strictEqual(r.ok, false);
    assert.strictEqual((await live.readStock())[1545], 4, 'rune non consommée');

    // Et trois de suite ne doivent rien retirer du miroir.
    await live.throwRune(1545, { effectId: 125, amount: 15 });
    const third = await live.throwRune(1545, { effectId: 125, amount: 15 });
    assert.ok(!third.dropped, 'pile écartée sur des échecs de FM ordinaires');
    assert.ok((await live.readStock())[1545] > 0, 'miroir vidé sur des échecs de FM');
  });

  // Sans preuve que le gabarit fonctionne, le silence reste un refus : c'est le
  // seul cas où écarter la pile a un sens.
  await test('gabarit non prouvé : le silence reste un refus', async () => {
    const { live } = makeLive();
    live.observe(inventoryPkt([{ uid: 200000000001, gid: 1545, qty: 5 }]));
    live.observe(effectsPkt([{ id: 125, value: 81 }]));
    const r = await live.throwRune(1545, { effectId: 125, amount: 15 });
    assert.strictEqual(r.rejected, true, 'le silence n\'est plus détecté comme un refus');
  });

  await test('refus serveur : une réponse efface l\'ardoise', async () => {
    const { live } = makeLive();
    live.observe(inventoryPkt([{ uid: 200000000001, gid: 1545, qty: 5 }]));
    live.observe(effectsPkt([{ id: 125, value: 81 }]));

    await live.throwRune(1545, { effectId: 125, amount: 15 });   // 1er refus
    // Jet suivant : le serveur répond, l'identifiant est donc valide.
    const p = live.throwRune(1545, { effectId: 125, amount: 15 });
    setTimeout(() => live.observe(effectsPkt([{ id: 125, value: 96 }])), 20);
    assert.strictEqual((await p).ok, true);

    // Deux refus de plus ne doivent pas suffire : le compteur est reparti à zéro.
    await live.throwRune(1545, { effectId: 125, amount: 15 });
    const r = await live.throwRune(1545, { effectId: 125, amount: 15 });
    assert.ok(!r.dropped, 'ardoise non remise à zéro après une réponse');
  });

  await test('refus serveur : préfère une autre pile avant d\'insister', async () => {
    const { live, sent } = makeLive();
    live.observe(inventoryPkt([{ uid: 200000000001, gid: 1545, qty: 5 }]));
    live.observe(inventoryPkt([{ uid: 200000000009, gid: 1545, qty: 5 }]));
    live.observe(effectsPkt([{ id: 125, value: 81 }]));

    await live.throwRune(1545, { effectId: 125, amount: 15 });   // refuse la plus fraîche
    await live.throwRune(1545, { effectId: 125, amount: 15 });   // doit basculer sur l'autre
    const used = sent.filter((_, i) => i % 2 === 0)
      .map(b => proto.readVarInt(b, PROFILE.move.uidOffset).value);
    assert.notStrictEqual(used[0], used[1], 'même pile rejouée malgré un refus');
  });

  // Les identifiants s'accumulent ; les plus anciens sont les plus souvent
  // périmés. Prendre le plus récent évite un refus serveur inutile.
  await test('choisit l\'identifiant le plus récemment vu', async () => {
    const { live, sent } = makeLive();
    live.observe(inventoryPkt([{ uid: 200000000001, gid: 1545, qty: 5 }]));   // ancien
    live.observe(inventoryPkt([{ uid: 200000000009, gid: 1545, qty: 5 }]));   // récent
    live.observe(effectsPkt([{ id: 125, value: 81 }]));

    const p = live.throwRune(1545, { effectId: 125, amount: 15 });
    setTimeout(() => live.observe(effectsPkt([{ id: 125, value: 96 }])), 20);
    await p;

    const uidSent = proto.readVarInt(sent[0], PROFILE.move.uidOffset).value;
    assert.strictEqual(uidSent, 200000000009, 'identifiant le plus ancien utilisé');
  });

  await test('après un refus, bascule sur l\'identifiant suivant', async () => {
    const { live, sent } = makeLive();
    live.observe(inventoryPkt([{ uid: 200000000001, gid: 1545, qty: 5 }]));
    live.observe(inventoryPkt([{ uid: 200000000009, gid: 1545, qty: 5 }]));
    live.observe(effectsPkt([{ id: 125, value: 81 }]));

    // Premier jet : aucun écho → refus, l'identifiant récent est écarté.
    const first = await live.throwRune(1545, { effectId: 125, amount: 15 });
    assert.strictEqual(first.rejected, true);
    assert.strictEqual(first.uid, 200000000009);

    // Second jet : il reste l'autre identifiant, la rune est encore jouable.
    const p = live.throwRune(1545, { effectId: 125, amount: 15 });
    setTimeout(() => live.observe(effectsPkt([{ id: 125, value: 96 }])), 20);
    const second = await p;
    assert.strictEqual(second.ok, true, 'bloqué alors qu\'un autre identifiant restait');
    assert.strictEqual(proto.readVarInt(sent[2], PROFILE.move.uidOffset).value, 200000000001);
  });

  // Un inventaire complet annonce toutes les piles dans le MÊME paquet : elles
  // ont donc exactement la même fraîcheur, et « la plus récente » ne départage
  // plus rien — le choix tombait sur la dernière du paquet, au hasard de
  // l'ordre des champs. On prend la plus grosse : elle survit à plus de jets,
  // donc son identifiant reste valide plus longtemps.
  await test('à fraîcheur égale, joue la plus grosse pile', async () => {
    const { live, sent } = makeLive();
    live.observe(inventoryPkt([
      { uid: 200000000001, gid: 1545, qty: 40 },
      { uid: 200000000009, gid: 1545, qty: 1 },
    ]));
    live.observe(effectsPkt([{ id: 125, value: 81 }]));

    const p = live.throwRune(1545, { effectId: 125, amount: 15 });
    setTimeout(() => live.observe(effectsPkt([{ id: 125, value: 96 }])), 20);
    await p;

    assert.strictEqual(proto.readVarInt(sent[0], PROFILE.move.uidOffset).value, 200000000001,
      'pile de 1 jouée alors qu\'une pile de 40 était aussi fraîche');
  });

  // La résolution se fait à la construction du paquet, à partir de l'état
  // COURANT du miroir : une pile vidée entre la lecture du stock et le jet
  // n'est plus jouable, et c'est la meilleure des survivantes qui part.
  await test('pile vidée entre la lecture du stock et le jet : la survivante est jouée', async () => {
    const { live, sent } = makeLive();
    live.observe(inventoryPkt([
      { uid: 200000000001, gid: 1545, qty: 40 },
      { uid: 200000000002, gid: 1545, qty: 5 },
      { uid: 200000000009, gid: 1545, qty: 1 },
    ]));
    live.observe(effectsPkt([{ id: 125, value: 81 }]));
    assert.strictEqual((await live.readStock())[1545], 46);

    // Le serveur consomme la grosse pile ailleurs : elle sort du miroir.
    live.observe(qtyUpdatePkt(200000000001, 0));

    const p = live.throwRune(1545, { effectId: 125, amount: 15 });
    setTimeout(() => live.observe(effectsPkt([{ id: 125, value: 96 }])), 20);
    await p;

    assert.strictEqual(proto.readVarInt(sent[0], PROFILE.move.uidOffset).value, 200000000002,
      'pile disparue du miroir jouée, ou survivante choisie au hasard du paquet');
  });

  // Plus aucune pile pour ce gid : c'est une rupture de stock, pas une panne.
  // Le code permet à l'appelant d'enchaîner sur son message d'absence de rune
  // au lieu de couper le run sur une erreur technique.
  await test('aucune pile pour ce gid : échec porteur du code d\'absence de rune', async () => {
    const { live, sent } = makeLive();
    live.observe(inventoryPkt([{ uid: 200000000001, gid: 1545, qty: 5 }]));
    live.observe(effectsPkt([{ id: 125, value: 81 }]));

    const err = await live.throwRune(1551, { effectId: 125, amount: 15 })
      .then(() => null, e => e);
    assert.ok(err, 'jet accepté alors qu\'aucune pile n\'existe');
    assert.strictEqual(err.code, 'no-stack', 'échec non identifiable comme une absence de rune');
    assert.strictEqual(err.runeGid, 1551);
    assert.match(err.message, /aucun identifiant fiable/);
    assert.strictEqual(sent.length, 0, 'des paquets sont partis sans pile');
  });

  await test('jet parti mais sans effet : échec de FM, identifiant conservé', async () => {
    const { live } = makeLive();
    live.observe(inventoryPkt([{ uid: 200000000001, gid: 1545, qty: 5 }]));
    live.observe(effectsPkt([{ id: 125, value: 81 }]));

    const p = live.throwRune(1545, { effectId: 125, amount: 15 });
    // Le serveur renvoie l'objet (il l'a bien pris) mais la stat ne bouge pas.
    setTimeout(() => live.observe(inventoryPkt([{ uid: 200000000001, gid: 1545, qty: 4 }])), 20);
    setTimeout(() => live.observe(effectsPkt([{ id: 125, value: 81 }])), 40);
    const r = await p;
    assert.strictEqual(r.ok, false);
    assert.ok(!r.rejected, 'échec de forgemagie pris pour un refus serveur');
    assert.ok((await live.readStock())[1545] > 0, 'identifiant écarté à tort');
  });

  await test('absence totale de réponse : jamais un succès supposé', async () => {
    const { live } = makeLive();
    live.observe(inventoryPkt([{ uid: 200000000001, gid: 1545, qty: 2 }]));
    live.observe(effectsPkt([{ id: 125, value: 81 }]));
    const r = await live.throwRune(1545, { effectId: 125, amount: 15 });
    assert.strictEqual(r.ok, false);
    // Silence complet du serveur : traité comme un refus, l'identifiant est
    // écarté plutôt que rejoué en boucle.
    assert.strictEqual(r.rejected, true);
    assert.strictEqual(r.stats[125], 81);
  });

  await test('refuse de jeter une rune dont l\'uid n\'est pas fiable', async () => {
    const { live, sent } = makeLive();
    live.observe(effectsPkt([{ id: 125, value: 81 }]));
    // Inventaire avec un uid minuscule → lecture « low » → écartée.
    live.observe(Buffer.concat([hdr(6000), lenF(3, Buffer.concat([varF(1, 1545), varF(2, 4)]))]));
    await assert.rejects(() => live.throwRune(1545), /aucun identifiant fiable/);
    assert.strictEqual(sent.length, 0);
  });

  await test('canal fermé : erreur explicite', async () => {
    const { live } = makeLive({ channel: { sendToServer: () => false } });
    live.observe(inventoryPkt([{ uid: 200000000001, gid: 1545, qty: 2 }]));
    live.observe(effectsPkt([{ id: 125, value: 81 }]));
    await assert.rejects(() => live.throwRune(1545), /canal fermé/);
  });

  await test('deux jets consécutifs enchaînent proprement', async () => {
    const { live, sent } = makeLive();
    live.observe(inventoryPkt([{ uid: 200000000001, gid: 1545, qty: 5 }]));
    live.observe(effectsPkt([{ id: 125, value: 81 }]));
    for (const v of [96, 111]) {
      const p = live.throwRune(1545);
      setTimeout(() => live.observe(effectsPkt([{ id: 125, value: v }])), 15);
      const r = await p;
      assert.strictEqual(r.ok, true, `jet vers ${v}`);
    }
    assert.strictEqual(sent.length, 4);
    assert.strictEqual((await live.readStats())[125], 111);
    assert.strictEqual((await live.readStock())[1545], 3);
  });

  // ─── Essai à blanc ───────────────────────────────────────────────────────

  await test('essai à blanc : rien n\'est envoyé mais tout est construit', async () => {
    const seen = [];
    const { live, sent } = makeLive({ dryRun: true, onDryRun: e => seen.push(e) });
    live.observe(inventoryPkt([{ uid: 200000000001, gid: 1545, qty: 4 }]));
    live.observe(effectsPkt([{ id: 125, value: 81 }]));
    assert.strictEqual(live.name, 'dry');
    assert.strictEqual(live.isDryRun(), true);

    const r = await live.throwRune(1545, { effectId: 125, amount: 15 });
    assert.strictEqual(sent.length, 0, 'des paquets sont partis en essai à blanc');
    assert.strictEqual(r.dryRun, true);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.stats[125], 96, 'stat simulée non appliquée');
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].uid, 200000000001);
    assert.strictEqual(seen[0].moveLength, Buffer.from(PROFILE.move.template, 'hex').length);
    // Les octets construits sont bien ceux qu'on aurait envoyés.
    const move = Buffer.from(seen[0].moveHex, 'hex');
    assert.strictEqual(proto.readVarInt(move, PROFILE.move.uidOffset).value, 200000000001);
    assert.strictEqual(seen[0].readyHex, PROFILE.ready.packet);
    assert.strictEqual((await live.readStock())[1545], 3, 'stock non décrémenté');
    assert.strictEqual(live.plannedPackets().length, 1);
  });

  await test('essai à blanc : converge sans réponse du serveur', async () => {
    const { live, sent } = makeLive({ dryRun: true });
    live.observe(inventoryPkt([{ uid: 200000000001, gid: 1545, qty: 20 }]));
    live.observe(effectsPkt([{ id: 125, value: 81 }]));
    for (let i = 0; i < 3; i++) await live.throwRune(1545, { effectId: 125, amount: 15 });
    assert.strictEqual((await live.readStats())[125], 126);
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(live.plannedPackets().length, 3);
  });

  await test('essai à blanc : mêmes refus qu\'en réel (uid douteux, pas d\'observation)', async () => {
    const { live, sent } = makeLive({ dryRun: true });
    await assert.rejects(() => live.throwRune(1545, { effectId: 125, amount: 15 }), /pose l'item/);
    live.observe(effectsPkt([{ id: 125, value: 81 }]));
    live.observe(Buffer.concat([hdr(6000), lenF(3, Buffer.concat([varF(1, 1545), varF(2, 4)]))]));
    await assert.rejects(() => live.throwRune(1545, { effectId: 125, amount: 15 }), /aucun identifiant fiable/);
    assert.strictEqual(sent.length, 0);
  });

  await test('essai à blanc : une vraie observation invalide l\'ardoise simulée', async () => {
    const { live } = makeLive({ dryRun: true });
    live.observe(inventoryPkt([{ uid: 200000000001, gid: 1545, qty: 9 }]));
    live.observe(effectsPkt([{ id: 125, value: 81 }]));
    await live.throwRune(1545, { effectId: 125, amount: 15 });
    assert.strictEqual((await live.readStats())[125], 96, 'stat simulée');
    // L'utilisateur pose un autre item : le jeu reprend la main.
    live.observe(effectsPkt([{ id: 125, value: 70 }]));
    assert.strictEqual((await live.readStats())[125], 70,
      'la simulation masque encore la réalité');
  });

  await test('bascule dry → live : l\'ardoise simulée ne fuite pas', async () => {
    const { live, sent } = makeLive({ dryRun: true });
    live.observe(inventoryPkt([{ uid: 200000000001, gid: 1545, qty: 9 }]));
    live.observe(effectsPkt([{ id: 125, value: 81 }]));
    await live.throwRune(1545, { effectId: 125, amount: 15 });
    assert.strictEqual((await live.readStats())[125], 96, 'stat simulée');

    live.setDryRun(false);
    assert.strictEqual(live.name, 'live');
    assert.strictEqual(live.plannedPackets().length, 0, 'plan non réinitialisé');
    // On repart de la valeur RÉELLEMENT observée, pas de la simulée.
    assert.strictEqual((await live.readStats())[125], 81);

    const p = live.throwRune(1545, { effectId: 125, amount: 15 });
    setTimeout(() => live.observe(effectsPkt([{ id: 125, value: 96 }])), 15);
    const r = await p;
    assert.strictEqual(r.ok, true);
    assert.strictEqual(sent.length, 2, 'le mode réel n\'envoie plus');
  });

  await test('bascule live → dry : plus rien ne part', async () => {
    const { live, sent } = makeLive();
    live.observe(inventoryPkt([{ uid: 200000000001, gid: 1545, qty: 9 }]));
    live.observe(effectsPkt([{ id: 125, value: 81 }]));
    live.setDryRun(true);
    await live.throwRune(1545, { effectId: 125, amount: 15 });
    assert.strictEqual(sent.length, 0);
  });

  console.log(`\n${passed}/${pending} tests OK${failures.length ? ' — ÉCHECS: ' + failures.join(', ') : ''}`);
  if (failures.length) process.exit(1);
})();
