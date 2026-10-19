'use strict';

const http = require('http');
const https = require('https');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const net = require('net');
const { parse: parseUrl } = require('url');
const plugins = require('./plugins');
// Modules cœur : factories pures, instanciées au démarrage par ensureFactories().
const bundled = {
  'zaap-server':     require('./zaap-server'),
  'haapi':           require('./haapi'),
  'retro-hook':      require('./retro-hook'),
  'frida-hook':      require('./frida-hook'),
  'game-proxy':      require('./game-proxy'),
  'launcher-import': require('./launcher-import'),
  'dt-clone':        require('./dt-clone'),
  'oauth-browser':   require('./oauth-browser'),
  // Socle d'apprentissage de protocole, partagé par les briques FM (et, à
  // venir, prix d'hôtel de vente et récolte). Pas un plugin : aucune route.
  'protocol-learn':  require('./protocol-learn'),
  // Briques de la Forgemagie. Ce ne sont pas des plugins (elles n'enregistrent
  // ni route ni listener) mais des factories pures consommées par le plugin
  // `fm` via la deps bag — un plugin ne require() pas ses voisins.
  'fm-data':         require('./fm-data'),
  'fm-engine':       require('./fm-engine'),
  'fm-protocol':     require('./fm-protocol'),
  'fm-live':         require('./fm-live'),
  'fm-weights':      require('./fm-weights'),
  'chasse-protocol': require('./chasse-protocol'),
};
// Deps natives à injecter dans les factories (binding natif, ou pkg-bound).
//
// Frida : Windows = v15 (CJS, packagée par pkg), Mac = v17 (ESM, requis pour
// supporter le dyld moderne de macOS Tahoe / Sequoia). Le bundle ncc du build
// Mac enveloppe systématiquement `import('frida')` dans un stub webpack qui
// finit par faire `require('frida')` — ce qui throw ERR_REQUIRE_ESM côté ESM.
// Pour bypass cette transformation, on utilise `new Function('return import')`
// qui crée la fonction dans le scope global Node et échappe à la réécriture
// statique de ncc. Sur Windows on garde require() direct (compatible pkg).
let frida = null;
async function loadFrida() {
  if (frida) return frida;
  if (process.platform === 'darwin') {
    const dynImport = new Function('m', 'return import(m)');
    const m = await dynImport('frida');
    frida = m.default || m;
  } else {
    frida = require('frida');
  }
  return frida;
}
const puppeteerCore = (() => { try { return require('puppeteer-core'); } catch { return null; } })();
const { machineIdSync } = require('./machine-id');

// Les APIs résolues au démarrage par ensureFactories().
let startZaapServer = null;
let registerHash = null;
let haapi = null;
let launchWithFrida = null;
let generateFakeIdentity = null;
let launchRetroWithFrida = null;
let createGameProxy = null;
let setCharacterUpdateHandler = null;
let setMapUpdateHandler = null;
// Tap paquets du canal jeu — exposé aux plugins (fm.js). Peut rester null si
// game-proxy ne l'expose pas.
let setPacketHandler = null;
let getGameChannel = null;
// Factories FM injectées au plugin `fm` (cf. bundled ci-dessus).
let createFmData = null;
let createFmEngine = null;
let createFmProtocol = null;
let createFmLive = null;
let createFmWeights = null;
let createProtocolLearn = null;
// Messages de la chasse au trésor, injectés au plugin `chasse`.
let createChasseProtocol = null;
// Schéma protobuf, dictionnaire de sens et graphe du monde : trois tables
// compressées, transmises aux plugins par la deps bag. Chargées
// PARESSEUSEMENT — mesuré, les décompresser et les indexer coûte 8,7 Mo de tas, et un utilisateur qui ne chasse jamais n'a
// pas à les payer au démarrage.
let _dofusSchema = null, _dofusNoms = null, _monde = null;
const dofusSchema = () => _dofusSchema || (_dofusSchema = require('./dofus-schema')());
const dofusNoms = () => _dofusNoms || (_dofusNoms = require('./dofus-noms')({ schema: dofusSchema() }));
const mondeDofus = () => _monde || (_monde = require('./monde')());
// Résolveur d'indices de chasse (appelle api.dofusdb.fr), injecté au plugin
// chasse. Pas une table : une factory, comme les briques FM.
const createChasseIndices = require('./chasse-indices');

// NB: toute la logique overlay (accountMapState, dofusdb cache, spawn
// sidecar, routes /api/map-* et /api/overlay/*) vit dans le
// plugin lib/overlay-backend.js.
let importFromLauncher = null;
let bootImportCount = 0;
let dtClone = null;
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const CURRENT_VERSION = require('../package.json').version;

