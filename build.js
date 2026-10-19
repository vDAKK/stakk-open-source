'use strict';

/**
 * STAKK Build Script
 * Compile en .exe avec pkg + copie les fichiers natifs necessaires
 * Ajoute l'icône et masque la console via rcedit
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, 'dist');
const VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
console.log(`\n  STAKK Build v${VERSION}\n`);

// 1. Créer le dossier dist
if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });

// 2. Convertir le logo en .ico
console.log('[build] Conversion logo PNG → ICO...');
const icoPath = path.join(DIST, 'stakk.ico');
try {
  const pngToIco = require('png-to-ico');
  const pngBuf = fs.readFileSync(path.join(__dirname, 'stakk-logo.png'));
  pngToIco(pngBuf).then(buf => {
    fs.writeFileSync(icoPath, buf);
    console.log('  stakk.ico créé');
    buildExe();
  }).catch(e => {
    console.log('  Erreur conversion:', e.message);
    buildExe();
  });
} catch (e) {
  console.log('  png-to-ico manquant, skip');
  buildExe();
}

function buildExe() {
  // 3. Compiler avec pkg
  try {
    console.log('[build] Compilation avec pkg...');
    execSync('npx pkg . -t node18-win-x64 -o dist/stakk.exe --compress GZip', {
      cwd: __dirname,
      stdio: 'inherit',
    });
  } catch (e) {
    console.error('[build] pkg échoué.');
    process.exit(1);
  }

  // 4. Masquer la console (PE subsystem GUI)
  setSubsystemGUI(path.join(DIST, 'stakk.exe'));
  finishBuild();
}

// Modifier le PE subsystem de 3 (CUI/Console) vers 2 (GUI/Windows)
// → l'exe se lance sans fenêtre console
function setSubsystemGUI(exePath) {
  try {
    console.log('[build] Désactivation de la console (PE subsystem)...');
    const buf = fs.readFileSync(exePath);
    // DOS header: PE offset at 0x3C
    const peOffset = buf.readUInt32LE(0x3C);
    // Subsystem is at PE offset + 0x5C (Optional Header + 0x44)
    const subsystemOffset = peOffset + 0x5C;
    const currentSub = buf.readUInt16LE(subsystemOffset);
    if (currentSub === 3) {
      buf.writeUInt16LE(2, subsystemOffset); // 2 = IMAGE_SUBSYSTEM_WINDOWS_GUI
      fs.writeFileSync(exePath, buf);
      console.log('  Console désactivée');
    } else {
      console.log('  Subsystem déjà à ' + currentSub);
    }
  } catch (e) {
    console.log('  Erreur PE:', e.message);
  }
}

function finishBuild() {

  // 5. Copier les fichiers natifs
  console.log('[build] Copie des fichiers natifs...');
  // `srcs` : emplacements candidats, le premier trouvé gagne. Frida vient de
  // node_modules (npm ci en CI) ; release/Release est l'ancien emplacement
  // local. `required` : sans lui stakk.exe démarre mais ne lance aucun jeu
  // (« Could not locate the bindings file ») — le build doit échouer.
  const nativeFiles = [
    { srcs: ['node_modules/frida/build/Release/frida_binding.node', 'release/Release/frida_binding.node'], dst: 'frida_binding.node', required: true },
    { srcs: ['release/binding-v6.0.1-n-api-win32-x64/lzma_native.node'], dst: 'lzma_native.node' },
    { srcs: ['release/binding-v6.0.1-n-api-win32-x64/liblzma.dll'], dst: 'liblzma.dll' },
  ];

  for (const f of nativeFiles) {
    const src = f.srcs.map(s => path.join(__dirname, s)).find(s => fs.existsSync(s));
    if (!src) {
      if (f.required) {
        console.error(`[build] ${f.dst} introuvable (cherché : ${f.srcs.join(', ')})`);
        process.exit(1);
      }
      continue;
    }
    fs.copyFileSync(src, path.join(DIST, f.dst));
    console.log(`  ${f.dst}`);
  }

  // 5b. Bundle Electron pour le sidecar overlay. ~270 MB. pkg ne peut pas
  // packer un binaire natif comme electron.exe → il vit dans dist/electron/
  // à côté de stakk.exe. web-server.js le cherche d'abord là.
  // Incrémental: si dist/electron existe et contient electron.exe, on skip
  // la recopie — gain de temps + évite les locks transitoires sur les dlls.
  const electronSrc = path.join(__dirname, 'node_modules', 'electron', 'dist');
  const electronDst = path.join(DIST, 'electron');
  if (fs.existsSync(electronSrc)) {
    const electronBin = path.join(electronDst, 'electron.exe');
    if (fs.existsSync(electronBin)) {
      console.log('[build] Electron déjà présent, skip copie');
    } else {
      console.log('[build] Copie Electron (~270 MB)...');
      try { fs.rmSync(electronDst, { recursive: true, force: true }); } catch {}
      fs.cpSync(electronSrc, electronDst, { recursive: true });
      console.log('  electron/ bundlé');
    }
  } else {
    console.log('[build] ⚠ node_modules/electron absent — overlay ne marchera pas en prod');
  }

  // 5c. Bundle les fichiers de l'overlay (main.js Electron, preload, index.html,
  // PowerShell watcher). Pas de node_modules — l'overlay n'a aucune dep externe
  // en runtime, juste les modules built-in de Node + Electron.
  const overlaySrc = path.join(__dirname, 'overlay');
  const overlayDst = path.join(DIST, 'overlay');
  if (fs.existsSync(overlaySrc)) {
    console.log('[build] Copie overlay/...');
    fs.rmSync(overlayDst, { recursive: true, force: true });
    fs.cpSync(overlaySrc, overlayDst, { recursive: true });
    // On enlève les fichiers de test/dev éventuels
    for (const stray of ['test-minimal.js', 'main2.js']) {
      const p = path.join(overlayDst, stray);
      try { fs.unlinkSync(p); } catch {}
    }
    console.log('  overlay/ bundlé');
  }

  // 5d. Interface web (servie par stakk sur http://localhost:3000).
  const uiSrc = path.join(__dirname, 'ui');
  const uiDst = path.join(DIST, 'ui');
  console.log('[build] Copie ui/...');
  fs.rmSync(uiDst, { recursive: true, force: true });
  fs.cpSync(uiSrc, uiDst, { recursive: true });
  console.log('  ui/ bundlé');

  // 6. Hygiène sécurité — NUKE tout ce qui peut contenir des credentials
  // utilisateur avant que le zip soit créé. Ces fichiers apparaissent si
  // qqn a lancé stakk.exe depuis dist/ pendant du dev :
  //   - release/data/<accountId>  → key HAAPI, refreshToken, cert Shield
  //   - config.json               → peut contenir groupes réseau nominatifs
  // Un leak de ces fichiers dans une release GitHub = impersonation
  // immédiate de l'auteur du build par n'importe quel downloader.
  const sensitive = [
    path.join(DIST, 'release', 'data'),
    path.join(DIST, 'config.json'),
  ];
  for (const p of sensitive) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
  }
  const dataDst = path.join(DIST, 'release', 'data');
  fs.mkdirSync(dataDst, { recursive: true });
  // Vérif paranoïaque : le dossier data doit être vide, et aucun fichier
  // sensible ne doit être présent à la racine de dist/.
  const stray = fs.readdirSync(dataDst);
  const lingeringSensitive = ['config.json'].filter(f => fs.existsSync(path.join(DIST, f)));
  if (stray.length || lingeringSensitive.length) {
    console.error('[build] ⚠ credentials détectés dans dist/ :', { stray, lingeringSensitive });
    console.error('[build] abort pour éviter leak.');
    process.exit(1);
  }

  // 8. Copier l'icône a coté de l'exe pour le tray
  if (fs.existsSync(icoPath)) {
    console.log('  stakk.ico (pour tray icon)');
  }

  // 9. Créer install.bat qui crée le raccourci STAKK.lnk avec les bons chemins
  // Le .lnk aura l'icône custom — Windows affiche l'icône du raccourci, pas de l'exe
  const installBat = `@echo off
chcp 65001 >nul
setlocal
set "DIR=%~dp0"
powershell -Command "$s=(New-Object -COM WScript.Shell).CreateShortcut('%DIR%STAKK.lnk'); $s.TargetPath='%DIR%stakk.exe'; $s.IconLocation='%DIR%stakk.ico,0'; $s.WorkingDirectory='%DIR%'; $s.Description='STAKK Launcher'; $s.Save()"
echo.
echo Raccourci STAKK créé avec l'icône STAKK.
echo Lance STAKK.lnk pour démarrer le launcher.
echo.
pause
`;
  fs.writeFileSync(path.join(DIST, 'install.bat'), installBat);
  console.log('  install.bat (crée le raccourci)');

  // 9. Ecrire le fichier version
  fs.writeFileSync(path.join(DIST, 'version.txt'), VERSION);

  console.log(`\n[build] Terminé ! → dist/stakk.exe (v${VERSION})\n`);
}
