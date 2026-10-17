'use strict';

/**
 * haapi.js — Factory. Les deps puppeteer-core (pour le Shield
 * OAuth via browser) sont injectées depuis le bundle stakk.
 */

module.exports = function createHaapi(deps) {
  deps = deps || {};
  const puppeteer = deps.puppeteer || null; // injecté dans loginAndCreateApiKey si besoin

const https  = require('https');
const net    = require('net');
const tls    = require('tls');
const zlib   = require('zlib');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const {stringify} = require('querystring');

// ZAAP_VERSION est envoyé en User-Agent sur haapi.ankama.com. HAAPI peut
// rejeter (403 "Unauthorized service") toute version trop ancienne après une
// maintenance Ankama. On lit la version Zaap réellement installée chez l'user
// depuis %APPDATA%/zaap/application.log et on l'utilise — ça élimine le besoin
// de rebuild/re-push à chaque bump côté Ankama. Fallback sur la valeur bundlée
// si pas de Zaap officiel installé ou log illisible.
const ZAAP_VERSION_FALLBACK = '3.14.8';
function detectZaapVersion() {
  try {
    const appdata = process.env.APPDATA;
    if (!appdata) return null;
    const logPath = path.join(appdata, 'zaap', 'application.log');
    if (!fs.existsSync(logPath)) return null;
    // Lit la fin du log (max 512 KB) — suffit pour attraper le dernier démarrage.
    const size = fs.statSync(logPath).size;
    const readSize = Math.min(size, 512 * 1024);
    const fd = fs.openSync(logPath, 'r');
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, size - readSize);
    fs.closeSync(fd);
    const versions = [...buf.toString('utf8').matchAll(/Zaap (\d+)\.(\d+)\.(\d+)/g)]
      .map(m => [+m[1], +m[2], +m[3]]);
    if (versions.length === 0) return null;
    versions.sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2]);
    return versions[0].join('.');
  } catch { return null; }
}
const _detected = detectZaapVersion();
const ZAAP_VERSION = _detected || ZAAP_VERSION_FALLBACK;
console.log(`[haapi] ZAAP_VERSION=${ZAAP_VERSION} (${_detected ? 'détecté depuis application.log' : 'fallback bundled'})`);

// ─── Agent SOCKS5 ──────────────────────────────────────────────────────────────

class SocksHttpsAgent extends https.Agent {
  constructor(proxyUri) {
    super({ keepAlive: false });
    const m = proxyUri.match(/^socks5:\/\/([^:]+):(\d+)/);
    if (!m) throw new Error('Proxy URI invalide: ' + proxyUri);
    this._proxyHost = m[1];
    this._proxyPort = parseInt(m[2]);
  }
  createConnection(opts, callback) {
    const raw = net.connect(this._proxyPort, this._proxyHost);
    raw.once('connect', () => {
      raw.write(Buffer.from([0x05, 0x01, 0x00]));
      raw.once('data', greet => {
        if (greet[0] !== 0x05 || greet[1] !== 0x00) return callback(new Error('SOCKS5: auth refusée'));
        const host = Buffer.from(opts.host);
        const port = opts.port || 443;
        const req = Buffer.allocUnsafe(7 + host.length);
        req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x03;
        req[4] = host.length; host.copy(req, 5);
        req[5 + host.length] = (port >> 8) & 0xff;
        req[6 + host.length] = port & 0xff;
        raw.write(req);
        raw.once('data', resp => {
          if (resp[0] !== 0x05 || resp[1] !== 0x00) return callback(new Error('SOCKS5: connexion refusée'));
          const sock = tls.connect({ socket: raw, servername: opts.host, rejectUnauthorized: opts.rejectUnauthorized !== false });
          sock.once('secureConnect', () => callback(null, sock));
          sock.once('error', callback);
        });
      });
    });
    raw.once('error', callback);
    return raw;
  }
}

// ─── Requête HTTPS — copie exacte du request.js de krm35/dofus-multi ────────

