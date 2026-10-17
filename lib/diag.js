'use strict';

/**
 * diag.js — Rapport de diagnostic one-shot, principalement pour macOS.
 *
 * Le build Mac est cross-compilé depuis Windows et lancé via un launcher shell
 * qui se ré-exécute en root (osascript). Beaucoup de choses peuvent diverger
 * silencieusement entre les deux environnements : identité de l'utilisateur
 * effectif, arch du process vs arch du launcher Ankama, chemins d'install des
 * jeux, présence du binding Frida natif. Ce module dump tout ça en une passe
 * pour qu'un testeur Mac produise l'évidence en un seul run.
 *
 * Aucune donnée sensible n'est imprimée : pour le keydata on ne sort que des
 * booléens, des compteurs et le nom de la variante de clé qui déchiffre.
 *
 * Usage :
 *   node index.js diag
 *   ./STAKK.app/Contents/MacOS/STAKK  (avec STAKK_DIAG=1, pas d'élévation)
 */

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');
const net    = require('net');

const { machineIdSync } = require('./machine-id');

const IS_MAC = process.platform === 'darwin';
const HOME   = process.env.HOME || process.env.USERPROFILE || '';

const out = [];
function say(line) { out.push(line); }
function section(title) { say(''); say(`── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`); }
function kv(k, v) { say(`  ${k.padEnd(26)} ${v}`); }
function check(label, ok, detail) {
  say(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}

function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

// ─── 1. Runtime ───────────────────────────────────────────────────────────────

function reportRuntime() {
  section('Runtime');
  kv('platform / arch', `${process.platform} / ${process.arch}`);
  kv('node', process.version);
  kv('os.release', os.release());
  kv('cpus', `${os.cpus().length} × ${os.cpus()[0] ? os.cpus()[0].model : '?'}`);
  kv('totalmem (MB)', Math.round(os.totalmem() / 1024 / 1024));

  if (process.getuid) {
    kv('uid / euid', `${process.getuid()} / ${process.geteuid()}`);
  }

  // Le point critique : sous élévation osascript, le launcher préserve HOME et
  // USER dans l'environnement, mais os.userInfo() lit getpwuid(geteuid()) et
  // renvoie donc "root". createHmEncoders() de launcher-import.js utilise
  // os.userInfo().username → hm1/hm2 calculés avec la mauvaise identité.
  let userInfoName = '?';
  try { userInfoName = os.userInfo().username; } catch (e) { userInfoName = `<throw: ${e.message}>`; }
  kv('os.userInfo().username', userInfoName);
  kv('process.env.USER', process.env.USER || '<unset>');
  if (userInfoName !== (process.env.USER || userInfoName)) {
    say(`  >>> MISMATCH username : hm1/hm2 seront calculés avec "${userInfoName}"`);
    say(`      alors que le launcher Ankama a chiffré avec "${process.env.USER}".`);
  }

  kv('os.homedir()', os.homedir());
  kv('process.env.HOME', process.env.HOME || '<unset>');
  if (os.homedir() !== (process.env.HOME || os.homedir())) {
    say('  >>> MISMATCH homedir : ~/.stakk (réglages, overlay) part au mauvais endroit.');
  }

  kv('cwd', process.cwd());
  kv('STAKK_APP_ROOT', process.env.STAKK_APP_ROOT || '<unset>');
  kv('__dirname', __dirname);
  kv('machineId (sha256, 12)', machineIdSync().slice(0, 12) + '…');
}

// ─── 2. Intégrité du bundle ───────────────────────────────────────────────────

function appRoot() {
  return process.env.STAKK_APP_ROOT
    || (process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..'));
}

function reportBundle() {
  section('Bundle');
  const ROOT = appRoot();
  kv('APP_ROOT résolu', ROOT);

  const wanted = [
    ['stakk-runtime',            'binaire Node darwin'],
    ['stakk.js',                 'bundle ncc'],
    ['node_modules/frida',       'wrapper frida JS'],
    ['node_modules/frida/build/frida_binding.node', 'binding natif frida'],
    ['release/data',             'persistance comptes'],
    ['version.txt',              'version'],
    ['overlay',                  'fallback overlay local'],
  ];
  for (const [rel, desc] of wanted) {
    check(rel.padEnd(46) + desc, exists(path.join(ROOT, rel)));
  }

  const vf = path.join(ROOT, 'version.txt');
  if (exists(vf)) {
    try { kv('version.txt', fs.readFileSync(vf, 'utf8').trim()); } catch {}
  }

  // frida 17 est ESM : son package.json déclare "type": "module". Si le
  // package copié dans le .app est la version Windows (15, CJS), le
  // dynamic import du bundle chargera un module incompatible avec le
  // binding natif darwin.
  const fpkg = path.join(ROOT, 'node_modules', 'frida', 'package.json');
  if (exists(fpkg)) {
    try {
      const p = JSON.parse(fs.readFileSync(fpkg, 'utf8'));
      kv('frida package', `v${p.version} (type=${p.type || 'commonjs'})`);
      if (IS_MAC && p.type !== 'module') {
        say('  >>> Sur Mac on attend frida 17 ESM. Le build a copié la version Windows.');
      }
    } catch {}
  }
}

// ─── 3. Chargement de Frida ───────────────────────────────────────────────────

async function reportFrida() {
  section('Frida');
  // Même mécanisme que web-server.js : new Function() échappe à la réécriture
  // statique de ncc, qui transformerait sinon import() en require() → ERR_REQUIRE_ESM.
  let frida = null;
  try {
    if (IS_MAC) {
      const dynImport = new Function('m', 'return import(m)');
      const m = await dynImport('frida');
      frida = m.default || m;
    } else {
      frida = require('frida');
    }
    check('chargement du module frida', true);
  } catch (e) {
    check('chargement du module frida', false, e.message);
    return;
  }

  try {
    const dev = await frida.getLocalDevice();
    check('frida.getLocalDevice()', true, dev.name);
  } catch (e) {
    check('frida.getLocalDevice()', false, e.message);
  }

  // enumerateProcesses exige déjà des privilèges sur macOS : si ça passe,
  // task_for_pid a de bonnes chances de passer aussi.
  try {
    const dev = await frida.getLocalDevice();
    const procs = await dev.enumerateProcesses();
    check('enumerateProcesses()', true, `${procs.length} process visibles`);
  } catch (e) {
    check('enumerateProcesses()', false, e.message);
  }
}

// ─── 4. Launcher Ankama : chemins + jeux ──────────────────────────────────────

const ZAAP_BASE = IS_MAC
  ? path.join(HOME, 'Library', 'Application Support', 'zaap')
  : path.join(process.env.APPDATA || '', 'zaap');

const FALLBACK_DIRS = IS_MAC
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

const GAME_EXES = IS_MAC
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

function reportGames() {
  section('Launcher Ankama / jeux');
  kv('ZAAP_BASE', ZAAP_BASE);
  check('ZAAP_BASE existe', exists(ZAAP_BASE));

  const repos = path.join(ZAAP_BASE, 'repositories', 'repositories.json');
  check('repositories.json', exists(repos), repos);

  const dirs = { ...FALLBACK_DIRS };
  let fromRepos = 0;
  if (exists(repos)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(repos, 'utf8'));
      let byName = {};
      if (parsed.repositories && !Array.isArray(parsed.repositories) && typeof parsed.repositories === 'object') byName = parsed.repositories;
      else if (Array.isArray(parsed.repositories)) for (const r of parsed.repositories) if (r && r.name) byName[r.name] = r;
      else if (typeof parsed === 'object') byName = parsed;
      say(`  clés présentes dans repositories.json : ${Object.keys(byName).join(', ') || '<aucune>'}`);
      for (const [k, names] of Object.entries(ZAAP_NAMES)) {
        for (const n of names) {
          const e = byName[n];
          const loc = e && (e.location || e.path || e.dir);
          if (typeof loc === 'string' && loc) { dirs[k] = loc; fromRepos++; break; }
        }
      }
    } catch (e) {
      say(`  parse repositories.json échoué : ${e.message}`);
    }
  }
  kv('résolus depuis repos.json', `${fromRepos}/4 (le reste = fallback hardcodé)`);

  say('');
  for (const [key, dir] of Object.entries(dirs)) {
    const exe = path.join(dir, GAME_EXES[key]);
    check(`${key.padEnd(7)} dir`, exists(dir), dir);
    check(`${key.padEnd(7)} exe`, exists(exe), exe);
  }
}

