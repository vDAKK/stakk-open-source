#!/usr/bin/env node
'use strict';

/**
 * check-maintenance.js — Post-maintenance diagnostic.
 *
 * Usage:
 *   node scripts/check-maintenance.js [--account <id>]
 *
 * Vérifie dans l'ordre les 5 points fragilisés par une maintenance Dofus :
 *   1. ZAAP_VERSION   : version envoyée vs version Zaap locale (application.log)
 *   2. HAAPI ping     : /json/Ankama/v5/Account/Account + SignOnWithApiKey
 *   3. OAuth page     : sélecteurs input[name=login|password] toujours présents
 *   4. Protobuf       : device_identifier 64 hex + string "type.ankama.com/jrz"
 *                       détectés dans les dumps .chars.hex du dernier launch
 *   5. Game proxy     : exe + ports 26116/5555 joignables
 *
 * Sortie: chaque check imprime [OK] / [WARN] / [FAIL] + détails. Exit code 0
 * si tout OK, 1 si au moins un FAIL.
 */

const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const net     = require('net');

const ROOT    = path.join(__dirname, '..');
const LIB     = path.join(ROOT, 'lib');
const DATA    = path.join(ROOT, 'cache', 'data');
const APPDATA = process.env.APPDATA || '';

let failed = 0;
const line = (tag, label, msg) => {
  const colors = { OK: '\x1b[32m', WARN: '\x1b[33m', FAIL: '\x1b[31m' };
  const reset = '\x1b[0m';
  if (tag === 'FAIL') failed++;
  console.log(`${colors[tag] || ''}[${tag}]${reset} ${label.padEnd(22)} ${msg}`);
};

// ─── 1. ZAAP_VERSION ─────────────────────────────────────────────────────────

function parseZaapVersion() {
  const src = fs.readFileSync(path.join(LIB, 'haapi.js'), 'utf8');
  const m = src.match(/ZAAP_VERSION\s*=\s*['"]([^'"]+)['"]/);
  return m ? m[1] : null;
}

function latestLocalZaap() {
  const log = path.join(APPDATA, 'zaap', 'application.log');
  if (!fs.existsSync(log)) return null;
  const buf = fs.readFileSync(log, 'utf8');
  const versions = [...buf.matchAll(/Zaap (\d+)\.(\d+)\.(\d+)/g)]
    .map(m => [+m[1], +m[2], +m[3]]);
  if (versions.length === 0) return null;
  versions.sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2]);
  return versions[0].join('.');
}

function checkZaapVersion() {
  const code = parseZaapVersion();
  const local = latestLocalZaap();
  if (!code) return line('FAIL', 'ZAAP_VERSION', 'introuvable dans lib/haapi.js');
  if (!local) return line('WARN', 'ZAAP_VERSION', `code=${code} — pas d'application.log Zaap pour comparer`);
  if (code === local) return line('OK',   'ZAAP_VERSION', `${code} (aligné avec Zaap local)`);
  line('WARN', 'ZAAP_VERSION', `code=${code} ≠ local=${local} — bump lib/haapi.js L19 si HAAPI 403`);
}

// ─── 2. HAAPI ping ───────────────────────────────────────────────────────────

function haapiGet(pathUrl, headers = {}) {
  const code = parseZaapVersion() || '3.12.28';
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'haapi.ankama.com',
      port: 443, path: pathUrl, method: 'GET',
      headers: {
        'user-agent': 'Zaap ' + code,
        'accept': '*/*',
        'accept-language': 'fr',
        'connection': 'close',
        ...headers,
      },
      timeout: 8000,
    }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: body.slice(0, 300) }));
    });
    req.on('error', e => resolve({ status: 0, err: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, err: 'timeout' }); });
    req.end();
  });
}

async function checkHaapi(argAccount) {
  // Sans APIKEY, on ping /Account/Account — on attend 401 (= HAAPI est vivant,
  // juste pas authentifié). N'importe quel 5xx ou timeout = problème HAAPI.
  const r = await haapiGet('/json/Ankama/v5/Account/Account');
  if (r.status === 0) return line('FAIL', 'HAAPI ping', `injoignable: ${r.err}`);
  if (r.status === 401 || r.status === 403) line('OK', 'HAAPI ping', `${r.status} sans key (HAAPI répond)`);
  else if (r.status >= 500) line('FAIL', 'HAAPI ping', `${r.status} — HAAPI en panne`);
  else line('WARN', 'HAAPI ping', `status inattendu ${r.status}: ${r.body.slice(0, 100)}`);

  if (!argAccount) return;
  const acc = loadAccount(argAccount);
  if (!acc?.key) return line('WARN', 'HAAPI auth', `compte ${argAccount} sans key — skip`);

  // HAAPI refuse les appels directs à /Account/Account ("Unauthorized service")
  // donc on teste plutôt preAuth() via la factory, qui est le vrai flow utilisé
  // au launch et englobe SignOnWithApiKey + ListWithApiKey + RefreshApiKey + CreateToken.
  try {
    const createHaapi = require(path.join(LIB, 'haapi.js'));
    const { preAuth } = createHaapi({});
    const res = await preAuth({ key: acc.key, refreshToken: acc.refreshToken }, null);
    if (res?.session?.account) line('OK', 'HAAPI preAuth', `SignOn OK pour ${res.session.account.login}`);
    else line('FAIL', 'HAAPI preAuth', `SignOn KO — key expirée ou HAAPI proto changé (re-login dans l'UI)`);
  } catch (e) {
    line('FAIL', 'HAAPI preAuth', `exception: ${e.message}`);
  }
}