function request(options, body, hostname) {
  options.headers = {
    accept:            '*/*',
    'accept-encoding': 'gzip,deflate',
    'accept-language': 'fr',
    connection:        'close',
    'user-agent':      'Zaap ' + ZAAP_VERSION,
    ...(options.headers || {}),
  };

  if (body) {
    options.headers['content-length'] = body.length;
    if (!options.headers['content-type']) options.headers['content-type'] = 'text/plain;charset=UTF-8';
  }

  return new Promise(resolve => {
    let data = '', buffer = [];
    const req = https.request({
      hostname: hostname || 'haapi.ankama.com',
      port: 443,
      ...options,
    }, res => {
      if (res.headers['content-encoding'] === 'gzip') {
        const gunzip = zlib.createGunzip();
        res.pipe(gunzip);
        gunzip.on('data', d => buffer.push(d.toString()));
        gunzip.on('end', () => {
          let json;
          try { json = JSON.parse(buffer.join('')); } catch {}
          resolve([false, json || buffer.join(''), res.headers]);
        });
        gunzip.on('error', () => resolve([true]));
      } else {
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try { resolve([false, JSON.parse(data), res.headers]); }
          catch { resolve([false, data.toString(), res.headers]); }
        });
        res.on('error', () => resolve([true]));
      }
    });
    req.on('error', err => { console.log(err); resolve([true, 'error']); });
    if (body) req.write(body);
    req.end();
  });
}

// ─── OAuth2 PKCE Login — copie exacte du router.js put-account de krm35 ────

const authHeaders = {
  'User-Agent':                'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
  'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language':           'fr,fr-FR;q=0.8,en-US;q=0.5,en;q=0.3',
  'content-type':              'application/x-www-form-urlencoded',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest':            'document',
  'Sec-Fetch-Mode':            'navigate',
  'Sec-Fetch-Site':            'same-origin',
  'Sec-Fetch-User':            '?1',
  'Pragma':                    'no-cache',
  'Cache-Control':             'no-cache',
};

function generateCodeVerifier() {
  const e = Math.floor(85 * Math.random() + 43);
  const t = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  let n = '';
  for (let r = 0; r < e; r++) n += t[Math.floor(Math.random() * t.length)];
  return n;
}

