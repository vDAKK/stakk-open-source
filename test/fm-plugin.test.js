'use strict';

/**
 * Tests d'intégration du plugin FM : routes, boucle, transport simulé.
 * Aucun réseau (dofusdb bouchonné), aucun Dofus.
 *   node test/fm-plugin.test.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const createFm = require('../lib/fm');
const createFmEngine = require('../lib/fm-engine');

// Les numéros de champs d'inventaire s'apprennent et se rangent sur disque.
// Un mapping laissé par un run précédent fausserait la lecture des paquets
// fabriqués ici : on repart d'une ardoise propre.
try {
  const dir = path.join(os.homedir(), '.stakk');
  for (const f of fs.readdirSync(dir)) {
    if (/^fm-fields-.+\.json$/.test(f)) fs.unlinkSync(path.join(dir, f));
  }
} catch { /* dossier absent : rien à nettoyer */ }

// ─── Bouchons ──────────────────────────────────────────────────────────────

const TABLES = {
  runes: {
    118: [
      { id: 1519, name: 'Rune Fo', amount: 1 },
      { id: 1545, name: 'Rune Pa Fo', amount: 3 },
      { id: 1551, name: 'Rune Ra Fo', amount: 10 },
    ],
    125: [
      { id: 1523, name: 'Rune Vi', amount: 5 },
      { id: 1548, name: 'Rune Pa Vi', amount: 15 },
      { id: 1554, name: 'Rune Ra Vi', amount: 50 },
    ],
    // PA : exo. Absent de l'item de test, donc travaillé en dernier.
    111: [
      { id: 1557, name: 'Rune Ga Pa', amount: 1 },
    ],
  },
  effects: { 118: { fr: 'Force' }, 125: { fr: 'Vitalité' }, 111: { fr: 'PA' } },
  // Orbes de forgemagie, triées par niveau : on prend la plus petite qui
  // couvre l'item plutôt que de gâcher une magistrale.
  orbes: [
    { id: 17272, name: 'Orbe régénérant mineur', level: 60 },
    { id: 17273, name: 'Orbe régénérant', level: 120 },
    { id: 17274, name: 'Orbe régénérant majeur', level: 180 },
  ],
};

const ITEM = {
  id: 7340, name: 'Cape du Kitsou', level: 62, typeName: 'Cape',
  stats: [{ effectId: 125, from: 81, to: 100 }, { effectId: 118, from: 7, to: 10 }],
};

function fakeFmData() {
  return () => ({
    EXO_EFFECT_IDS: [111, 128, 117],
    getTables: async () => TABLES,
    refresh: async () => TABLES,
    searchItems: async (q) => (String(q).includes('kitsou') ? [ITEM] : []),
    getItem: async (id) => {
      if (Number(id) !== ITEM.id) throw new Error(`item ${id} introuvable`);
      return ITEM;
    },
  });
}

function makeHarness(opts = {}) {
  const routes = {};
  const listeners = {};
  let config = { fm: undefined };
  const logs = [];
  const packetHandlers = [];

  const api = createFm({
    fs, path, os, https: require('https'),
    log: m => logs.push(String(m)),
    registerRoute: (m, p, h) => { routes[`${m} ${p}`] = h; },
    on: (ev, h) => { (listeners[ev] = listeners[ev] || []).push(h); },
    loadConfig: () => config,
    saveConfig: c => { config = c; },
    setPacketHandler: opts.noTap ? null : (fn => { packetHandlers.push(fn); return true; }),
    getGameChannel: () => opts.channel || null,
    DATA_DIR: os.tmpdir(),
    createFmData: fakeFmData(),
    createFmEngine,
    createFmProtocol: opts.noProtocol ? null : require('../lib/fm-protocol'),
  });

  const call = (method, p, body, url) =>
    routes[`${method} ${p}`](body, { url: url || p });

  return { api, routes, call, listeners, logs, packetHandlers, config: () => config };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 4000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error('timeout');
    await sleep(15);
  }
}

