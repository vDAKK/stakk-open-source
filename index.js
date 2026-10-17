'use strict';

const fs       = require('fs');
const path     = require('path');

// En mode pkg (exe compilé), désactiver stdout/stderr pour éviter
// que Windows ouvre une console à chaque écriture
if (process.pkg) {
  const noop = () => {};
  process.stdout.write = noop;
  process.stderr.write = noop;
  console.log = noop;
  console.error = noop;
  console.warn = noop;
  console.info = noop;
}
const { spawn }    = require('child_process');
const readline     = require('readline');
const { v4: uuidv4 } = require('uuid');
// Ces modules exportent une factory (deps) => api, pas l'api directement —
// même contrat que celui consommé par web-server.js via hotModules.getFactory.
// Chaque factory résout ses propres deps par défaut, d'où le `{}`.
const { startZaapServer, registerHash } = require('./lib/zaap-server')({});
const haapi = require('./lib/haapi')({});
const { importFromLauncher } = require('./lib/launcher-import')({});
const { createGameProxy } = require('./lib/game-proxy')({});
// frida-hook n'est PAS instancié ici : sur darwin il a besoin d'un import()
// ESM async (frida v17), impossible depuis un require() sync top-level. Les
// commandes qui en dépendent le chargent à la demande via loadFridaHook().
let _fridaHook = null;
async function loadFridaHook() {
  if (_fridaHook) return _fridaHook;
  let frida;
  if (process.platform === 'darwin') {
    // new Function pour échapper à la réécriture statique de ncc, cf.
    // le même contournement dans lib/web-server.js.
    const dynImport = new Function('m', 'return import(m)');
    const m = await dynImport('frida');
    frida = m.default || m;
  } else {
    frida = require('frida');
  }
  _fridaHook = require('./lib/frida-hook')({ frida });
  return _fridaHook;
}

// ─── Config ──────────────────────────────────────────────────────────────────

// APP_ROOT : dossier racine de stakk. Priorité env var → pkg → __dirname.
// Mac bytenode build : le launcher shell passe STAKK_APP_ROOT.
const APP_ROOT    = process.env.STAKK_APP_ROOT
  || (process.pkg ? path.dirname(process.execPath) : __dirname);
const DATA_DIR    = path.join(APP_ROOT, 'release', 'data');
const CONFIG_PATH = path.join(APP_ROOT, 'config.json');

// Dossiers d'installation. Résolution par plateforme via
// repositories.json du launcher Ankama (source de vérité), avec fallback
// sur les paths standards par OS si le fichier n'est pas dispo.
const HOME = process.env.HOME || process.env.USERPROFILE || '';
const ZAAP_BASE = process.platform === 'darwin'
  ? path.join(HOME, 'Library', 'Application Support', 'zaap')
  : path.join(process.env.APPDATA || '', 'zaap');
// Layout Mac observé (Ankama Launcher : /Applications/Ankama/<GameName>) —
// les clés matchent celles de Windows (%LOCALAPPDATA%\Ankama\<GameName>).
const FALLBACK_DIRS = process.platform === 'darwin'
  ? {
      retro:  '/Applications/Ankama/Retro',
      dofus3: '/Applications/Ankama/Dofus-dofus3',
      beta:   '/Applications/Ankama/Dofus-beta',
      experimental: '/Applications/Ankama/Dofus-experimental',
      wakfu:  '/Applications/Ankama/Wakfu',
    }
  : {
      retro:  path.join(process.env.LOCALAPPDATA || '', 'Ankama', 'Retro'),
      dofus3: path.join(process.env.LOCALAPPDATA || '', 'Ankama', 'Dofus-dofus3'),
      beta:   path.join(process.env.LOCALAPPDATA || '', 'Ankama', 'Dofus-beta'),
      experimental: path.join(process.env.LOCALAPPDATA || '', 'Ankama', 'Dofus-experimental'),
      wakfu:  path.join(process.env.LOCALAPPDATA || '', 'Ankama', 'Wakfu'),
    };