// APP_ROOT : env var (Mac bytenode launcher), pkg execPath, ou __dirname (dev).
const APP_ROOT   = process.env.STAKK_APP_ROOT
  || (process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..'));
const DATA_DIR    = path.join(APP_ROOT, 'release', 'data');
const CONFIG_PATH = path.join(APP_ROOT, 'config.json');
const WEB_PORT    = 3000;
const LAUNCH_DELAY = 3000;

// Source de vérité pour la résolution des installs de jeu : le launcher
// Ankama (Zaap) maintient un `repositories/repositories.json` qui liste
// chaque jeu installé avec son chemin absolu. Ça évite de hardcoder des
// paths par plateforme qui tombent en vrac au prochain patch Ankama.
const _HOME = process.env.HOME || process.env.USERPROFILE || '';
const _ZAAP_BASE = process.platform === 'darwin'
  ? path.join(_HOME, 'Library', 'Application Support', 'zaap')
  : path.join(process.env.APPDATA || '', 'zaap');
const _REPOS_JSON = path.join(_ZAAP_BASE, 'repositories', 'repositories.json');

// ─── Langue du client de jeu ─────────────────────────────────────────────────
// La langue choisie dans l'UI est écrite par le plugin overlay-backend dans
// ~/.stakk/overlay/lang.json. On la relit au lancement pour démarrer le jeu
// dans la même langue que STAKK, au lieu du français figé.
//
// Les clients n'ont pas tous les mêmes langues : Dofus 3 et Dofus Retro sont
// publiés en fr/en/es/pt (l'allemand a disparu avec la fermeture des serveurs
// DE). Une langue absente retombe donc sur l'anglais plutôt que d'envoyer un
// code que le client refuserait.
const UI_LANG_FILE = path.join(_HOME, '.stakk', 'overlay', 'lang.json');
const GAME_LANGS = { dofus3: ['fr', 'en', 'es', 'pt'], beta: ['fr', 'en', 'es', 'pt'], experimental: ['fr', 'en', 'es', 'pt'], retro: ['fr', 'en', 'es', 'pt'] };
function uiLang() {
  try {
    const parsed = JSON.parse(fs.readFileSync(UI_LANG_FILE, 'utf8'));
    if (typeof parsed.lang === 'string' && /^[a-z]{2}$/.test(parsed.lang)) return parsed.lang;
  } catch { /* jamais choisie → français */ }
  return 'fr';
}
function gameLang(gameKey) {
  const wanted = uiLang();
  const supported = GAME_LANGS[gameKey] || ['fr'];
  return supported.includes(wanted) ? wanted : 'en';
}

// Mapping du "game key" STAKK (retro/dofus3/beta/wakfu) vers le "name" qu'on
// retrouve dans repositories.json (clé interne Zaap).
const _ZAAP_GAME_KEYS = {
  retro:  ['retro', 'dofus-retro'],
  dofus3: ['dofus3', 'dofus-dofus3', 'dofus'],
  beta:   ['beta', 'dofus-beta'],
  experimental: ['experimental', 'dofus-experimental'],
  wakfu:  ['wakfu'],
};

// Guesses par plateforme si repositories.json ne rend rien d'exploitable
// (launcher jamais lancé, format changé, corruption…).
const _FALLBACK_DIRS = process.platform === 'darwin'
  ? {
      // Layout Mac observé : /Applications/Ankama/<GameName>/ (mêmes clés
      // que %LOCALAPPDATA%\Ankama\<GameName>\ côté Windows).
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

function resolveGameDirs() {
  const dirs = { ..._FALLBACK_DIRS };
  try {
    if (!fs.existsSync(_REPOS_JSON)) return dirs;
    const raw = fs.readFileSync(_REPOS_JSON, 'utf8');
    const parsed = JSON.parse(raw);
    // repositories.json a plusieurs formats possibles selon version Zaap :
    //   { repositories: { "<name>": { location: "...", ... } } }
    //   { "<name>": { location: "..." } }
    //   ou un array { repositories: [ { name, location } ] }.
    // On normalise en un dict { name → location }.
    let byName = {};
    if (parsed.repositories && !Array.isArray(parsed.repositories) && typeof parsed.repositories === 'object') {
      byName = parsed.repositories;
    } else if (Array.isArray(parsed.repositories)) {
      for (const r of parsed.repositories) {
        if (r && r.name) byName[r.name] = r;
      }
    } else if (typeof parsed === 'object') {
      byName = parsed;
    }
    for (const [stakkKey, zaapNames] of Object.entries(_ZAAP_GAME_KEYS)) {
      for (const name of zaapNames) {
        const entry = byName[name];
        const loc = entry && (entry.location || entry.path || entry.dir);
        if (typeof loc === 'string' && loc) {
          dirs[stakkKey] = loc;
          break;
        }
      }
    }
  } catch (e) {
    // Silencieux : on retombe sur les fallbacks.
  }
  return dirs;
}

const GAME_DIRS = resolveGameDirs();
const GAME_IDS = { retro: 1, dofus3: 1, beta: 1, experimental: 1, wakfu: 3 };
// Clients Unity Dofus : meme exe, meme flow de lancement, seul le canal
// (--gameRelease) et le dossier de logs changent.
const DOFUS_RELEASES = { dofus3: 'dofus3', beta: 'beta', experimental: 'experimental' };
const GAME_NAMES = { retro: 'retro', dofus3: 'dofus', beta: 'dofus', experimental: 'dofus', wakfu: 'wakfu' };
// Exécutable relatif au gameDir. Sur Mac c'est le binaire DANS le .app bundle
// (pas le .app lui-même qui est un dossier) — nécessaire pour Frida spawn.
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

// ─── Data helpers ────────────────────────────────────────────────────────────

function loadAccounts() {
  if (!fs.existsSync(DATA_DIR)) return [];
  // Les fichiers d'accounts sont nommés <accountId> (numérique, sans ext).
  // Tout le reste (dumps .chars.hex, overlay-bounds.json, sous-dossiers…)
  // est filtré avant parsing pour éviter les "comptes fantômes" dans l'UI.
  return fs.readdirSync(DATA_DIR)
    .filter(f => /^\d+$/.test(f))
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch { return null; } })
    .filter(Boolean);
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return { groups: [] }; }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// Un groupe peut cibler certains jeux uniquement via `games: ['retro', ...]`.
// `games` vide/absent = applique à tous les jeux (comportement historique).
// Quand gameKey est fourni, on ne considère que les groupes qui matchent —
// ça permet à un compte d'avoir un réseau différent selon le jeu lancé.
function networkForAccount(accountId, groups, gameKey) {
  for (const g of groups) {
    if (!g.accounts || !g.accounts.includes(accountId)) continue;
    const gameFilter = Array.isArray(g.games) ? g.games : [];
    if (gameKey && gameFilter.length && !gameFilter.includes(gameKey)) continue;
    const proxyUri = (g.proxy && g.proxy.type === 'socks5') ? `socks5://${g.proxy.host}:${g.proxy.port}` : null;
    return { proxyUri, localAddress: g.localAddress || null, groupName: g.name };
  }
  return { proxyUri: null, localAddress: null, groupName: null };
}

function getInterfaces() {
  const ifaces = os.networkInterfaces();
  const res = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (/vmware|virtual|qemu/i.test(name)) continue;
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal) res.push({ name, address: a.address, mac: a.mac });
    }
  }
  return res;
}

// ─── Game launch ─────────────────────────────────────────────────────────────

const launchLog = [];
// Un même compte peut tourner sur plusieurs jeux en parallèle (Dofus 3 +
// Retro par exemple). On indexe par clé composite "<accountId>:<gameKey>"
// pour tracker chaque instance indépendamment.
const runningPids = {}; // "<accountId>:<gameKey>" → pid
const runningHandles = {}; // "<accountId>:<gameKey>" → { fridaHandle, proxyHandle }

const runKey = (accountId, gameKey) => `${accountId}:${gameKey}`;
function runningGamesFor(accountId) {
  const prefix = accountId + ':';
  return Object.keys(runningPids)
    .filter(k => k.startsWith(prefix))
    .map(k => k.slice(prefix.length));
}

async function cleanupAccount(accountId, gameKey) {
  // Compat : si appelé avec un seul arg qui est déjà une clé composite
  const key = gameKey ? runKey(accountId, gameKey) : (accountId.includes(':') ? accountId : null);
  if (!key) return;
  const h = runningHandles[key];
  delete runningPids[key];
  delete runningHandles[key];
  if (!h) return;
  try { await h.fridaHandle?.cleanup?.(); } catch {}
  try { await h.proxyHandle?.close?.(); } catch {}
}

// (Le watcher PowerShell force-show a été remplacé par le hook Frida
// dans retro-hook.js qui patche CreateWindowEx + ShowWindow directement
// dans le process de Retro, bien plus fiable.)

// Sanity check périodique: tuer les handles dont le PID n'existe plus
setInterval(() => {
  for (const [key, pid] of Object.entries(runningPids)) {
    try { process.kill(pid, 0); } catch { cleanupAccount(key); }
  }
}, 5000).unref?.();
function log(msg) { const line = `[${new Date().toLocaleTimeString()}] ${msg}`; launchLog.push(line); if (launchLog.length > 500) launchLog.shift(); _origLog(line); }

// Intercepter TOUS les console.log pour les capturer dans launchLog
const _origLog = console.log.bind(console);
const _origErr = console.error.bind(console);
console.log = (...args) => {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  const line = msg.startsWith('[') ? msg : `[${new Date().toLocaleTimeString()}] ${msg}`;
  if (!launchLog.includes(line)) { launchLog.push(line); if (launchLog.length > 500) launchLog.shift(); }
  _origLog(...args);
};
console.error = (...args) => {
  const msg = args.map(a => typeof a === 'string' ? a : (a?.message || JSON.stringify(a))).join(' ');
  const line = `[${new Date().toLocaleTimeString()}] [ERROR] ${msg}`;
  launchLog.push(line); if (launchLog.length > 500) launchLog.shift();
  _origErr(...args);
};

// ─── Plugin framework ────────────────────────────────────────────────────────
//
// Un plugin est un module chargé par plugins.loadPlugins() (intégré dans lib/
// ou déposé dans <APP_ROOT>/plugins/). Sa factory est invoquée avec la deps bag
// ci-dessous. Le plugin peut alors brancher des handlers sur les events
// lifecycle (launch/detach/ready) et enregistrer des routes HTTP via
// registerRoute(). Ajouter une feature (organizer, stats…) = écrire un plugin,
// sans toucher au cœur.

