'use strict';

/**
 * launcher-import.js — Import des comptes depuis le launcher Ankama (zaap keydata)
 * Copie directe de la logique de krm35/dofus-multi (back/accounts.js)
 * Factory — machineIdSync injecté depuis le bundle (native dep).
 */

module.exports = function createLauncherImport(deps) {
  deps = deps || {};
  const machineIdSync = deps.machineIdSync || require('./machine-id').machineIdSync;

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');

const ALGORITHM = 'aes-128-cbc';
const SEPARATOR = '|';

// Chemin keydata du launcher Ankama (ancien Zaap), résolu par plateforme :
//   Windows : %APPDATA%\zaap
//   macOS   : ~/Library/Application Support/zaap
const _HOME = process.env.HOME || process.env.USERPROFILE || '';
const ZAAP_PATH = process.platform === 'darwin'
  ? path.join(_HOME, 'Library', 'Application Support', 'zaap')
  : path.join(process.env.APPDATA || '', 'zaap');
const KEYDATA_PATH = path.join(ZAAP_PATH, 'keydata');

function createHashFromString(string) {
  const hash = crypto.createHash('md5');
  hash.update(string);
  return hash.digest();
}

// Archs à essayer pour reconstruire la clé, dans l'ordre. La clé keydata est
// dérivée par le launcher Ankama avec SON `os.arch()`, pas le nôtre : sur un
// Mac Apple Silicon le launcher tourne sous Rosetta et se voit donc en 'x64',
// alors que stakk tourne nativement en 'arm64'. Sans ce repli, l'import
// échoue sur « bad decrypt » alors que le keydata est parfaitement lisible.
function archCandidates() {
  const mine = os.arch();
  if (process.platform !== 'darwin') return [mine];
  return mine === 'arm64' ? [mine, 'x64'] : [mine, 'arm64'];
}

// Arch avec laquelle le keydata s'est réellement déchiffré. C'est l'identité
// du launcher, la seule qui vaille : hm1 doit être dérivé avec la MÊME, sinon
// hm2 ne déchiffre pas le certificat Shield importé et createToken échoue sur
// le même « bad decrypt ». Renseignée par decrypt(), lue par createHmEncoders().
let archLauncher = null;

function decrypt(data) {
  const splitData = data.split(SEPARATOR);
  const iv  = Buffer.from(splitData[0], 'hex');
  const enc = Buffer.from(splitData[1], 'hex');
  let lastErr;
  for (const arch of archCandidates()) {
    const uuid = [os.platform(), arch, machineIdSync(), os.cpus().length, os.cpus()[0].model].join();
    const key  = createHashFromString(uuid);
    try {
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
      const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
      const out = JSON.parse(dec.toString());
      archLauncher = arch;
      return out;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

function createHashFromStringSha(e) {
  return crypto.createHash('sha256').update(e).digest('hex').slice(0, 32);
}

function getOsVersion() {
  const [t, n] = os.release().split('.');
  return parseFloat(`${t}.${n}`);
}

function getComputerRam() {
  return Math.pow(2, Math.round(Math.log(os.totalmem() / 1024 / 1024) / Math.log(2)));
}

function createHmEncoders() {
  const t = [
    archLauncher || os.arch(),
    os.platform(),
    machineIdSync(),
    os.userInfo().username,
    getOsVersion(),
    getComputerRam(),
  ];
  const hm1 = createHashFromStringSha(t.join(''));
  const hm2 = hm1.split('').reverse().join('');
  return { hm1, hm2 };
}

/**
 * Importe les comptes depuis le keydata du launcher.
 * Retourne un tableau d'objets compte avec key, refreshToken, accountId, etc.
 */
function importFromLauncher() {
  if (!fs.existsSync(KEYDATA_PATH)) {
    console.log('[Import] Dossier keydata introuvable:', KEYDATA_PATH);
    return [];
  }

  const files = fs.readdirSync(KEYDATA_PATH).filter(f => f.startsWith('.keydata'));
  const accounts = [];

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(KEYDATA_PATH, file), 'utf8');
      // decrypt() AVANT createHmEncoders() : c'est lui qui détermine l'arch du
      // launcher, dont hm1 dépend. Dans l'autre ordre on dériverait hm1 avec
      // l'arch de stakk et le certificat Shield importé serait illisible.
      const decrypted = decrypt(raw);
      const { hm1, hm2 } = createHmEncoders();
      decrypted.hm1 = hm1;
      decrypted.hm2 = hm2;
      decrypted.launcher = true;
      accounts.push(decrypted);
      console.log(`[Import] ${decrypted.login || decrypted.accountId} → clé ${decrypted.key?.slice(0, 8)}…`);
    } catch (e) {
      console.error(`[Import] Erreur pour ${file}: ${e.message}`);
    }
  }

  return accounts;
}

  return { importFromLauncher };
};