const ZAAP_NAMES = {
  retro:  ['retro', 'dofus-retro'],
  dofus3: ['dofus3', 'dofus-dofus3', 'dofus'],
  beta:   ['beta', 'dofus-beta'],
  experimental: ['experimental', 'dofus-experimental'],
  wakfu:  ['wakfu'],
};
function resolveGameDirs() {
  const dirs = { ...FALLBACK_DIRS };
  try {
    const f = path.join(ZAAP_BASE, 'repositories', 'repositories.json');
    if (!fs.existsSync(f)) return dirs;
    const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
    let byName = {};
    if (parsed.repositories && !Array.isArray(parsed.repositories) && typeof parsed.repositories === 'object') byName = parsed.repositories;
    else if (Array.isArray(parsed.repositories)) for (const r of parsed.repositories) if (r && r.name) byName[r.name] = r;
    else if (typeof parsed === 'object') byName = parsed;
    for (const [k, names] of Object.entries(ZAAP_NAMES)) {
      for (const n of names) {
        const e = byName[n];
        const loc = e && (e.location || e.path || e.dir);
        if (typeof loc === 'string' && loc) { dirs[k] = loc; break; }
      }
    }
  } catch {}
  return dirs;
}
const GAME_DIRS = resolveGameDirs();

const GAME_NAMES = {
  retro:  'retro',
  dofus3: 'dofus',
  beta:   'dofus',
  experimental: 'dofus',
  wakfu:  'wakfu',
};

// Exécutable relatif au gameDir. Sur Mac c'est le binaire DANS le .app bundle
// (pas le .app lui-même qui est un dossier). Pour Frida c'est ce qu'on spawn.
const GAME_EXES = process.platform === 'darwin'
  ? {
      retro:  'Dofus Retro.app/Contents/MacOS/Dofus Retro',
      dofus3: 'Dofus.app/Contents/MacOS/Dofus',
      beta:   'Dofus.app/Contents/MacOS/Dofus',
      experimental: 'Dofus.app/Contents/MacOS/Dofus',
      wakfu:  'Wakfu.app/Contents/MacOS/Wakfu',
    }
  : {
      retro:  'Dofus Retro.exe',
      dofus3: 'Dofus.exe',
      beta:   'Dofus.exe',
      experimental: 'Dofus.exe',
      wakfu:  'Wakfu.exe',
    };

// gameId Ankama pour CreateToken
const GAME_IDS = {
  retro:  1,
  dofus3: 1,
  beta:   1,
  experimental: 1,
  wakfu:  3,
};

// Canal passe au client Unity (--gameRelease) + suffixe du dossier de logs.
const DOFUS_RELEASES = { dofus3: 'dofus3', beta: 'beta', experimental: 'experimental' };

const LAUNCH_DELAY_MS = 3000;

// ─── Groupes & Proxy ─────────────────────────────────────────────────────────

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return { groups: [] }; }
}

function networkForAccount(accountId, groups) {
  for (const g of groups) {
    if (g.accounts && g.accounts.includes(accountId)) {
      const proxyUri = (g.proxy && g.proxy.type === 'socks5')
        ? `socks5://${g.proxy.host}:${g.proxy.port}` : null;
      return { proxyUri, localAddress: g.localAddress || null };
    }
  }
  return { proxyUri: null, localAddress: null };
}

// ─── Comptes ─────────────────────────────────────────────────────────────────

function loadAccounts() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs.readdirSync(DATA_DIR)
    .map(name => {
      try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')); }
      catch { return null; }
    })
    .filter(Boolean);
}

// ─── Lancement ───────────────────────────────────────────────────────────────

function ensureBat(gameDir) {
  const batPath = path.join(gameDir, 'zaap-start.bat');
  if (fs.existsSync(batPath)) return batPath;

  const exes = fs.readdirSync(gameDir).filter(f => {
    const l = f.toLowerCase();
    return l.endsWith('.exe') && !l.includes('crash') && !l.includes('unins');
  });
  if (!exes.length) throw new Error(`Aucun exe dans ${gameDir}`);

  const bat = [
    '@echo off',
    'set LOGFILE=dofus.%ACCOUNT_ID%.log',
    'set PREVLOGFILE=dofus.prev.%ACCOUNT_ID%.log',
    'if exist "%ZAAP_LOGS_PATH%" (',
    '  if exist "%ZAAP_LOGS_PATH%\\%PREVLOGFILE%" del "%ZAAP_LOGS_PATH%\\%PREVLOGFILE%"',
    '  if exist "%ZAAP_LOGS_PATH%\\%LOGFILE%" move /Y "%ZAAP_LOGS_PATH%\\%LOGFILE%" "%ZAAP_LOGS_PATH%\\%PREVLOGFILE%"',
    ')',
    `"${exes[0]}" --port=%ZAAP_PORT% --gameName=%ZAAP_GAME% --gameRelease=%ZAAP_RELEASE% --instanceId=%ZAAP_INSTANCE_ID% --gameInstanceKey=%ZAAP_HASH% %*`,
  ].join('\r\n');

  fs.writeFileSync(batPath, bat, 'utf8');
  console.log(`[Launch] Créé ${batPath}`);
  return batPath;
}