const _pluginListeners = { launch: [], detach: [], ready: [], 'accounts-imported': [] };
function on(event, handler) {
  const arr = _pluginListeners[event];
  if (!arr) throw new Error(`unknown plugin event: ${event}`);
  arr.push(handler);
  return () => { const i = arr.indexOf(handler); if (i >= 0) arr.splice(i, 1); };
}
function emit(event, payload) {
  const arr = _pluginListeners[event] || [];
  for (const h of arr) {
    try { Promise.resolve(h(payload)).catch(e => log(`[plugin] ${event} handler err: ${e.message}`)); }
    catch (e) { log(`[plugin] ${event} handler sync err: ${e.message}`); }
  }
}
function registerRoute(method, pathStr, handler) {
  const key = `${method.toUpperCase()} ${pathStr}`;
  routes[key] = handler;
}
// deps bag passée à chaque plugin. Tout ce dont un plugin peut avoir besoin
// pour brancher une feature — stdlib Node + frida + état d'app + hooks.
function getPluginApi() {
  return {
    fs, path, os, crypto: require('crypto'), net, http, https: require('https'),
    frida,
    // spawn : nécessaire aux plugins mac qui délèguent la capture clavier au
    // helper natif (cf. organizer). Un plugin ne require() pas ses
    // propres modules, tout passe par cette bag.
    spawn,
    runningPids, runningHandles, runKey,
    loadAccounts, loadConfig, saveConfig,
    DATA_DIR, CONFIG_PATH, APP_ROOT, WEB_PORT,
    on, registerRoute, log,
    // Exposé pour overlay-backend qui s'abonne aux events mapId du game-proxy
    setMapUpdateHandler: (...a) => setMapUpdateHandler && setMapUpdateHandler(...a),
    // Tap paquets jeu pour les plugins qui parlent le protocole (fm.js).
    // Retourne false si la version de game-proxy chargée ne l'expose pas
    // encore — au plugin de se désactiver proprement dans ce cas.
    setPacketHandler: (fn) => {
      if (!setPacketHandler) return false;
      setPacketHandler(fn);
      return true;
    },
    getGameChannel: (accountId) => (getGameChannel ? getGameChannel(accountId) : null),
    createFmData, createFmEngine, createFmProtocol, createFmLive, createFmWeights,
    createProtocolLearn,
    createChasseProtocol,
    // Le socle de chasse. Les trois tables sont exposées par des accesseurs et
    // non par des valeurs : une propriété simple les chargerait à la
    // construction de la bag, donc au démarrage, pour TOUS les utilisateurs —
    // y compris ceux qui ne chassent jamais. Là, elles ne se lisent que si un
    // plugin de chasse les demande vraiment.
    get schemaDofus() { return dofusSchema(); },
    get nomsDofus() { return dofusNoms(); },
    get monde() { return mondeDofus(); },
    createChasseIndices,
    cacheIndices: path.join(DATA_DIR, 'chasse-indices.json'),
  };
}

// Init des factories au démarrage. Toutes les dépendances se câblent ici.
// haapi et zaap doivent être prêts AVANT les autres (game-proxy et
// oauth-browser peuvent vouloir les utiliser).
let _factoriesPromise = null;
async function ensureFactories() {
  if (startZaapServer) return;
  if (!_factoriesPromise) {
    _factoriesPromise = (async () => {
      // 0. Charge frida (lazy : require sur Windows / dynamic import sur Mac).
      //    Doit être prêt avant frida-hook, retro-hook et getPluginApi().
      await loadFrida();

      // 1. haapi d'abord (pas de deps internes)
      haapi = bundled['haapi']({ puppeteer: puppeteerCore });

      // 2. Puis zaap-server (dépend de haapi injecté)
      const zaapApi = bundled['zaap-server']({ net, uuidv4, haapi });
      startZaapServer = zaapApi.startZaapServer;
      registerHash = zaapApi.registerHash;

      // 3. Les autres
      const fridaApi  = bundled['frida-hook']({ frida });
      const retroApi  = bundled['retro-hook']({ frida });
      const proxyApi  = bundled['game-proxy']({ net });
      const importApi = bundled['launcher-import']({ machineIdSync });
      const dtApi     = bundled['dt-clone']({});
      // Factories brutes (pas d'appel ici) : les plugins fm et chasse les
      // instancient avec leurs propres deps.
      createProtocolLearn   = bundled['protocol-learn'];
      createFmData          = bundled['fm-data'];
      createFmEngine        = bundled['fm-engine'];
      createFmProtocol      = bundled['fm-protocol'];
      createFmLive          = bundled['fm-live'];
      createFmWeights       = bundled['fm-weights'];
      createChasseProtocol  = bundled['chasse-protocol'];
      launchWithFrida = fridaApi.launchWithFrida;
      generateFakeIdentity = fridaApi.generateFakeIdentity;
      launchRetroWithFrida = retroApi.launchRetroWithFrida;
      createGameProxy = proxyApi.createGameProxy;
      setCharacterUpdateHandler = proxyApi.setCharacterUpdateHandler;
      setMapUpdateHandler = proxyApi.setMapUpdateHandler;
      setPacketHandler = proxyApi.setPacketHandler || null;
      getGameChannel = proxyApi.getChannel || null;
      importFromLauncher = importApi.importFromLauncher;
      dtClone = dtApi;

      // 4. Plugins — chargés après les factories cœur, pour que la deps bag
      // (on, registerRoute…) soit complète. Une erreur dans un plugin ne
      // bloque pas les autres.
      try { await plugins.loadPlugins(getPluginApi(), { appRoot: APP_ROOT, log }); }
      catch (e) { log(`[plugin] load err: ${e.message}`); }
      emit('ready', {});

      // L'auto-import du boot a eu lieu dans startWebServer(), avant que les
      // plugins existent : on leur notifie maintenant (key-refresh sonde
      // alors les comptes importés).
      if (bootImportCount > 0) emit('accounts-imported', { count: bootImportCount });
    })();
  }
  await _factoriesPromise;
}

