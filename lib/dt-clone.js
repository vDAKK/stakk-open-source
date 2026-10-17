'use strict';

/**
 * STAKK — Dofus Touch APK cloning pipeline (Dokky-style).
 *
 * Takes a base.apk of com.ankama.dofustouch, decompiles it, renames the
 * package to com.ankama.dofustouch<suffix>, rebuilds it, and signs it. The
 * result can be installed side-by-side with the original, enabling multiple
 * independent Dofus Touch instances on the same phone.
 *
 * Requires the bundled JDK at cache/jdk8u422-b05-jre/. apktool.jar and
 * uber-apk-signer.jar are downloaded once to cache/dt-tools/ on first use.
 */

module.exports = function createDtClone(deps) {
  deps = deps || {};
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

const APP_ROOT = process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..');
const CACHE = path.join(APP_ROOT, 'cache');
const JDK_DIR = path.join(CACHE, 'jdk8u422-b05-jre');
const TOOLS_DIR = path.join(CACHE, 'dt-tools');
const APKTOOL_JAR = path.join(TOOLS_DIR, 'apktool.jar');
const SIGNER_JAR = path.join(TOOLS_DIR, 'uber-apk-signer.jar');

// Pinned versions. apktool 2.9.3 is the last release to support Java 8 which
// matches the bundled JDK (Temurin 1.8.0_422). uber-apk-signer is single-jar,
// so it comes out of the Android SDK dependency hell.
const APKTOOL_URL = 'https://github.com/iBotPeaches/Apktool/releases/download/v2.9.3/apktool_2.9.3.jar';
const SIGNER_URL = 'https://github.com/patrickfav/uber-apk-signer/releases/download/v1.3.0/uber-apk-signer-1.3.0.jar';

function javaBin() {
  const exe = process.platform === 'win32' ? 'java.exe' : 'java';
  return path.join(JDK_DIR, 'bin', exe);
}

function runJar(jarPath, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const java = javaBin();
    if (!fs.existsSync(java)) {
      return reject(new Error(`JDK introuvable: ${java}`));
    }
    const proc = spawn(java, ['-jar', jarPath, ...args], {
      ...opts,
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(jarPath)} exit ${code}: ${stderr.slice(-600) || stdout.slice(-600)}`));
    });
  });
}

function download(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const followRedirect = (currentUrl, depth = 0) => {
      if (depth > 5) return reject(new Error('trop de redirections'));
      https.get(currentUrl, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, currentUrl).toString();
          followRedirect(next, depth + 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} sur ${currentUrl}`));
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        const tmpPath = destPath + '.part';
        const out = fs.createWriteStream(tmpPath);
        res.on('data', chunk => {
          received += chunk.length;
          if (onProgress && total) onProgress(received, total);
        });
        res.pipe(out);
        out.on('finish', () => {
          out.close(() => {
            fs.renameSync(tmpPath, destPath);
            resolve();
          });
        });
        out.on('error', err => {
          try { fs.unlinkSync(tmpPath); } catch {}
          reject(err);
        });
      }).on('error', reject);
    };
    followRedirect(url);
  });
}

async function ensureTools(log = () => {}) {
  if (!fs.existsSync(TOOLS_DIR)) fs.mkdirSync(TOOLS_DIR, { recursive: true });
  if (!fs.existsSync(APKTOOL_JAR)) {
    log(`[dt-clone] téléchargement apktool 2.9.3...`);
    await download(APKTOOL_URL, APKTOOL_JAR);
    log(`[dt-clone] apktool OK`);
  }
  if (!fs.existsSync(SIGNER_JAR)) {
    log(`[dt-clone] téléchargement uber-apk-signer 1.3.0...`);
    await download(SIGNER_URL, SIGNER_JAR);
    log(`[dt-clone] uber-apk-signer OK`);
  }
}

function walkFiles(dir, extensions) {
  const results = [];
  (function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (!extensions || extensions.some(ext => e.name.endsWith(ext))) results.push(full);
    }
  })(dir);
  return results;
}