// Langue du client de jeu : même source que l'UI (~/.stakk/overlay/lang.json,
// écrit par le plugin overlay-backend). Dofus est publié en fr/en/es/pt, donc
// toute autre langue retombe sur l'anglais plutôt que d'envoyer un code que le
// client refuserait.
const GAME_LANGS = ['fr', 'en', 'es', 'pt'];
function gameLang() {
  try {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const file = path.join(home, '.stakk', 'overlay', 'lang.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (GAME_LANGS.includes(parsed.lang)) return parsed.lang;
    if (typeof parsed.lang === 'string' && /^[a-z]{2}$/.test(parsed.lang)) return 'en';
  } catch { /* jamais choisie → français */ }
  return 'fr';
}

async function launchAccount(accountData, gameKey, network) {
  const proxyUri = network?.proxyUri || null;
  const localAddress = network?.localAddress || null;
  const gameDir = GAME_DIRS[gameKey];
  if (!gameDir || !fs.existsSync(gameDir)) {
    console.error(`[!] Dossier jeu introuvable: ${gameDir}`);
    return;
  }

  // Zaap sur port 26616 comme krm35 — le jeu croit qu'il est sur 26116
  const { port: zaapPort } = await startZaapServer(26616);

  const hash       = uuidv4();
  const gameName   = GAME_NAMES[gameKey];
  const gameId     = GAME_IDS[gameKey];

  registerHash(hash, { ...accountData, proxy: proxyUri || null, gameId });

  console.log(`\n[Launch] ${accountData.login} → ${gameKey}${proxyUri ? ' [proxy]' : ''}`);
  console.log(`  zaap=${zaapPort}  hash=${hash.slice(0, 8)}…`);

  if (gameKey === 'retro') {
    // ── Retro (Electron) ─────────────────────────────────────────
    // Utilise zaap-start.bat + env vars + args Electron natifs
    let batPath;
    try { batPath = ensureBat(gameDir); }
    catch (e) { console.error(`[!] ${e.message}`); return; }

    const env = {
      ...process.env,
      ZAAP_PORT:        String(zaapPort),
      ZAAP_GAME:        gameName,
      ZAAP_RELEASE:     'main',
      ZAAP_INSTANCE_ID: '1',
      ZAAP_HASH:        hash,
      ZAAP_CAN_AUTH:    'true',
      ZAAP_LOGS_PATH:   path.join(gameDir, 'logs'),
      ACCOUNT_ID:       String(accountData.accountId),
    };

    const extraArgs = [];
    if (proxyUri) extraArgs.push(`--proxy-server=${proxyUri}`);

    const child = spawn(batPath, extraArgs, { cwd: gameDir, env, shell: true, detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', e => console.error(`[!] spawn error: ${e.message}`));
    child.unref();

  } else {
    // ── Dofus3 / Wakfu / Beta / Experimental (Unity) ─────────────
    // On utilise zaap-start.bat exactement comme le vrai Zaap :
    //   - env vars ZAAP_* (lues par le bat pour les logs)
    //   - args CLI passés via %* (lus par l'exe pour l'auth)
    //   - credentials.json (fallback lu par Unity)
    // Lancer Dofus.exe directement (comme le launcher officiel)
    const exePath = path.join(gameDir, 'Dofus.exe');
    if (!fs.existsSync(exePath)) {
      console.error(`[!] Dofus.exe introuvable dans ${gameDir}`);
      return;
    }

    // Le jeu est lancé avec --port=26116 — Frida redirige vers proxy → zaap(26616)
    const release = DOFUS_RELEASES[gameKey] || 'dofus3';
    const logsDir = path.join(process.env.APPDATA, 'zaap', 'gamesLogs', 'dofus-' + release);
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

    const exeArgs = [
      '--port', '26116', '--gameName', gameName, '--gameRelease', release,
      '--instanceId', '1', '--hash', hash,
      '--canLogin', 'true',
      '--logFile', path.join(logsDir, `dofus.${accountData.accountId}.log`),
      '--langCode', gameLang(), '--autoConnectType', '1', '--connectionPort', '5555',
      '--configUrl', 'https://dofus2.cdn.ankama.com/config/release_windows.json',
      '-force-d3d12',
    ];

    // Pré-auth identique à krm35 — crée une session avant de lancer le jeu
    try {
      await haapi.preAuth(accountData, proxyUri);
    } catch (e) {
      console.log(`[preAuth] Erreur (non bloquante): ${e.message}`);
    }

    const { launchWithFrida, generateFakeIdentity } = await loadFridaHook();
    const fakeId = generateFakeIdentity(accountData);

    // Démarrer un proxy local pour CHAQUE compte (comme krm35)
    let proxyHandle = null;
    try {
      proxyHandle = await createGameProxy({
        flashKey: fakeId.flashKey,
        localAddress: localAddress,
        proxyUri: proxyUri,
        zaapPort: zaapPort,
      });
      console.log(`[Proxy] Port ${proxyHandle.port} pour ${accountData.login} (flashKey=${fakeId.flashKey})`);
    } catch (e) {
      console.error(`[Proxy] Erreur: ${e.message}`);
    }

    const env = {
      ...process.env,
      ZAAP_PORT: '26116', ZAAP_GAME: gameName, ZAAP_RELEASE: release,
      ZAAP_INSTANCE_ID: '1', ZAAP_HASH: hash, ZAAP_CAN_AUTH: 'true',
      ZAAP_LOGS_PATH: logsDir, ACCOUNT_ID: String(accountData.accountId),
    };

    try {
      await launchWithFrida(exePath, exeArgs, { cwd: gameDir, env }, fakeId, proxyHandle?.port || 0);
    } catch (e) {
      console.error(`[!] Frida échoué (${e.message}) — lancement sans hook`);
      const child = spawn(exePath, exeArgs, { cwd: gameDir, env, detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', err => console.error(`[!] spawn error: ${err.message}`));
      child.unref();
    }
  }
}

const delay = ms => new Promise(r => setTimeout(r, ms));

// ─── Menu ─────────────────────────────────────────────────────────────────────

function printBanner() {
  console.log('\n  ┌─────────────────────────────────────┐');
  console.log('  │     Dofus Multi — sans Ankama       │');
  console.log('  └─────────────────────────────────────┘\n');
}

function printAccounts(accounts, groups) {
  if (!accounts.length) { console.log('  Aucun compte dans release/data/\n'); return; }
  console.log('  Comptes :');
  accounts.forEach((a, i) => {
    const net = networkForAccount(a.accountId, groups);
    const tag = net.proxyUri ? ' [proxy]' : net.localAddress ? ` [${net.localAddress}]` : '';
    console.log(`    [${i + 1}] ${a.login.padEnd(28)} id=${a.accountId}${tag}`);
  });
  console.log('');
}

async function launchList(accounts, gameKey, groups) {
  for (const acc of accounts) {
    await launchAccount(acc, gameKey, networkForAccount(acc.accountId, groups));
    await delay(LAUNCH_DELAY_MS);
  }
}

async function interactiveMenu() {
  const accounts = loadAccounts();
  const { groups } = loadConfig();
  printBanner();
  printAccounts(accounts, groups);
  console.log('  Jeux   : retro | dofus3 | beta | experimental | wakfu');
  console.log('  Cmds   : launch <n°|all> <jeu>   list   quit\n');

  const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => new Promise(r => rl.question(q, r));

  for (;;) {
    const input = (await ask('  > ')).trim();
    if (!input) continue;
    const parts = input.split(/\s+/);
    const cmd   = parts[0].toLowerCase();

    if (cmd === 'quit' || cmd === 'q' || cmd === 'exit') {
      console.log('  Ctrl+C pour tout arrêter.\n');
      rl.close(); return;
    }

    if (cmd === 'list') { printAccounts(accounts, groups); continue; }

    if (cmd === 'launch') {
      const target  = parts[1];
      const gameKey = (parts[2] || 'dofus3').toLowerCase();
      if (!GAME_DIRS[gameKey]) { console.log(`  Jeu inconnu. Dispo: ${Object.keys(GAME_DIRS).join(', ')}`); continue; }

      if (target === 'all') { await launchList(accounts, gameKey, groups); continue; }

      const idx = parseInt(target) - 1;
      if (isNaN(idx) || idx < 0 || idx >= accounts.length) {
        console.log(`  Numéro invalide (1-${accounts.length})`); continue;
      }
      const acc = accounts[idx];
      await launchAccount(acc, gameKey, networkForAccount(acc.accountId, groups));
      continue;
    }

    console.log('  Commande inconnue.');
  }
}

// ─── Login ──────────────────────────────────────────────────────────────────

async function loginAccounts(accounts) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => new Promise(r => rl.question(q, r));

  if (!accounts.length) {
    // Nouveau compte
    const login = await ask('Login (email ou pseudo) : ');
    const password = await ask('Mot de passe : ');
    try {
      const result = await haapi.loginAndCreateApiKey(login, password, null);
      const dataFile = path.join(DATA_DIR, String(result.accountId));
      const data = {
        key:          result.key,
        provider:     'ankama',
        refreshToken: result.refreshToken,
        isStayLoggedIn: true,
        accountId:    result.accountId,
        login,
        refreshDate:  Date.now(),
      };
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(dataFile, JSON.stringify(data, null, 4));
      console.log(`[Login] Compte ${login} ajouté (id=${result.accountId})`);
    } catch (e) {
      console.error(`[Login] ERREUR: ${e.message}`);
    }
    rl.close();
    return;
  }

  // Rafraîchir les comptes existants
  for (const acc of accounts) {
    console.log(`\n[Login] Compte: ${acc.login} (id=${acc.accountId})`);
    const password = await ask(`  Mot de passe pour ${acc.login}: `);
    if (!password) { console.log('  → ignoré'); continue; }

    try {
      const result = await haapi.loginAndCreateApiKey(acc.login, password, null);
      const dataFile = path.join(DATA_DIR, String(result.accountId));
      const data = { ...acc, key: result.key, refreshToken: result.refreshToken, refreshDate: Date.now() };
      fs.writeFileSync(dataFile, JSON.stringify(data, null, 4));
      console.log(`  → clé rafraîchie pour ${acc.login}`);
    } catch (e) {
      console.error(`  → ERREUR: ${e.message}`);
    }
  }
  rl.close();
}

// ─── Shield (fake fingerprint pour monocompte) ─────────────────────────────

function makeid(length) {
  let result = '';
  const chars = 'abcdef0123456789';
  for (let i = 0; i < length; i++) result += chars[Math.floor(Math.random() * chars.length)];
  return result;
}

async function shieldAccount(acc) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => new Promise(r => rl.question(q, r));
  const { stringify } = require('querystring');
  const { oauthViaBrowser } = require('./lib/oauth-browser')({ haapi });

  console.log(`\n[Shield] Compte: ${acc.login} (id=${acc.accountId})`);
  console.log('[Shield] Étape 1: Login OAuth frais via navigateur');
  console.log('[Shield] IMPORTANT: connecte-toi avec le compte ' + acc.login + '\n');

  // OAuth via navigateur avec protocole zaap://
  let tokenResp;
  try {
    tokenResp = await oauthViaBrowser();
  } catch (e) {
    console.error('[Shield] OAuth échoué:', e.message);
    rl.close(); return;
  }

  const APIKEY = tokenResp.access_token;
  const refreshToken = tokenResp.refresh_token;
  console.log('[Shield] Nouvelle clé API obtenue !');

  // Générer un faux fingerprint
  const hm1 = makeid(32);
  const hm2 = hm1.split('').reverse().join('');
  console.log('[Shield] Faux fingerprint généré');

  // Demander le code Shield par email
  console.log('[Shield] Envoi du code Shield par email...');
  await haapi.request(
    { method: 'GET', path: '/json/Ankama/v5/Shield/SecurityCode?transportType=EMAIL', headers: { APIKEY } }
  );

  const code = await ask('[Shield] Code reçu par email : ');
  if (!code.trim()) { console.log('[Shield] Annulé.'); rl.close(); return; }

  // Valider avec le faux hm1/hm2
  const query = stringify({
    game_id: '102', code: code.trim(), hm1, hm2,
    name: 'multi-' + makeid(8),
  });
  const [e2, r2] = await haapi.request(
    { method: 'GET', path: '/json/Ankama/v5/Shield/ValidateCode?' + query, headers: { APIKEY } }
  );

  if (e2 || !r2?.encodedCertificate) {
    console.error('[Shield] Validation échouée:', JSON.stringify(r2));
    rl.close(); return;
  }

  // Sauvegarder
  acc.key = APIKEY;
  acc.refreshToken = refreshToken;
  acc.certificate = r2;
  acc.hm1 = hm1;
  acc.hm2 = hm2;
  acc.refreshDate = Date.now();

  const dataFile = path.join(DATA_DIR, String(acc.accountId));
  fs.writeFileSync(dataFile, JSON.stringify(acc, null, 4));

  console.log(`\n[Shield] Nouveau certificat enregistré pour ${acc.login}`);
  console.log('[Shield] Ce compte a un certificat unique pour serveurs monocompte.');
  rl.close();
}

// ─── Mode CLI ─────────────────────────────────────────────────────────────────

async function cliMode(args) {
  const accounts = loadAccounts();
  const { groups } = loadConfig();
  const cmd = args[0];

  if (cmd === 'list') { printAccounts(accounts, groups); process.exit(0); }

  if (cmd === 'launch') {
    const target  = args[1];
    const gameKey = (args[2] || 'dofus3').toLowerCase();

    let toLoad;
    if (target === 'all') {
      toLoad = accounts;
    } else {
      // Support 1,2,3 ou juste 1
      const indices = target.split(',').map(s => parseInt(s.trim()) - 1);
      toLoad = indices.map(i => accounts[i]).filter(Boolean);
    }
    if (!toLoad.length) { console.error('Compte invalide'); process.exit(1); }

    await launchList(toLoad, gameKey, groups);
    console.log('\nServeur Zaap actif. Ctrl+C pour arrêter.');
    process.on('SIGINT', () => process.exit(0));
    return;
  }

  if (cmd === 'shield') {
    const idx = parseInt(args[1]) - 1;
    if (isNaN(idx) || !accounts[idx]) { console.error('Usage: node index.js shield <n°>'); process.exit(1); }
    await shieldAccount(accounts[idx]);
    process.exit(0);
  }

  if (cmd === 'login') {
    await loginAccounts(accounts);
    process.exit(0);
  }

  if (cmd === 'import') {
    const imported = importFromLauncher();
    if (!imported.length) { console.log('Aucun compte trouvé dans le launcher.'); process.exit(1); }
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    for (const acc of imported) {
      const file = path.join(DATA_DIR, String(acc.accountId));
      // Conserver les préférences existantes (proxy, alias, etc.)
      let existing = {};
      try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      const merged = { ...existing, ...acc, refreshDate: Date.now() };
      fs.writeFileSync(file, JSON.stringify(merged, null, 4));
      console.log(`[Import] Sauvegardé: ${acc.login || acc.accountId}`);
    }
    console.log(`\n${imported.length} compte(s) importé(s). Relance avec: node index.js launch 1 dofus3`);
    process.exit(0);
  }

  if (cmd === 'web') {
    const { startWebServer } = require('./lib/web-server');
    startWebServer();
    return;
  }

  console.error('Usage: node index.js [web | list | launch <n°|all> <jeu> | import | login | diag]');
  process.exit(1);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const cliArgs = process.argv.slice(2);
if (cliArgs[0] === 'diag') {
  // Rapport d'environnement one-shot. Court-circuite cliMode() qui charge la
  // config et les comptes — justement ce qui peut être cassé sur Mac.
  require('./lib/diag').runDiag()
    .then(() => process.exit(0))
    .catch(e => { console.error(e); process.exit(1); });
} else if (cliArgs.length > 0) {
  cliMode(cliArgs).catch(e => { console.error(e.message); process.exit(1); });
} else {
  // Ouvrir l'URL — cross-platform
  function openURL(url) {
    const { spawn } = require('child_process');
    const platform = process.platform;
    if (platform === 'win32') {
      spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  }

  // Par défaut : lancer l'API locale + ouvrir l'interface dans le navigateur.
  // Si le port est déjà pris → une instance tourne déjà, juste réouvrir la page et quitter.
  const UI_URL = 'http://localhost:3000/';
  const { startWebServer } = require('./lib/web-server');
  startWebServer((err) => {
    if (err && err.code === 'EADDRINUSE') {
      openURL(UI_URL);
      setTimeout(() => process.exit(0), 500);
    }
  });

  if (!process.env.STAKK_NO_BROWSER) setTimeout(() => openURL(UI_URL), 1000);
}