async function launchAccount(accountData, gameKey, network) {
  const proxyUri = network?.proxyUri || null;
  const localAddress = network?.localAddress || null;
  const gameDir = GAME_DIRS[gameKey];
  if (!gameDir || !fs.existsSync(gameDir)) { log(`Dossier introuvable: ${gameDir}`); return false; }

  await ensureFactories();
  const { port: zaapPort } = await startZaapServer(26616);
  const hash       = uuidv4();
  const gameId     = GAME_IDS[gameKey] || 1;
  const gameName   = GAME_NAMES[gameKey] || 'dofus';

  registerHash(hash, { ...accountData, proxy: proxyUri || null, gameId, gameKey });
  log(`${accountData.login} → ${gameKey} (zaap=${zaapPort} hash=${hash.slice(0,8)}…)`);

  if (gameKey === 'retro' || gameKey === 'wakfu') {
    // Retro (Electron) et Wakfu (Java) : flow différents.
    //
    // Retro = Electron avec .exe → spawn direct avec args --port/--gameName...
    // Wakfu = Java (pas d'exe, pas d'args CLI Zaap) → spawn via zaap-start.bat
    //         qui reçoit des args positionnels (lang, xms, xmx, JVM opts…) et
    //         lance jre/bin/java.exe avec WakfuClient. Les env vars ZAAP_*
    //         sont lues par le bat et par le client Wakfu.
    const isWakfu = gameKey === 'wakfu';
    const exeName = GAME_EXES[gameKey];
    const exePath = isWakfu ? path.join(gameDir, 'zaap-start.bat') : path.join(gameDir, exeName);
    if (!fs.existsSync(exePath)) {
      log(`${isWakfu ? 'zaap-start.bat' : exeName} introuvable dans ${gameDir}`);
      return false;
    }

    // Rotation des logs (ce que faisait zaap-start.bat)
    const logsDir = path.join(gameDir, 'logs');
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    const logFile     = path.join(logsDir, `dofus.${accountData.accountId}.log`);
    const prevLogFile = path.join(logsDir, `dofus.prev.${accountData.accountId}.log`);
    try { if (fs.existsSync(prevLogFile)) fs.unlinkSync(prevLogFile); } catch {}
    try { if (fs.existsSync(logFile)) fs.renameSync(logFile, prevLogFile); } catch {}

    // Args selon le jeu
    let exeArgs;
    if (isWakfu) {
      // Positional args du bat : lang xms xmx javaOpts partner natives debugLog uiScale clientOpts
      // Valeurs observées dans $APPDATA/zaap/application.log pour Wakfu launch.
      const javaOpts = '-XX:+UnlockExperimentalVMOptions -XX:+UseG1GC -XX:G1NewSizePercent=20 -XX:G1ReservePercent=20 -Djava.net.preferIPv4Stack=true -Dsun.awt.noerasebackground=true -Dsun.java2d.noddraw=true -Djogl.disable.openglarbcontext';
      exeArgs = ['fr', '2G', '4G', `"${javaOpts}"`, 'default', 'natives/', 'NUL', 'true', '""'];
    } else {
      exeArgs = [
        `--port=${zaapPort}`,
        `--gameName=${gameName}`,
        '--gameRelease=main',
        '--instanceId=1',
        `--gameInstanceKey=${hash}`,
      ];
      // Copier la config/préferences Flash du dir Retro par défaut vers un
      // dir unique par compte, PUIS --user-data-dir. La copie évite que
      // Retro démarre avec un état vierge (sCurrentLanguage="" etc.) qui le
      // fait quitter silencieusement. Single-instance lock devient per-dir.
      const userDataDir = path.join(process.env.APPDATA || _HOME, 'STAKK', 'Retro', String(accountData.accountId));
      const defaultRetroData = path.join(process.env.APPDATA || _HOME, 'Dofus Retro');
      try {
        if (!fs.existsSync(userDataDir)) {
          fs.mkdirSync(userDataDir, { recursive: true });
          // Copier config.json + Preferences + Pepper Data (Flash trust) pour
          // que le jeu trouve sa langue et ses permissions Flash dès le départ.
          for (const item of ['config.json', 'Preferences']) {
            const src = path.join(defaultRetroData, item);
            if (fs.existsSync(src)) fs.copyFileSync(src, path.join(userDataDir, item));
          }
          const pepperSrc = path.join(defaultRetroData, 'Pepper Data');
          if (fs.existsSync(pepperSrc)) {
            const pepperDst = path.join(userDataDir, 'Pepper Data');
            fs.cpSync(pepperSrc, pepperDst, { recursive: true });
          }
        }
      } catch (e) { log(`[Retro] init userData: ${e.message}`); }
      // Retro n'a pas de flag de langue : elle vit dans son config.json
      // (`sCurrentLanguage`). On l'aligne sur l'UI à CHAQUE lancement, sinon
      // un changement de langue dans STAKK ne serait jamais répercuté sur un
      // profil déjà créé.
      try {
        const cfgPath = path.join(userDataDir, 'config.json');
        let cfg = {};
        try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) || {}; } catch {}
        const wanted = gameLang('retro');
        if (cfg.sCurrentLanguage !== wanted) {
          cfg.sCurrentLanguage = wanted;
          fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 4));
          log(`[Retro] langue du client → ${wanted}`);
        }
      } catch (e) { log(`[Retro] langue non appliquée: ${e.message}`); }
      exeArgs.push(`--user-data-dir=${userDataDir}`);
      // --proxy-server est un flag Chromium — Retro (Electron) uniquement.
      if (proxyUri) exeArgs.push(`--proxy-server=${proxyUri}`);
    }

    const env = {
      ...process.env,
      ZAAP_PORT:        String(zaapPort),
      ZAAP_GAME:        gameName,
      ZAAP_RELEASE:     'main',
      ZAAP_INSTANCE_ID: '1',
      ZAAP_HASH:        hash,
      ZAAP_CAN_AUTH:    'true',
      ZAAP_LOGS_PATH:   logsDir,
      ACCOUNT_ID:       String(accountData.accountId),
    };
    // Si STAKK a été lancé depuis un environnement Electron (VSCode, Claude
    // Code, etc.), ELECTRON_RUN_AS_NODE=1 est dans l'env et fait démarrer
    // Dofus Retro (Electron 11) en mode Node pur — les flags --port=X etc.
    // sont alors rejetés comme "bad option" et le jeu quitte sans fenêtre.
    delete env.ELECTRON_RUN_AS_NODE;

    try {
      if (gameKey === 'retro') {
        // Pour Retro, on passe par Frida (comme krm) pour patcher les appels
        // Win32 CreateWindowEx + ShowWindow en temps réel. Cela force
        // WS_VISIBLE sur chaque fenêtre créée et convertit tout SW_HIDE en
        // SW_SHOW, contournant le check anti-multi-account qui cachait la
        // BrowserWindow principale après auth.
        const fridaHandle = await launchRetroWithFrida(exePath, exeArgs, { cwd: gameDir, env }, log);
        const pid = fridaHandle.pid;
        const rk = runKey(accountData.accountId, 'retro');
        runningPids[rk] = pid;
        runningHandles[rk] = { fridaHandle };
        fridaHandle.onDetach((reason) => {
          log(`[Cleanup] ${accountData.login} retro fermé (${reason}) — nettoyage`);
          emit('detach', { accountId: accountData.accountId, gameKey: 'retro', reason });
          cleanupAccount(accountData.accountId, 'retro');
        });
        emit('launch', { accountId: accountData.accountId, gameKey: 'retro', pid, fridaHandle });
        accountData.lastLaunch = Date.now();
        accountData.launchCount = (accountData.launchCount || 0) + 1;
        fs.writeFileSync(path.join(DATA_DIR, String(accountData.accountId)), JSON.stringify(accountData, null, 4));
        log(`${accountData.login} lancé (retro via Frida) PID=${pid}`);
      } else {
        // Wakfu : on bat + shell est ce qui marche (bat split correctement
        // les args JVM et set les env WAKFU_*), mais `shell:true` fait
        // flasher une fenêtre cmd même avec windowsHide. Contournement :
        // on génère un .vbs helper qui invoque le bat via WshShell.Run
        // avec le flag 0 (hidden) — ce mode natif Windows démarre cmd en
        // background sans jamais créer de console visible.
        const vbsDir = path.join(process.env.APPDATA || _HOME, 'STAKK');
        if (!fs.existsSync(vbsDir)) fs.mkdirSync(vbsDir, { recursive: true });
        const vbsPath = path.join(vbsDir, `wakfu-launch-${accountData.accountId}.vbs`);
        // Échappe les guillemets VBS : `"` → `""`
        const esc = (s) => String(s).replace(/"/g, '""');
        const cmdLine = `"${esc(exePath)}" ${exeArgs.map(a => `"${esc(a)}"`).join(' ')}`;
        const vbs = [
          'Set WshShell = CreateObject("WScript.Shell")',
          `WshShell.CurrentDirectory = "${esc(gameDir)}"`,
          // Propage les env vars ZAAP_* dont le bat a besoin
          ...Object.entries(env).filter(([k]) => k.startsWith('ZAAP_') || k === 'ACCOUNT_ID')
            .map(([k, v]) => `WshShell.Environment("PROCESS")("${k}") = "${esc(v)}"`),
          `WshShell.Run "${esc(cmdLine)}", 0, False`,
        ].join('\r\n');
        fs.writeFileSync(vbsPath, vbs, 'utf8');
        const spawnOpts = { cwd: gameDir, env, detached: true, stdio: 'ignore', windowsHide: true };
        const child = spawn('wscript.exe', [vbsPath], spawnOpts);
        const pid = child.pid;
        const rk = runKey(accountData.accountId, 'wakfu');
        runningPids[rk] = pid;
        runningHandles[rk] = {};
        child.on('exit', (code, sig) => {
          log(`[Cleanup] ${accountData.login} wakfu fermé (code=${code} sig=${sig}) — nettoyage`);
          emit('detach', { accountId: accountData.accountId, gameKey: 'wakfu', reason: `exit ${code}` });
          cleanupAccount(accountData.accountId, 'wakfu');
        });
        emit('launch', { accountId: accountData.accountId, gameKey: 'wakfu', pid });
        child.on('error', err => log(`spawn error: ${err.message}`));
        child.unref();
        accountData.lastLaunch = Date.now();
        accountData.launchCount = (accountData.launchCount || 0) + 1;
        fs.writeFileSync(path.join(DATA_DIR, String(accountData.accountId)), JSON.stringify(accountData, null, 4));
        log(`${accountData.login} lancé (wakfu) PID=${pid}`);
      }
    } catch (e) {
      log(`[${gameKey}] spawn échoué: ${e.message}`);
      return false;
    }
  } else if (DOFUS_RELEASES[gameKey]) {
    const release = DOFUS_RELEASES[gameKey];
    // Sur Windows c'est Dofus.exe à la racine. Sur Mac c'est le binaire
    // Unity à l'intérieur du .app bundle (GAME_EXES pointe dessus).
    const exeName = GAME_EXES[gameKey];
    const exePath = path.join(gameDir, exeName);
    if (!fs.existsSync(exePath)) { log(`${exeName} introuvable dans ${gameDir}`); return false; }

    // logsDir Windows = %APPDATA%\zaap\... ; Mac = ~/Library/Application Support/zaap/...
    // On réutilise _ZAAP_BASE défini plus haut pour l'hygiène cross-platform.
    const logsDir = path.join(_ZAAP_BASE, 'gamesLogs', 'dofus-' + release);
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

    // Le configUrl pointe vers le manifest CDN décrivant les ressources de
    // ce build de Dofus. Mac et Windows ont chacun leur fichier — passer le
    // mauvais peut faire choker Dofus au boot (ressources introuvables).
    // -force-d3d12 est Windows-only (DirectX) ; Mac utilise Metal nativement
    // donc on n'envoie pas le flag.
    const isMac = process.platform === 'darwin';
    const configUrl = isMac
      ? 'https://dofus2.cdn.ankama.com/config/release_macosx.json'
      : 'https://dofus2.cdn.ankama.com/config/release_windows.json';
    const exeArgs = [
      '--port', '26116', '--gameName', gameName, '--gameRelease', release,
      '--instanceId', '1', '--hash', hash,
      '--canLogin', 'true',
      '--logFile', path.join(logsDir, `dofus.${accountData.accountId}.log`),
      '--langCode', gameLang(gameKey), '--autoConnectType', '1', '--connectionPort', '5555',
      '--configUrl', configUrl,
    ];
    if (!isMac) exeArgs.push('-force-d3d12');

    const fakeId = generateFakeIdentity(accountData);

    let proxyHandle = null;
    try {
      proxyHandle = await createGameProxy({
        flashKey: fakeId.flashKey,
        localAddress: localAddress,
        proxyUri: proxyUri,
        zaapPort: zaapPort,
        accountId: accountData.accountId,
        dataDir: DATA_DIR,
        reconDir: process.env.STAKK_MAP_RECON ? path.join(DATA_DIR, 'recon') : null,
      });
      log(`[Proxy] Port ${proxyHandle.port} pour ${accountData.login} (flashKey=${fakeId.flashKey})`);
      if (process.env.STAKK_MAP_RECON) {
        log(`[RECON] Mode ON — logs: ${path.join(DATA_DIR, 'recon')}`);
      }
    } catch (e) {
      log(`[Proxy] Erreur: ${e.message}`);
    }

    const env = {
      ...process.env,
      ZAAP_PORT: '26116', ZAAP_GAME: gameName, ZAAP_RELEASE: release,
      ZAAP_INSTANCE_ID: '1', ZAAP_HASH: hash, ZAAP_CAN_AUTH: 'true',
      ZAAP_LOGS_PATH: logsDir, ACCOUNT_ID: String(accountData.accountId),
    };

    try {
      const fridaHandle = await launchWithFrida(exePath, exeArgs, { cwd: gameDir, env }, fakeId, proxyHandle?.port || 0);
      const pid = fridaHandle.pid;
      const rk = runKey(accountData.accountId, gameKey);
      runningPids[rk] = pid;
      runningHandles[rk] = { fridaHandle, proxyHandle };

      // Auto-cleanup quand le process Dofus meurt (fermeture manuelle par l'user)
      fridaHandle.onDetach((reason) => {
        log(`[Cleanup] ${accountData.login} Dofus fermé (${reason}) — nettoyage`);
        emit('detach', { accountId: accountData.accountId, gameKey, reason });
        cleanupAccount(accountData.accountId, gameKey);
      });
      emit('launch', { accountId: accountData.accountId, gameKey, pid, fridaHandle });

      // Stats
      accountData.lastLaunch = Date.now();
      accountData.launchCount = (accountData.launchCount || 0) + 1;
      fs.writeFileSync(path.join(DATA_DIR, String(accountData.accountId)), JSON.stringify(accountData, null, 4));
      log(`${accountData.login} lancé PID=${pid}`);
    } catch (e) {
      log(`Frida fallback: ${e.message}`);
      if (process.platform === 'darwin') {
        log(`[Mac] Frida n'a pas pu s'attacher — vérifie que SIP est désactivé (csrutil status) et que install.sh a tourné (codesign ad-hoc).`);
      }
      const spawnOpts = { cwd: gameDir, env, detached: true, stdio: 'ignore' };
      if (process.platform === 'win32') spawnOpts.windowsHide = true;
      const child = spawn(exePath, exeArgs, spawnOpts);
      child.on('error', err => log(`spawn error: ${err.message}`));
      child.unref();
      // Proxy orphelin sans Frida — fermer pour pas leak
      if (proxyHandle) { try { await proxyHandle.close(); } catch {} }
    }
  }
  return true;
}

