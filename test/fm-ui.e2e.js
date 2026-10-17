'use strict';

/**
 * Test bout-en-bout de l'onglet Forgemagie.
 *
 * Monte un faux stakk.exe sur le port 3000 (routes /api/fm/* servies par le
 * VRAI plugin fm.js, le reste bouchonné), sert ui/index.html, puis pilote
 * Chrome : sélection d'un item, lancement d'un run simulé, vérification du
 * résultat affiché. Aucun Dofus, aucun compte réel.
 *
 *   node test/fm-ui.e2e.js            # dofusdb en direct
 *   node test/fm-ui.e2e.js --headful  # fenêtre visible
 *
 * Prérequis : Chrome ou Edge installé (chemin auto-détecté).
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const createFm = require('../lib/fm');
const createFmData = require('../lib/fm-data');
const createFmEngine = require('../lib/fm-engine');

const PORT = 3000;
const HTML = path.resolve(__dirname, '..', 'ui', 'index.html');
const HEADFUL = process.argv.includes('--headful');

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

// ������ Faux exe ����������������������������������������������������������������������������������������������������������������������������

const routes = {};
let config = {};
const ACCOUNTS = [{
  accountId: 101, login: 'test@stakk', nickname: 'DAKK',
  characterName: 'Kitsou', characterLevel: 200, characterClass: 'Iop',
  refreshDate: Date.now(), launches: 0, runningGames: [],
}];

// Canal de jeu bouchonné : on retient ce que le plugin envoie, et on peut
// pousser des paquets entrants comme le ferait le proxy.
const sentPackets = [];
const packetHandlers = [];
const fakeChannel = { sendToServer: b => { sentPackets.push(Buffer.from(b)); return true; }, sendToClient: () => true };

createFm({
  fs, path, os, https: require('https'),
  log: m => process.env.FM_VERBOSE && console.log(m),
  registerRoute: (m, p, h) => { routes[`${m} ${p}`] = h; },
  on: () => {},
  loadConfig: () => config,
  saveConfig: c => { config = c; },
  setPacketHandler: fn => { packetHandlers.push(fn); return true; },
  getGameChannel: () => fakeChannel,
  DATA_DIR: os.tmpdir(),
  createFmData, createFmEngine,
});

// Pousse quelques paquets pendant une capture, comme le proxy le ferait.
function feedCapturePackets() {
  for (const fn of packetHandlers) {
    fn(101, 'out', 3014, Buffer.from('2f1a2d08ff', 'hex'), null);
    fn(101, 'in', 2754, Buffer.from('2b0a290a27', 'hex'), null);
    fn(101, 'out', 2566, Buffer.from('281a2608ff', 'hex'), null);
  }
}

// Pousse un inventaire de runes + les stats de l'item, comme le serveur.
function feedLiveObservation() {
  const vi = v => { const o = []; let n = v; do { const b = n % 128; n = Math.floor(n / 128); o.push(b | (n > 0 ? 0x80 : 0)); } while (n > 0); return Buffer.from(o); };
  const lenF = (f, p) => Buffer.concat([Buffer.from([(f << 3) | 2]), vi(p.length), p]);
  const varF = (f, v) => Buffer.concat([Buffer.from([(f << 3) | 0]), vi(v)]);
  // Format réel du canal : <varint longueur><message>. Le plugin recolle le
  // flux TCP, donc un paquet non cadré serait simplement ignoré.
  const frame = payload => Buffer.concat([vi(payload.length), payload]);
  const inv = frame(Buffer.concat([lenF(1, Buffer.from('type.ankama.com/inv')),
    ...[{ uid: 200000000001, gid: 1523, qty: 30 }, { uid: 200000000002, gid: 1548, qty: 20 }]
      .map(it => lenF(3, Buffer.concat([varF(1, it.uid), varF(2, it.gid), varF(3, it.qty)])))]));
  // Forme réelle : les effets vivent dans le sous-message de l'objet, à côté
  // de son gid (7340 = Cape du Kitsou, l'item choisi par le test). La lecture
  // est scopée sur ce gid, sinon les effets des runes du même paquet seraient
  // pris pour ceux de l'item.
  const objectMsg = (uid, gid, effs) => lenF(3, Buffer.concat([
    varF(1, uid), varF(2, gid),
    ...effs.map(e => lenF(5, Buffer.concat([varF(1, e.id), varF(2, e.value)]))),
  ]));
  const eff = frame(Buffer.concat([lenF(1, Buffer.from('type.ankama.com/eff')),
    objectMsg(300000000001, 7340, [{ id: 125, value: 81 }])]));
  for (const fn of packetHandlers) { fn(101, 'in', 6000, inv, null); fn(101, 'in', 6100, eff, null); }
}

// Bouchons minimaux pour que l'UI démarre sans erreur réseau.
const STUBS = {
  'GET /api/accounts': () => ACCOUNTS,
  'GET /api/config': () => ({ groups: [] }),
  'GET /api/interfaces': () => [],
  'GET /api/running': () => ({}),
  'GET /api/logs': () => [],
  'GET /api/version': () => ({ version: 'e2e' }),
  'GET /api/build-flags': () => ({}),
  'GET /api/hot-status': () => ({ modules: {} }),
  'GET /api/update/check': () => ({ update: false }),
  'GET /api/organizer/shortcuts': () => ({ accounts: {}, cycle: {} }),
  'GET /api/account-subs': () => ({}),
  'GET /api/click-broadcast': () => ({ enabled: false }),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(HTML));
  }

  const key = `${req.method} ${url.pathname}`;
  const handler = routes[key] || STUBS[key];
  if (!handler) { res.writeHead(404); return res.end('{}'); }

  let body = null;
  if (req.method === 'POST') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { body = {}; }
  }
  try {
    const out = await handler(body, req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

// Capture synthétique : 2 poses de rune (uid différents) + 2 forges, au
// format écrit par fm.js. Sert à tester le bouton « Analyser la capture ».
function buildFakeCapture() {
  const vi = v => { const o = []; let n = v; do { const b = n % 128; n = Math.floor(n / 128); o.push(b | (n > 0 ? 0x80 : 0)); } while (n > 0); return Buffer.from(o); };
  const lenF = (f, p) => Buffer.concat([Buffer.from([(f << 3) | 2]), vi(p.length), p]);
  const varF = (f, v) => Buffer.concat([Buffer.from([(f << 3) | 0]), vi(v)]);
  const hdr = id => { const b = Buffer.alloc(2); b.writeUInt16BE((id << 2) & 0xffff, 0); return b; };
  const move = uid => Buffer.concat([hdr(4210),
    lenF(1, Buffer.from('type.ankama.com/xyz')),
    lenF(2, Buffer.concat([varF(1, uid), varF(2, 1)]))]);
  const ready = Buffer.concat([hdr(4211), lenF(1, Buffer.from('type.ankama.com/rdy'))]);
  const l = (dir, id, b) => `10:00:00.000 ${dir.padEnd(3)} msgId=${id} len=${b.length} hex=${b.toString('hex')}`;
  return ['# capture e2e', '#',
    l('OUT', 4210, move(100000000000)), l('OUT', 4211, ready),
    l('IN', 999, Buffer.from('0102', 'hex')),
    l('OUT', 4210, move(100000000001)), l('OUT', 4211, ready)].join('\n') + '\n';
}

// ������ Pilotage navigateur ������������������������������������������������������������������������������������������������������

const assert = require('assert');
const steps = [];
function step(name, ok, detail) {
  steps.push({ name, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' � ' + detail : ''}`);
}

(async () => {
  const exe = BROWSERS.find(p => fs.existsSync(p));
  if (!exe) { console.error('Aucun Chrome/Edge trouvé � test ignoré.'); process.exit(0); }

  await new Promise((r, j) => server.listen(PORT, '127.0.0.1', r).on('error', j));
  console.log(`fm ui e2e � serveur sur http://localhost:${PORT}`);

  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: !HEADFUL,
    args: ['--no-sandbox', '--window-size=1440,900'],
    defaultViewport: { width: 1440, height: 900 },
  });
  const page = await browser.newPage();
  // Deux niveaux : les vraies erreurs JS (bloquantes) et les 404 réseau, qui
  // ici viennent des routes non-FM absentes du bouchon � on les liste sans
  // faire échouer le test tant qu'aucune n'est une route /api/fm/*.
  const pageErrors = [];
  const notFound = [];
  page.on('pageerror', e => pageErrors.push(String(e.message)));
  page.on('console', m => { if (m.type() === 'error' && !/status of 404/.test(m.text())) pageErrors.push('console: ' + m.text()); });
  page.on('response', r => { if (r.status() === 404) notFound.push(new URL(r.url()).pathname); });

  try {
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#rn-fm', { timeout: 10000 });
    step('onglet Forgemagie présent', true);

    // Sélectionne le compte puis ouvre l'onglet.
    await page.waitForSelector('.acc-row', { timeout: 10000 });
    await page.click('.acc-row');
    await page.click('#rn-fm');
    await page.waitForSelector('#fmQ', { timeout: 10000 });
    step('panneau FM rendu avec un compte', true);

    await page.type('#fmQ', 'cape du kitsou');
    await page.waitForFunction(
      () => document.querySelectorAll('#fmRes .fm-res-row').length > 0 &&
            !document.querySelector('#fmRes').textContent.includes('Recherche'),
      { timeout: 20000 });
    const firstResult = await page.$eval('#fmRes .fm-res-row .fm-res-name', e => e.textContent);
    step('recherche dofusdb', true, firstResult);

    await page.click('#fmRes .fm-res-row');
    await page.waitForSelector('.fm-stats tbody tr', { timeout: 20000 });
    const statCount = await page.$$eval('.fm-stats tbody tr', rows => rows.length);
    assert.ok(statCount > 0, 'aucune ligne de stat');
    step('tableau des stats', true, `${statCount} stat(s)`);

    // Curseur : pousse l'objectif au-delà du plafond �  le plafond doit suivre.
    const slid = await page.evaluate(() => {
      const wrap = document.querySelector('.fm-stats .fm-rg');
      const [a, b] = wrap.querySelectorAll('input');
      const key = wrap.id.replace('fmrg-', '');
      a.value = a.max;
      a.dispatchEvent(new Event('input', { bubbles: true }));
      return {
        key,
        a: +a.value, b: +b.value,
        outA: document.getElementById('fmouta-' + key).textContent,
        target: window.FM ? null : undefined,
      };
    });
    assert.strictEqual(slid.b, slid.a, 'le plafond n\'a pas suivi l\'objectif');
    assert.strictEqual(String(slid.a), slid.outA, 'affichage désynchronisé');
    step('double curseur : pas de croisement', true, `objectif=${slid.a} plafond=${slid.b}`);

    // Les champs chiffrés et le curseur doivent rester d'accord dans les deux
    // sens : c'est par eux qu'on vise une valeur précise.
    const numSync = await page.evaluate(() => {
      const wrap = document.querySelector('.fm-stats .fm-rg');
      const key = wrap.id.replace('fmrg-', '');
      const [ia] = wrap.querySelectorAll('input');
      const afterDrag = document.getElementById('fmnuma-' + key).value;
      // Saisie → curseur
      const num = document.getElementById('fmnuma-' + key);
      num.value = '42';
      num.dispatchEvent(new Event('change', { bubbles: true }));
      return { key, afterDrag, sliderAfterType: ia.value, numAfterType: num.value };
    });
    assert.strictEqual(numSync.afterDrag, String(slid.a), 'le champ ne suit pas le curseur');
    assert.strictEqual(numSync.sliderAfterType, '42', 'le curseur ne suit pas la saisie');
    step('champs chiffrés synchronisés avec le curseur', true,
      `curseur→champ ${numSync.afterDrag}, champ→curseur ${numSync.sliderAfterType}`);

    // Remet un objectif atteignable rapidement, puis lance la simulation.
    await page.evaluate(() => {
      const wrap = document.querySelector('.fm-stats .fm-rg');
      const [a, b] = wrap.querySelectorAll('input');
      const key = wrap.id.replace('fmrg-', '');
      const eid = key.slice(1);
      const row = FM.item.stats.find(s => String(s.effectId) === eid);
      const goal = (row.to || row.from) + 5;
      b.value = String(goal); b.dispatchEvent(new Event('input', { bubbles: true }));
      a.value = String(goal); a.dispatchEvent(new Event('input', { bubbles: true }));
      // Ne garde que cette stat pour un run court.
      for (const k of Object.keys(FM.targets)) if (k !== eid) delete FM.targets[k];
      FM.delay = [0, 0];
    });
    await page.click('.fm-btn.go');
    await page.waitForFunction(
      () => document.querySelector('#fmRunBox .fm-state') &&
            /terminé|bloqué|erreur/.test(document.querySelector('#fmRunBox .fm-state').textContent),
      { timeout: 25000 });
    const state = await page.$eval('#fmRunBox .fm-state', e => e.textContent.replace(/\s+/g, ' ').trim());
    assert.ok(/terminé/.test(state), `run non terminé: ${state}`);
    step('run simulé jusqu\'au bout', true, state);

    // Historique détaillé : une entrée par jet, avec les lignes touchées.
    const hist = await page.$$eval('#fmRunBox .fm-hist-e', es => es.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
    assert.ok(hist.length > 0, 'historique vide');
    assert.ok(hist.some(h => /passé|raté/.test(h)), 'aucun verdict de jet');
    assert.ok(hist.some(h => /Rune/.test(h)), 'rune non nommée dans l\'historique');
    assert.ok(hist.some(h => /→/.test(h)), 'variations non détaillées');
    step('historique détaillé façon jeu', true, hist[0].slice(0, 60) + '…');

    // Le journal texte reste accessible par onglet.
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('#fmRunBox .fm-tabs button')]
        .find(x => /Journal/.test(x.textContent));
      b.click();
    });
    await page.waitForSelector('#fmRunBox .fm-log', { timeout: 8000 });
    step('bascule vers le journal texte', true);

    const logLines = await page.$$eval('#fmRunBox .fm-log div', ds => ds.map(d => d.textContent));
    assert.ok(logLines.length >= 2, 'journal vide');
    assert.ok(logLines.some(l => /Rune/.test(l)), 'aucun jet de rune journalisé');
    step('journal des jets', true, `${logLines.length} ligne(s)`);

    const pct = await page.$eval('#fmRunBox .fm-bar i', e => e.style.width);
    assert.strictEqual(pct, '100%');
    step('barre de progression à 100 %', true);

    // Le bouton Forger doit être réactivé après la fin du run.
    const disabled = await page.$eval('.fm-btn.go', e => e.disabled);
    assert.strictEqual(disabled, false);
    step('bouton réarmé après le run', true);

    // ������ Presets ������������������������������������������������������������������������������������������������������������������
    await page.waitForSelector('#fmPresetName', { timeout: 5000 });
    await page.evaluate(() => {
      document.getElementById('fmPresetName').value = 'Kitsou vita';
      // Objectif reconnaissable, pour vérifier qu'il revient au chargement.
      const wrap = document.querySelector('.fm-stats .fm-rg');
      const [a, b] = wrap.querySelectorAll('input');
      b.value = '133'; b.dispatchEvent(new Event('input', { bubbles: true }));
      a.value = '133'; a.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.click('#fmPresets .fm-btn');           // Enregistrer
    await page.waitForSelector('#fmPresetPick', { timeout: 8000 });
    const presetNames = await page.$$eval('#fmPresetPick option', os => os.map(o => o.value));
    assert.ok(presetNames.includes('Kitsou vita'), presetNames.join(','));
    step('preset enregistré', true, presetNames.join(', '));

    // On casse le réglage, puis on recharge le preset.
    await page.evaluate(() => {
      const wrap = document.querySelector('.fm-stats .fm-rg');
      const [a] = wrap.querySelectorAll('input');
      a.value = '90'; a.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('#fmPresets .fm-btn')];
      btns.find(b => /Charger/.test(b.textContent)).click();
    });
    await page.waitForFunction(
      () => JSON.stringify(FM.targets).includes('133'), { timeout: 8000 });
    const restored = await page.evaluate(() => JSON.stringify(FM.targets));
    assert.match(restored, /133/, restored);
    step('preset rechargé restaure les objectifs', true, restored);

    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('#fmPresets .fm-btn')];
      btns.find(b => /Supprimer/.test(b.textContent)).click();
    });
    await page.waitForFunction(
      () => !document.getElementById('fmPresetPick'), { timeout: 8000 });
    step('preset supprimé', true);

    // ������ Enchaînement de plusieurs exemplaires (simulation) ����������������������������
    await page.evaluate(() => {
      document.getElementById('fmAll').click();
      FM.copies = 3;
      FM.delay = [0, 0];
    });
    await page.waitForSelector('#fmAllDetail input', { timeout: 5000 });
    step('option « tous les exemplaires » avec compteur en simulation', true);

    await page.click('.fm-btn.go');
    await page.waitForFunction(
      () => /terminé|bloqué|erreur/.test(document.querySelector('#fmRunBox .fm-state')?.textContent || '') &&
            /exemplaire/.test(document.querySelector('#fmRunBox .fm-state')?.textContent || ''),
      { timeout: 25000 });
    const queueState = await page.$eval('#fmRunBox .fm-state', e => e.textContent.replace(/\s+/g, ' ').trim());
    assert.match(queueState, /exemplaire 3\/3/, queueState);
    assert.match(queueState, /terminé/);
    step('file de 3 exemplaires menée à terme', true, queueState);

    const queueLog = await page.$$eval('#fmRunBox .fm-log div', ds => ds.map(d => d.textContent));
    assert.ok(queueLog.some(l => /démarrage \[3\/3\]/.test(l)), 'pas de trace du 3e exemplaire');
    assert.ok(queueLog.some(l => /3 exemplaire\(s\) terminé/.test(l)));
    step('journal trace chaque exemplaire', true);

    await page.evaluate(() => document.getElementById('fmAll').click());

    // ������ Mode Jeu : clé en main ������������������������������������������������������������������������������������
    // Aucune calibration, aucun armement manuel : le profil est intégré et
    // l'observation démarre toute seule dès qu'un item est choisi.
    await page.click('#fmTrLive');
    await page.waitForFunction(
      () => /Protocole intégré/.test(document.getElementById('fmCalib')?.textContent || ''),
      { timeout: 10000 });
    step('protocole intégré, rien à configurer', true);

    await page.waitForFunction(
      () => /Lecture de l|STAKK lit les stats/.test(document.getElementById('fmLiveBox')?.textContent || ''),
      { timeout: 10000 });
    step('observation armée automatiquement', true);

    // Rien n'a encore été lu : le bouton Forger doit rester verrouillé.
    await page.waitForFunction(() => document.querySelector('.fm-btn.go')?.disabled === true,
      { timeout: 10000 });
    const goHint0 = await page.$eval('#fmRunBox .fm-lbl', e => e.textContent).catch(() => '');
    assert.match(goHint0, /observe/i);
    step('Forger verrouillé tant que l\'atelier n\'est pas lu', true, goHint0);

    // Le serveur pousse inventaire + stats via le tap du proxy.
    feedLiveObservation();
    await page.waitForFunction(
      () => /mode Jeu est prêt/.test(document.getElementById('fmLiveBox')?.textContent || ''),
      { timeout: 15000 });
    step('atelier lu �  mode Jeu prêt sans une seule étape manuelle', true,
      (await page.$eval('#fmLiveBox', e => e.textContent.replace(/\s+/g, ' ').trim())).slice(0, 60) + '⬦');

    await page.waitForFunction(() => !document.querySelector('.fm-btn.go').disabled, { timeout: 10000 });
    step('Forger déverrouillé après lecture', true);

    // ������ Recalibration (repli si Ankama change ses signatures) ����������������������
    const calDisabled = await page.$eval('#fmCalBtn', e => e.disabled).catch(() => null);
    assert.strictEqual(calDisabled, true, 'bouton Analyser actif sans capture');
    step('analyse désactivée tant qu\'il n\'y a pas de capture', true);

    // Le compteur de paquets doit monter TOUT SEUL, sans changer d'onglet.
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('#fmCalib .fm-btn')]
        .find(x => /Démarrer la capture/.test(x.textContent));
      b.click();
    });
    await page.waitForFunction(
      () => /Arrêter la capture/.test(document.getElementById('fmCalib')?.textContent || ''),
      { timeout: 10000 });
    feedCapturePackets();
    await page.waitForFunction(
      () => /Arrêter la capture \((?!0 )\d+ paquets\)/.test(document.getElementById('fmCalib')?.textContent || ''),
      { timeout: 10000 });
    const counter = await page.$$eval('#fmCalib .fm-btn', bs =>
      (bs.find(b => /Arrêter la capture/.test(b.textContent)) || {}).textContent.trim());
    step('compteur de paquets rafraîchi sans changer d\'onglet', true, counter);

    await page.evaluate(() => {
      const b = [...document.querySelectorAll('#fmCalib .fm-btn')]
        .find(x => /Arrêter la capture/.test(x.textContent));
      b.click();
    });
    await page.waitForFunction(
      () => /Démarrer la capture/.test(document.getElementById('fmCalib')?.textContent || ''),
      { timeout: 10000 });
    await new Promise(r => setTimeout(r, 300));   // laisse le flux se fermer
    step('capture arrêtée depuis l\'UI', true);

    // Dépose une capture synthétique puis analyse.
    const capFile = path.join(os.homedir(), '.stakk', 'fm-capture-101.log');
    fs.mkdirSync(path.dirname(capFile), { recursive: true });
    fs.writeFileSync(capFile, buildFakeCapture());
    await page.click('#fmTrSim');
    await page.click('#fmTrLive');
    // La recalibration est repliée dans un <details> : on l'ouvre comme le
    // ferait l'utilisateur, sinon le bouton n'a pas de boîte cliquable.
    await page.evaluate(() => {
      const d = document.querySelector('#fmCalib details');
      if (d) { d.open = true; d.dispatchEvent(new Event('toggle')); }
    });
    await page.waitForFunction(
      () => { const b = document.getElementById('fmCalBtn'); return b && !b.disabled; },
      { timeout: 10000 });
    await page.evaluate(() => document.getElementById('fmCalBtn').click());
    await page.waitForFunction(
      () => /calibré localement/.test(document.getElementById('fmCalib')?.textContent || ''),
      { timeout: 15000 });
    const calText = await page.$eval('#fmCalib', e => e.textContent.replace(/\s+/g, ' ').trim());
    step('calibration locale prend le pas sur le profil intégré', true, calText.slice(0, 70) + '…');

    // ������ Essai à blanc ������������������������������������������������������������������������������������������������������
    await page.click('#fmTrDry');
    await page.waitForFunction(
      () => /Essai à blanc/.test(document.querySelector('.fm-btn.go')?.textContent || '') &&
            !document.querySelector('.fm-btn.go').disabled,
      { timeout: 10000 });
    step('bouton bascule en Essai à blanc', true);

    const beforeDry = sentPackets.length;
    await page.click('.fm-btn.go');
    // On attend le run EN MODE essai à blanc : sans le mode dans la condition,
    // le run simulé précédent (déjà « terminé ») satisferait l'attente.
    await page.waitForFunction(
      () => {
        const t = document.querySelector('#fmRunBox .fm-state')?.textContent || '';
        return /essai à blanc/.test(t) && /terminé|bloqué|erreur/.test(t);
      },
      { timeout: 25000 });
    const dryState = await page.$eval('#fmRunBox .fm-state', e => e.textContent.replace(/\s+/g, ' ').trim());
    assert.match(dryState, /terminé/, dryState);
    assert.match(dryState, /essai à blanc/);
    step('essai à blanc mené jusqu\'au bout', true, dryState);

    assert.strictEqual(sentPackets.length, beforeDry,
      `${sentPackets.length - beforeDry} paquet(s) envoyé(s) en essai à blanc`);
    step('aucun paquet envoyé pendant l\'essai à blanc', true);

    const dryLog = await page.$$eval('#fmRunBox .fm-log div', ds => ds.map(d => d.textContent));
    assert.ok(dryLog.some(l => /essai à blanc.*non envoyé/.test(l)), 'rapport de non-envoi absent');
    assert.ok(dryLog.some(l => /pose \d+ o/.test(l)), 'taille de paquet non rapportée');
    step('journal détaille ce qui aurait été envoyé', true,
      (dryLog.find(l => /non envoyé/.test(l)) || '').slice(11, 80));

    // Retour au profil intégré : la remise à zéro ne doit pas laisser STAKK
    // sans protocole, elle doit juste rendre la main au profil livré.
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('#fmCalib .fm-btn')]
        .find(x => /Revenir au profil intégré/.test(x.textContent));
      b.click();
    });
    await page.waitForFunction(
      () => /Protocole intégré/.test(document.getElementById('fmCalib')?.textContent || ''),
      { timeout: 10000 });
    step('retour au profil intégré', true);
    fs.unlinkSync(capFile);
    await page.click('#fmTrSim');

    const shot = path.join(os.tmpdir(), 'stakk-fm-e2e.png');
    await page.screenshot({ path: shot, fullPage: false });
    console.log(`\ncapture: ${shot}`);

    step('aucune erreur JS dans la page', pageErrors.length === 0,
      pageErrors.slice(0, 3).join(' | '));
    const fm404 = [...new Set(notFound)].filter(p => p.startsWith('/api/fm/'));
    step('aucune route /api/fm/* manquante', fm404.length === 0, fm404.join(', '));
    if (notFound.length) {
      console.log(`(404 hors périmètre FM, normal avec le bouchon: ${[...new Set(notFound)].join(', ')})`);
    }
  } catch (e) {
    step('parcours complet', false, e.message);
    // Diagnostic : état réel de la page au moment de l'échec.
    try {
      const dump = await page.evaluate(async () => {
        let calibrate = null;
        try {
          const r = await fetch('http://localhost:3000/api/fm/calibrate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accountId: 101 }),
          });
          calibrate = { status: r.status, body: (await r.text()).slice(0, 300) };
        } catch (err) { calibrate = { error: String(err) }; }
        window.__calibrate = calibrate;
        let server = null;
        try {
          server = await fetch('http://localhost:3000/api/fm/status?accountId=101')
            .then(r => r.json());
        } catch (err) { server = { fetchError: String(err) }; }
        return {
          calibrate: window.__calibrate,
          calibBox: document.getElementById('fmCalib')?.textContent?.replace(/\s+/g, ' ').slice(0, 200),
          toast: document.getElementById('toast')?.textContent,
          serverStatus: server && server.run
            ? { status: server.run.status, thrown: server.run.thrown, error: server.run.error }
            : server,
          uiPolling: typeof FM !== 'undefined' ? !!FM.poll : null,
          runBox: document.getElementById('fmRunBox')?.innerHTML?.slice(0, 400),
          targets: typeof FM !== 'undefined' ? JSON.stringify(FM.targets) : null,
          itemId: typeof FM !== 'undefined' ? FM.item && FM.item.id : null,
          delay: typeof FM !== 'undefined' ? JSON.stringify(FM.delay) : null,
        };
      });
      console.error('DIAG', JSON.stringify(dump, null, 1));
    } catch {}
    if (pageErrors.length) console.error('erreurs page:', pageErrors.slice(0, 5));
  } finally {
    if (!HEADFUL) await browser.close();
    server.close();
  }

  const failed = steps.filter(s => !s.ok);
  console.log(`\n${steps.length - failed.length}/${steps.length} étapes OK`);
  process.exit(failed.length ? 1 : 0);
})();