function replaceStrings(filePath, replacements) {
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch { return; }
  let dirty = false;
  for (const [from, to] of replacements) {
    if (content.includes(from)) {
      content = content.split(from).join(to);
      dirty = true;
    }
  }
  if (dirty) fs.writeFileSync(filePath, content);
}

/**
 * Clone a Dofus Touch APK. The suffix is appended to the package name and
 * folder paths so the clone installs alongside the original.
 *
 * @param {Buffer} inputBuffer  raw bytes of base.apk
 * @param {string} suffix       e.g. "_alt1", "_alpha", "_2"
 * @param {(msg: string) => void} [log]
 * @returns {Promise<Buffer>}   the signed cloned APK
 */
async function cloneApk(inputBuffer, suffix, log = () => {}) {
  if (!suffix || !/^[a-z0-9_]{1,12}$/i.test(suffix)) {
    throw new Error('suffix invalide (lettres/chiffres/underscore, max 12 caractères)');
  }
  // apktool hates dashes in package segments, so normalize
  const safeSuffix = suffix.startsWith('_') ? suffix : '_' + suffix;

  await ensureTools(log);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stakk-dt-'));
  const inputApk = path.join(workDir, 'input.apk');
  const decompiled = path.join(workDir, 'decompiled');
  const rebuiltApk = path.join(workDir, 'rebuilt.apk');
  const signedDir = path.join(workDir, 'signed');
  log(`[dt-clone] workDir=${workDir} suffix=${safeSuffix}`);

  try {
    fs.writeFileSync(inputApk, inputBuffer);
    log(`[dt-clone] écriture input ${inputBuffer.length} octets`);

    // 1. Decompile
    log(`[dt-clone] apktool d (décompilation)...`);
    await runJar(APKTOOL_JAR, ['d', '-f', '--no-debug-info', '-o', decompiled, inputApk]);
    log(`[dt-clone] décompilation OK`);

    // 2. Rename package-dotted and package-slashed
    const OLD_PKG = 'com.ankama.dofustouch';
    const NEW_PKG = OLD_PKG + safeSuffix;
    const OLD_PATH = 'com/ankama/dofustouch';
    const NEW_PATH = OLD_PATH + safeSuffix;

    // 2a. Move the smali package dir(s) — apktool can emit smali/, smali_classes2/, smali_classes3/…
    const topEntries = fs.readdirSync(decompiled, { withFileTypes: true });
    for (const e of topEntries) {
      if (!e.isDirectory() || !(e.name === 'smali' || e.name.startsWith('smali_'))) continue;
      const smaliRoot = path.join(decompiled, e.name);
      const oldPkgDir = path.join(smaliRoot, OLD_PATH);
      const newPkgDir = path.join(smaliRoot, NEW_PATH);
      if (fs.existsSync(oldPkgDir)) {
        fs.mkdirSync(path.dirname(newPkgDir), { recursive: true });
        fs.renameSync(oldPkgDir, newPkgDir);
        log(`[dt-clone] rename ${e.name}/com/ankama/dofustouch → ${e.name}/com/ankama/dofustouch${safeSuffix}`);
      }
    }

    // 2b. Text replace in all relevant files
    const files = walkFiles(decompiled, ['.smali', '.xml', '.yml', '.json']);
    log(`[dt-clone] patch ${files.length} fichiers...`);
    for (const f of files) {
      replaceStrings(f, [
        [OLD_PATH, NEW_PATH],  // slashed first (longer prefix wins)
        [OLD_PKG, NEW_PKG],
      ]);
    }

    // 2c. Strip split-APK requirements from the manifest so the cloned APK
    //     installs standalone without needing config.*.apk siblings.
    const manifestPath = path.join(decompiled, 'AndroidManifest.xml');
    if (fs.existsSync(manifestPath)) {
      let manifest = fs.readFileSync(manifestPath, 'utf8');
      manifest = manifest.replace(/\s+android:requiredSplitTypes="[^"]*"/g, '');
      manifest = manifest.replace(/\s+android:splitTypes="[^"]*"/g, '');
      manifest = manifest.replace(/android:extractNativeLibs="false"/g, 'android:extractNativeLibs="true"');
      // Drop isSplitRequired (newer Android)
      manifest = manifest.replace(/\s+android:isSplitRequired="[^"]*"/g, '');
      fs.writeFileSync(manifestPath, manifest);
      log(`[dt-clone] manifest patché (splits strippés)`);
    }

    // 2d. Rewrite the app label in every strings.xml so the clone shows up
    //     distinctly in the Android app drawer (e.g. "Dofus alt1" instead of
    //     a duplicated "DOFUS Touch"). We target name="app_name" specifically
    //     — Dofus Touch uses that standard key.
    const newLabel = 'Dofus ' + safeSuffix.replace(/^_/, ''); // "_alt1" → "Dofus alt1"
    const resDir = path.join(decompiled, 'res');
    if (fs.existsSync(resDir)) {
      const stringsFiles = [];
      for (const entry of fs.readdirSync(resDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('values')) continue;
        const s = path.join(resDir, entry.name, 'strings.xml');
        if (fs.existsSync(s)) stringsFiles.push(s);
      }
      let patchedCount = 0;
      const appNameRe = /(<string\b[^>]*\bname="app_name"[^>]*>)[^<]*(<\/string>)/;
      for (const f of stringsFiles) {
        try {
          let xml = fs.readFileSync(f, 'utf8');
          if (appNameRe.test(xml)) {
            xml = xml.replace(appNameRe, '$1' + newLabel + '$2');
            fs.writeFileSync(f, xml);
            patchedCount++;
          }
        } catch {}
      }
      log(`[dt-clone] label patché → "${newLabel}" dans ${patchedCount}/${stringsFiles.length} strings.xml`);
    }

    // 3. Rebuild
    log(`[dt-clone] apktool b (recompilation)...`);
    await runJar(APKTOOL_JAR, ['b', '-f', '--use-aapt2', '-o', rebuiltApk, decompiled]);
    log(`[dt-clone] recompilation OK (${fs.statSync(rebuiltApk).size} octets)`);

    // 4. Sign in place — uber-apk-signer --overwrite rewrites the input APK
    //    with the signed+aligned output, so we just re-read it.
    log(`[dt-clone] signature (uber-apk-signer --overwrite)...`);
    const signerRes = await runJar(SIGNER_JAR, [
      '--apks', rebuiltApk,
      '--overwrite',
      '--allowResign',
    ]);
    if (signerRes.stdout) log('[dt-clone] signer: ' + signerRes.stdout.trim().slice(-300));

    // With --overwrite, uber-apk-signer writes the signed+zipaligned result
    // back to the input path. But it also drops idsig/sha256 companions —
    // we only need the .apk itself.
    if (!fs.existsSync(rebuiltApk)) {
      // Fallback: some uber-apk-signer builds move the output to a sibling
      // even in overwrite mode. Look for *-aligned-debugSigned.apk next to it.
      const parent = path.dirname(rebuiltApk);
      const candidates = fs.readdirSync(parent).filter(n => n.endsWith('.apk') && n !== 'input.apk');
      log('[dt-clone] overwrite absent, candidates: ' + candidates.join(', '));
      if (candidates.length === 0) throw new Error('apk signé introuvable dans ' + parent);
      const pick = candidates.find(n => /debugSigned/.test(n)) || candidates[0];
      const signedBytes = fs.readFileSync(path.join(parent, pick));
      log(`[dt-clone] signé OK via fallback ${pick} (${signedBytes.length} octets)`);
      return signedBytes;
    }
    const signedBytes = fs.readFileSync(rebuiltApk);
    log(`[dt-clone] signé OK (${signedBytes.length} octets)`);
    return signedBytes;
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

async function checkTools() {
  const problems = [];
  if (!fs.existsSync(javaBin())) problems.push(`JDK bundlé introuvable: ${javaBin()}`);
  // apktool + signer are auto-downloaded, so they're fine if missing
  return problems;
}

  return { cloneApk, ensureTools, checkTools, javaBin };
};