// ─── API routes ──────────────────────────────────────────────────────────────

const routes = {};

routes['GET /api/accounts'] = () => {
  const accounts = loadAccounts();
  const { groups } = loadConfig();
  // Nettoyer les PIDs morts (le handle est disposé proprement)
  for (const [key, pid] of Object.entries(runningPids)) {
    try { process.kill(pid, 0); } catch { cleanupAccount(key); }
  }
  const now = Date.now();
  return accounts.map(a => {
    const refreshAge = a.refreshDate ? now - a.refreshDate : Infinity;
    const keyFresh = refreshAge < 24 * 60 * 60 * 1000; // < 24h
    const keyWarn = refreshAge < 7 * 24 * 60 * 60 * 1000; // < 7 days
    const games = runningGamesFor(a.accountId);
    return {
      accountId: a.accountId, login: a.login,
      hasCertificate: !!a.certificate,
      customShield: !!a.customShield,
      running: games.length > 0,
      runningGames: games,
      pid: runningPids[runKey(a.accountId, games[0])] || null,
      refreshDate: a.refreshDate || null,
      health: !a.key ? 'expired' : !keyWarn ? 'expired' : !keyFresh ? 'warn' : 'ok',
      lastLaunch: a.lastLaunch || null,
      launchCount: a.launchCount || 0,
      characterName: a.characterName || null,
      characterLevel: a.characterLevel || null,
      characterClass: a.characterClass || null,
      characters: a.characters || [],
      ...networkForAccount(a.accountId, groups),
    };
  });
};

// Mettre à jour les infos personnage (nom, classe, niveau) d'un compte
routes['POST /api/account/character'] = (body) => {
  const { accountId, name, level, charClass } = body;
  const file = path.join(DATA_DIR, String(accountId));
  let acc;
  try { acc = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('Compte introuvable'); }
  if (name !== undefined) acc.characterName = (name || '').trim() || null;
  if (level !== undefined) acc.characterLevel = level ? parseInt(level) : null;
  if (charClass !== undefined) acc.characterClass = (charClass || '').trim() || null;
  fs.writeFileSync(file, JSON.stringify(acc, null, 4));
  return { ok: true };
};

routes['GET /api/interfaces'] = () => getInterfaces();
// Clients installes sur la machine. L'UI s'en sert pour n'afficher que
// les jeux reellement presents (ex: canal experimental absent chez la
// plupart des joueurs). Un exe plus ancien ne connait pas cette route :
// le front retombe alors sur sa liste par defaut.
const GAME_LABELS = { dofus3: 'Dofus 3', beta: 'Beta', experimental: 'Experimental', retro: 'Retro', wakfu: 'Wakfu' };
routes['GET /api/games'] = () => Object.keys(GAME_LABELS).map(key => ({
  key,
  label: GAME_LABELS[key],
  dir: GAME_DIRS[key] || null,
  installed: !!(GAME_DIRS[key] && fs.existsSync(path.join(GAME_DIRS[key], GAME_EXES[key]))),
}));
routes['GET /api/config'] = () => loadConfig();
routes['GET /api/logs'] = () => launchLog;
routes['GET /api/logs/download'] = () => ({ _raw: launchLog.join('\n'), _contentType: 'text/plain', _filename: 'stakk-logs-' + new Date().toISOString().slice(0,10) + '.txt' });