// ─── 5. keydata : quelle variante de clé déchiffre ? ──────────────────────────

// launcher-import.js dérive la clé AES d'un seul jeu de valeurs
// (platform, arch, machineId, nbCpus, modèle cpu). Si le launcher Ankama a
// chiffré depuis un process aux caractéristiques différentes — typiquement
// Electron x64 sous Rosetta pendant que STAKK tourne arm64 natif — la clé ne
// correspond pas et le déchiffrement throw. On teste ici plusieurs variantes
// plausibles pour identifier laquelle est la bonne sur cette machine.
function keyCandidates() {
  const machineId = machineIdSync();
  const realArch  = os.arch();
  const realCount = os.cpus().length;
  const realModel = os.cpus()[0] ? os.cpus()[0].model : '';

  const archs  = IS_MAC ? [realArch, realArch === 'arm64' ? 'x64' : 'arm64'] : [realArch];
  // Sous Rosetta, os.cpus() ne rapporte pas forcément le même nombre de cores
  // que nativement. On balaie les valeurs plausibles autour du réel.
  const counts = Array.from(new Set([realCount, realCount / 2, realCount * 2].filter(n => Number.isInteger(n) && n > 0)));
  const models = Array.from(new Set([realModel, 'Apple processor'].filter(Boolean)));

  const list = [];
  for (const arch of archs) {
    for (const count of counts) {
      for (const model of models) {
        list.push({
          label: `arch=${arch} cpus=${count} model="${model}"`,
          uuid: [os.platform(), arch, machineId, count, model].join(),
        });
      }
    }
  }
  return list;
}