// Résolution cross-platform du browser Chromium pour Puppeteer. Tente
// Brave → Chrome → Chromium → Edge dans l'ordre, selon la plateforme.
// Retourne le 1er path existant ou null si aucun trouvé.
function resolveBrowserPath() {
  const fs = require('fs');
  const candidates = process.platform === 'darwin' ? [
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ] : process.platform === 'linux' ? [
    '/usr/bin/brave-browser', '/usr/bin/google-chrome',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
  ] : [
    // Windows
    'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
    'C:/Program Files (x86)/BraveSoftware/Brave-Browser/Application/brave.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

async function loginAndCreateApiKey(login, password, proxyUri) {
  const puppeteerLib = puppeteer || require('puppeteer-core');
  const path = require('path');

  const codeVerifier = generateCodeVerifier();
  const code_challenge = crypto.createHash('sha256').update(codeVerifier).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  // Étape 1 : URL du formulaire. Historiquement on faisait un HTTP GET
  // préliminaire pour suivre le redirect 302 d'Ankama, mais le serveur sert
  // maintenant directement la page de login (pas de redirect). On construit
  // donc l'URL directement — le browser fera le boulot (WAF, cookies…).
  const initPath = `/login/ankama?code_challenge=${code_challenge}&redirect_uri=zaap://login&client_id=102&direct=true&origin_tracker=https://www.ankama-launcher.com/launcher`;
  let formUrl = 'https://auth.ankama.com' + initPath;

  // Best-effort : si Ankama fait encore un redirect, on suit (garde compat
  // avec anciens déploiements). Sinon on continue avec l'URL de base.
  try {
    const initResult = await request(
      { method: 'GET', headers: authHeaders, path: initPath },
      null, 'auth.ankama.com'
    );
    const location = (initResult[2] || {}).location;
    if (location) {
      formUrl = location.startsWith('http') ? location : 'https://auth.ankama.com' + location;
      console.log('[auth] step1 redirect: OK');
    } else {
      console.log('[auth] step1: pas de redirect (serve direct, OK)');
    }
  } catch (e) {
    console.log(`[auth] step1 HTTP check échoué (${e.message}) — on continue sur URL directe`);
  }
  const userDataDir = path.join(__dirname, '..', 'cache', 'browser', login);

  const browserPath = resolveBrowserPath();
  if (!browserPath) {
    throw new Error('Aucun browser Chromium trouvé (Brave/Chrome/Chromium/Edge). Installe-en un et réessaye.');
  }
  console.log(`[auth] Ouverture du navigateur: ${browserPath}`);
  const browser = await puppeteerLib.launch({
    executablePath: browserPath,
    headless: false,
    userDataDir,
    args: ['--no-first-run', '--disable-features=BraveShields'],
  });

  const page = await browser.newPage();

  // Capture du code OAuth. Les URLs custom-protocol (zaap://) sont déléguées
  // par Chromium à l'OS avant que Puppeteer n'ait le temps de réagir côté
  // Network. On utilise CDP (DevTools Protocol) pour intercepter les
  // demandes de navigation AVANT qu'elles n'atteignent Chromium lui-même.
  let code = null;
  const setCode = (c) => {
    if (c && !code) { code = c; console.log('[auth] code capturé'); }
  };
  const extract = (u) => {
    const m = u && u.match(/code=([^&\s"'<>]+)/);
    return m ? m[1] : null;
  };

  const cdp = await page.target().createCDPSession();
  await cdp.send('Page.enable');
  cdp.on('Page.frameRequestedNavigation', (e) => {
    if (e.url && e.url.startsWith('zaap://')) setCode(extract(e.url));
  });
  cdp.on('Page.frameScheduledNavigation', (e) => {
    if (e.url && e.url.startsWith('zaap://')) setCode(extract(e.url));
  });

  await page.setRequestInterception(true);
  page.on('request', req => {
    const url = req.url();
    if (url.startsWith('zaap://')) { setCode(extract(url)); req.abort().catch(()=>{}); }
    else req.continue().catch(()=>{});
  });
  page.on('response', (response) => {
    try {
      const h = response.headers();
      const loc = h.location || h['Location'];
      if (loc && loc.startsWith('zaap://')) setCode(extract(loc));
    } catch {}
  });
  page.on('framenavigated', (frame) => {
    try { const u = frame.url(); if (u.startsWith('zaap://')) setCode(extract(u)); } catch {}
  });

  await page.goto(formUrl, { waitUntil: 'networkidle2' });

  // Remplir le formulaire automatiquement
  try {
    await page.waitForSelector('input[name="login"]', { timeout: 10000 });
    await page.type('input[name="login"]', login, { delay: 30 });
    await page.type('input[name="password"]', password, { delay: 30 });
    await page.click('button[type="submit"]');
  } catch (e) {
    console.log('[auth] Formulaire non trouvé, le user doit se connecter manuellement');
  }

  // Attendre le code. On poll agressivement en scannant :
  // - Tout le HTML (regex sur zaap://login?code=…)
  // - Tous les href des <a> et src des <iframe>
  // - Puis on clique AUTO sur le premier lien zaap:// trouvé — ça déclenche
  //   la navigation que notre CDP/interceptor capture avant l'OS.
  console.log('[auth] Attente de la connexion...');
  for (let i = 0; i < 240 && !code; i++) {
    await new Promise(r => setTimeout(r, 250));
    try {
      const scraped = await page.evaluate(() => {
        const body = document.body?.innerHTML || '';
        let m = body.match(/zaap:\/\/login\?code=([^"'&<\s]+)/);
        if (m) return { code: m[1] };
        for (const a of document.querySelectorAll('a[href]')) {
          const m2 = a.href.match(/zaap:\/\/login\?code=([^&\s]+)/);
          if (m2) return { code: m2[1], clickSelector: null };
        }
        for (const f of document.querySelectorAll('iframe')) {
          const m3 = (f.src || '').match(/zaap:\/\/login\?code=([^&\s]+)/);
          if (m3) return { code: m3[1] };
        }
        // Sinon, cherche un bouton "Continuer"/"Ouvrir" à cliquer
        for (const b of document.querySelectorAll('a, button')) {
          const txt = (b.textContent || '').toLowerCase();
          if (txt.includes('continuer') || txt.includes('ouvrir') || txt.includes('launcher') || txt.includes('continue') || txt.includes('open')) {
            b.click();
            return { clicked: txt.slice(0, 40) };
          }
        }
        return null;
      });
      if (scraped?.code) { if (!code) { code = scraped.code; console.log('[auth] code scrapé de la page'); } }
      else if (scraped?.clicked) { console.log('[auth] auto-click sur:', scraped.clicked); }
    } catch {}
  }

  await browser.close();
  console.log('[auth] Code:', code ? 'OK' : 'ÉCHOUÉ');

  if (!code) throw new Error('Login : code introuvable après redirect');
  console.log('[auth] Code OAuth obtenu');

  // Échanger le code contre un token
  const result = await request(
    { method: 'POST', headers: authHeaders, path: '/token' },
    stringify({ grant_type: 'authorization_code', code, redirect_uri: 'zaap://login', client_id: 102, code_verifier: codeVerifier }),
    'auth.ankama.com'
  );
  if (!result?.[1]?.access_token) throw new Error('Login : échange token échoué');
  console.log('[auth] Token OK');

  const APIKEY = result[1].access_token;
  const refreshToken = result[1].refresh_token;

  // Récupérer infos du compte
  const acctResult = await request(
    { path: '/json/Ankama/v5/Account/Account', method: 'GET', headers: { APIKEY } }
  );
  if (acctResult[0] || !acctResult[1]?.id) throw new Error('Login : impossible de récupérer le compte');

  return { key: APIKEY, accountId: acctResult[1].id, refreshToken, login: acctResult[1].login || login, security: acctResult[1].security };
}

// ─── Appels HAAPI ─────────────────────────────────────────────────────────────

function generateHashFromCertif(hm1, certif) {
  const hm2 = hm1.split('').reverse().join('');
  const i = crypto.createDecipheriv('aes-256-ecb', hm2, '');
  const r = Buffer.concat([i.update(certif.encodedCertificate, 'base64'), i.final()]);
  return crypto.createHash('sha256').update(hm1 + r.toString()).digest('hex');
}

async function refreshApiKey(key, refreshToken, proxyUri) {
  const agent = proxyUri ? new SocksHttpsAgent(proxyUri) : null;
  const [error, json] = await request(
    { agent, method: 'POST', path: '/json/Ankama/v5/Api/RefreshApiKey', headers: { APIKEY: key } },
    `refresh_token=${refreshToken}&long_life_token=true`
  );
  // Jamais le JSON brut : il contient la nouvelle clé et le refreshToken.
  console.log(`[haapi] refreshApiKey: ${!error && json && json.key ? 'OK' : 'échec'}${json && json.reason ? ` (${json.reason})` : ''}`);
  if (!error && json && json.key) return json.key;
  // Avant on retombait silencieusement sur l'ancienne clé — résultat : tout
  // appelant croyait avoir rafraîchi alors que la clé était morte (en
  // particulier autoRefreshKeys qui bumpait refreshDate sur du vide). On
  // throw maintenant ; les callers (web-server.autoRefreshKeys, zaap-server)
  // ont déjà un try/catch qui gère.
  const msg = (json && (json.message || json.error_description)) || 'refresh failed';
  const status = (json && json.status) || (error ? 'network' : 'unknown');
  throw new Error(`refreshApiKey: ${status} ${msg}`);
}

// Refresh complet avec fallback OAuth2 — utilisé par le plugin key-refresh.
// Retourne { key, refreshToken, rotated, source }. Throw si les deux
// endpoints refusent.
//
// Pourquoi deux voies :
//   1. /Api/RefreshApiKey (HAAPI) : prolonge la TTL de la clé existante. Plus
//      léger mais exige que la clé soit encore reconnue par Ankama. Quand
//      Ankama révoque le service ('Unauthorized service \\Ankama\\Api'),
//      cette voie est barrée même si le refresh_token est encore vivant.
//   2. /token (auth.ankama.com, grant_type=refresh_token) : rotate la paire
//      complète. N'exige PAS un APIKEY valide — c'est le grant OAuth2
//      standard. Marche tant que le refresh_token n'a pas été révoqué (par
//      logout du launcher, fresh login ailleurs, etc.).
async function refreshKeyPair(key, refreshToken, proxyUri) {
  const agent = proxyUri ? new SocksHttpsAgent(proxyUri) : null;

  // Voie 1 — HAAPI extend
  const r1 = await request(
    { agent, method: 'POST', path: '/json/Ankama/v5/Api/RefreshApiKey', headers: { APIKEY: key } },
    `refresh_token=${refreshToken}&long_life_token=true`
  );
  if (!r1[0] && r1[1] && r1[1].key) {
    return { key: r1[1].key, refreshToken, rotated: false, source: 'haapi' };
  }
  console.log('[haapi] refreshKeyPair: HAAPI échec, fallback OAuth2…');

  // Voie 2 — OAuth2 grant_type=refresh_token (rotate)
  const r2 = await request(
    { agent, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, path: '/token' },
    stringify({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: 102 }),
    'auth.ankama.com'
  );
  if (!r2[0] && r2[1] && r2[1].access_token) {
    return {
      key: r2[1].access_token,
      refreshToken: r2[1].refresh_token || refreshToken,
      rotated: true,
      source: 'oauth2',
    };
  }

  const m1 = (r1[1] && r1[1].message) || 'haapi failed';
  const m2 = (r2[1] && (r2[1].error_description || r2[1].error)) || 'oauth2 failed';
  throw new Error(`refreshKeyPair: HAAPI=${m1} | OAuth2=${m2}`);
}

async function createToken(key, gameId, proxyUri, cert, hm1) {
  const agent = proxyUri ? new SocksHttpsAgent(proxyUri) : null;
  let certId = '', certH = '';
  if (cert && hm1) {
    certId = cert.id;
    certH  = generateHashFromCertif(hm1, cert);
  }
  const [error, json] = await request(
    { agent, method: 'GET',
      path: `/json/Ankama/v5/Account/CreateToken?game=${gameId}&certificate_id=${certId}&certificate_hash=${certH}`,
      headers: { APIKEY: key } }
  );
  if (error || !json || !json.token) {
    throw new Error('createToken: pas de token — ' + JSON.stringify(json));
  }
  return json.token;
}

// Pré-auth identique à krm35/fake.js — crée une session sur les serveurs Ankama
async function preAuth(account, proxyUri) {
  const agent = proxyUri ? new SocksHttpsAgent(proxyUri) : null;
  const key = account.key;
  const localAddress = null;

  // 1. SignOnWithApiKey
  const [e1, session] = await request(
    { agent, localAddress, method: 'POST', path: '/json/Ankama/v5/Account/SignOnWithApiKey', headers: { APIKEY: key } },
    'game=102'
  );
  if (e1 || !session?.account) {
    console.log('[preAuth] SignOn failed:', JSON.stringify(session).slice(0, 200));
    return null;
  }
  console.log(`[preAuth] SignOn OK: ${session.account.login} (id=${session.account.id})`);

  // 2. ListWithApiKey
  const [e2, subs] = await request(
    { agent, localAddress, method: 'GET', path: '/json/Ankama/v5/Game/ListWithApiKey', headers: { APIKEY: key } }
  );

  // 3. RefreshApiKey — best-effort. refreshApiKey throw maintenant en cas
  // d'échec ; on swallow ici pour ne pas casser preAuth si Ankama refuse
  // l'extend mais accepte encore SignOn (état transitoire pendant rotation).
  //
  // Ankama ROTATE la clé à cet appel : celle qu'il renvoie remplace la
  // précédente, invalidée dans la foulée. On la reporte donc sur l'objet
  // compte — l'appelant réécrit ce même objet sur disque après le lancement,
  // sans quoi la session suivante repartirait avec une clé morte.
  try {
    const rotated = await refreshApiKey(key, account.refreshToken, proxyUri);
    if (rotated && rotated !== account.key) {
      console.log(`[preAuth] clé rotée par Ankama : ${String(account.key).slice(0, 8)}… → ${String(rotated).slice(0, 8)}…`);
      account.key = rotated;
      account.refreshDate = Date.now();
    }
  }
  catch (e) { console.log('[preAuth] RefreshApiKey skip:', e.message); }

  // 4. CreateToken (game=99, sans certificat — comme krm35)
  const [e4, token99] = await request(
    { agent, localAddress, method: 'GET',
      path: '/json/Ankama/v5/Account/CreateToken?game=99&certificate_id=&certificate_hash=',
      headers: { APIKEY: key } }
  );
  console.log(`[preAuth] CreateToken(99): ${!e4 && token99 && token99.token ? 'OK' : 'échec'}`);

  return { session, subscription: (subs && subs[0]) || {} };
}

  return { request, loginAndCreateApiKey, refreshApiKey, refreshKeyPair, createToken, generateHashFromCertif, SocksHttpsAgent, preAuth };
};