routes['POST /api/config'] = (body) => { saveConfig(body); return { ok: true }; };

// Écrit sur disque les comptes du launcher Ankama. Synchrone et sans
// dépendre de ensureFactories() : le déchiffrement du keydata n'a besoin que
// de machineIdSync, donc le boot peut l'appeler avant même que le serveur
// écoute — la liste est complète dès le premier GET /api/accounts.
function importLauncherToDisk() {
  if (!importFromLauncher) {
    importFromLauncher = bundled['launcher-import']({ machineIdSync }).importFromLauncher;
  }
  const imported = importFromLauncher();
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const acc of imported) {
    const file = path.join(DATA_DIR, String(acc.accountId));
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    // Ne PAS écraser un hm1 personnalisé (Shield monocompte)
    const merged = { ...existing, ...acc, refreshDate: Date.now() };
    if (existing.customShield) {
      merged.hm1 = existing.hm1;
      merged.hm2 = existing.hm2;
      merged.certificate = existing.certificate;
      merged.customShield = true;
      // Le certificat Shield est rattaché à la CLÉ qui l'a demandé : prendre
      // celle du launcher le rendrait inutilisable (« Invalid security
      // parameters » sur CreateToken, alors que la clé elle-même est bonne).
      // On garde donc le couple clé + certificat tant qu'il fonctionne.
      if (existing.key) {
        merged.key = existing.key;
        merged.refreshToken = existing.refreshToken || acc.refreshToken;
        merged.refreshDate = existing.refreshDate || merged.refreshDate;
      }
    }
    fs.writeFileSync(file, JSON.stringify(merged, null, 4));
  }
  return imported.length;
}

async function runLauncherImport() {
  // Pas d'await ensureFactories() : si Frida est cassé (binding natif
  // introuvable), l'import doit quand même marcher.
  const count = importLauncherToDisk();
  if (count > 0) emit('accounts-imported', { count });
  return { count };
}

routes['POST /api/import'] = () => runLauncherImport();

routes['GET /api/running'] = () => {
  // Vérifier quels PIDs sont encore actifs, retourner un map par
  // "<accountId>:<gameKey>" → pid.
  const result = {};
  for (const [key, pid] of Object.entries(runningPids)) {
    try {
      process.kill(pid, 0); // signal 0 = test si le process existe
      result[key] = pid;
    } catch {
      delete runningPids[key];
    }
  }
  return result;
};

routes['POST /api/exit'] = () => {
  setTimeout(() => process.exit(0), 200);
  return { ok: true };
};

// Marker pour le recon protocole — écrit une ligne "=== MARKER ===" dans le
// log recon du proxy d'un compte donné, pour que l'utilisateur puisse annoter
// "je viens de changer de map" sans quitter le jeu. No-op si le mode recon
// n'est pas actif sur ce compte.
routes['POST /api/recon/marker'] = (body) => {
  const { accountId, gameKey = 'dofus3', label = 'marker' } = body || {};
  if (!accountId) return { ok: false, error: 'accountId requis' };
  const h = runningHandles[runKey(accountId, gameKey)];
  const marker = h?.proxyHandle?.reconMarker;
  if (typeof marker !== 'function') return { ok: false, error: 'recon inactif ou compte non lancé' };
  marker(String(label));
  return { ok: true };
};

routes['POST /api/kill'] = async (body) => {
  // Si gameKey fourni, on ne tue que cette instance. Sinon, on tue toutes
  // les instances de ce compte (comportement legacy).
  const { accountId, gameKey } = body;
  const targets = gameKey
    ? [runKey(accountId, gameKey)].filter(k => runningPids[k])
    : runningGamesFor(accountId).map(g => runKey(accountId, g));
  if (!targets.length) return { ok: false, error: 'Pas de process actif' };
  for (const key of targets) {
    const pid = runningPids[key];
    try {
      process.kill(pid);
      log(`Process ${pid} terminé (${key})`);
    } catch (e) {
      log(`Process ${pid} déjà mort: ${e.message}`);
    }
    await cleanupAccount(key);
  }
  return { ok: true, killed: targets.length };
};

routes['POST /api/account/delete'] = (body) => {
  const file = path.join(DATA_DIR, String(body.accountId));
  try { fs.unlinkSync(file); return { ok: true }; } catch { return { ok: false }; }
};

routes['POST /api/launch'] = async (body) => {
  const { accountIds = [], gameKey } = body || {};
  const accounts = loadAccounts();
  const { groups } = loadConfig();
  let launched = 0;
  for (const id of accountIds) {
    const acc = accounts.find(a => a.accountId === id);
    if (!acc) continue;
    const resolvedGame = gameKey || 'dofus3';
    const net = networkForAccount(id, groups, resolvedGame);
    const ok = await launchAccount(acc, resolvedGame, net);
    if (ok) launched++;
    if (accountIds.length > 1) await new Promise(r => setTimeout(r, LAUNCH_DELAY));
  }
  return { launched };
};

// ─── Shield OAuth (nouveau certificat pour monocompte) ──────────────────────

const crypto = require('crypto');
const { stringify } = require('querystring');
const pendingOAuth = {}; // codeVerifier par accountId

// Ajouter un compte manuellement (hors import launcher). Utilisé quand le
// launcher Ankama n'est pas installé ou que son keydata est indéchiffrable
// (ex: macOS où le launcher utilise un algo de chiffrement différent).
// Flow identique à Shield login mais crée l'account file avant.
routes['POST /api/account/add'] = async (body) => {
  await ensureFactories();
  const { login, password } = body || {};
  if (!login || !password) throw new Error('Login + password requis');

  log(`[AddAccount] Login HAAPI pour ${login}...`);
  const tokenResp = await haapi.loginAndCreateApiKey(login, password, null);
  const APIKEY = tokenResp.key;
  const refreshToken = tokenResp.refreshToken;
  const accountId = tokenResp.accountId;
  const security = tokenResp.security || [];
  const realLogin = tokenResp.login || login;
  log(`[AddAccount] accountId=${accountId} security=[${security.join(',')}]`);

  if (!accountId) throw new Error('HAAPI n\'a pas retourné d\'accountId');

  return await finaliserAjoutCompte({ accountId, login: realLogin, APIKEY, refreshToken, security });
};

// Range une paire clé/refreshToken fraîche sur le fichier compte et enchaîne
// sur le Shield si Ankama en réclame un.
//
// Partagé par les deux portes d'entrée — /api/account/add (login + mot de
// passe) et /api/account/add-oauth (navigateur) — parce que tout ce qui suit
// l'obtention du token est identique, et que le frontend attend la même forme
// de réponse dans les deux cas.
async function finaliserAjoutCompte({ accountId, login, APIKEY, refreshToken, security }) {
  // Évite d'écraser un compte existant (avec potentiellement un customShield)
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, String(accountId));
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const merged = {
    ...existing,
    accountId,
    login,
    key: APIKEY,
    refreshToken,
    refreshDate: Date.now(),
  };
  delete merged.keyDead; // clé neuve : le badge rouge éventuel n'a plus lieu d'être
  fs.writeFileSync(file, JSON.stringify(merged, null, 4));

  // Si Shield requis, on lance le flow email/OTP comme /api/shield/login
  const hasOTP = Array.isArray(security) && security.includes('OTP');
  const hasShield = Array.isArray(security) && security.includes('SHIELD');
  if (hasOTP || hasShield) {
    pendingOAuth[accountId] = { APIKEY, refreshToken, method: hasOTP ? 'otp' : 'email' };
    if (hasOTP) {
      log(`[AddAccount] Shield OTP requis — user entre le code depuis l'app Authenticator`);
    } else {
      await haapi.request(
        { method: 'GET', path: '/json/Ankama/v5/Shield/SecurityCode?transportType=EMAIL', headers: { APIKEY } }
      );
      log(`[AddAccount] Code Shield envoyé par email`);
    }
    emit('accounts-imported', { count: 1 });
    return { ok: true, accountId, login, needsShield: true, method: hasOTP ? 'otp' : 'email' };
  }

  emit('accounts-imported', { count: 1 });
  return { ok: true, accountId, login, needsShield: false };
}