function tryDecrypt(raw, uuid) {
  const [ivHex, encHex] = raw.split('|');
  const key = crypto.createHash('md5').update(uuid).digest();
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.from(ivHex, 'hex'));
  const dec = Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]);
  return JSON.parse(dec.toString());
}

function reportKeydata() {
  section('keydata Ankama (import comptes)');
  const KEYDATA = path.join(ZAAP_BASE, 'keydata');
  kv('KEYDATA_PATH', KEYDATA);
  if (!exists(KEYDATA)) {
    check('dossier keydata', false, 'introuvable — le launcher n\'a jamais mémorisé de compte, ou HOME est faux');
    return;
  }

  let files = [];
  try {
    files = fs.readdirSync(KEYDATA).filter(f => f.startsWith('.keydata'));
  } catch (e) {
    check('lecture keydata', false, e.message);
    return;
  }
  check('dossier keydata', true, `${files.length} fichier(s) .keydata`);
  if (!files.length) return;

  const raw = (() => {
    try { return fs.readFileSync(path.join(KEYDATA, files[0]), 'utf8'); } catch { return null; }
  })();
  if (!raw) { check('lecture du 1er keydata', false); return; }

  const candidates = keyCandidates();
  say(`  ${candidates.length} variante(s) de clé testée(s) sur ${files[0]} :`);
  let winner = null;
  for (const c of candidates) {
    try {
      const obj = tryDecrypt(raw, c.uuid);
      // On n'imprime AUCUNE valeur déchiffrée : juste les noms de champs.
      say(`  OK   ${c.label} → champs: ${Object.keys(obj).join(',')}`);
      if (!winner) winner = c;
    } catch (e) {
      say(`  FAIL ${c.label} → ${e.message}`);
    }
  }

  say('');
  if (!winner) {
    say('  >>> AUCUNE variante ne déchiffre. La dérivation de clé de');
    say('      launcher-import.js:40 ne correspond pas à ce launcher.');
  } else if (winner.label.startsWith(`arch=${os.arch()} cpus=${os.cpus().length}`)) {
    say('  >>> La variante native fonctionne : la dérivation de clé actuelle est bonne.');
  } else {
    say(`  >>> Seule une variante NON native déchiffre : ${winner.label}`);
    say('      launcher-import.js:40 doit balayer les variantes au lieu d\'en');
    say('      supposer une seule.');
  }
}

// ─── 6. Divers ────────────────────────────────────────────────────────────────

function reportBrowser() {
  section('Browser (login HAAPI)');
  const candidates = IS_MAC ? [
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ] : [
    'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ];
  const found = candidates.filter(exists);
  check('browser Chromium trouvé', found.length > 0, found[0] || candidates.join(' | '));

  // haapi.js écrit le profil Puppeteer dans <bundle>/../cache/browser/<login>.
  // Dans un .app installé sous /Applications ça tombe DANS le bundle, ce qui
  // casse la signature et échoue si le volume est en lecture seule.
  const userDataParent = path.join(appRoot(), 'cache', 'browser');
  kv('profil Puppeteer', userDataParent);
  let writable = false;
  try {
    fs.mkdirSync(userDataParent, { recursive: true });
    const probe = path.join(userDataParent, '.diag-write-probe');
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    writable = true;
  } catch (e) {
    check('profil Puppeteer inscriptible', false, e.message);
  }
  if (writable) check('profil Puppeteer inscriptible', true);
}

function reportPort() {
  section('Port 3000');
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', e => {
      check('bind 127.0.0.1:3000', false, e.code);
      resolve();
    });
    srv.once('listening', () => {
      check('bind 127.0.0.1:3000', true, 'libre');
      srv.close(() => resolve());
    });
    srv.listen(3000, '127.0.0.1');
  });
}

// ─── Entrée ───────────────────────────────────────────────────────────────────

async function runDiag() {
  out.length = 0;
  say('');
  say('════════════ STAKK diag ════════════');

  reportRuntime();
  reportBundle();
  await reportFrida();
  reportGames();
  reportKeydata();
  reportBrowser();
  await reportPort();

  say('');
  say('════════════ fin ════════════');
  say('');

  const text = out.join('\n');
  process.stdout.write(text + '\n');
  return text;
}

module.exports = { runDiag };
