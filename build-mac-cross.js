'use strict';

/**
 * STAKK Mac cross-build (depuis Windows).
 *
 * Produit un bundle STAKK.app natif Mac que l'user double-clique dans Finder.
 * Pipeline :
 *   1. Télécharge le binaire Node.js officiel darwin-<arch> (cache local)
 *   2. Bundle index.js + lib/ via @vercel/ncc → un seul stakk.js minifié
 *   3. Wrap dans STAKK.app/Contents/{MacOS,Resources,Info.plist}
 *   4. Launcher shell MacOS/STAKK → exec Node runtime + stakk.js
 *
 * Pourquoi pas pkg : pkg sur Windows cross-compile Mac plante avec
 * "spawn UNKNOWN" (fabricator step, bug pkg v5.8 connu). L'approche
 * ncc+Node est plus fiable et produit le même résultat final pour l'user.
 *
 * Structure produite :
 *   dist-mac-<arch>/
 *     STAKK.app/
 *       Contents/
 *         Info.plist                                 metadata app
 *         MacOS/
 *           STAKK                                    launcher shell
 *         Resources/
 *           stakk-runtime                            binaire Node.js darwin
 *           stakk.js                                 bundle ncc (tout le JS)
 *           node_modules/frida/build/Release/frida_binding.node  natif Frida (arch)
 *           node_modules/frida/                      wrapper JS
 *           node_modules/bindings/ + file-uri-to-path
 *           release/data/                            dossier persistance vide
 *           version.txt
 *     install.sh                                     codesign + xattr + SIP
 *
 * Usage :
 *   node build-mac-cross.js arm64   → Apple Silicon
 *   node build-mac-cross.js x64     → Intel
 *   node build-mac-cross.js both    → les 2
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');
const png2icons = require('png2icons');

const NODE_VERSION = 'v18.20.8';  // Doit matcher la version Node locale (devDeps)
const args = process.argv.slice(2);
const target = (args[0] || 'arm64').toLowerCase();
const archs = target === 'both' ? ['arm64', 'x64'] : [target];

for (const arch of archs) {
  if (arch !== 'arm64' && arch !== 'x64') {
    console.error(`ERREUR: arch invalide '${arch}'`);
    process.exit(1);
  }
}

const ROOT    = __dirname;
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

// Cache des binaires Node.js Mac téléchargés (évite le re-download à chaque build)
const NODE_CACHE = path.join(ROOT, 'mac-prebuilds', 'node');
if (!fs.existsSync(NODE_CACHE)) fs.mkdirSync(NODE_CACHE, { recursive: true });

function fetchNodeBinary(arch) {
  const binName = `node-darwin-${arch}-${NODE_VERSION}`;
  const binPath = path.join(NODE_CACHE, binName);
  if (fs.existsSync(binPath)) return Promise.resolve(binPath);
  const url = `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-darwin-${arch}.tar.gz`;
  const tarPath = path.join(os.tmpdir(), `stakk-${binName}.tar.gz`);
  console.log(`[build] Download ${url}`);
  return new Promise((resolve, reject) => {
    const follow = (u) => {
      https.get(u, res => {
        if (res.statusCode === 301 || res.statusCode === 302) return follow(res.headers.location);
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        const w = fs.createWriteStream(tarPath);
        res.pipe(w);
        w.on('finish', () => { w.close(); resolve(); });
        w.on('error', reject);
      }).on('error', reject);
    };
    follow(url);
  }).then(() => {
    console.log('[build] Extract Node binary');
    const inner = `node-${NODE_VERSION}-darwin-${arch}/bin/node`;
    const tarP = tarPath.replace(/\\/g, '/');
    const outP = NODE_CACHE.replace(/\\/g, '/');
    // --force-local empêche GNU tar de lire « C:\… » comme un hôte distant.
    // Utile quand on cross-build depuis Windows, mais macOS embarque bsdtar,
    // qui ne connaît pas l'option et refuse la commande.
    const forceLocal = process.platform === 'win32' ? '--force-local ' : '';
    execSync(`tar ${forceLocal}-xzf "${tarP}" -C "${outP}" "${inner}"`, {
      stdio: 'inherit', shell: true,
    });
    const extracted = path.join(NODE_CACHE, inner);
    fs.copyFileSync(extracted, binPath);
    try { fs.rmSync(path.join(NODE_CACHE, `node-${NODE_VERSION}-darwin-${arch}`), { recursive: true, force: true }); } catch {}
    try { fs.unlinkSync(tarPath); } catch {}
    fs.chmodSync(binPath, 0o755);
    return binPath;
  });
}

function bundleWithNcc(outDir) {
  if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
  console.log('[build] ncc build (bundle + tree-shake)');
  // --external frida / electron : ncc ne bundle pas le natif, on le fournit
  // séparément dans Resources/node_modules/
  execSync(
    `npx ncc build index.js -o "${outDir}" --external frida --external electron --minify`,
    { cwd: ROOT, stdio: 'inherit' }
  );
}

// Copie un package ET toutes ses deps runtime transitivement depuis
// node_modules/ source → node_modules/ dest. Ignore devDependencies.
// Nécessaire pour les modules externes ncc (frida) : ncc ne les copie pas,
// et bindings.js + device.js de frida require()nt des deps runtime (minimatch,
// brace-expansion…) qui doivent exister côté binary.
function copyPackageWithDeps(pkgName, srcNodeModules, destNodeModules, visited = new Set()) {
  if (visited.has(pkgName)) return;
  visited.add(pkgName);
  const srcPkgDir = path.join(srcNodeModules, pkgName);
  if (!fs.existsSync(srcPkgDir)) return;
  const destPkgDir = path.join(destNodeModules, pkgName);
  if (!fs.existsSync(destPkgDir)) {
    fs.cpSync(srcPkgDir, destPkgDir, { recursive: true });
  }
  let pkgJson = null;
  try {
    pkgJson = JSON.parse(fs.readFileSync(path.join(srcPkgDir, 'package.json'), 'utf8'));
  } catch { return; }
  const deps = pkgJson.dependencies || {};
  for (const dep of Object.keys(deps)) {
    copyPackageWithDeps(dep, srcNodeModules, destNodeModules, visited);
  }
}

async function buildArch(arch) {
  console.log(`\n=== STAKK Mac v${VERSION} ${arch} ===\n`);
  const DIST       = path.join(ROOT, `dist-mac-${arch}`);
  const bundleDir  = path.join(ROOT, `.ncc-bundle-${arch}`);
  try { fs.rmSync(DIST, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(DIST, { recursive: true });

  // Structure .app standard
  const APP      = path.join(DIST, 'STAKK.app');
  const CONTENTS = path.join(APP, 'Contents');
  const MACOS    = path.join(CONTENTS, 'MacOS');
  const RES      = path.join(CONTENTS, 'Resources');
  fs.mkdirSync(MACOS, { recursive: true });
  fs.mkdirSync(RES,   { recursive: true });

  // 1. Node binary officiel → Resources/stakk-runtime
  const nodeBin = await fetchNodeBinary(arch);
  fs.copyFileSync(nodeBin, path.join(RES, 'stakk-runtime'));
  fs.chmodSync(path.join(RES, 'stakk-runtime'), 0o755);

  // 2. Bundle ncc → Resources/stakk.js (+ éventuels chunks)
  bundleWithNcc(bundleDir);
  fs.copyFileSync(path.join(bundleDir, 'index.js'), path.join(RES, 'stakk.js'));
  // Tout ce que ncc a émis, pas seulement les .js.
  //
  // ncc reconnaît les `fs.readFileSync(path.join(__dirname, …))` et recopie
  // les fichiers de données à côté du bundle : `monde.json.gz` (graphe du
  // monde), `dofus-schema.json.gz` (schéma protobuf). Un filtre sur `.js` les
  // aurait jetés. Les .json requis, eux, sont déjà
  // inlinés dans le bundle et n'apparaissent pas ici.
  for (const f of fs.readdirSync(bundleDir)) {
    if (f === 'index.js' || f === 'package.json') continue;
    const src = path.join(bundleDir, f);
    if (!fs.statSync(src).isFile()) continue;
    fs.copyFileSync(src, path.join(RES, f));
  }

  // Garde-fou : ces tables se chargent par chemin, donc leur absence ne
  // se voit qu'à l'exécution, sur une machine qu'on n'a pas sous la main. Un
  // build qui part sans elles doit échouer ici, pas chez l'utilisateur.
  for (const table of ['monde.json.gz', 'dofus-schema.json.gz']) {
    if (!fs.existsSync(path.join(RES, table))) {
      console.error(`ERREUR: ${table} absent du bundle — la fonctionnalité qui en dépend serait morte en release.`);
      process.exit(1);
    }
  }

  // 3. frida_binding.node natif Mac (arch-specific). Frida 17 met le binding
  //    à `<module_root>/build/frida_binding.node` (différent du legacy
  //    `build/Release/<name>.node` du package `bindings`). On supporte les
  //    deux layouts pour permettre downgrade futur.
  const fridaCandidates = [
    path.join(ROOT, 'mac-prebuilds', arch, 'build', 'frida_binding.node'),
    path.join(ROOT, 'mac-prebuilds', arch, 'build', 'Release', 'frida_binding.node'),
  ];
  const fridaSrc = fridaCandidates.find(p => fs.existsSync(p));
  if (!fridaSrc) {
    console.error(`ERREUR: frida binding manquant pour ${arch}. Cherché :`);
    fridaCandidates.forEach(p => console.error(`  ${p}`));
    console.error(`Télécharge depuis https://github.com/frida/frida/releases/tag/17.9.1`);
    console.error(`(frida-v17.9.1-napi-v8-darwin-${arch}.tar.gz, contient build/frida_binding.node)`);
    process.exit(1);
  }

  // 4. Copie frida + toutes ses deps transitives runtime depuis mac-frida/.
  //    Le client principal reste sur frida 15 (CJS, compat Windows) ; mac-frida/
  //    a une install isolée frida 17 ESM qui supporte le dyld moderne (macOS
  //    Tahoe). web-server.js charge frida via dynamic import() qui marche
  //    pour les deux layouts.
  const macFridaModules = path.join(ROOT, 'mac-frida', 'node_modules');
  const srcModules  = fs.existsSync(macFridaModules) ? macFridaModules : path.join(ROOT, 'node_modules');
  const destModules = path.join(RES, 'node_modules');
  fs.mkdirSync(destModules, { recursive: true });
  copyPackageWithDeps('frida', srcModules, destModules);

  // Écrase le binding (Windows .node fetché par npm install sur ce poste)
  // par le prebuild Mac arch-specific.
  const fridaBuildDir = path.join(destModules, 'frida', 'build');
  fs.mkdirSync(fridaBuildDir, { recursive: true });
  fs.copyFileSync(fridaSrc, path.join(fridaBuildDir, 'frida_binding.node'));

  // 5. Launcher shell : Contents/MacOS/STAKK. Finder l'exécute au double-clic.
  //    STAKK_APP_ROOT = Resources/ → DATA_DIR, CONFIG_PATH, overlay/ résolvent
  //    au bon endroit (index.js lit process.env.STAKK_APP_ROOT en priorité).
  //
  //    Auto-élévation : Frida.spawn() a besoin de task_for_pid sur Dofus.app,
  //    refusé par le kernel sans entitlement debugger Apple-signé même SIP off.
  //    Le seul moyen sans cert Apple Developer = tourner en root. Le launcher
  //    se ré-exécute via osascript "do shell script ... with administrator
  //    privileges" → prompt mdp macOS natif au 1er run, STAKK tourne ensuite
  //    en root et Frida peut injecter Dofus. Si l'user annule le prompt, on
  //    bascule en mode normal (UI accessible mais Frida ne pourra pas hook).
  const launcher = `#!/bin/bash
DIR="$(cd "$(dirname "$0")/../Resources" && pwd)"

# Mode diagnostic : dump l'environnement et sort, sans prompt d'élévation.
#   STAKK_DIAG=1 ./STAKK.app/Contents/MacOS/STAKK        (en tant qu'user)
#   sudo STAKK_DIAG=1 ./STAKK.app/Contents/MacOS/STAKK   (env root, comme en prod)
# Les deux sorties ensemble montrent ce que l'élévation casse.
if [ -n "$STAKK_DIAG" ]; then
  export STAKK_APP_ROOT="$DIR"
  cd "$DIR"
  exec "$DIR/stakk-runtime" "$DIR/stakk.js" diag
fi

# Déjà root (relaunch via osascript) → run direct
if [ "$(id -u)" = "0" ]; then
  export STAKK_APP_ROOT="$DIR"
  cd "$DIR"
  exec "$DIR/stakk-runtime" "$DIR/stakk.js"
fi

# Bypass volontaire de l'élévation : touch ~/.stakk-no-sudo pour ne plus
# être prompt (utile si l'user accepte que Frida ne marche pas).
if [ -f "$HOME/.stakk-no-sudo" ]; then
  export STAKK_APP_ROOT="$DIR"
  cd "$DIR"
  exec "$DIR/stakk-runtime" "$DIR/stakk.js"
fi

SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
# On conserve HOME et USER côté élévation — sinon ~/.stakk (réglages,
# comptes) partirait dans /var/root et l'user perdrait l'accès à
# ses comptes existants. Heredoc pour éviter l'escape hell de "do shell
# script \"...\"" : bash expand $USER_HOME et $SELF avant osascript.
USER_HOME="$HOME"
USER_NAME="$USER"
osascript >/dev/null 2>&1 <<APPLESCRIPT
do shell script "HOME='$USER_HOME' USER='$USER_NAME' '$SELF'" with administrator privileges
APPLESCRIPT
RC=$?
if [ $RC -ne 0 ]; then
  echo "[launcher] Élévation refusée — STAKK démarre en mode user (Frida désactivé)" >&2
  export STAKK_APP_ROOT="$DIR"
  cd "$DIR"
  exec "$DIR/stakk-runtime" "$DIR/stakk.js"
fi
`;
  const launcherPath = path.join(MACOS, 'STAKK');
  fs.writeFileSync(launcherPath, launcher);
  fs.chmodSync(launcherPath, 0o755);

  // 6. Icon : génère stakk.icns depuis stakk-logo.png. png2icons fait une
  //    vraie conversion multi-résolutions (.icns = conteneur Apple avec PNG
  //    à plusieurs sizes : 16, 32, 64, 128, 256, 512, 1024). Finder utilisera
  //    l'icône au double-clic, dans le Dock, Cmd+Tab, etc.
  try {
    const logoPng = fs.readFileSync(path.join(ROOT, 'stakk-logo.png'));
    const icnsBuf = png2icons.createICNS(logoPng, png2icons.BILINEAR, 0);
    if (icnsBuf) {
      fs.writeFileSync(path.join(RES, 'stakk.icns'), icnsBuf);
    } else {
      console.log('[build] png2icons.createICNS retourne null — pas d\'icône');
    }
  } catch (e) {
    console.log(`[build] icon generation échoué: ${e.message}`);
  }

  // 7. Info.plist : déclare l'app à LaunchServices. CFBundleExecutable doit
  //    matcher le nom du fichier MacOS/. CFBundleIconFile pointe vers
  //    stakk.icns dans Resources/ (sans extension — convention Apple).
  const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>STAKK</string>
  <key>CFBundleIconFile</key>
  <string>stakk</string>
  <key>CFBundleIdentifier</key>
  <string>fr.vdakk.stakk</string>
  <key>CFBundleName</key>
  <string>STAKK</string>
  <key>CFBundleDisplayName</key>
  <string>STAKK</string>
  <key>CFBundleVersion</key>
  <string>${VERSION}</string>
  <key>CFBundleShortVersionString</key>
  <string>${VERSION}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleSignature</key>
  <string>????</string>
  <key>LSMinimumSystemVersion</key>
  <string>10.15</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>LSUIElement</key>
  <false/>
</dict>
</plist>
`;
  fs.writeFileSync(path.join(CONTENTS, 'Info.plist'), infoPlist);

  // 7. Data dir vide + version dans Resources/
  fs.mkdirSync(path.join(RES, 'release', 'data'), { recursive: true });
  fs.writeFileSync(path.join(RES, 'version.txt'), VERSION);

  // 7b. ui/ et overlay/ — servis par web-server.js depuis APP_ROOT.
  for (const dir of ['ui', 'overlay']) {
    const src = path.join(ROOT, dir);
    if (fs.existsSync(src)) {
      fs.cpSync(src, path.join(RES, dir), { recursive: true });
      console.log(`[build] ${dir}/ copié`);
    }
  }

  // 7b-bis. mac-helper/keytap — capture clavier/souris globale.
  //
  //   Le script Frida injecté ne peut PAS lire l'entrée physique : Dofus tourne
  //   en hardened runtime, et dès que du code non signé y est injecté macOS
  //   cesse d'honorer ses autorisations TCC d'entrée. STAKK, lui, n'est pas
  //   injecté — il porte le droit et fait la lecture, puis agit par RPC.
  //   Sans ce binaire, organizer et click-boadcast loggent « helper absent »
  //   et les raccourcis restent inertes.
  //
  //   Compilé ici plutôt que versionné : c'est un exécutable natif, et il doit
  //   correspondre à l'arch du bundle en cours de build.
  const keytapSrc = path.join(ROOT, 'mac-helper', 'keytap.swift');
  if (fs.existsSync(keytapSrc)) {
    const helperDir = path.join(RES, 'mac-helper');
    fs.mkdirSync(helperDir, { recursive: true });
    const keytapOut = path.join(helperDir, 'keytap');
    // -target : le build cross produit les deux arches depuis une seule
    // machine, donc on ne peut pas se fier à l'arch de l'hôte.
    const swiftTarget = `${arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos11.0`;
    try {
      execSync(`swiftc -O -target ${swiftTarget} -o "${keytapOut}" "${keytapSrc}"`, { stdio: 'pipe' });
      fs.chmodSync(keytapOut, 0o755);
      console.log(`[build] mac-helper/keytap compilé (${swiftTarget})`);
    } catch (e) {
      // Non fatal : le reste de l'app fonctionne, seuls les raccourcis et le
      // broadcast de clic sont perdus. On le dit fort plutôt que de livrer
      // un bundle silencieusement amputé.
      const detail = (e.stderr || e.stdout || '').toString().trim().split('\n')[0] || e.message;
      console.warn(`[build] ATTENTION: keytap non compilé (${detail})`);
      console.warn('[build]   → raccourcis fenêtre et broadcast de clic inactifs dans ce bundle');
    }
  }

  // 8. install.sh à côté de STAKK.app : codesign ad-hoc PLAIN (sans hardened
  //    runtime) + strip quarantine. À exécuter 1 fois après extraction du zip.
  //
  //    HISTORIQUE : v1.4.14 → v1.4.16 utilisaient `--options runtime` +
  //    entitlements debugger. Mauvaise idée : hardened runtime active la
  //    vérification stricte des entitlements, et Apple n'honore cs.debugger
  //    que pour des binaires signés avec un cert Developer ID. Ad-hoc +
  //    --options runtime = kernel bloque task_for_pid → frida.spawn fail
  //    avec "Undefined error: 0" même en root. krm ne signe pas du tout sa
  //    fausse "Ankama Launcher" et son tool marche → la signature ad-hoc
  //    plain (juste pour permettre au .node natif de loader sur Apple
  //    Silicon, pas de hardened runtime) est la bonne approche.
  const installSh = `#!/bin/bash
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$DIR/STAKK.app"

if [ ! -d "$APP" ]; then
  echo "ERREUR: STAKK.app introuvable dans $DIR"
  exit 1
fi

echo "[1/4] Permissions exécutables..."
chmod +x "$APP/Contents/MacOS/STAKK"
chmod +x "$APP/Contents/Resources/stakk-runtime"

echo "[2/4] Retire le flag quarantine (évite Gatekeeper)..."
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

echo "[3/4] Ad-hoc signature plain (PAS de --options runtime)..."
# --deep pour signer le frida_binding.node natif aussi (requis Apple Silicon).
# --options runtime VOLONTAIREMENT OMIS : avec hardened runtime, l'entitlement
# debugger ad-hoc serait rejeté par le kernel et frida.spawn échouerait sur
# Dofus.app même en root.
codesign --force --deep --sign - "$APP" 2>/dev/null || true

echo ""
echo "================================================================"
echo "  STAKK.app prêt dans: $APP"
echo "================================================================"
echo ""
echo "[4/4] SIP doit être désactivé pour que Frida puisse injecter :"
echo "  1. Reboot en Recovery (Intel: Cmd+R · Apple Silicon: hold power)"
echo "  2. Terminal > csrutil disable"
echo "  3. Reboot normalement"
echo ""
echo "Lance STAKK : double-clic sur STAKK.app dans Finder. Tu seras prompt"
echo "pour ton mot de passe admin (élévation root requise pour Frida)."
`;
  fs.writeFileSync(path.join(DIST, 'install.sh'), installSh);
  fs.chmodSync(path.join(DIST, 'install.sh'), 0o755);

  // Cleanup bundle intermédiaire
  try { fs.rmSync(bundleDir, { recursive: true, force: true }); } catch {}

  // Hygiène sécurité : aucun credential local ne doit fuiter dans la release
  for (const p of [path.join(RES, 'config.json')]) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
  }
  // Vérif paranoïaque avant zip : release/data doit être vide. Un fichier de
  // compte oublié = key HAAPI + refreshToken publiés dans la release GitHub.
  const dataDir = path.join(RES, 'release', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const strayData = fs.readdirSync(dataDir);
  if (strayData.length) {
    console.error('[build] credentials détectés dans release/data :', strayData);
    console.error('[build] abort pour éviter le leak.');
    process.exit(1);
  }

  // 9. Zip de release. bsdtar (System32) écrit un vrai zip avec des séparateurs
  //    "/" — contrairement à Compress-Archive de PowerShell 5.1 qui produit des
  //    backslashes illisibles côté macOS. Les bits exécutables ne survivent pas
  //    au transfert, c'est install.sh qui les remet (chmod + codesign).
  const zipName = `macos-${arch}-v${VERSION}.zip`;
  const zipPath = path.join(ROOT, zipName);
  try { fs.rmSync(zipPath, { force: true }); } catch {}
  try {
    if (process.platform === 'win32') {
      const bsdtar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
      execSync(`"${bsdtar}" -a -c -f "${zipPath}" STAKK.app install.sh`, {
        cwd: DIST, stdio: 'inherit',
      });
    } else {
      // Sur macOS, `zip -y` archive STAKK.app ET install.sh en une passe, en
      // gardant les bits exécutables et les liens symboliques du bundle.
      // install.sh reste chargé de la signature ad-hoc et du déquarantinage.
      execSync(`zip -q -r -y "${zipPath}" STAKK.app install.sh`, {
        cwd: DIST, stdio: 'inherit',
      });
    }
    const mb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
    console.log(`[build] ${zipName} (${mb} MB)`);
  } catch (e) {
    console.error(`[build] zip échoué (${e.message}) — zippe dist-mac-${arch}/ à la main`);
  }

  console.log(`\n[build] Terminé → ${APP} (v${VERSION} ${arch})`);
}

(async () => {
  for (const arch of archs) {
    await buildArch(arch);
  }
  console.log('\nTous les builds Mac terminés.');
})().catch(e => { console.error(e); process.exit(1); });