// Ajouter un compte via le navigateur, sans mot de passe Ankama.
//
// Indispensable pour les comptes créés par SSO (`"provider": "google"`, Apple,
// Facebook…) : ils n'ont pas de mot de passe Ankama, donc /api/account/add,
// qui poste des identifiants sur auth.ankama.com, ne peut pas fonctionner. Ici
// on ouvre la vraie page de login Ankama, qui propose tous les fournisseurs,
// et on récupère le code d'autorisation via le protocole zaap://.
//
// Le certificat Shield émis ensuite l'est pour CETTE clé : le compte devient
// autonome, sans dépendance au launcher.
routes['POST /api/account/add-oauth'] = async () => {
  await ensureFactories();
  const { oauthViaBrowser } = bundled['oauth-browser']({ haapi });

  log('[AddOAuth] Ouverture du navigateur pour le login Ankama...');
  const tokenResp = await oauthViaBrowser();
  const APIKEY = tokenResp && tokenResp.access_token;
  const refreshToken = tokenResp && tokenResp.refresh_token;
  if (!APIKEY) throw new Error('Login navigateur : aucun token reçu');

  const [err, acct] = await haapi.request(
    { method: 'GET', path: '/json/Ankama/v5/Account/Account', headers: { APIKEY } }
  );
  if (err || !acct || !acct.id) {
    throw new Error('Login navigateur : impossible de lire le compte — ' + JSON.stringify(acct).slice(0, 120));
  }
  log(`[AddOAuth] Connecté : ${acct.login} (id=${acct.id}) security=[${(acct.security || []).join(',')}]`);

  return await finaliserAjoutCompte({
    accountId: acct.id,
    login: acct.login || String(acct.id),
    APIKEY, refreshToken,
    security: acct.security || [],
  });
};

// Refresh la clé HAAPI d'un compte existant. Cas d'usage : Ankama a révoqué la
// clé (403 Unauthorized service) et l'user veut juste régénérer la paire
// key/refreshToken sans refaire le flow Shield complet. Le certificat existant
// (acc.certificate, hm1, hm2) reste inchangé — il est tied au accountId/hm1
// pas à la clé API, donc createToken continue de marcher avec la nouvelle clé.
//
// Si le compte a Shield/OTP côté Ankama, la fresh OAuth login le détecte mais
// on ne ré-émet PAS de nouveau certificat ici — on se contente de stocker la
// nouvelle clé, en supposant que le certificat existant suffit (vrai dans 99%
// des cas où la clé est juste expirée et pas le certificat). Si ça ne suffit
// pas, fallback vers /api/shield/login pour un certificat neuf.
routes['POST /api/account/refresh-key'] = async (body) => {
  await ensureFactories();
  const { accountId, login, password } = body || {};
  if (!accountId) throw new Error('accountId requis');
  if (!login || !password) throw new Error('Login + password requis');
  const accounts = loadAccounts();
  const acc = accounts.find(a => a.accountId === accountId);
  if (!acc) throw new Error('Compte introuvable');

  log(`[RefreshKey] Login HAAPI pour ${login} (id=${accountId})...`);
  const tokenResp = await haapi.loginAndCreateApiKey(login, password, null);
  const APIKEY = tokenResp.key;
  const refreshToken = tokenResp.refreshToken;
  if (tokenResp.accountId && tokenResp.accountId !== accountId) {
    throw new Error(`accountId mismatch: attendu ${accountId}, reçu ${tokenResp.accountId} — mauvais login ?`);
  }

  acc.key = APIKEY;
  acc.refreshToken = refreshToken;
  acc.refreshDate = Date.now();
  fs.writeFileSync(path.join(DATA_DIR, String(accountId)), JSON.stringify(acc, null, 4));
  log(`[RefreshKey] OK — clé rafraîchie pour ${acc.login} (id=${accountId})`);
  emit('accounts-imported', { count: 1 });
  return { ok: true, accountId, login: acc.login, hasShield: Array.isArray(tokenResp.security) && tokenResp.security.length > 0 };
};

// Shield : OAuth → détecte email ou OTP → valide
routes['POST /api/shield/login'] = async (body) => {
  await ensureFactories();
  const { accountId, login, password } = body;
  const accounts = loadAccounts();
  const acc = accounts.find(a => a.accountId === accountId);
  if (!acc) throw new Error('Compte introuvable');
  if (!password) throw new Error('Mot de passe requis');

  log(`[Shield] Login OAuth pour ${login}...`);
  const tokenResp = await haapi.loginAndCreateApiKey(login, password, null);
  const APIKEY = tokenResp.key;
  const refreshToken = tokenResp.refreshToken;
  const security = tokenResp.security || [];
  log(`[Shield] Clé API: ${APIKEY.slice(0,8)}... security=[${security.join(',')}]`);

  // Détecter le type de Shield
  const hasOTP = Array.isArray(security) && security.includes('OTP');
  const hasShield = Array.isArray(security) && security.includes('SHIELD');

  pendingOAuth[accountId] = { APIKEY, refreshToken, method: hasOTP ? 'otp' : 'email' };

  if (hasOTP) {
    // OTP/Authenticator — pas besoin d'envoyer un code, l'utilisateur l'a déjà
    log(`[Shield] Compte avec Authenticator (OTP) — entre le code de l'app`);
  } else {
    // Email Shield — envoyer le code par email
    const [err, resp] = await haapi.request(
      { method: 'GET', path: '/json/Ankama/v5/Shield/SecurityCode?transportType=EMAIL', headers: { APIKEY } }
    );
    log(`[Shield] Code envoyé par email`);
  }

  return { ok: true, method: pendingOAuth[accountId].method };
};

routes['POST /api/shield/validate'] = async (body) => {
  await ensureFactories();
  const { accountId, shieldCode } = body;
  const accounts = loadAccounts();
  const acc = accounts.find(a => a.accountId === accountId);
  if (!acc) throw new Error('Compte introuvable');

  const pending = pendingOAuth[accountId];
  if (!pending) throw new Error('Fais d\'abord le login');

  const hm1 = crypto.randomBytes(16).toString('hex');
  const hm2 = hm1.split('').reverse().join('');

  let r2;
  if (pending.method === 'otp') {
    // Valider via OTP/Authenticator
    const query = stringify({
      game_id: '102', code: shieldCode, hm1, hm2,
      name: 'stakk-' + crypto.randomBytes(4).toString('hex'),
    });
    const [err, resp] = await haapi.request(
      { method: 'GET', path: '/json/Ankama/v5/Shield/ValidateOtp?' + query, headers: { APIKEY: pending.APIKEY } }
    );
    r2 = resp;
    log(`[Shield] ValidateOtp: ${JSON.stringify(r2).slice(0,120)}`);
  } else {
    // Valider via code email
    const query = stringify({
      game_id: '102', code: shieldCode, hm1, hm2,
      name: 'stakk-' + crypto.randomBytes(4).toString('hex'),
    });
    const [err, resp] = await haapi.request(
      { method: 'GET', path: '/json/Ankama/v5/Shield/ValidateCode?' + query, headers: { APIKEY: pending.APIKEY } }
    );
    r2 = resp;
    log(`[Shield] ValidateCode: ${r2?.encodedCertificate ? 'certificat reçu' : 'échec'}`);
  }

  if (!r2?.encodedCertificate) throw new Error('Shield échoué : ' + JSON.stringify(r2));

  acc.key = pending.APIKEY;
  acc.refreshToken = pending.refreshToken;
  acc.certificate = r2;
  acc.hm1 = hm1;
  acc.hm2 = hm2;
  acc.customShield = true;
  acc.refreshDate = Date.now();
  fs.writeFileSync(path.join(DATA_DIR, String(acc.accountId)), JSON.stringify(acc, null, 4));
  delete pendingOAuth[accountId];
  log(`[Shield] Certificat enregistré pour ${acc.login}`);
  emit('accounts-imported', { count: 1 });
  return { ok: true };
};

