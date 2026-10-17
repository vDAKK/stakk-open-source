'use strict';

/**
 * STAKK Mac Build Script
 *
 * IMPORTANT : Ce script doit être exécuté SUR UN MAC.
 * Il compile stakk pour macOS avec pkg (target darwin-x64 ou darwin-arm64).
 *
 * Prérequis :
 *   - macOS (Intel ou Apple Silicon)
 *   - Node.js 18
 *   - npm install terminé
 *   - Frida binding natif darwin (téléchargé via `npm install`)
 *
 * Après le build :
 *   - Distribuer le binaire `dist/stakk` (pas d'extension sur Mac)
 *   - L'utilisateur doit désactiver SIP pour que Frida fonctionne
 *     (voir README.md)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

if (os.platform() !== 'darwin') {
  console.error('ERREUR: Ce script doit être exécuté sur macOS.');
  console.error('Sur Windows, utilise `node build.js`.');
  process.exit(1);
}

const DIST = path.join(__dirname, 'dist-mac');
const VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;

console.log(`\n  STAKK Mac Build v${VERSION}\n`);

if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });

// Détecter l'architecture (x64 ou arm64)
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const target = `node18-macos-${arch}`;
console.log(`[build] Target: ${target}`);

// Compiler avec pkg
try {
  execSync(`npx pkg . -t ${target} -o dist-mac/stakk`, {
    cwd: __dirname,
    stdio: 'inherit',
  });
} catch (e) {
  console.error('[build] pkg échoué.');
  process.exit(1);
}

// Rendre exécutable
fs.chmodSync(path.join(DIST, 'stakk'), 0o755);

// Copier le binding Frida pour darwin (inclus dans node_modules/frida/build/)
const fridaBindingSrc = path.join(__dirname, 'node_modules', 'frida', 'build', 'Release', 'frida_binding.node');
if (fs.existsSync(fridaBindingSrc)) {
  fs.copyFileSync(fridaBindingSrc, path.join(DIST, 'frida_binding.node'));
  console.log('  frida_binding.node');
}

// Interface web + overlay, servis par stakk depuis le dossier de l'exe
for (const dir of ['ui', 'overlay']) {
  const src = path.join(__dirname, dir);
  if (fs.existsSync(src)) {
    fs.rmSync(path.join(DIST, dir), { recursive: true, force: true });
    fs.cpSync(src, path.join(DIST, dir), { recursive: true });
    console.log(`  ${dir}/`);
  }
}

// Créer le dossier data
const dataDst = path.join(DIST, 'release', 'data');
if (!fs.existsSync(dataDst)) fs.mkdirSync(dataDst, { recursive: true });

// Créer STAKK.command (double-click pour lancer)
const commandScript = `#!/bin/bash
cd "$(dirname "$0")"
./stakk
`;
const cmdPath = path.join(DIST, 'STAKK.command');
fs.writeFileSync(cmdPath, commandScript);
fs.chmodSync(cmdPath, 0o755);
console.log('  STAKK.command (lanceur)');

// Créer install.sh pour permissions SIP
const installSh = `#!/bin/bash
# STAKK Mac Installation

DIR="$(cd "$(dirname "$0")" && pwd)"
chmod +x "$DIR/stakk"
chmod +x "$DIR/STAKK.command"

echo ""
echo "========================================================"
echo "  STAKK installé dans: $DIR"
echo "========================================================"
echo ""
echo "IMPORTANT: Pour que Frida fonctionne, SIP doit être"
echo "partiellement désactivé."
echo ""
echo "1. Redémarre ton Mac en mode Recovery"
echo "   - Intel: Cmd+R au démarrage"
echo "   - Apple Silicon: garde le bouton d'alimentation"
echo ""
echo "2. Dans Terminal (menu Utilities):"
echo "   csrutil disable"
echo ""
echo "3. Redémarre normalement"
echo ""
echo "Voir: https://developer.apple.com/documentation/security/"
echo "      disabling-and-enabling-system-integrity-protection"
echo ""
echo "Lance STAKK avec un double-clic sur STAKK.command"
echo ""
`;
const installPath = path.join(DIST, 'install.sh');
fs.writeFileSync(installPath, installSh);
fs.chmodSync(installPath, 0o755);
console.log('  install.sh (instructions SIP)');

// Version
fs.writeFileSync(path.join(DIST, 'version.txt'), VERSION);

console.log(`\n[build] Terminé ! → dist-mac/stakk (v${VERSION})\n`);