let passed = 0, pending = 0;
const failures = [];
function test(name, fn) {
  pending++;
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ok  ${name}`); })
    .catch(e => { failures.push(name); console.error(`  FAIL ${name}\n       ${e.message}`); });
}

(async () => {
  console.log('fm plugin');

  await test('les routes attendues sont enregistrées', () => {
    const { routes } = makeHarness();
    for (const k of [
      'GET /api/fm/tables', 'POST /api/fm/tables/refresh', 'GET /api/fm/items',
      'GET /api/fm/item', 'GET /api/fm/config', 'POST /api/fm/config',
      'GET /api/fm/status', 'POST /api/fm/start', 'POST /api/fm/stop',
      'POST /api/fm/capture/start', 'POST /api/fm/capture/stop', 'GET /api/fm/capture/status',
    ]) assert.ok(routes[k], `route manquante: ${k}`);
  });

  await test('GET /api/fm/item renvoie defaults, axes, runes et libellés', async () => {
    const { call } = makeHarness();
    const r = await call('GET', '/api/fm/item', null, '/api/fm/item?id=7340');
    assert.strictEqual(r.item.name, 'Cape du Kitsou');
    // Par défaut : la fourchette naturelle de l'item (jet mini → jet maxi).
    assert.deepStrictEqual(r.defaults[125], [81, 100]);
    assert.strictEqual(r.axis[125], 200);
    assert.strictEqual(r.labels[118], 'Force');
    assert.strictEqual(r.runes[118].length, 3);
  });

  await test('GET /api/fm/item sans id échoue proprement', async () => {
    const { call } = makeHarness();
    await assert.rejects(() => call('GET', '/api/fm/item', null, '/api/fm/item'), /id requis/);
  });

  await test('GET /api/fm/items filtre sur la query', async () => {
    const { call } = makeHarness();
    assert.strictEqual((await call('GET', '/api/fm/items', null, '/api/fm/items?q=kitsou')).items.length, 1);
    assert.strictEqual((await call('GET', '/api/fm/items', null, '/api/fm/items?q=zzz')).items.length, 0);
  });

  await test('config: défauts puis persistance', async () => {
    const h = makeHarness();
    const d = await h.call('GET', '/api/fm/config');
    assert.deepStrictEqual(d.delay, [500, 1000]);
    assert.strictEqual(d.transport, 'sim');
    await h.call('POST', '/api/fm/config', { delay: [100, 200], transport: 'live' });
    const after = await h.call('GET', '/api/fm/config');
    assert.deepStrictEqual(after.delay, [100, 200]);
    assert.strictEqual(after.transport, 'live');
    assert.deepStrictEqual(h.config().fm.delay, [100, 200]);
  });

  await test('config: transport inconnu ignoré', async () => {
    const h = makeHarness();
    await h.call('POST', '/api/fm/config', { transport: 'wat' });
    assert.strictEqual((await h.call('GET', '/api/fm/config')).transport, 'sim');
  });

  await test('config: presets ajout puis suppression', async () => {
    const h = makeHarness();
    await h.call('POST', '/api/fm/config', { preset: { key: 'cape', value: { itemId: 7340 } } });
    assert.deepStrictEqual((await h.call('GET', '/api/fm/config')).presets.cape, { itemId: 7340 });
    await h.call('POST', '/api/fm/config', { deletePreset: 'cape' });
    assert.strictEqual((await h.call('GET', '/api/fm/config')).presets.cape, undefined);
  });

  await test('start refuse un accountId absent', async () => {
    const { call } = makeHarness();
    await assert.rejects(() => call('POST', '/api/fm/start', { itemId: 7340 }), /accountId requis/);
  });

  await test('start refuse un item sans cible', async () => {
    const { call } = makeHarness();
    await assert.rejects(
      () => call('POST', '/api/fm/start', { accountId: 1, itemId: 7340, targets: {} }),
      /aucune stat forgeable/);
  });

  // Le profil est intégré : plus de calibration préalable. Le seul verrou qui
  // reste est l'observation — tant que STAKK n'a pas lu l'item dans le jeu,
  // il n'envoie rien.
  await test('start en live sans observation est refusé (pas de paquet envoyé)', async () => {
    const sent = [];
    const { call } = makeHarness({ channel: { sendToServer: b => { sent.push(b); return true; } } });
    await assert.rejects(
      () => call('POST', '/api/fm/start', {
        accountId: 42, itemId: 7340, transport: 'live', targets: { 118: [10, 10] },
      }),
      /pose l'item/);
    assert.strictEqual(sent.length, 0, 'des paquets sont partis sans observation');
  });

  await test('run simulé complet : atteint les objectifs et journalise', async () => {
    const { call } = makeHarness();
    const start = await call('POST', '/api/fm/start', {
      accountId: 7, itemId: 7340,
      targets: { 118: [10, 10], 125: [110, 110] },
      delay: [0, 0],
    });
    assert.strictEqual(start.ok, true);
    assert.strictEqual(start.run.transport, 'sim');

    const done = await waitFor(async () => {
      const r = await call('GET', '/api/fm/status', null, '/api/fm/status?accountId=7');
      return ['done', 'blocked', 'error'].includes(r.run.status) ? r.run : null;
    });
    assert.strictEqual(done.status, 'done', `statut=${done.status} err=${done.error}`);
    assert.ok(done.stats[118] >= 10, `force=${done.stats[118]}`);
    assert.ok(done.stats[125] >= 110, `vita=${done.stats[125]}`);
    assert.ok(done.thrown > 0);
    assert.strictEqual(done.progress, 1);
    assert.ok(done.log.some(l => l.level === 'success'));
    assert.ok(done.log.length <= 60, 'journal borné');
  });

  await test('deux runs sur des comptes différents cohabitent', async () => {
    const { call } = makeHarness();
    await call('POST', '/api/fm/start', { accountId: 1, itemId: 7340, targets: { 118: [9, 9] }, delay: [0, 0] });
    await call('POST', '/api/fm/start', { accountId: 2, itemId: 7340, targets: { 118: [9, 9] }, delay: [0, 0] });
    const all = await call('GET', '/api/fm/status', null, '/api/fm/status');
    assert.strictEqual(all.runs.length, 2);
    await waitFor(async () => {
      const r = await call('GET', '/api/fm/status', null, '/api/fm/status');
      return r.runs.every(x => x.status === 'done');
    });
  });

  await test('start refuse un second run sur le même compte', async () => {
    const { call } = makeHarness();
    await call('POST', '/api/fm/start', {
      accountId: 3, itemId: 7340, targets: { 118: [10, 10], 125: [400, 400] }, delay: [50, 50],
    });
    await assert.rejects(
      () => call('POST', '/api/fm/start', { accountId: 3, itemId: 7340, targets: { 118: [10, 10] } }),
      /tourne déjà/);
    await call('POST', '/api/fm/stop', { accountId: 3 });
  });

  await test('stop interrompt la boucle', async () => {
    const { call } = makeHarness();
    await call('POST', '/api/fm/start', {
      accountId: 4, itemId: 7340, targets: { 125: [500, 500] }, delay: [40, 40],
    });
    await waitFor(async () =>
      (await call('GET', '/api/fm/status', null, '/api/fm/status?accountId=4')).run.thrown > 0);
    const s = await call('POST', '/api/fm/stop', { accountId: 4 });
    assert.strictEqual(s.run.status, 'stopped');
    const thrown = s.run.thrown;
    await sleep(200);
    const after = await call('GET', '/api/fm/status', null, '/api/fm/status?accountId=4');
    assert.ok(after.run.thrown - thrown <= 1, 'la boucle continue après stop');
  });

  await test('stop sur compte inconnu ne casse pas', async () => {
    const { call } = makeHarness();
    assert.strictEqual((await call('POST', '/api/fm/stop', { accountId: 999 })).ok, false);
  });

  await test('detach coupe le run en cours', async () => {
    const h = makeHarness();
    await h.call('POST', '/api/fm/start', {
      accountId: 5, itemId: 7340, targets: { 125: [500, 500] }, delay: [40, 40],
    });
    await waitFor(async () =>
      (await h.call('GET', '/api/fm/status', null, '/api/fm/status?accountId=5')).run.thrown > 0);
    for (const fn of h.listeners.detach) fn({ accountId: 5 });
    const r = await h.call('GET', '/api/fm/status', null, '/api/fm/status?accountId=5');
    assert.strictEqual(r.run.status, 'stopped');
    assert.strictEqual(r.run.error, 'compte déconnecté');
  });

  await test('capture : start → paquets écrits → stop', async () => {
    const h = makeHarness();
    const st0 = await h.call('GET', '/api/fm/capture/status', null, '/api/fm/capture/status?accountId=8');
    assert.strictEqual(st0.available, true);
    assert.strictEqual(st0.running, false);
    // Profil livré avec STAKK : utilisable sans aucune capture.
    assert.strictEqual(st0.calibrated, true);
    assert.strictEqual(st0.profileSource, 'builtin');

    const started = await h.call('POST', '/api/fm/capture/start', { accountId: 8 });
    assert.ok(started.file.endsWith('fm-capture-8.log'));
    assert.strictEqual(h.packetHandlers.length, 1);

    const tap = h.packetHandlers[0];
    tap(8, 'out', 1234, Buffer.from('deadbeef', 'hex'), null);
    tap(8, 'in', 5678, Buffer.from('cafe', 'hex'), null);
    tap(99, 'out', 1, Buffer.from('ff', 'hex'), null);   // autre compte → ignoré

    const mid = await h.call('GET', '/api/fm/capture/status', null, '/api/fm/capture/status?accountId=8');
    assert.strictEqual(mid.running, true);
    assert.strictEqual(mid.count, 2);

    const stopped = await h.call('POST', '/api/fm/capture/stop', { accountId: 8 });
    assert.strictEqual(stopped.count, 2);
    await sleep(60);
    const content = fs.readFileSync(stopped.file, 'utf8');
    assert.ok(content.includes('msgId=1234'), 'paquet OUT absent du dump');
    assert.ok(content.includes('hex=deadbeef'));
    assert.ok(!content.includes('hex=ff\n'), 'paquet d\'un autre compte capturé');
    fs.unlinkSync(stopped.file);
  });

  await test('capture indisponible si le proxy n\'expose pas le tap', async () => {
    const { call } = makeHarness({ noTap: true });
    const st = await call('GET', '/api/fm/capture/status', null, '/api/fm/capture/status?accountId=1');
    assert.strictEqual(st.available, false);
    // handler synchrone → on l'enveloppe pour que assert.rejects voie une promesse
    await assert.rejects(async () => call('POST', '/api/fm/capture/start', { accountId: 1 }), /indisponible/);
  });

  // ─── Calibration ─────────────────────────────────────────────────────────

  // Fabrique une capture réaliste : 2 poses de rune (uid différents) + 2 forges.
  function fakeCapture() {
    const vi = v => { const o = []; let n = v; do { const b = n % 128; n = Math.floor(n / 128); o.push(b | (n > 0 ? 0x80 : 0)); } while (n > 0); return Buffer.from(o); };
    const lenF = (f, p) => Buffer.concat([Buffer.from([(f << 3) | 2]), vi(p.length), p]);
    const varF = (f, v) => Buffer.concat([Buffer.from([(f << 3) | 0]), vi(v)]);
    const hdr = id => { const b = Buffer.alloc(2); b.writeUInt16BE((id << 2) & 0xffff, 0); return b; };
    const move = uid => Buffer.concat([hdr(4210),
      lenF(1, Buffer.from('type.ankama.com/xyz')),
      lenF(2, Buffer.concat([varF(1, uid), varF(2, 1)]))]);
    const ready = Buffer.concat([hdr(4211), lenF(1, Buffer.from('type.ankama.com/rdy'))]);
    const l = (dir, id, b) => `10:00:00.000 ${dir.padEnd(3)} msgId=${id} len=${b.length} hex=${b.toString('hex')}`;
    return [
      '# capture', '#',
      l('OUT', 4210, move(100000000000)),
      l('OUT', 4211, ready),
      l('IN', 999, Buffer.from('0102', 'hex')),
      l('OUT', 4210, move(100000000001)),
      l('OUT', 4211, ready),
    ].join('\n') + '\n';
  }

  await test('calibrate : capture valide → profil écrit et résumé renvoyé', async () => {
    const h = makeHarness();
    const st = await h.call('GET', '/api/fm/capture/status', null, '/api/fm/capture/status?accountId=31');
    fs.writeFileSync(st.file, fakeCapture());
    const r = await h.call('POST', '/api/fm/calibrate', { accountId: 31 });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.profile.moveMsgId, 4210);
    assert.strictEqual(r.profile.readyMsgId, 4211);
    assert.deepStrictEqual(r.profile.observedUids.sort((a, b) => a - b), [100000000000, 100000000001]);

    const after = await h.call('GET', '/api/fm/capture/status', null, '/api/fm/capture/status?accountId=31');
    assert.strictEqual(after.calibrated, true);
    assert.strictEqual(after.profileSource, 'learned', 'le profil appris doit primer');
    assert.strictEqual(after.profile.moveMsgId, 4210);

    // Le verrou restant n'est plus la calibration : ce harnais n'a pas de
    // canal de jeu, donc c'est là-dessus que ça bloque.
    await assert.rejects(
      () => h.call('POST', '/api/fm/start', { accountId: 31, itemId: 7340, transport: 'live', targets: { 118: [10, 10] } }),
      /canal de jeu/);

    // Après réinitialisation on retombe sur le profil intégré, pas sur rien.
    await h.call('POST', '/api/fm/calibrate/reset', { accountId: 31 });
    const reset = await h.call('GET', '/api/fm/capture/status', null, '/api/fm/capture/status?accountId=31');
    assert.strictEqual(reset.calibrated, true);
    assert.strictEqual(reset.profileSource, 'builtin');
    fs.unlinkSync(st.file);
  });

  await test('calibrate : capture inexploitable → diagnostic, pas de profil', async () => {
    const h = makeHarness();
    const st = await h.call('GET', '/api/fm/capture/status', null, '/api/fm/capture/status?accountId=32');
    fs.writeFileSync(st.file, '# capture vide\n');
    const r = await h.call('POST', '/api/fm/calibrate', { accountId: 32 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'empty');
    assert.ok(r.detail);
    // Une analyse ratée ne casse rien : on reste sur le profil intégré.
    const after = await h.call('GET', '/api/fm/capture/status', null, '/api/fm/capture/status?accountId=32');
    assert.strictEqual(after.profileSource, 'builtin');
    fs.unlinkSync(st.file);
  });

  await test('calibrate : sans capture → message explicite', async () => {
    const h = makeHarness();
    const p = path.join(os.homedir(), '.stakk', 'fm-capture-33.log');
    try { fs.unlinkSync(p); } catch {}
    await assert.rejects(async () => h.call('POST', '/api/fm/calibrate', { accountId: 33 }), /aucune capture/);
  });

  await test('calibrate : refuse pendant une capture en cours', async () => {
    const h = makeHarness();
    await h.call('POST', '/api/fm/capture/start', { accountId: 34 });
    await assert.rejects(async () => h.call('POST', '/api/fm/calibrate', { accountId: 34 }), /arrête la capture/);
    const r = await h.call('POST', '/api/fm/capture/stop', { accountId: 34 });
    await sleep(60);                    // laisse le flux se vider avant l'effacement
    try { fs.unlinkSync(r.file); } catch {}
  });

  await test('calibrate : indisponible si fm-protocol absent', async () => {
    const h = makeHarness({ noProtocol: true });
    const st = await h.call('GET', '/api/fm/capture/status', null, '/api/fm/capture/status?accountId=35');
    assert.strictEqual(st.analyzer, false);
    await assert.rejects(async () => h.call('POST', '/api/fm/calibrate', { accountId: 35 }), /indisponible/);
  });

  // ─── Parcours live ───────────────────────────────────────────────────────

  const vi = v => { const o = []; let n = v; do { const b = n % 128; n = Math.floor(n / 128); o.push(b | (n > 0 ? 0x80 : 0)); } while (n > 0); return Buffer.from(o); };
  const lenF = (f, p) => Buffer.concat([Buffer.from([(f << 3) | 2]), vi(p.length), p]);
  const varF = (f, v) => Buffer.concat([Buffer.from([(f << 3) | 0]), vi(v)]);
  // Format réel du canal jeu : <varint longueur><message protobuf>. Les
  // paquets de test doivent l'être aussi, sinon ils ne passent pas le
  // recollage — et ils ne représenteraient plus rien de réel.
  const frame = payload => Buffer.concat([vi(payload.length), payload]);
  const inventoryPkt = items => frame(Buffer.concat([lenF(1, Buffer.from('type.ankama.com/inv')),
    ...items.map(it => lenF(3, Buffer.concat([varF(1, it.uid), varF(2, it.gid), varF(3, it.qty)])))]));
  // Forme réelle : les effets sont DANS le sous-message de l'objet, à côté de
  // son gid. La lecture est scopée sur le gid de l'item (7340 ici), sinon les
  // effets des runes présentes dans le même paquet seraient pris pour ceux de
  // l'item.
  const objectMsg = (uid, gid, effs) => lenF(3, Buffer.concat([
    varF(1, uid), varF(2, gid),
    ...effs.map(e => lenF(5, Buffer.concat([varF(1, e.id), varF(2, e.value)]))),
  ]));
  const effectsPkt = (effs, gid, uid) => frame(Buffer.concat([
    lenF(1, Buffer.from('type.ankama.com/eff')),
    objectMsg(uid || 900000000001, gid || 7340, effs)]));

  // Prépare un compte calibré + canal bouchonné.
  const proto = require('../lib/fm-protocol')();

  function liveHarness(accountId) {
    const sent = [];
    const channel = { sendToServer: b => { sent.push(Buffer.from(b)); return true; }, sendToClient: () => true };
    const h = makeHarness({ channel });
    const capFile = path.join(os.homedir(), '.stakk', `fm-capture-${accountId}.log`);
    fs.mkdirSync(path.dirname(capFile), { recursive: true });
    fs.writeFileSync(capFile, fakeCapture());
    return { h, sent, capFile, channel };
  }

  // Paquets d'échange au format du client : enveloppe Any, uid en varint. Le
  // nom de type est paramétrable — c'est précisément ce qu'Ankama change d'un
  // build à l'autre, et ce que l'apprentissage doit encaisser.
  function movePacket(code, uid) {
    return proto.buildMovePacket(proto.defaultProfile({ move: code }), uid);
  }
  function readyPacket(code) {
    return proto.buildReadyPacket(proto.defaultProfile({ ready: code }));
  }

  // Clé en main : sans la moindre capture, l'armement doit passer grâce au
  // profil intégré.
  await test('live : armement possible sans aucune calibration', async () => {
    const { h } = liveHarness(41);
    fs.unlinkSync(path.join(os.homedir(), '.stakk', 'fm-capture-41.log'));
    const st = await h.call('POST', '/api/fm/live/arm', { accountId: 41, itemId: 7340 });
    assert.strictEqual(st.armed, true);
    assert.strictEqual(st.profileSource, 'builtin');
    assert.strictEqual(st.ready, false, 'prêt sans avoir rien observé');
    await h.call('POST', '/api/fm/live/disarm', { accountId: 41 });
  });

  await test('live : armement refusé sans canal de jeu', async () => {
    const { h, capFile } = liveHarness(42);
    // makeHarness sans `channel` → getGameChannel renvoie null
    const h2 = makeHarness();
    await h2.call('POST', '/api/fm/calibrate', { accountId: 42 });
    await assert.rejects(
      () => h2.call('POST', '/api/fm/live/arm', { accountId: 42, itemId: 7340 }),
      /canal de jeu/);
    fs.unlinkSync(capFile);
    try { fs.unlinkSync(path.join(os.homedir(), '.stakk', 'fm-protocol-42.json')); } catch {}
  });

  await test('live : armé mais rien observé → refus de démarrer, zéro paquet', async () => {
    const { h, sent, capFile } = liveHarness(43);
    await h.call('POST', '/api/fm/calibrate', { accountId: 43 });
    const st = await h.call('POST', '/api/fm/live/arm', { accountId: 43, itemId: 7340 });
    assert.strictEqual(st.armed, true);
    assert.strictEqual(st.ready, false);
    assert.match(st.diagnostic, /pose l'item/);
    await assert.rejects(
      () => h.call('POST', '/api/fm/start', { accountId: 43, itemId: 7340, transport: 'live', targets: { 125: [110, 110] } }),
      /pose l'item/);
    assert.strictEqual(sent.length, 0, 'des paquets sont partis sans observation');
    fs.unlinkSync(capFile);
    try { fs.unlinkSync(path.join(os.homedir(), '.stakk', 'fm-protocol-43.json')); } catch {}
  });

  await test('protocole : réappris tout seul quand le joueur pose une rune à la main', async () => {
    const { h, capFile } = liveHarness(45);
    const profilePath = path.join(os.homedir(), '.stakk', 'fm-protocol-45.json');
    try { fs.unlinkSync(profilePath); } catch {}

    await h.call('POST', '/api/fm/live/arm', { accountId: 45, itemId: 7340 });
    const tap = h.packetHandlers[0];
    // Le serveur annonce l'inventaire : STAKK connaît désormais ces uid.
    tap(45, 'in', 6000, inventoryPkt([
      { uid: 200000000001, gid: 1523, qty: 30 },
      { uid: 200000000002, gid: 1548, qty: 20 },
    ]), null);

    // Ankama a changé ses signatures : le joueur pose une rune à la main, et
    // le paquet sortant porte un uid que STAKK reconnaît.
    const move = movePacket('zzz', 200000000002);
    const ready = readyPacket('yyy');
    tap(45, 'out', 3076, move, null);
    tap(45, 'out', 2564, ready, null);

    const saved = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    assert.strictEqual(saved.source, 'auto', "le profil doit venir de l'apprentissage");
    assert.strictEqual(saved.codes.move, 'zzz');
    assert.strictEqual(saved.codes.ready, 'yyy');
    // Et il doit reproduire à l'octet près ce que le client a envoyé.
    assert.strictEqual(
      proto.buildMovePacket(saved, 200000000002).toString('hex'), move.toString('hex'));
    assert.strictEqual(proto.buildReadyPacket(saved).toString('hex'), ready.toString('hex'));

    try { fs.unlinkSync(capFile); } catch {}
    try { fs.unlinkSync(profilePath); } catch {}
  });

  // Vécu en production le 12/08/2026 : Ankama rebat les signatures en pleine
  // session, STAKK réapprend le gabarit à la pose manuelle… et le run relancé
  // reste muet, parce que l'observateur ARMÉ avait figé le profil à
  // l'armement. Le bon gabarit était sur disque, il n'atteignait pas le fil.
  await test('protocole : un profil réappris atteint l\'observateur déjà armé', async () => {
    const { h, sent, capFile } = liveHarness(47);
    const profilePath = path.join(os.homedir(), '.stakk', 'fm-protocol-47.json');
    try { fs.unlinkSync(profilePath); } catch {}

    await h.call('POST', '/api/fm/live/arm', { accountId: 47, itemId: 7340 });
    const tap = h.packetHandlers[0];
    tap(47, 'in', 6000, inventoryPkt([
      { uid: 200000000001, gid: 1523, qty: 30 },
      { uid: 200000000002, gid: 1548, qty: 20 },
    ]), null);
    tap(47, 'in', 6100, effectsPkt([{ id: 125, value: 81 }]), null);

    // Le joueur pose une rune à la main : nouveau gabarit, observateur toujours
    // armé (on ne désarme pas, c'est tout l'intérêt).
    tap(47, 'out', 3076, movePacket('zzz', 200000000002), null);
    tap(47, 'out', 2564, readyPacket('yyy'), null);
    const relearned = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    assert.strictEqual(relearned.codes.move, 'zzz', 'profil non réappris');

    let value = 81, answered = 0;
    const answer = setInterval(() => {
      const pairs = Math.floor(sent.length / 2);
      if (pairs > answered) {
        answered = pairs;
        value += 15;
        tap(47, 'in', 6100, effectsPkt([{ id: 125, value }]), null);
      }
    }, 10);

    await h.call('POST', '/api/fm/start', {
      accountId: 47, itemId: 7340, transport: 'live',
      targets: { 125: [110, 110] }, delay: [0, 0],
    });
    const done = await waitFor(async () => {
      const r = await h.call('GET', '/api/fm/status', null, '/api/fm/status?accountId=47');
      return ['done', 'blocked', 'error', 'stopped'].includes(r.run.status) ? r.run : null;
    }, 8000);
    clearInterval(answer);

    assert.strictEqual(done.status, 'done', `statut=${done.status} err=${done.error}`);
    assert.ok(sent.length >= 2, 'aucun paquet envoyé');
    // Le forger part au NOUVEAU format, pas à celui capturé à l'armement.
    assert.strictEqual(sent[1].toString('hex'), relearned.ready.packet,
      'la forge est partie avec le gabarit d\'avant le réapprentissage');
    assert.strictEqual(sent[0].length, Buffer.from(relearned.move.template, 'hex').length,
      'la pose est partie avec le gabarit d\'avant le réapprentissage');

    await h.call('POST', '/api/fm/live/disarm', { accountId: 47 });
    try { fs.unlinkSync(capFile); } catch {}
    try { fs.unlinkSync(profilePath); } catch {}
  });

  // L'apprentissage passif peut se tromper de paquet : plusieurs messages
  // sortants portent un identifiant d'objet. Le faux positif se figeait alors
  // sur disque et masquait le gabarit intégré — pourtant exact — pour toutes
  // les sessions suivantes, jusqu'à une pose manuelle. Vécu le 12/08/2026.
  await test('protocole : un profil appris muet est écarté au profit de l\'intégré', async () => {
    const { h, sent, capFile } = liveHarness(50);
    const profilePath = path.join(os.homedir(), '.stakk', 'fm-protocol-50.json');
    // Profil appris bidon : bon format, mauvaise signature. Le serveur simulé
    // ne répondra donc jamais à ses paquets.
    const bogus = proto.defaultProfile({ move: 'zzz', ready: 'yyy' });
    bogus.source = 'auto';
    fs.writeFileSync(profilePath, JSON.stringify(bogus, null, 2));

    await h.call('POST', '/api/fm/live/arm', { accountId: 50, itemId: 7340 });
    const tap = h.packetHandlers[0];
    tap(50, 'in', 6000, inventoryPkt([
      { uid: 200000000001, gid: 1523, qty: 30 },
      { uid: 200000000002, gid: 1548, qty: 20 },
      { uid: 200000000003, gid: 1554, qty: 20 },
    ]), null);
    tap(50, 'in', 6100, effectsPkt([{ id: 125, value: 81 }]), null);

    // Le serveur simulé n'honore QUE les poses au gabarit intégré : tant que
    // le profil bidon est en place, aucun jet n'obtient de réponse.
    const builtinCode = proto.defaultProfile().codes.move;
    let value = 81, seen = 0;
    const answer = setInterval(() => {
      while (seen < sent.length) {
        const buf = sent[seen++];
        if (!buf.includes(Buffer.from(`type.ankama.com/${builtinCode}`, 'latin1'))) continue;
        value += 15;
        tap(50, 'in', 6100, effectsPkt([{ id: 125, value }]), null);
      }
    }, 10);

    await h.call('POST', '/api/fm/start', {
      accountId: 50, itemId: 7340, transport: 'live',
      targets: { 125: [110, 110] }, delay: [0, 0],
    });
    const done = await waitFor(async () => {
      const r = await h.call('GET', '/api/fm/status', null, '/api/fm/status?accountId=50');
      return ['done', 'blocked', 'error', 'stopped'].includes(r.run.status) ? r.run : null;
      // Le repli n'arrive qu'après NO_ANSWER_LIMIT jets muets, chacun payant
      // le délai d'attente complet : compter large.
    }, 30000);
    clearInterval(answer);

    assert.strictEqual(done.status, 'done',
      `le run n'a pas récupéré tout seul (statut=${done.status} err=${done.error})`);
    // Le fichier peut réapparaître : la preuve du gabarit s'y range dès qu'un
    // jet obtient réponse. Ce qui compte est qu'aucun profil APPRIS n'y fasse
    // plus autorité — le gabarit intégré doit avoir repris la main.
    const reste = fs.existsSync(profilePath)
      ? JSON.parse(fs.readFileSync(profilePath, 'utf8')) : null;
    assert.ok(!reste || reste.source === 'builtin',
      'le profil appris muet est resté sur disque');
    const st = await h.call('GET', '/api/fm/capture/status', null, '/api/fm/capture/status?accountId=50');
    assert.strictEqual(st.profileSource, 'builtin', 'le profil appris muet fait toujours foi');

    await h.call('POST', '/api/fm/live/disarm', { accountId: 50 });
    try { fs.unlinkSync(capFile); } catch {}
    try { fs.unlinkSync(profilePath); } catch {}
  });

  // Vécu le 12/08/2026 : un gabarit qui forgeait correctement depuis plusieurs
  // jets s'est fait écraser en plein run par un simple déplacement d'objet
  // (message « kcr », { quantité, identifiant }) que l'apprentissage a pris
  // pour une pose. Un profil dont le serveur accuse réception ne doit jamais
  // se faire remplacer — un profil cassé, lui, n'a pas cette preuve, donc le
  // rattrapage par pose manuelle continue de fonctionner.
  await test('protocole : un profil qui répond ne se fait pas écraser', async () => {
    const { h, sent, capFile } = liveHarness(51);
    const profilePath = path.join(os.homedir(), '.stakk', 'fm-protocol-51.json');
    try { fs.unlinkSync(profilePath); } catch {}

    await h.call('POST', '/api/fm/live/arm', { accountId: 51, itemId: 7340 });
    const tap = h.packetHandlers[0];
    tap(51, 'in', 6000, inventoryPkt([
      { uid: 200000000001, gid: 1523, qty: 30 },
      { uid: 200000000002, gid: 1548, qty: 20 },
      { uid: 200000000003, gid: 1554, qty: 20 },
    ]), null);
    tap(51, 'in', 6100, effectsPkt([{ id: 125, value: 81 }]), null);

    let value = 81, answered = 0;
    const answer = setInterval(() => {
      const pairs = Math.floor(sent.length / 2);
      if (pairs > answered) {
        answered = pairs;
        value += 15;
        tap(51, 'in', 6100, effectsPkt([{ id: 125, value }]), null);
      }
    }, 10);

    await h.call('POST', '/api/fm/start', {
      accountId: 51, itemId: 7340, transport: 'live',
      targets: { 125: [110, 110] }, delay: [0, 0],
    });
    // Dès qu'un jet a reçu réponse, le gabarit courant est prouvé.
    await waitFor(async () => sent.length >= 2 && answered >= 1, 8000);

    // Le joueur déplace une rune : paquet sortant portant un uid connu, suivi
    // d'une commande. C'est exactement la forme d'une pose — mais le gabarit
    // en place fonctionne, donc on n'y touche pas.
    tap(51, 'out', 3076, movePacket('zzz', 200000000003), null);
    tap(51, 'out', 2564, readyPacket('yyy'), null);

    const done = await waitFor(async () => {
      const r = await h.call('GET', '/api/fm/status', null, '/api/fm/status?accountId=51');
      return ['done', 'blocked', 'error', 'stopped'].includes(r.run.status) ? r.run : null;
    }, 15000);
    clearInterval(answer);

    // Le fichier existe : la preuve du gabarit s'y range. Ce qu'il ne doit pas
    // contenir, c'est le gabarit du déplacement d'objet.
    const surDisque = fs.existsSync(profilePath)
      ? JSON.parse(fs.readFileSync(profilePath, 'utf8')) : null;
    assert.notStrictEqual(surDisque && surDisque.codes && surDisque.codes.move, 'zzz',
      'un profil prouvé a été écrasé par un simple déplacement d\'objet');
    // Et la preuve a bien été écrite : c'est elle qui rendra la garde efficace
    // au prochain démarrage. Le gabarit ici est l'intégré, la preuve se range
    // donc à côté d'une copie de celui-ci, qui ne doit pas le masquer.
    assert.ok(surDisque && surDisque.provenTemplate,
      'aucune preuve persistée : la garde ne survivra pas au redémarrage');
    assert.strictEqual(surDisque.source, 'builtin',
      'la preuve posée sur l\'intégré s\'est déguisée en profil appris');
    assert.strictEqual(done.status, 'done', `statut=${done.status} err=${done.error}`);

    await h.call('POST', '/api/fm/live/disarm', { accountId: 51 });
    try { fs.unlinkSync(capFile); } catch {}
    try { fs.unlinkSync(profilePath); } catch {}
  });

  // Le format du fichier de profil est un contrat avec les installations déjà
  // en service : un utilisateur qui met STAKK à jour doit retrouver le gabarit
  // que sa forge utilisait la veille, sans repasser par une pose manuelle.
  await test('un profil au format du 12/08/2026 est relu sans conversion', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stakk-compat-'));
    // Copie fidèle d'un profil réellement appris en jeu.
    const reel = {
      version: 2, source: 'auto', codes: { move: 'kcj', ready: 'kqo' },
      move: {
        msgId: null,
        template: '30122e0a210a13747970652e616e6b616d612e636f6d2f6b636a120a08ed9ab2c50218013001'
          + '10ffffffffffffffffff01',
        uidOffset: 29, uidLength: 5, uidFieldNumber: 1, typeName: 'kcj',
        observedUids: [682397037],
      },
      ready: {
        msgId: null,
        packet: '2812260a190a13747970652e616e6b616d612e636f6d2f6b716f1202100110ffffffffffffffffff01',
        typeName: 'kqo', confidence: 'high',
      },
      createdAt: '2026-08-12T10:30:34.179Z',
    };
    fs.writeFileSync(path.join(dir, 'fm-protocol-11111111.json'), JSON.stringify(reel, null, 2));

    const store = require('../lib/protocol-learn')().createProfileStore({
      fs, path, dir, feature: 'fm', accountId: 11111111,
      builtin: () => null, isEquivalent: () => false, log: () => {},
    });
    const p = store.get();
    assert.strictEqual(p.codes.move, 'kcj');
    assert.strictEqual(p.move.uidOffset, 29);
    assert.strictEqual(p.move.uidLength, 5);
    assert.strictEqual(p.move.template, reel.move.template, 'gabarit altéré à la relecture');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // La preuve qu'un gabarit obtient des réponses vivait en mémoire : un
  // redémarrage de STAKK la perdait, et le premier paquet sortant portant un
  // uid connu réécrivait un profil pourtant valide. Elle est désormais rangée
  // à côté du profil, donc elle traverse le redémarrage.
  await test('la garde anti-écrasement survit au redémarrage', async () => {
    const profilePath = path.join(os.homedir(), '.stakk', 'fm-protocol-70.json');
    try { fs.unlinkSync(profilePath); } catch {}

    // Un profil appris est en place et il forge : on le déclare prouvé via le
    // store, comme le fait la boucle de run au premier jet qui obtient réponse.
    const store = require('../lib/protocol-learn')().createProfileStore({
      fs, path, dir: path.join(os.homedir(), '.stakk'), feature: 'fm', accountId: 70,
      builtin: () => null, isEquivalent: () => false, log: () => {},
    });
    const appris = {
      version: 2, source: 'auto', codes: { move: 'aaa', ready: 'bbb' },
      move: { template: movePacket('aaa', 200000000003).toString('hex'),
        uidOffset: 1, uidLength: 5, uidFieldNumber: 1, typeName: 'aaa', observedUids: [] },
      ready: { packet: readyPacket('bbb').toString('hex'), typeName: 'bbb', confidence: 'high' },
    };
    store.learn(appris);
    store.markProven();

    // Redémarrage : plugin neuf, aucune trace en mémoire de la preuve.
    const { h, capFile } = liveHarness(70);
    // Une pose de rune n'existe que dans l'atelier : sans observation armée, le
    // tap ne regarde même pas les paquets sortants.
    await h.call('POST', '/api/fm/live/arm', { accountId: 70, itemId: 7340 });
    const tap2 = h.packetHandlers[0];
    tap2(70, 'in', 6000, inventoryPkt([{ uid: 200000000003, gid: 1523, qty: 20 }]), null);
    tap2(70, 'out', 3076, movePacket('zzz', 200000000003), null);
    tap2(70, 'out', 2564, readyPacket('yyy'), null);

    const apres = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    assert.strictEqual(apres.codes.move, 'aaa',
      'la preuve n\'a pas survécu au redémarrage : le gabarit a été écrasé');

    await h.call('POST', '/api/fm/live/disarm', { accountId: 70 });
    try { fs.unlinkSync(capFile); } catch {}
    try { fs.unlinkSync(profilePath); } catch {}
    try { fs.unlinkSync(path.join(os.homedir(), '.stakk', 'fm-inventory-70.json')); } catch {}
  });

  // Le pendant de la garde : une preuve que les faits démentent doit pouvoir
  // être oubliée. Le cas dangereux est la série muette qui ne touche QU'UNE
  // rune (stock mono-rune, objectif à une seule ligne) : elle n'atteint jamais
  // la branche multi-runes, donc seule la remise à zéro en tête d'escalade
  // efface la preuve. Sans elle, une preuve périmée resterait sur disque, et
  // le redémarrage ne la lèverait plus.
  await test('protocole : une preuve démentie est oubliée avant même le repli', async () => {
    const { h, capFile } = liveHarness(71);
    const profilePath = path.join(os.homedir(), '.stakk', 'fm-protocol-71.json');
    // Preuve laissée par une version précédente de STAKK : elle porte sur un
    // gabarit intégré qui n'est plus celui d'aujourd'hui, donc elle ne protège
    // plus rien — mais elle traîne, et rien ne la retirait.
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    fs.writeFileSync(profilePath, JSON.stringify({
      ...proto.defaultProfile(), provenTemplate: 'ancien gabarit integre',
    }, null, 2));

    // Attente de réponse au plancher : la série muette coûte six délais pleins.
    await h.call('POST', '/api/fm/config', { tuning: { throwTimeoutMs: 500, graceMs: 0 } });
    await h.call('POST', '/api/fm/live/arm', { accountId: 71, itemId: 7340 });
    const tap = h.packetHandlers[0];
    // Trois piles de la MÊME rune : le transport en écarte une tous les trois
    // refus, il en faut donc plusieurs pour que la série atteigne la limite
    // sans jamais changer de rune. La troisième n'est jamais jouée — elle sert
    // d'ancre connue pour la pose manuelle d'après.
    tap(71, 'in', 6000, inventoryPkt([
      { uid: 200000000001, gid: 1523, qty: 30 },
      { uid: 200000000002, gid: 1523, qty: 30 },
      { uid: 200000000003, gid: 1523, qty: 30 },
    ]), null);
    tap(71, 'in', 6100, effectsPkt([{ id: 125, value: 81 }]), null);

    // Le serveur ne répond à rien : c'est ce que fait une MAJ Ankama.
    await h.call('POST', '/api/fm/start', {
      accountId: 71, itemId: 7340, transport: 'live',
      targets: { 125: [110, 110] }, delay: [0, 0],
    });
    const done = await waitFor(async () => {
      const r = await h.call('GET', '/api/fm/status', null, '/api/fm/status?accountId=71');
      return ['done', 'blocked', 'error', 'stopped'].includes(r.run.status) ? r.run : null;
    }, 30000);
    assert.strictEqual(done.status, 'blocked', `statut=${done.status} err=${done.error}`);

    const apres = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    assert.ok(!apres.provenTemplate,
      'la preuve a survécu à la série muette : elle bloquera la pose manuelle pour toujours');

    // Et le rattrapage par pose manuelle refonctionne : c'est tout l'intérêt
    // d'avoir oublié la preuve.
    tap(71, 'out', 3076, movePacket('zzz', 200000000003), null);
    tap(71, 'out', 2564, readyPacket('yyy'), null);
    const reappris = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    assert.strictEqual(reappris.codes.move, 'zzz',
      'le réapprentissage est resté verrouillé par une preuve démentie');

    await h.call('POST', '/api/fm/live/disarm', { accountId: 71 });
    try { fs.unlinkSync(capFile); } catch {}
    try { fs.unlinkSync(profilePath); } catch {}
    try { fs.unlinkSync(path.join(os.homedir(), '.stakk', 'fm-inventory-71.json')); } catch {}
  });

  // Les deux tests qui suivent sont les deux moitiés d'une même histoire : un
  // gabarit qui a répondu hier, et STAKK qu'on relance aujourd'hui. La preuve
  // se dédouble à dessein — persistée pour barrer l'apprentissage passif, de
  // session pour décider si un jet muet est un refus. Chacun vérifie une
  // moitié ; les confondre condamnerait le compte après une MAJ Ankama.
  function preuveDeLaVeille(accountId) {
    const profilePath = path.join(os.homedir(), '.stakk', `fm-protocol-${accountId}.json`);
    try { fs.unlinkSync(profilePath); } catch {}
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    // Session précédente : le gabarit intégré a obtenu des réponses du jeu, la
    // preuve s'est rangée à côté de lui.
    require('../lib/protocol-learn')().createProfileStore({
      fs, path, dir: path.join(os.homedir(), '.stakk'), feature: 'fm', accountId,
      builtin: () => proto.defaultProfile(), isEquivalent: () => false, log: () => {},
    }).markProven();
    return profilePath;
  }

  await test('protocole : la protection du gabarit prouvé traverse le redémarrage', async () => {
    const profilePath = preuveDeLaVeille(72);
    // Redémarrage : plugin neuf, aucune preuve en mémoire.
    const { h, capFile } = liveHarness(72);
    await h.call('POST', '/api/fm/live/arm', { accountId: 72, itemId: 7340 });
    const tap = h.packetHandlers[0];
    tap(72, 'in', 6000, inventoryPkt([{ uid: 200000000003, gid: 1523, qty: 20 }]), null);
    // Déplacement d'objet : la forme d'une pose, mais le gabarit en place a
    // fait ses preuves hier. La preuve PERSISTÉE doit encore le protéger.
    tap(72, 'out', 3076, movePacket('zzz', 200000000003), null);
    tap(72, 'out', 2564, readyPacket('yyy'), null);

    const apres = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    assert.strictEqual(apres.source, 'builtin',
      'le gabarit prouvé a été écrasé après un redémarrage');
    assert.notStrictEqual(apres.codes.move, 'zzz',
      'le gabarit prouvé a été écrasé par un simple déplacement en inventaire');
    assert.ok(apres.provenTemplate, 'la preuve persistée a disparu du fichier');
    // La ligne qui explique le refus doit NOMMER le gabarit qui l'emporte :
    // c'est la seule chose qui dise à l'utilisateur pourquoi sa pose manuelle
    // n'a rien changé. « le gabarit en place obtient des réponses » tout court
    // ne lui apprend rien qu'il puisse recouper.
    const refus = h.logs.find(l => l.includes('ignoré'));
    assert.ok(refus, 'le paquet écarté n\'est pas journalisé');
    assert.ok(refus.includes(`(${apres.codes.move})`),
      `le gabarit qui l'emporte n'est pas nommé : ${refus}`);

    await h.call('POST', '/api/fm/live/disarm', { accountId: 72 });
    try { fs.unlinkSync(capFile); } catch {}
    try { fs.unlinkSync(profilePath); } catch {}
    try { fs.unlinkSync(path.join(os.homedir(), '.stakk', 'fm-inventory-72.json')); } catch {}
  });

  // L'autre moitié, et la plus importante : la porte de sortie. Sur un gabarit
  // réputé prouvé, fm-live lit un jet muet comme un échec de forgemagie
  // ordinaire — jamais comme un refus — donc la série ne monte pas et STAKK ne
  // dit jamais « protocole périmé ». Si la preuve qui commande ça survivait au
  // redémarrage, une MAJ Ankama condamnerait le compte : le run tournerait
  // dans le vide pour toujours. Elle doit donc être lavée au démarrage.
  await test('protocole : après un redémarrage, un jet muet redevient un refus', async () => {
    const profilePath = preuveDeLaVeille(73);
    const { h, capFile } = liveHarness(73);
    // Attente de réponse au plancher : sinon chaque jet muet coûte 2 s.
    await h.call('POST', '/api/fm/config', { tuning: { throwTimeoutMs: 500, graceMs: 0 } });
    await h.call('POST', '/api/fm/live/arm', { accountId: 73, itemId: 7340 });
    const tap = h.packetHandlers[0];
    tap(73, 'in', 6000, inventoryPkt([
      { uid: 200000000001, gid: 1523, qty: 30 },
      { uid: 200000000002, gid: 1523, qty: 30 },
    ]), null);
    tap(73, 'in', 6100, effectsPkt([{ id: 125, value: 81 }]), null);

    // Le serveur ne répond plus à rien : c'est ce que fait une MAJ Ankama.
    await h.call('POST', '/api/fm/start', {
      accountId: 73, itemId: 7340, transport: 'live',
      targets: { 125: [110, 110] }, delay: [0, 0],
    });
    let refuse = false;
    try {
      await waitFor(async () => {
        const r = await h.call('GET', '/api/fm/status', null, '/api/fm/status?accountId=73');
        return (r.run.history || []).some(x => x.rejected);
      }, 12000);
      refuse = true;
    } catch { /* le message d'échec est celui de l'assertion ci-dessous */ }
    assert.ok(refuse,
      'un jet muet reste compté comme un échec de forgemagie : le run ne se débloquera jamais');

    await h.call('POST', '/api/fm/stop', { accountId: 73 });
    await h.call('POST', '/api/fm/live/disarm', { accountId: 73 });
    try { fs.unlinkSync(capFile); } catch {}
    try { fs.unlinkSync(profilePath); } catch {}
    try { fs.unlinkSync(path.join(os.homedir(), '.stakk', 'fm-inventory-73.json')); } catch {}
  });

  // Le bouton « oublier le profil » de l'interface est le dernier recours quand
  // plus rien ne marche. Effacer le fichier emporte la preuve PERSISTÉE, mais
  // pas celle de session — et si le profil résolu après effacement porte le même
  // gabarit (le cas normal : la preuve était posée sur l'intégré), elle tient
  // toujours. Les jets muets restent alors lus comme des échecs de forgemagie
  // ordinaires et le run n'escalade jamais : le bouton n'aurait rien débloqué.
  await test('reset : le bouton de dernier recours rend aussi la preuve de session', async () => {
    const { h, sent, capFile } = liveHarness(74);
    const profilePath = path.join(os.homedir(), '.stakk', 'fm-protocol-74.json');
    try { fs.unlinkSync(profilePath); } catch {}
    await h.call('POST', '/api/fm/config', { tuning: { throwTimeoutMs: 500, graceMs: 0 } });
    await h.call('POST', '/api/fm/live/arm', { accountId: 74, itemId: 7340 });
    const tap = h.packetHandlers[0];
    tap(74, 'in', 6000, inventoryPkt([
      { uid: 200000000001, gid: 1523, qty: 30 },
      { uid: 200000000002, gid: 1523, qty: 30 },
      { uid: 200000000003, gid: 1523, qty: 30 },
    ]), null);
    tap(74, 'in', 6100, effectsPkt([{ id: 125, value: 81 }]), null);

    // Premier run : le serveur répond. Le gabarit intégré gagne sa preuve, sur
    // disque ET en session.
    let seen = 0;
    const answer = setInterval(() => {
      const pairs = Math.floor(sent.length / 2);
      if (pairs > seen) { seen = pairs; tap(74, 'in', 6100, effectsPkt([{ id: 125, value: 81 }]), null); }
    }, 10);
    await h.call('POST', '/api/fm/start', {
      accountId: 74, itemId: 7340, transport: 'live',
      targets: { 125: [110, 110] }, delay: [0, 0],
    });
    await waitFor(async () => {
      const r = await h.call('GET', '/api/fm/status', null, '/api/fm/status?accountId=74');
      return (r.run.history || []).length >= 1;
    }, 12000);
    clearInterval(answer);
    await h.call('POST', '/api/fm/stop', { accountId: 74 });
    assert.ok(JSON.parse(fs.readFileSync(profilePath, 'utf8')).provenTemplate,
      'préalable : le run en mode Jeu n\'a pas posé de preuve');

    // L'utilisateur appuie sur « oublier le profil ».
    await h.call('POST', '/api/fm/calibrate/reset', { accountId: 74 });

    // Second run, serveur muet : l'escalade doit repartir de zéro. Un seul jet
    // compté comme refus suffit à le prouver — sous preuve de session, fm-live
    // n'en marque jamais aucun.
    await h.call('POST', '/api/fm/start', {
      accountId: 74, itemId: 7340, transport: 'live',
      targets: { 125: [110, 110] }, delay: [0, 0],
    });
    let refuse = false;
    try {
      await waitFor(async () => {
        const r = await h.call('GET', '/api/fm/status', null, '/api/fm/status?accountId=74');
        return (r.run.history || []).some(x => x.rejected);
      }, 12000);
      refuse = true;
    } catch { /* le message d'échec est celui de l'assertion ci-dessous */ }
    assert.ok(refuse,
      'la preuve de session a survécu au reset : le bouton de dernier recours ne débloque rien');

    await h.call('POST', '/api/fm/stop', { accountId: 74 });
    await h.call('POST', '/api/fm/live/disarm', { accountId: 74 });
    try { fs.unlinkSync(capFile); } catch {}
    try { fs.unlinkSync(profilePath); } catch {}
    try { fs.unlinkSync(path.join(os.homedir(), '.stakk', 'fm-inventory-74.json')); } catch {}
  });

  // La preuve ne s'accorde qu'en mode Jeu. Ni la simulation ni l'essai à blanc
  // n'envoient un octet : leur « réponse » est fabriquée par STAKK lui-même, et
  // depuis que la preuve vit sur disque, l'accorder à un run simulé
  // verrouillerait le gabarit bien au-delà de la session — jusqu'à la remise à
  // zéro manuelle du profil. Rien dans la boucle n'empêche cette restriction de
  // se rouvrir : ce test est ce qui la ferme.
  await test('protocole : un run simulé n\'accorde aucune preuve de gabarit', async () => {
    const profilePath = path.join(os.homedir(), '.stakk', 'fm-protocol-75.json');
    try { fs.unlinkSync(profilePath); } catch {}
    const { call } = makeHarness();
    await call('POST', '/api/fm/start', {
      accountId: 75, itemId: 7340,
      targets: { 118: [10, 10], 125: [110, 110] }, delay: [0, 0],
    });
    const done = await waitFor(async () => {
      const r = await call('GET', '/api/fm/status', null, '/api/fm/status?accountId=75');
      return ['done', 'blocked', 'error'].includes(r.run.status) ? r.run : null;
    });
    assert.strictEqual(done.status, 'done', `statut=${done.status} err=${done.error}`);
    assert.ok(done.thrown > 0, 'préalable : aucun jet, donc aucune occasion de poser une preuve');
    const surDisque = fs.existsSync(profilePath)
      ? JSON.parse(fs.readFileSync(profilePath, 'utf8')) : null;
    assert.ok(!surDisque || !surDisque.provenTemplate,
      'un run simulé a posé une preuve persistante : le gabarit est verrouillé hors session');
    try { fs.unlinkSync(profilePath); } catch {}
  });

  // ─── Socle protocol-learn : dégradation ──────────────────────────────────
  //
  // Les deux chemins d'un exe trop ancien pour connaître protocol-learn. Ni
  // l'un ni l'autre ne doit laisser remonter d'exception : hot-modules appelle
  // les factories de plugins à la suite, une seule qui lève emporte les autres.

  function bareDeps(over) {
    return Object.assign({
      fs, path, os, https: require('https'),
      on: () => {}, loadConfig: () => ({}), saveConfig: () => {},
      setPacketHandler: () => true, getGameChannel: () => null, DATA_DIR: os.tmpdir(),
      createFmData: fakeFmData(), createFmEngine,
    }, over);
  }

  await test('socle absent : le plugin se désactive proprement, sans lever', () => {
    const routes = {};
    const logs = [];
    let api;
    // `null` explicite = l'exe SAIT qu'il ne l'a pas : le require de repli est
    // coupé, comme il l'est de fait en hot où fm.js vit seul dans son dossier.
    assert.doesNotThrow(() => {
      api = createFm(bareDeps({
        log: l => logs.push(String(l)),
        registerRoute: (m, p, h) => { routes[`${m} ${p}`] = h; },
        createProtocolLearn: null,
      }));
    }, 'la factory a levé : le chargement des autres plugins serait emporté');
    assert.deepStrictEqual(api, {}, 'le plugin s\'est installé sans son socle');
    assert.strictEqual(Object.keys(routes).length, 0, 'des routes ont été enregistrées sans socle');
    assert.ok(logs.some(l => l.includes('protocol-learn')),
      'désactivation muette : l\'utilisateur verrait un onglet vide sans explication');
  });

  await test('socle absent : fm-protocol lève, fm absorbe et ne perd que le mode Jeu', async () => {
    const routes = {};
    const logs = [];
    let api;
    assert.doesNotThrow(() => {
      api = createFm(bareDeps({
        log: l => logs.push(String(l)),
        registerRoute: (m, p, h) => { routes[`${m} ${p}`] = h; },
        // Le socle est là pour fm.js, mais pas pour fm-protocol : c'est le vrai
        // lever de fm-protocol qu'on fait passer ici, pas une imitation.
        createProtocolLearn: require('../lib/protocol-learn'),
        createFmProtocol: d => require('../lib/fm-protocol')({ ...d, createProtocolLearn: null }),
      }));
    }, 'le lever de fm-protocol a emporté toute la factory');
    assert.notDeepStrictEqual(api, {}, 'l\'onglet entier est tombé avec fm-protocol');
    assert.ok(routes['GET /api/fm/tables'], 'les routes de l\'onglet ont disparu');
    assert.ok(logs.some(l => l.includes('fm-protocol indisponible')),
      'la perte du mode Jeu n\'est pas journalisée');
    // Le reste marche : c'est bien une dégradation, pas une panne.
    const call = (method, p, body, url) => routes[`${method} ${p}`](body, { url: url || p });
    assert.ok((await call('GET', '/api/fm/tables')).runes);
    await assert.rejects(
      () => call('POST', '/api/fm/live/arm', { accountId: 76, itemId: 7340 }),
      'le mode Jeu s\'est armé sans fm-protocol');
  });

  // Le plan est fige au demarrage : changer un plafond en cours de run n avait
  // aucun effet. Ici seul le plafond interdit le palier superieur, donc le
  // changement se lit directement dans la rune choisie au jet suivant.
  await test('retarget : un plafond releve change le palier au jet suivant', async () => {
    const { h, sent, capFile } = liveHarness(52);
    await h.call('POST', '/api/fm/live/arm', { accountId: 52, itemId: 7340 });
    const tap = h.packetHandlers[0];
    tap(52, 'in', 6000, inventoryPkt([
      { uid: 200000000001, gid: 1523, qty: 30 },   // Rune Vi    +5
      { uid: 200000000002, gid: 1548, qty: 30 },   // Rune Pa Vi +15
      { uid: 200000000003, gid: 1554, qty: 30 },   // Rune Ra Vi +50
    ]), null);
    tap(52, 'in', 6100, effectsPkt([{ id: 125, value: 81 }]), null);

    // Le serveur repond a chaque jet SANS rien changer : ce sont des echecs de
    // forgemagie ordinaires, donc le run continue indefiniment.
    let seen = 0;
    const answer = setInterval(() => {
      const pairs = Math.floor(sent.length / 2);
      if (pairs > seen) { seen = pairs; tap(52, 'in', 6100, effectsPkt([{ id: 125, value: 81 }]), null); }
    }, 10);

    // Objectif 85, plafond 85 : a 81, seule la Rune Vi passe (86 depasse, mais
    // c est le palier le plus fin, qui beneficie de l exception).
    await h.call('POST', '/api/fm/start', {
      accountId: 52, itemId: 7340, transport: 'live',
      targets: { 125: [85, 85] }, delay: [0, 0],
    });
    await waitFor(async () => {
      const r = await h.call('GET', '/api/fm/status', null, '/api/fm/status?accountId=52');
      return (r.run.history || []).length >= 2 ? r.run : null;
    }, 8000);
    const before = await h.call('GET', '/api/fm/status', null, '/api/fm/status?accountId=52');
    assert.ok((before.run.history || []).every(x => x.runeGid === 1523),
      'un autre palier que la Rune Vi a ete joue avant le retarget');

    // Plafond porte a 100 : la Rune Pa Vi (81+15=96) devient jouable.
    const res = await h.call('POST', '/api/fm/retarget', {
      accountId: 52, targets: { 125: [85, 100] }, thresholds: {},
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.resumed, false, 'un run actif ne doit pas etre relance');

    const switched = await waitFor(async () => {
      const r = await h.call('GET', '/api/fm/status', null, '/api/fm/status?accountId=52');
      return (r.run.history || []).some(x => x.runeGid === 1548) ? r.run : null;
    }, 8000);
    clearInterval(answer);
    assert.ok(switched, 'le palier superieur n a jamais ete joue apres le retarget');

    await h.call('POST', '/api/fm/stop', { accountId: 52 });
    await h.call('POST', '/api/fm/live/disarm', { accountId: 52 });
    try { fs.unlinkSync(capFile); } catch {}
    try { fs.unlinkSync(path.join(os.homedir(), '.stakk', 'fm-protocol-52.json')); } catch {}
  });

  // Un plan sans aucune cible ferait passer le run pour termine. On refuse, et
  // surtout on garde le plan precedent : un run ne doit jamais se retrouver
  // avec un plan a moitie applique.
  await test('retarget : un reglage sans cible est refuse, le plan est conserve', async () => {
    const { h, sent, capFile } = liveHarness(53);
    await h.call('POST', '/api/fm/live/arm', { accountId: 53, itemId: 7340 });
    const tap = h.packetHandlers[0];
    tap(53, 'in', 6000, inventoryPkt([{ uid: 200000000001, gid: 1523, qty: 30 }]), null);
    tap(53, 'in', 6100, effectsPkt([{ id: 125, value: 81 }]), null);

    let seen = 0;
    const answer = setInterval(() => {
      const pairs = Math.floor(sent.length / 2);
      if (pairs > seen) { seen = pairs; tap(53, 'in', 6100, effectsPkt([{ id: 125, value: 81 }]), null); }
    }, 10);

    await h.call('POST', '/api/fm/start', {
      accountId: 53, itemId: 7340, transport: 'live',
      targets: { 125: [110, 110] }, delay: [0, 0],
    });
    await waitFor(async () => {
      const r = await h.call('GET', '/api/fm/status', null, '/api/fm/status?accountId=53');
      return (r.run.history || []).length >= 1;
    }, 8000);

    const res = await h.call('POST', '/api/fm/retarget', { accountId: 53, targets: {}, thresholds: {} });
    assert.strictEqual(res.ok, false, 'un plan sans cible a ete accepte');

    const after = await h.call('GET', '/api/fm/status', null, '/api/fm/status?accountId=53');
    assert.strictEqual(after.run.status, 'running', 'le run a ete casse par un reglage refuse');
    assert.strictEqual((after.run.targets || []).length, 1, 'le plan precedent a ete perdu');
    assert.strictEqual(after.run.targets[0].goal, 110);
    clearInterval(answer);

    await h.call('POST', '/api/fm/stop', { accountId: 53 });
    await h.call('POST', '/api/fm/live/disarm', { accountId: 53 });
    try { fs.unlinkSync(capFile); } catch {}
    try { fs.unlinkSync(path.join(os.homedir(), '.stakk', 'fm-protocol-53.json')); } catch {}
  });

  await test('retarget : refuse sur un run arrete', async () => {
    const { h, capFile } = liveHarness(54);
    // Nettoyage AVANT armement, pas seulement après : si ce test échoue avant
    // d'atteindre son propre nettoyage final, le miroir d'inventaire d'une
    // exécution précédente survivrait et fausserait ce test-ci comme le test
    // « all en jeu » qui réutilise ce compte plus loin dans le fichier.
    try { fs.unlinkSync(path.join(os.homedir(), '.stakk', 'fm-inventory-54.json')); } catch {}
    try { fs.unlinkSync(path.join(os.homedir(), '.stakk', 'fm-protocol-54.json')); } catch {}
    await h.call('POST', '/api/fm/live/arm', { accountId: 54, itemId: 7340 });
    const tap = h.packetHandlers[0];
    tap(54, 'in', 6000, inventoryPkt([{ uid: 200000000001, gid: 1523, qty: 30 }]), null);
    tap(54, 'in', 6100, effectsPkt([{ id: 125, value: 81 }]), null);

    await h.call('POST', '/api/fm/start', {
      accountId: 54, itemId: 7340, transport: 'live',
      targets: { 125: [110, 110] }, delay: [0, 0],
    });
    await h.call('POST', '/api/fm/stop', { accountId: 54 });

    const res = await h.call('POST', '/api/fm/retarget', {
      accountId: 54, targets: { 125: [110, 140] }, thresholds: {},
    });
    assert.strictEqual(res.ok, false, 'un run arrete a accepte un retarget');
    assert.ok(res.reason, 'aucune raison renvoyee');

    await h.call('POST', '/api/fm/live/disarm', { accountId: 54 });
    try { fs.unlinkSync(capFile); } catch {}
    try { fs.unlinkSync(path.join(os.homedir(), '.stakk', 'fm-protocol-54.json')); } catch {}
    // Le compte 54 est réutilisé par un test « all en jeu » plus loin dans le
    // fichier : sans ce nettoyage, le miroir d'inventaire persisté ici (avec
    // l'objet fictif posé dans l'atelier) fausserait son comptage d'exemplaires.
    try { fs.unlinkSync(path.join(os.homedir(), '.stakk', 'fm-inventory-54.json')); } catch {}
  });

  // Cas vecu : run arrete sur « plus de rune jetable » parce que le plafond
  // interdit le seul palier en stock. Monter le plafond doit le faire repartir
  // sans que l utilisateur ait a relancer quoi que ce soit.
  await test('retarget : un run bloque repart quand le reglage le debloque', async () => {
    const { h, sent, capFile } = liveHarness(55);
    // Le compte 55 est aussi arme en direct par un autre test plus loin dans
    // le fichier, avec un tout autre stock (rune Vi + exemplaires de l'item).
    // `live/arm` recharge le miroir d'inventaire persiste sur disque AVANT
    // notre propre tap : un residu d'une execution precedente (interrompue ou
    // non) rendrait jouable une rune qui ne doit pas l'etre ici, et le test
    // ne bloquerait jamais. On repart d'une ardoise propre, comme le fait le
    // test « protocole : un paquet sortant sans uid connu n'apprend rien »
    // pour son propre profil.
    try { fs.unlinkSync(path.join(os.homedir(), '.stakk', 'fm-inventory-55.json')); } catch {}
    try { fs.unlinkSync(path.join(os.homedir(), '.stakk', 'fm-protocol-55.json')); } catch {}
    await h.call('POST', '/api/fm/live/arm', { accountId: 55, itemId: 7340 });
    const tap = h.packetHandlers[0];
    // Uniquement de la Rune Ra Vi (+50) : a 81, elle donne 131, hors plafond.
    tap(55, 'in', 6000, inventoryPkt([{ uid: 200000000003, gid: 1554, qty: 30 }]), null);
    tap(55, 'in', 6100, effectsPkt([{ id: 125, value: 81 }]), null);

    let value = 81, seen = 0;
    const answer = setInterval(() => {
      const pairs = Math.floor(sent.length / 2);
      if (pairs > seen) { seen = pairs; value += 50; tap(55, 'in', 6100, effectsPkt([{ id: 125, value }]), null); }
    }, 10);

    await h.call('POST', '/api/fm/start', {
      accountId: 55, itemId: 7340, transport: 'live',
      targets: { 125: [110, 110] }, delay: [0, 0],
    });
    const blocked = await waitFor(async () => {
      const r = await h.call('GET', '/api/fm/status', null, '/api/fm/status?accountId=55');
      return r.run.status === 'blocked' ? r.run : null;
    }, 8000);
    assert.strictEqual(sent.length, 0, 'des paquets sont partis alors que rien n etait jouable');
    assert.ok(blocked.error, 'aucune raison de blocage');

    const res = await h.call('POST', '/api/fm/retarget', {
      accountId: 55, targets: { 125: [110, 140] }, thresholds: {},
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.resumed, true, 'le run bloque n a pas ete relance');

    const done = await waitFor(async () => {
      const r = await h.call('GET', '/api/fm/status', null, '/api/fm/status?accountId=55');
      return ['done', 'blocked', 'error', 'stopped'].includes(r.run.status) ? r.run : null;
    }, 10000);
    clearInterval(answer);
    assert.strictEqual(done.status, 'done', `statut=${done.status} err=${done.error}`);
    assert.ok(sent.length >= 2, 'la reprise n a envoye aucun paquet');

    await h.call('POST', '/api/fm/live/disarm', { accountId: 55 });
    try { fs.unlinkSync(capFile); } catch {}
    try { fs.unlinkSync(path.join(os.homedir(), '.stakk', 'fm-protocol-55.json')); } catch {}
    // Le compte 55 est réutilisé par un test « all » plus loin dans le
    // fichier : sans ce nettoyage, le miroir d'inventaire persisté ici (avec
    // la Rune Ra Vi posée dans l'atelier) fausserait son comptage de piles.
    try { fs.unlinkSync(path.join(os.homedir(), '.stakk', 'fm-inventory-55.json')); } catch {}
  });

  // Le test précédent bloque AVANT le moindre jet (thrown=0 au blocage) : le
  // mécanisme le plus délicat de la reprise — le `-=` qui évite un double
  // comptage dans totalThrown, et la préservation de `thrown` au lieu de sa
  // remise à zéro — n'y est donc jamais exercé. Ici le run jette réellement
  // deux runes avant de se bloquer, pour que la comptabilité de reprise soit
  // mise à l'épreuve pour de vrai.
  await test('retarget : thrown et totalThrown restent exacts a travers une reprise', async () => {
    const { h, sent, capFile } = liveHarness(60);
    // Même précaution que pour les comptes 54/55 : ardoise propre avant
    // d'armer, pas seulement nettoyée en fin de test.
    try { fs.unlinkSync(path.join(os.homedir(), '.stakk', 'fm-inventory-60.json')); } catch {}
    try { fs.unlinkSync(path.join(os.homedir(), '.stakk', 'fm-protocol-60.json')); } catch {}
    await h.call('POST', '/api/fm/live/arm', { accountId: 60, itemId: 7340 });
    const tap = h.packetHandlers[0];
    // Deux piles de Rune Vi (+5) seulement : exactement deux jets réussis
    // possibles avant que le plafond (92) n'écarte tout le reste — la Rune Ra
    // Vi (+50) le dépasse toujours, et Vi est alors épuisée. La Rune Ra Vi
    // est en stock abondant, réservée à l'après-reprise.
    tap(60, 'in', 6000, inventoryPkt([
      { uid: 200000000001, gid: 1523, qty: 2 },
      { uid: 200000000002, gid: 1554, qty: 30 },
    ]), null);
    tap(60, 'in', 6100, effectsPkt([{ id: 125, value: 81 }]), null);

    // Le serveur répond à chaque jet avec la valeur qu'aurait produite un jet
    // réussi de la rune attendue à ce stade : deux Rune Vi (+5), puis — après
    // la reprise — une Rune Ra Vi (+50) qui atteint l'objectif.
    const values = [86, 91, 141];
    let seen = 0;
    const answer = setInterval(() => {
      const pairs = Math.floor(sent.length / 2);
      if (pairs > seen && pairs <= values.length) {
        seen = pairs;
        tap(60, 'in', 6100, effectsPkt([{ id: 125, value: values[pairs - 1] }]), null);
      }
    }, 10);

    await h.call('POST', '/api/fm/start', {
      accountId: 60, itemId: 7340, transport: 'live',
      targets: { 125: [110, 92] }, delay: [0, 0],
    });
    const blocked = await waitFor(async () => {
      const r = await h.call('GET', '/api/fm/status', null, '/api/fm/status?accountId=60');
      return r.run.status === 'blocked' ? r.run : null;
    }, 8000);
    assert.strictEqual(blocked.thrown, 2, `deux jets auraient du partir avant le blocage, thrown=${blocked.thrown}`);
    assert.strictEqual(blocked.totalThrown, 2, `totalThrown desynchronise avant meme la reprise (${blocked.totalThrown})`);

    // Plafond porté à 200 : la Rune Ra Vi (91+50=141) devient jouable.
    const res = await h.call('POST', '/api/fm/retarget', {
      accountId: 60, targets: { 125: [110, 200] }, thresholds: {},
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.resumed, true, 'le run bloque n a pas ete relance');

    const done = await waitFor(async () => {
      const r = await h.call('GET', '/api/fm/status', null, '/api/fm/status?accountId=60');
      return ['done', 'blocked', 'error', 'stopped'].includes(r.run.status) ? r.run : null;
    }, 10000);
    clearInterval(answer);
    assert.strictEqual(done.status, 'done', `statut=${done.status} err=${done.error}`);

    // Le coeur du mécanisme : sur un run mono-exemplaire, thrown et
    // totalThrown couvrent exactement les mêmes jets et doivent donc être
    // identiques — trois jets au total, deux avant blocage et un après
    // reprise. Un double comptage (le `-=` de la route disparu) désynchronise
    // les deux champs ; une remise à zéro de `thrown` en reprise (au lieu de
    // le préserver) les ferait retomber ensemble, mais en-dessous du compte
    // réel — d'où la première assertion, sur la valeur exacte.
    assert.strictEqual(done.thrown, 3, `thrown attendu 3 (2 avant blocage + 1 apres reprise), obtenu ${done.thrown}`);
    assert.strictEqual(done.totalThrown, done.thrown,
      `totalThrown (${done.totalThrown}) desynchronise de thrown (${done.thrown})`);

    await h.call('POST', '/api/fm/stop', { accountId: 60 });
    await h.call('POST', '/api/fm/live/disarm', { accountId: 60 });
    try { fs.unlinkSync(capFile); } catch {}
    try { fs.unlinkSync(path.join(os.homedir(), '.stakk', 'fm-protocol-60.json')); } catch {}
    try { fs.unlinkSync(path.join(os.homedir(), '.stakk', 'fm-inventory-60.json')); } catch {}
  });

  await test('protocole : un paquet sortant sans uid connu n\'apprend rien', async () => {
    const { h, capFile } = liveHarness(46);
    const profilePath = path.join(os.homedir(), '.stakk', 'fm-protocol-46.json');
    try { fs.unlinkSync(profilePath); } catch {}

    await h.call('POST', '/api/fm/live/arm', { accountId: 46, itemId: 7340 });
    const tap = h.packetHandlers[0];
    tap(46, 'in', 6000, inventoryPkt([{ uid: 200000000001, gid: 1523, qty: 30 }]), null);
    // uid absent de l'inventaire : c'est une autre commande de jeu.
    tap(46, 'out', 3076, movePacket('zzz', 999999999), null);
    tap(46, 'out', 2564, readyPacket('yyy'), null);

    assert.strictEqual(fs.existsSync(profilePath), false, 'aucun profil ne doit être écrit');
    try { fs.unlinkSync(capFile); } catch {}
  });

  await test('live : observation via le tap puis run complet qui envoie les paquets', async () => {
    const { h, sent, capFile } = liveHarness(44);
    await h.call('POST', '/api/fm/calibrate', { accountId: 44 });
    await h.call('POST', '/api/fm/live/arm', { accountId: 44, itemId: 7340 });

    // Le proxy pousse l'inventaire et les stats de l'item.
    const tap = h.packetHandlers[0];
    tap(44, 'in', 6000, inventoryPkt([
      { uid: 200000000001, gid: 1523, qty: 30 },   // Rune Vi  (+5)
      { uid: 200000000002, gid: 1548, qty: 20 },   // Rune Pa Vi (+15)
      { uid: 200000000003, gid: 1554, qty: 5 },    // Rune Ra Vi (+50)
    ]), null);
    tap(44, 'in', 6100, effectsPkt([{ id: 125, value: 81 }]), null);

    const st = await h.call('GET', '/api/fm/live/status', null, '/api/fm/live/status?accountId=44');
    assert.strictEqual(st.ready, true);
    // 118 à 0 : la Force n'est pas dans le message, donc la ligne n'existe
    // pas sur l'item — c'est une information, pas une valeur manquante.
    assert.deepStrictEqual(st.stats, { 125: 81, 118: 0 });
    assert.strictEqual(st.stock['1548'], 20);

    // Simule le serveur : chaque paire pose+forge fait monter la vitalité.
    // On réagit au NOMBRE de paires envoyées pour ne répondre qu'une fois par
    // jet, comme le vrai serveur.
    let value = 81, answered = 0;
    const answer = setInterval(() => {
      const pairs = Math.floor(sent.length / 2);
      if (pairs > answered) {
        answered = pairs;
        value += 15;
        tap(44, 'in', 6100, effectsPkt([{ id: 125, value }]), null);
      }
    }, 10);

    await h.call('POST', '/api/fm/start', {
      accountId: 44, itemId: 7340, transport: 'live',
      targets: { 125: [110, 110] }, delay: [0, 0],
    });
    const done = await waitFor(async () => {
      const r = await h.call('GET', '/api/fm/status', null, '/api/fm/status?accountId=44');
      return ['done', 'blocked', 'error', 'stopped'].includes(r.run.status) ? r.run : null;
    }, 8000);
    clearInterval(answer);

    assert.strictEqual(done.status, 'done', `statut=${done.status} err=${done.error}`);
    assert.ok(done.stats[125] >= 110, `vita=${done.stats[125]}`);
    assert.ok(sent.length >= 2, 'aucun paquet envoyé');
    assert.strictEqual(sent.length % 2, 0, 'pose sans forge (ou l\'inverse)');
    // Les paquets de pose portent bien l'uid observé, sur la longueur du gabarit.
    const profile = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.stakk', 'fm-protocol-44.json'), 'utf8'));
    const tplLen = Buffer.from(profile.move.template, 'hex').length;
    assert.strictEqual(sent[0].length, tplLen);
    assert.strictEqual(sent[1].toString('hex'), profile.ready.packet);

    await h.call('POST', '/api/fm/live/disarm', { accountId: 44 });
    fs.unlinkSync(capFile);
    fs.unlinkSync(path.join(os.homedir(), '.stakk', 'fm-protocol-44.json'));
  });

  // Mise à jour de quantité : { identifiant, nouvelle quantité }, sans gid.
  // À zéro, la pile sort du miroir.
  const qtyPkt = (uid, qty) => frame(Buffer.concat([
    lenF(1, Buffer.from('type.ankama.com/qty')),
    lenF(3, Buffer.concat([varF(1, uid), varF(2, qty)]))]));

  // Vécu en production : la pile choisie disparaît (consommée, fusionnée,
  // déplacée) entre deux jets. L'uid étant re-résolu à l'envoi, plus rien ne
  // part — mais le run mourait alors sur « jet impossible », une erreur
  // technique pour ce qui n'est qu'une rupture de stock.
  await test('live : une pile disparue du miroir ne coupe plus le run sur une erreur technique', async () => {
    const { h, sent, capFile } = liveHarness(48);
    await h.call('POST', '/api/fm/calibrate', { accountId: 48 });
    await h.call('POST', '/api/fm/live/arm', { accountId: 48, itemId: 7340 });

    const tap = h.packetHandlers[0];
    // Une seule pile de Rune Pa Vi : c'est le seul palier jouable.
    tap(48, 'in', 6000, inventoryPkt([{ uid: 200000000002, gid: 1548, qty: 20 }]), null);
    tap(48, 'in', 6100, effectsPkt([{ id: 125, value: 81 }]), null);

    // Le serveur répond au premier jet… et annonce dans la foulée que la pile
    // est vide. Les jets suivants n'ont donc plus aucun identifiant à jouer.
    let value = 81, answered = 0;
    const answer = setInterval(() => {
      const pairs = Math.floor(sent.length / 2);
      if (pairs <= answered) return;
      answered = pairs;
      value += 15;
      tap(48, 'in', 6100, effectsPkt([{ id: 125, value }]), null);
      tap(48, 'in', 6200, qtyPkt(200000000002, 0), null);
    }, 10);

    await h.call('POST', '/api/fm/start', {
      accountId: 48, itemId: 7340, transport: 'live',
      targets: { 125: [130, 130] }, delay: [0, 0],
    });
    const done = await waitFor(async () => {
      const r = await h.call('GET', '/api/fm/status', null, '/api/fm/status?accountId=48');
      return ['done', 'blocked', 'error', 'stopped'].includes(r.run.status) ? r.run : null;
    }, 8000);
    clearInterval(answer);

    assert.strictEqual(done.status, 'blocked', `statut=${done.status} err=${done.error}`);
    assert.match(done.error, /plus de rune jetable/, 'message d\'absence de rune attendu');
    assert.strictEqual(sent.length, 2, 'un identifiant disparu du miroir a été rejoué');

    await h.call('POST', '/api/fm/live/disarm', { accountId: 48 });
    fs.unlinkSync(capFile);
    fs.unlinkSync(path.join(os.homedir(), '.stakk', 'fm-protocol-48.json'));
  });

  // Le garde-fou concluait « le format d'échange a changé » après six jets sans
  // réponse, même quand ils portaient tous sur la MÊME rune : ses piles étaient
  // mortes, le gabarit n'y était pour rien, et aucune autre rune n'avait été
  // essayée. Ce message a coûté une soirée de forge.
  await test('live : six jets muets sur une seule rune n\'accusent pas le protocole', async () => {
    const { h, sent, capFile } = liveHarness(49);
    await h.call('POST', '/api/fm/calibrate', { accountId: 49 });
    // Cadence serrée : six jets sans réponse, on n'attend pas 12 secondes.
    await h.call('POST', '/api/fm/config', { tuning: { throwTimeoutMs: 500, graceMs: 0, readyDelayMs: 0 } });
    await h.call('POST', '/api/fm/live/arm', { accountId: 49, itemId: 7340 });

    const tap = h.packetHandlers[0];
    // Deux piles de la même rune : trois refus chacune, six en tout.
    tap(49, 'in', 6000, inventoryPkt([
      { uid: 200000000002, gid: 1548, qty: 20 },
      { uid: 200000000003, gid: 1548, qty: 20 },
    ]), null);
    tap(49, 'in', 6100, effectsPkt([{ id: 125, value: 81 }]), null);

    await h.call('POST', '/api/fm/start', {
      accountId: 49, itemId: 7340, transport: 'live',
      targets: { 125: [130, 130] }, delay: [0, 0],
    });
    // Le serveur ne répond jamais : chaque jet part et meurt en silence.
    const done = await waitFor(async () => {
      const r = await h.call('GET', '/api/fm/status', null, '/api/fm/status?accountId=49');
      return ['done', 'blocked', 'error', 'stopped'].includes(r.run.status) ? r.run : null;
    }, 20000);

    assert.strictEqual(done.status, 'blocked', `statut=${done.status} err=${done.error}`);
    assert.ok(!/format d'échange/.test(done.error),
      `protocole accusé à tort : ${done.error}`);
    assert.match(done.error, /plus de rune jetable/, 'message d\'absence de rune attendu');
    assert.ok(sent.length >= 12, `jets réellement partis : ${sent.length / 2}`);

    await h.call('POST', '/api/fm/live/disarm', { accountId: 49 });
    fs.unlinkSync(capFile);
    fs.unlinkSync(path.join(os.homedir(), '.stakk', 'fm-protocol-49.json'));
  });

  await test('essai à blanc : run complet, journal du non-envoyé, zéro paquet', async () => {
    const { h, sent, capFile } = liveHarness(46);
    await h.call('POST', '/api/fm/calibrate', { accountId: 46 });
    await h.call('POST', '/api/fm/live/arm', { accountId: 46, itemId: 7340 });
    const tap = h.packetHandlers[0];
    tap(46, 'in', 6000, inventoryPkt([
      { uid: 200000000001, gid: 1523, qty: 30 },
      { uid: 200000000002, gid: 1548, qty: 20 },
    ]), null);
    tap(46, 'in', 6100, effectsPkt([{ id: 125, value: 81 }]), null);

    const start = await h.call('POST', '/api/fm/start', {
      accountId: 46, itemId: 7340, transport: 'dry',
      targets: { 125: [110, 110] }, delay: [0, 0],
    });
    assert.strictEqual(start.run.transport, 'dry');

    const done = await waitFor(async () => {
      const r = await h.call('GET', '/api/fm/status', null, '/api/fm/status?accountId=46');
      return ['done', 'blocked', 'error', 'stopped'].includes(r.run.status) ? r.run : null;
    }, 8000);

    assert.strictEqual(done.status, 'done', `statut=${done.status} err=${done.error}`);
    assert.strictEqual(sent.length, 0, 'des paquets sont partis en essai à blanc');
    assert.ok(done.log.some(l => /essai à blanc/.test(l.message)), 'aucun rapport de non-envoi');
    assert.ok(done.log.some(l => /pose \d+ o/.test(l.message)), 'taille du paquet non rapportée');
    assert.ok(done.stats[125] >= 110);

    await h.call('POST', '/api/fm/live/disarm', { accountId: 46 });
    fs.unlinkSync(capFile);
    fs.unlinkSync(path.join(os.homedir(), '.stakk', 'fm-protocol-46.json'));
  });

  await test('essai à blanc : mêmes prérequis que le mode Jeu', async () => {
    const { h, sent, capFile } = liveHarness(47);
    await h.call('POST', '/api/fm/calibrate', { accountId: 47 });
    // L'armement est automatique, mais tant que rien n'est observé on refuse.
    await assert.rejects(
      () => h.call('POST', '/api/fm/start', { accountId: 47, itemId: 7340, transport: 'dry', targets: { 125: [110, 110] } }),
      /pose l'item/);
    const st = await h.call('GET', '/api/fm/live/status', null, '/api/fm/live/status?accountId=47');
    assert.strictEqual(st.armed, true, 'l\'observation aurait dû s\'armer toute seule');
    assert.strictEqual(sent.length, 0);
    await h.call('POST', '/api/fm/live/disarm', { accountId: 47 });
    fs.unlinkSync(capFile);
    fs.unlinkSync(path.join(os.homedir(), '.stakk', 'fm-protocol-47.json'));
  });

  await test('config : le mode essai à blanc est persistable', async () => {
    const h = makeHarness();
    await h.call('POST', '/api/fm/config', { transport: 'dry' });
    assert.strictEqual((await h.call('GET', '/api/fm/config')).transport, 'dry');
  });

  // ─── Tous les exemplaires ────────────────────────────────────────────────

  await test('all en simulation : enchaîne le nombre d\'exemplaires demandé', async () => {
    const { call } = makeHarness();
    await call('POST', '/api/fm/start', {
      accountId: 51, itemId: 7340, targets: { 125: [95, 95] },
      delay: [0, 0], all: true, copies: 3,
    });
    const done = await waitFor(async () => {
      const r = await call('GET', '/api/fm/status', null, '/api/fm/status?accountId=51');
      return ['done', 'blocked', 'error', 'stopped'].includes(r.run.status) ? r.run : null;
    }, 8000);
    assert.strictEqual(done.status, 'done', `statut=${done.status} err=${done.error}`);
    assert.strictEqual(done.queue.total, 3);
    assert.strictEqual(done.queue.finished, 3);
    assert.ok(done.totalThrown >= 3, `jets cumulés=${done.totalThrown}`);
    assert.ok(done.log.some(l => /3 exemplaire\(s\) terminé/.test(l.message)));
    assert.ok(done.log.some(l => /démarrage \[2\/3\]/.test(l.message)), 'pas de trace du 2e exemplaire');
  });

  await test('all borne le nombre d\'exemplaires simulés', async () => {
    const { call } = makeHarness();
    const r = await call('POST', '/api/fm/start', {
      accountId: 52, itemId: 7340, targets: { 125: [82, 82] },
      delay: [0, 0], all: true, copies: 9999,
    });
    assert.strictEqual(r.run.queue.total, 50);
    await call('POST', '/api/fm/stop', { accountId: 52 });
  });

  await test('exo : proposé par /api/fm/item et travaillé en dernier', async () => {
    const h = makeHarness();
    const r = await h.call('GET', '/api/fm/item', null, '/api/fm/item?id=7340');
    assert.ok(r.exos.some(e => e.effectId === 111), 'PA non proposé en exo');
    assert.strictEqual(r.labels[111], 'PA');

    const start = await h.call('POST', '/api/fm/start', {
      accountId: 61, itemId: 7340,
      targets: { 125: [95, 95], 111: [1, 1] },
      delay: [0, 0],
    });
    const exo = start.run.targets.find(t => t.effectId === 111);
    const base = start.run.targets.find(t => t.effectId === 125);
    assert.ok(exo, 'cible hors item perdue');
    assert.strictEqual(exo.exo, true);
    assert.strictEqual(exo.phase, 1);
    assert.strictEqual(base.phase, 0);
    await h.call('POST', '/api/fm/stop', { accountId: 61 });
  });

  // Un exo décroché doit arrêter la forge : continuer risquerait de le faire
  // sauter, et c'est l'objectif de la session.
  await test('exo décroché : la forge s\'arrête et le signale', async () => {
    const { call } = makeHarness();
    const start = await call('POST', '/api/fm/start', {
      accountId: 67, itemId: 7340,
      targets: { 125: [95, 95], 111: [1, 1] },
      phases: { 111: 0, 125: 1 },        // l'exo d'abord
      delay: [0, 0],
    });
    assert.strictEqual(start.ok, true);
    const done = await waitFor(async () => {
      const r = await call('GET', '/api/fm/status', null, '/api/fm/status?accountId=67');
      return ['done', 'blocked', 'error'].includes(r.run.status) ? r.run : null;
    }, 8000);

    assert.strictEqual(done.status, 'done');
    assert.ok(done.exoWon, 'exo non signalé');
    assert.strictEqual(done.exoWon.effectId, 111);
    assert.strictEqual(done.exoWon.label, 'PA');
    assert.ok(done.log.some(l => /EXO PA obtenu/.test(l.message)));
    // La vitalité n'a pas été touchée : on s'est arrêté avant.
    assert.ok((done.stats[125] || 0) < 95, 'la forge a continué après l\'exo');
  });

  // L'historique doit montrer TOUTES les lignes touchées, pas seulement la
  // stat visée : un jet en casse souvent d'autres, c'est l'information utile.
  await test('historique : détaille chaque jet et les lignes touchées', async () => {
    const { call } = makeHarness();
    await call('POST', '/api/fm/start', {
      accountId: 68, itemId: 7340, targets: { 125: [110, 110] }, delay: [0, 0],
    });
    const done = await waitFor(async () => {
      const r = await call('GET', '/api/fm/status', null, '/api/fm/status?accountId=68');
      return ['done', 'blocked', 'error'].includes(r.run.status) ? r.run : null;
    }, 8000);

    assert.ok(Array.isArray(done.history), 'pas d\'historique');
    assert.ok(done.history.length > 0, 'historique vide');
    const passed = done.history.find(e => e.ok);
    assert.ok(passed, 'aucun jet réussi enregistré');
    assert.ok(passed.rune, 'rune non nommée');
    assert.strictEqual(passed.target, 'Vitalité');
    assert.ok(passed.deltas.length > 0, 'aucune variation enregistrée');
    const d = passed.deltas[0];
    assert.strictEqual(d.effectId, 125);
    assert.strictEqual(d.label, 'Vitalité');
    assert.strictEqual(d.after - d.before, d.delta);
    assert.ok(d.delta > 0, 'jet réussi sans gain');

    // Un jet raté est enregistré aussi, sans variation.
    const failed = done.history.find(e => !e.ok && !e.rejected);
    if (failed) assert.strictEqual(failed.deltas.length, 0, 'variation sur un jet raté');
  });

  await test('sans all, la file n\'existe pas', async () => {
    const { call } = makeHarness();
    const r = await call('POST', '/api/fm/start', {
      accountId: 53, itemId: 7340, targets: { 125: [82, 82] }, delay: [0, 0],
    });
    assert.strictEqual(r.run.queue, null);
    await call('POST', '/api/fm/stop', { accountId: 53 });
  });

  await test('all en jeu : compte les exemplaires vus en inventaire', async () => {
    const { h, capFile } = liveHarness(54);
    await h.call('POST', '/api/fm/calibrate', { accountId: 54 });
    await h.call('POST', '/api/fm/live/arm', { accountId: 54, itemId: 7340 });
    const tap = h.packetHandlers[0];
    // Deux exemplaires de la cape (gid 7340) + des runes.
    tap(54, 'in', 6000, inventoryPkt([
      { uid: 300000000001, gid: 7340, qty: 1 },
      { uid: 300000000002, gid: 7340, qty: 1 },
      { uid: 200000000001, gid: 1523, qty: 30 },
    ]), null);
    // L'item posé dans l'atelier est l'un des exemplaires de l'inventaire :
    // son uid doit être celui déjà vu, sinon il compterait comme un de plus.
    tap(54, 'in', 6100, effectsPkt([{ id: 125, value: 81 }], 7340, 300000000001), null);

    const st = await h.call('GET', '/api/fm/live/status', null, '/api/fm/live/status?accountId=54');
    assert.strictEqual(st.copies, 2, 'exemplaires mal comptés');

    const r = await h.call('POST', '/api/fm/start', {
      accountId: 54, itemId: 7340, transport: 'dry',
      targets: { 125: [86, 86] }, delay: [0, 0], all: true,
    });
    assert.strictEqual(r.run.queue.total, 2);

    // Le 1er exemplaire finit, puis STAKK doit ATTENDRE le suivant.
    const waiting = await waitFor(async () => {
      const s = await h.call('GET', '/api/fm/status', null, '/api/fm/status?accountId=54');
      return s.run.status === 'waiting-item' ? s.run : null;
    }, 8000);
    assert.ok(waiting.log.some(l => /retire-le et pose le suivant/.test(l.message)));
    assert.strictEqual(waiting.queue.finished, 1);

    // On pose un exemplaire neuf : la stat repasse sous l'objectif.
    // L'item posé dans l'atelier est l'un des exemplaires de l'inventaire :
    // son uid doit être celui déjà vu, sinon il compterait comme un de plus.
    tap(54, 'in', 6100, effectsPkt([{ id: 125, value: 81 }], 7340, 300000000001), null);
    const done = await waitFor(async () => {
      const s = await h.call('GET', '/api/fm/status', null, '/api/fm/status?accountId=54');
      return ['done', 'blocked', 'error', 'stopped'].includes(s.run.status) ? s.run : null;
    }, 8000);
    assert.strictEqual(done.status, 'done', `statut=${done.status} err=${done.error}`);
    assert.strictEqual(done.queue.finished, 2);
    assert.ok(done.log.some(l => /nouvel exemplaire détecté/.test(l.message)));

    await h.call('POST', '/api/fm/live/disarm', { accountId: 54 });
    fs.unlinkSync(capFile);
    fs.unlinkSync(path.join(os.homedir(), '.stakk', 'fm-protocol-54.json'));
  });

  await test('all : stop pendant l\'attente d\'un exemplaire coupe la file', async () => {
    const { h, capFile } = liveHarness(55);
    await h.call('POST', '/api/fm/calibrate', { accountId: 55 });
    await h.call('POST', '/api/fm/live/arm', { accountId: 55, itemId: 7340 });
    const tap = h.packetHandlers[0];
    tap(55, 'in', 6000, inventoryPkt([
      { uid: 300000000001, gid: 7340, qty: 1 },
      { uid: 300000000002, gid: 7340, qty: 1 },
      { uid: 200000000001, gid: 1523, qty: 30 },
    ]), null);
    tap(55, 'in', 6100, effectsPkt([{ id: 125, value: 81 }]), null);
    await h.call('POST', '/api/fm/start', {
      accountId: 55, itemId: 7340, transport: 'dry',
      targets: { 125: [86, 86] }, delay: [0, 0], all: true,
    });
    await waitFor(async () => {
      const s = await h.call('GET', '/api/fm/status', null, '/api/fm/status?accountId=55');
      return s.run.status === 'waiting-item';
    }, 8000);
    const s = await h.call('POST', '/api/fm/stop', { accountId: 55 });
    assert.strictEqual(s.run.status, 'stopped');
    await sleep(700);
    const after = await h.call('GET', '/api/fm/status', null, '/api/fm/status?accountId=55');
    assert.strictEqual(after.run.status, 'stopped', 'la file a repris après un arrêt');

    await h.call('POST', '/api/fm/live/disarm', { accountId: 55 });
    fs.unlinkSync(capFile);
    fs.unlinkSync(path.join(os.homedir(), '.stakk', 'fm-protocol-55.json'));
  });

  // L'inventaire complet ne passe qu'à la connexion du personnage. Sans veille
  // dès le lancement, l'observation armée plus tard ne voit presque rien et le
  // moteur s'arrête sur « plus de rune » alors que le sac est plein.
  await test('stock : la veille au lancement amorce l\'observation', async () => {
    const { h, capFile } = liveHarness(56);
    await h.call('POST', '/api/fm/calibrate', { accountId: 56 });

    // Connexion du personnage → l'inventaire complet passe AVANT tout armement.
    for (const fn of h.listeners.launch) fn({ accountId: 56 });
    const tap = h.packetHandlers[0];
    tap(56, 'in', 6000, inventoryPkt([
      { uid: 200000000001, gid: 1523, qty: 40 },
      { uid: 200000000002, gid: 1548, qty: 12 },
    ]), null);

    // L'utilisateur ouvre l'atelier bien plus tard.
    const st = await h.call('POST', '/api/fm/live/arm', { accountId: 56, itemId: 7340 });
    assert.strictEqual(st.stock['1523'], 40, 'stock non amorcé depuis la veille');
    assert.strictEqual(st.stock['1548'], 12);

    tap(56, 'in', 6100, effectsPkt([{ id: 125, value: 81 }]), null);
    const run = await h.call('POST', '/api/fm/start', {
      accountId: 56, itemId: 7340, transport: 'dry',
      targets: { 125: [110, 110] }, delay: [0, 0],
    });
    assert.strictEqual(run.ok, true);
    const done = await waitFor(async () => {
      const r = await h.call('GET', '/api/fm/status', null, '/api/fm/status?accountId=56');
      return ['done', 'blocked', 'error'].includes(r.run.status) ? r.run : null;
    }, 8000);
    assert.strictEqual(done.status, 'done', `statut=${done.status} err=${done.error}`);

    await h.call('POST', '/api/fm/live/disarm', { accountId: 56 });
    fs.unlinkSync(capFile);
    fs.unlinkSync(path.join(os.homedir(), '.stakk', 'fm-protocol-56.json'));
  });

  // Un gros inventaire est découpé par TCP. Sans recollage, les messages à
  // cheval sur deux chunks sont perdus — c'est ce qui faisait qu'un sac plein
  // ne rendait qu'une poignée d'objets.
  await test('stock : un message coupé entre deux chunks TCP est recollé', async () => {
    const { h, capFile } = liveHarness(58);
    await h.call('POST', '/api/fm/calibrate', { accountId: 58 });
    for (const fn of h.listeners.launch) fn({ accountId: 58 });
    const tap = h.packetHandlers[0];

    // Message d'inventaire complet, puis coupé en 3 comme le ferait TCP.
    const framed = inventoryPkt([
      { uid: 200000000001, gid: 1523, qty: 40 },
      { uid: 200000000002, gid: 1548, qty: 12 },
      { uid: 200000000003, gid: 1554, qty: 7 },
    ]);
    const cut = [framed.subarray(0, 9), framed.subarray(9, 30), framed.subarray(30)];
    for (const part of cut) tap(58, 'in', 6000, part, null);

    const st = await h.call('POST', '/api/fm/live/arm', { accountId: 58, itemId: 7340 });
    assert.strictEqual(st.stock['1523'], 40, 'inventaire perdu à la découpe TCP');
    assert.strictEqual(st.stock['1548'], 12);
    assert.strictEqual(st.stock['1554'], 7);

    await h.call('POST', '/api/fm/live/disarm', { accountId: 58 });
    fs.unlinkSync(capFile);
    fs.unlinkSync(path.join(os.homedir(), '.stakk', 'fm-protocol-58.json'));
  });

  await test('stock : deux messages collés dans un même chunk sont tous lus', async () => {
    const { h, capFile } = liveHarness(59);
    await h.call('POST', '/api/fm/calibrate', { accountId: 59 });
    for (const fn of h.listeners.launch) fn({ accountId: 59 });
    const tap = h.packetHandlers[0];

    const a = inventoryPkt([{ uid: 200000000001, gid: 1523, qty: 5 }]);
    const b = inventoryPkt([{ uid: 200000000002, gid: 1548, qty: 9 }]);
    tap(59, 'in', 6000, Buffer.concat([a, b]), null);

    const st = await h.call('POST', '/api/fm/live/arm', { accountId: 59, itemId: 7340 });
    assert.strictEqual(st.stock['1523'], 5);
    assert.strictEqual(st.stock['1548'], 9, 'second message du chunk ignoré');

    await h.call('POST', '/api/fm/live/disarm', { accountId: 59 });
    fs.unlinkSync(capFile);
    fs.unlinkSync(path.join(os.homedir(), '.stakk', 'fm-protocol-59.json'));
  });

  // Le serveur n'envoie l'inventaire complet qu'à la connexion du personnage.
  // Sans sauvegarde, redémarrer STAKK obligerait à relancer le perso.
  await test('stock : le miroir survit à un redémarrage de STAKK', async () => {
    const invFile = path.join(os.homedir(), '.stakk', 'fm-inventory-65.json');
    try { fs.unlinkSync(invFile); } catch {}

    // Première session : l'inventaire arrive et l'observation est désarmée.
    const first = liveHarness(65);
    await first.h.call('POST', '/api/fm/calibrate', { accountId: 65 });
    for (const fn of first.h.listeners.launch) fn({ accountId: 65 });
    first.h.packetHandlers[0](65, 'in', 6000, inventoryPkt([
      { uid: 200000000001, gid: 1523, qty: 44 },
      { uid: 200000000002, gid: 1548, qty: 17 },
    ]), null);
    await first.h.call('POST', '/api/fm/live/arm', { accountId: 65, itemId: 7340 });
    await first.h.call('POST', '/api/fm/live/disarm', { accountId: 65 });
    assert.ok(fs.existsSync(invFile), 'inventaire non sauvegardé');

    // Seconde session : tout est reparti de zéro en mémoire.
    const second = liveHarness(65);
    const st = await second.h.call('POST', '/api/fm/live/arm', { accountId: 65, itemId: 7340 });
    assert.strictEqual(st.stock['1523'], 44, 'miroir non rechargé après redémarrage');
    assert.strictEqual(st.stock['1548'], 17);

    await second.h.call('POST', '/api/fm/live/disarm', { accountId: 65 });
    fs.unlinkSync(invFile);
    fs.unlinkSync(first.capFile);
    try { fs.unlinkSync(path.join(os.homedir(), '.stakk', 'fm-protocol-65.json')); } catch {}
  });

  await test('stock : blocage sur stock maigre explique d\'où vient le stock', async () => {
    const { h, capFile } = liveHarness(57);
    await h.call('POST', '/api/fm/calibrate', { accountId: 57 });
    await h.call('POST', '/api/fm/live/arm', { accountId: 57, itemId: 7340 });
    const tap = h.packetHandlers[0];
    // Une seule rune vue, aucune veille : le moteur va bloquer tout de suite.
    tap(57, 'in', 6000, inventoryPkt([{ uid: 200000000001, gid: 1523, qty: 1 }]), null);
    tap(57, 'in', 6100, effectsPkt([{ id: 125, value: 81 }]), null);
    await h.call('POST', '/api/fm/start', {
      accountId: 57, itemId: 7340, transport: 'dry',
      targets: { 125: [200, 200] }, delay: [0, 0],
    });
    const done = await waitFor(async () => {
      const r = await h.call('GET', '/api/fm/status', null, '/api/fm/status?accountId=57');
      return ['done', 'blocked', 'error'].includes(r.run.status) ? r.run : null;
    }, 8000);
    assert.strictEqual(done.status, 'blocked');
    assert.ok(done.log.some(l => /ne lit que ce qui passe sur le réseau/.test(l.message)),
      'aucune explication sur l\'origine du stock');

    await h.call('POST', '/api/fm/live/disarm', { accountId: 57 });
    fs.unlinkSync(capFile);
    fs.unlinkSync(path.join(os.homedir(), '.stakk', 'fm-protocol-57.json'));
  });

  // Un exo raté détruit des lignes : une stat visée retombe SOUS le jet
  // minimum d'origine. On remet alors l'item à neuf plutôt que de remonter
  // des jets sur une base ruinée.
  await test('orbe : item cassé → remise à neuf puis reprise', async () => {
    const { h, sent, capFile } = liveHarness(62);
    await h.call('POST', '/api/fm/calibrate', { accountId: 62 });
    await h.call('POST', '/api/fm/live/arm', { accountId: 62, itemId: 7340 });
    const tap = h.packetHandlers[0];
    tap(62, 'in', 6000, inventoryPkt([
      { uid: 200000000001, gid: 1523, qty: 30 },
      { uid: 300000000001, gid: 1557, qty: 5 },       // Rune Ga Pa (exo)
      { uid: 400000000001, gid: 17273, qty: 2 },      // Orbe régénérant, niv 120
    ]), null);
    // Vitalité déjà au-dessus de son objectif → la première action sera l'exo.
    tap(62, 'in', 6100, effectsPkt([{ id: 125, value: 60 }]), null);

    await h.call('POST', '/api/fm/start', {
      accountId: 62, itemId: 7340, transport: 'dry',
      // Un jet désastreux suffit : la remise à neuf ne dépend plus d'une
      // tentative d'exo, seulement de la perte de poids.
      targets: { 125: [200, 200] },
      delay: [10, 10], orbe: true,
    });

    // L'exo rate et ruine l'item : la vitalité s'effondre à 10 pour un jet
    // maxi de 100, soit 10 % du poids d'origine.
    const ruin = setInterval(async () => {
      const r = await h.call('GET', '/api/fm/status', null, '/api/fm/status?accountId=62');
      if (r.run.thrown >= 1) {
        clearInterval(ruin);
        tap(62, 'in', 6100, effectsPkt([{ id: 125, value: 10 }]), null);
      }
    }, 15);

    // On arrête dès que l'orbe est posée : la forge repart ensuite pour de
    // longues séries et le journal, borné, ferait défiler la trace.
    const used = await waitFor(async () => {
      const r = await h.call('GET', '/api/fm/status', null, '/api/fm/status?accountId=62');
      return r.run.orbesUsed > 0 ? r.run : null;
    }, 8000);
    clearInterval(ruin);
    await h.call('POST', '/api/fm/stop', { accountId: 62 });

    assert.ok(used.orbesUsed > 0, 'aucune orbe utilisée sur un item cassé');
    assert.ok(used.log.some(l => /remise à neuf/.test(l.message)), 'pas de trace de la remise à neuf');
    assert.ok(used.log.some(l => /Orbe/.test(l.message)), 'orbe non nommée');
    assert.ok(used.log.some(l => /% de son poids d'origine/.test(l.message)),
      'la perte de poids n\'est pas expliquée');

    await h.call('POST', '/api/fm/live/disarm', { accountId: 62 });
    fs.unlinkSync(capFile);
    fs.unlinkSync(path.join(os.homedir(), '.stakk', 'fm-protocol-62.json'));
  });

  await test('orbe : sans orbe en inventaire, on s\'arrête au lieu d\'insister', async () => {
    const { h, capFile } = liveHarness(63);
    await h.call('POST', '/api/fm/calibrate', { accountId: 63 });
    await h.call('POST', '/api/fm/live/arm', { accountId: 63, itemId: 7340 });
    const tap = h.packetHandlers[0];
    tap(63, 'in', 6000, inventoryPkt([
      { uid: 200000000001, gid: 1523, qty: 30 },
      { uid: 300000000001, gid: 1557, qty: 5 },
    ]), null);
    tap(63, 'in', 6100, effectsPkt([{ id: 125, value: 60 }]), null);

    await h.call('POST', '/api/fm/start', {
      accountId: 63, itemId: 7340, transport: 'dry',
      // Un jet désastreux suffit : la remise à neuf ne dépend plus d'une
      // tentative d'exo, seulement de la perte de poids.
      targets: { 125: [200, 200] },
      delay: [10, 10], orbe: true,
    });
    const ruin = setInterval(async () => {
      const r = await h.call('GET', '/api/fm/status', null, '/api/fm/status?accountId=63');
      if (r.run.thrown >= 1) {
        clearInterval(ruin);
        tap(63, 'in', 6100, effectsPkt([{ id: 125, value: 10 }]), null);
      }
    }, 15);
    const done = await waitFor(async () => {
      const r = await h.call('GET', '/api/fm/status', null, '/api/fm/status?accountId=63');
      return ['done', 'blocked', 'error', 'stopped'].includes(r.run.status) ? r.run : null;
    }, 8000);
    clearInterval(ruin);
    assert.strictEqual(done.status, 'blocked');
    assert.match(done.error, /orbe/);

    await h.call('POST', '/api/fm/live/disarm', { accountId: 63 });
    fs.unlinkSync(capFile);
    fs.unlinkSync(path.join(os.homedir(), '.stakk', 'fm-protocol-63.json'));
  });

  // Une orbe ne couvre que les items jusqu'à SON niveau : pour un item 65,
  // la mineure (60) ne convient pas, il faut la 120.
  await test('orbe : choisit la première qui couvre le niveau de l\'item', async () => {
    const { h, capFile } = liveHarness(66);
    await h.call('POST', '/api/fm/calibrate', { accountId: 66 });
    await h.call('POST', '/api/fm/live/arm', { accountId: 66, itemId: 7340 });   // item niveau 62
    const tap = h.packetHandlers[0];
    tap(66, 'in', 6000, inventoryPkt([
      { uid: 200000000001, gid: 1523, qty: 30 },
      { uid: 300000000001, gid: 1557, qty: 5 },
      { uid: 400000000001, gid: 17272, qty: 9 },   // mineure, niv 60 → trop faible
      { uid: 400000000002, gid: 17273, qty: 1 },   // régénérante, niv 120 → celle-ci
    ]), null);
    tap(66, 'in', 6100, effectsPkt([{ id: 125, value: 60 }]), null);

    await h.call('POST', '/api/fm/start', {
      accountId: 66, itemId: 7340, transport: 'dry',
      targets: { 125: [200, 200] },
      delay: [10, 10], orbe: true,
    });
    const ruin = setInterval(async () => {
      const r = await h.call('GET', '/api/fm/status', null, '/api/fm/status?accountId=66');
      if (r.run.thrown >= 1) {
        clearInterval(ruin);
        tap(66, 'in', 6100, effectsPkt([{ id: 125, value: 10 }]), null);
      }
    }, 15);
    const used = await waitFor(async () => {
      const r = await h.call('GET', '/api/fm/status', null, '/api/fm/status?accountId=66');
      return r.run.orbesUsed > 0 ? r.run : null;
    }, 8000);
    clearInterval(ruin);
    await h.call('POST', '/api/fm/stop', { accountId: 66 });

    assert.ok(used.log.some(l => /Orbe régénérant\b/.test(l.message)),
      'la mineure a été retenue alors qu\'elle ne couvre pas l\'item');
    assert.ok(!used.log.some(l => /mineur/.test(l.message)), 'orbe mineure utilisée à tort');

    await h.call('POST', '/api/fm/live/disarm', { accountId: 66 });
    fs.unlinkSync(capFile);
    fs.unlinkSync(path.join(os.homedir(), '.stakk', 'fm-protocol-66.json'));
  });

  await test('orbe : ignorée si l\'option est décochée', async () => {
    const { h, capFile } = liveHarness(64);
    await h.call('POST', '/api/fm/calibrate', { accountId: 64 });
    await h.call('POST', '/api/fm/live/arm', { accountId: 64, itemId: 7340 });
    const tap = h.packetHandlers[0];
    tap(64, 'in', 6000, inventoryPkt([
      { uid: 200000000001, gid: 1523, qty: 30 },
      { uid: 400000000001, gid: 17273, qty: 2 },
    ]), null);
    tap(64, 'in', 6100, effectsPkt([{ id: 125, value: 40 }]), null);

    await h.call('POST', '/api/fm/start', {
      accountId: 64, itemId: 7340, transport: 'dry',
      targets: { 125: [100, 100] }, delay: [0, 0],     // orbe non demandée
    });
    const done = await waitFor(async () => {
      const r = await h.call('GET', '/api/fm/status', null, '/api/fm/status?accountId=64');
      return ['done', 'blocked', 'error', 'stopped'].includes(r.run.status) ? r.run : null;
    }, 8000);
    assert.strictEqual(done.orbesUsed, 0, 'orbe utilisée sans qu\'on la demande');

    await h.call('POST', '/api/fm/live/disarm', { accountId: 64 });
    fs.unlinkSync(capFile);
    fs.unlinkSync(path.join(os.homedir(), '.stakk', 'fm-protocol-64.json'));
  });

  await test('live : detach désarme l\'observation', async () => {
    const { h, capFile } = liveHarness(45);
    await h.call('POST', '/api/fm/calibrate', { accountId: 45 });
    await h.call('POST', '/api/fm/live/arm', { accountId: 45, itemId: 7340 });
    for (const fn of h.listeners.detach) fn({ accountId: 45 });
    const st = await h.call('GET', '/api/fm/live/status', null, '/api/fm/live/status?accountId=45');
    assert.strictEqual(st.armed, false);
    fs.unlinkSync(capFile);
    fs.unlinkSync(path.join(os.homedir(), '.stakk', 'fm-protocol-45.json'));
  });

  console.log(`\n${passed}/${pending} tests OK${failures.length ? ' — ÉCHECS: ' + failures.join(', ') : ''}`);
  if (failures.length) process.exit(1);
})();