// Kill every lingering adb.exe process on the user's Windows machine so the
// WebUSB layer can actually claim the phone. Typically needed after Android
// Studio / scrcpy / Zaap left daemons hanging around. Best-effort: we return
// OK even if nothing was running.
routes['POST /api/dt/killadb'] = async () => {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    const proc = spawn('taskkill', ['/F', '/IM', 'adb.exe'], { windowsHide: true });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { out += d.toString(); });
    proc.on('close', (code) => {
      // code 128 on Windows = "no such process" — still a success for us.
      resolve({ ok: true, killed: code === 0, code, out: out.trim().slice(0, 200) });
    });
    proc.on('error', (err) => resolve({ ok: false, error: err.message }));
  });
};

// ─── Version & modules ───────────────────────────────────────────────────────

routes['GET /api/version'] = () => ({ version: CURRENT_VERSION });

// Modules cœur + plugins chargés, pour le panneau « Modules » de l'UI.
routes['GET /api/modules'] = () => ({
  core: Object.keys(bundled).sort(),
  plugins: plugins.getStatus().plugins,
});

// ─── HTTP server ─────────────────────────────────────────────────────────────

// Seule l'UI servie par stakk elle-même (loopback) peut appeler l'API locale.
// Protège contre le CSRF : un site malveillant ouvert dans le même navigateur
// ne peut pas déclencher /api/launch etc. Les autres ports loopback restent
// admis pour le dev (python -m http.server…) : seul un process local peut les
// servir, et le navigateur applique toujours CORS aux sites externes.
const LOCAL_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function isAllowedOrigin(origin) {
  return !!origin && LOCAL_ORIGIN_RE.test(origin);
}

// Dossiers statiques. APP_ROOT d'abord (à côté de l'exe, ou racine du dépôt en
// dev), puis relatif à ce fichier pour les bundles qui aplatissent lib/.
function staticRoot(name) {
  const candidates = [
    path.join(APP_ROOT, name),
    path.join(__dirname, '..', name),
    path.join(__dirname, name),
  ];
  return candidates.find(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } })
    || candidates[0];
}
const UI_DIR      = staticRoot('ui');
const OVERLAY_DIR = staticRoot('overlay');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

// Sert `rel` depuis `root`, sans jamais sortir de `root`.
function serveStatic(res, root, rel) {
  const file = path.resolve(root, '.' + path.posix.normalize('/' + rel));
  if (file !== root && !file.startsWith(root + path.sep)) {
    res.writeHead(403); res.end(); return;
  }
  let buf;
  try { buf = fs.readFileSync(file); }
  catch { res.writeHead(404); res.end('Not found'); return; }
  const ct = CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'no-cache' });
  res.end(buf);
}

function startWebServer(onError) {
  // Auto-import des comptes du launcher Ankama, AVANT d'écouter : l'UI
  // s'ouvre ~1s après le lancement et doit voir les comptes au premier
  // chargement, sans F5 ni clic sur « Importer ». Best-effort : sans
  // launcher installé, importFromLauncher() retourne [].
  try {
    bootImportCount = importLauncherToDisk();
    if (bootImportCount > 0) log(`[boot] auto-import launcher: ${bootImportCount} compte(s)`);
  } catch (e) {
    log(`[boot] auto-import KO: ${e.message}`);
  }

  // Init des factories dès le boot (non bloquant — erreurs logguées mais ne
  // stoppent pas stakk), pour que les plugins soient prêts avant le 1er clic.
  ensureFactories().catch(e => log(`[init] erreur: ${e.message}`));

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin || '';
    const referer = req.headers.referer || '';
    const fromAllowedOrigin = isAllowedOrigin(origin);
    const fromAllowedReferer = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(referer);
    const allowed = fromAllowedOrigin || fromAllowedReferer;

    if (fromAllowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(fromAllowedOrigin ? 204 : 403);
      res.end();
      return;
    }

    const { pathname } = parseUrl(req.url);

    // Overlay Electron : renderer servi en HTTP depuis stakk (loopback), donc
    // SAME-ORIGIN avec /api/* → pas de CORS ni de mixed-content.
    if (pathname === '/overlay' || pathname === '/overlay/') {
      serveStatic(res, OVERLAY_DIR, 'index.html');
      return;
    }
    if (pathname.startsWith('/overlay/')) {
      serveStatic(res, OVERLAY_DIR, pathname.slice('/overlay/'.length));
      return;
    }

    // Interface principale.
    if (!pathname.startsWith('/api/')) {
      serveStatic(res, UI_DIR, pathname === '/' ? 'index.html' : pathname.slice(1));
      return;
    }

    // Verrou CSRF : toute requête /api/* doit venir d'une page loopback
    if (!allowed) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Origin not allowed' }));
      return;
    }

    // Dofus Touch APK cloning — raw binary I/O, special-cased so the
    // generic JSON body parser below doesn't try to JSON.parse a 1 GB APK.
    if (pathname === '/api/dt/clone' && req.method === 'POST') {
      await ensureFactories();
      const url = parseUrl(req.url, true);
      const suffix = (url.query && url.query.suffix) || '';
      if (!suffix) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'suffix query param required' }));
        return;
      }
      try {
        const chunks = [];
        let totalBytes = 0;
        for await (const c of req) {
          chunks.push(c);
          totalBytes += c.length;
          if (totalBytes > 2 * 1024 * 1024 * 1024) {
            throw new Error('APK trop gros (max 2 Go)');
          }
        }
        const inputBuf = Buffer.concat(chunks, totalBytes);
        log(`[dt-clone] reçu ${totalBytes} octets, suffix="${suffix}"`);
        const cloned = await dtClone.cloneApk(inputBuf, suffix, (m) => log(m));
        res.writeHead(200, {
          'Content-Type': 'application/vnd.android.package-archive',
          'Content-Length': cloned.length,
        });
        res.end(cloned);
      } catch (e) {
        log(`[dt-clone] erreur: ${e.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // API
    const key = `${req.method} ${pathname}`;
    const handler = routes[key];
    if (!handler) { res.writeHead(404); res.end('Not found'); return; }

    let body = null;
    if (req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { body = {}; }
    }

    try {
      // Handler reçoit (body, req) — les plugins qui ont besoin de la query
      // string parsent req.url eux-mêmes (parseUrl). Les handlers historiques
      // n'utilisent que le 1er arg, donc backward-compat.
      const result = await handler(body, req);
      // Support raw download (logs export)
      if (result?._raw !== undefined) {
        res.writeHead(200, {
          'Content-Type': result._contentType || 'text/plain',
          'Content-Disposition': 'attachment; filename="' + (result._filename || 'export.txt') + '"',
        });
        res.end(result._raw);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      if (onError) onError(err);
      else process.exit(1);
      return;
    }
    throw err;
  });

  // Enregistrer un handler pour recevoir les mises à jour perso détectées par le proxy.
  // On log dans le launchLog pour que l'UI voie l'info instantanément via GET /api/logs.
  // setCharacterUpdateHandler n'est dispo qu'après ensureFactories — on
  // attend la promesse avant de l'appeler.
  ensureFactories().then(() => {
    setCharacterUpdateHandler((accountId, info) => {
      if (info.characterName) {
        log(`[Char] ${accountId} → ${info.characterName} lvl ${info.characterLevel || '?'}${info.characterClass?' ('+info.characterClass+')':''}`);
      } else if (info.characters) {
        log(`[Char] ${accountId} → ${info.characters.length} persos détectés`);
      }
    });
    // setMapUpdateHandler est désormais consommé par le plugin
    // overlay-backend (lib/overlay-backend.js), pas ici.
  }).catch(e => log(`[Char] handler setup failed: ${e.message}`));

  // Loopback uniquement : l'API manipule clés et comptes, et le verrou
  // Origin/Referer ne protège que des navigateurs, pas d'un client du LAN.
  server.listen(WEB_PORT, '127.0.0.1', () => {
    console.log(`\n  Interface web: http://localhost:${WEB_PORT}\n`);
  });
}

module.exports = { startWebServer };