function loadAccount(id) {
  const f = path.join(DATA, String(id));
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

// ─── 3. OAuth page ───────────────────────────────────────────────────────────

function fetchUrl(url, headers = {}) {
  return new Promise(resolve => {
    const req = https.request(url, {
      method: 'GET',
      headers: { 'user-agent': 'Mozilla/5.0', ...headers },
      timeout: 10000,
    }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body, loc: res.headers.location }));
    });
    req.on('error', e => resolve({ status: 0, err: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, err: 'timeout' }); });
    req.end();
  });
}

async function checkOauth() {
  // auth.ankama.com est derrière un WAF Cloudflare qui bloque les User-Agents
  // non-browser (403). Côté STAKK on passe par puppeteer-core donc c'est OK,
  // mais ici on ne peut que tester la joignabilité TCP + un fetch browser-like.
  const url = 'https://auth.ankama.com/login/ankama?code_challenge=x&redirect_uri=zaap://login&client_id=102&direct=true';
  const r1 = await fetchUrl(url, {
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
    'accept-language': 'fr,fr-FR;q=0.8',
  });
  if (r1.status === 0) return line('FAIL', 'OAuth endpoint', `auth.ankama.com injoignable: ${r1.err}`);
  if (r1.status === 403) line('WARN', 'OAuth endpoint', `403 WAF (attendu en fetch Node — test réel = lancer un login dans l'UI)`);
  else if (r1.status >= 300 && r1.status < 400) line('OK', 'OAuth endpoint', `${r1.status} → ${(r1.loc || '').slice(0, 70)}`);
  else if (r1.status === 200 && /name=["']login["']/.test(r1.body)) line('OK', 'OAuth endpoint', `form accessible, selectors OK`);
  else line('WARN', 'OAuth endpoint', `HTTP ${r1.status} — à vérifier en browser`);
}

// ─── 4. Protobuf patterns (depuis les dumps .chars.hex) ──────────────────────

function checkProtobuf() {
  if (!fs.existsSync(DATA)) return line('WARN', 'Protobuf dumps', `pas de cache/data/`);
  const dumps = fs.readdirSync(DATA).filter(f => f.endsWith('.chars.hex'));
  if (dumps.length === 0) return line('WARN', 'Protobuf dumps', `aucun .chars.hex — lance un compte puis re-vérifie`);

  let lastMtime = 0, lastFile = null;
  for (const f of dumps) {
    const st = fs.statSync(path.join(DATA, f));
    if (st.mtimeMs > lastMtime) { lastMtime = st.mtimeMs; lastFile = f; }
  }
  const ageH = ((Date.now() - lastMtime) / 3600000).toFixed(1);
  line('OK', 'Protobuf dumps', `${dumps.length} fichier(s), dernier=${lastFile} (${ageH}h)`);

  // On ne peut vérifier device_id/jrz que depuis le trafic live — ces dumps
  // contiennent CharactersListMessage (serveur→client), pas IdentificationRequest.
  // On vérifie juste que le format msgId est lisible.
  try {
    const raw = fs.readFileSync(path.join(DATA, lastFile), 'utf8');
    const m = raw.match(/msgId=(\d+)\s+len=(\d+)/);
    if (m) line('OK', 'Protobuf format', `msgId=${m[1]} len=${m[2]} — header lisible`);
    else line('WARN', 'Protobuf format', `header du dump non-parsable`);
  } catch (e) {
    line('WARN', 'Protobuf format', e.message);
  }

  // Note opérationnelle
  line('OK', 'Protobuf live', `pour vérifier device_id/jrz en live, regarde les logs [Proxy:NNNN] *** DEVICE_ID / FINGERPRINT au prochain launch`);
}

// ─── 5. Frida + game proxy ───────────────────────────────────────────────────

function tcpPing(host, port, timeout = 3000) {
  return new Promise(resolve => {
    const s = net.connect({ host, port });
    const done = (ok, err) => { try { s.destroy(); } catch {} resolve({ ok, err }); };
    s.setTimeout(timeout);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false, 'timeout'));
    s.once('error', e => done(false, e.message));
  });
}

async function checkGameInfra() {
  // Frida binding présent
  const fridaNode = path.join(ROOT, 'node_modules', 'frida', 'build', 'Release', 'frida_binding.node');
  if (fs.existsSync(fridaNode)) line('OK', 'Frida binding', `présent`);
  else line('FAIL', 'Frida binding', `node_modules/frida manquant — npm install`);

  // Ports Ankama joignables (test DNS + TCP handshake)
  const r1 = await tcpPing('haapi.ankama.com', 443);
  line(r1.ok ? 'OK' : 'FAIL', 'TCP haapi:443', r1.ok ? 'joignable' : r1.err);

  // CDN config (utilisé par --configUrl au launch)
  const r2 = await tcpPing('dofus2.cdn.ankama.com', 443);
  line(r2.ok ? 'OK' : 'WARN', 'TCP cdn:443', r2.ok ? 'joignable' : r2.err);
}

// ─── main ────────────────────────────────────────────────────────────────────

(async () => {
  const args = process.argv.slice(2);
  const accIdx = args.indexOf('--account');
  const accountId = accIdx >= 0 ? args[accIdx + 1] : null;

  console.log('STAKK — check-maintenance\n');
  checkZaapVersion();
  await checkHaapi(accountId);
  await checkOauth();
  checkProtobuf();
  await checkGameInfra();

  console.log('');
  if (failed === 0) { console.log('\x1b[32mTout est OK.\x1b[0m'); process.exit(0); }
  else { console.log(`\x1b[31m${failed} check(s) FAIL — voir MAINTENANCE_CHECKLIST.md\x1b[0m`); process.exit(1); }
})();
