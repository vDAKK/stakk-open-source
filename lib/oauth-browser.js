'use strict';

/**
 * oauth-browser.js — Login OAuth via le navigateur du user.
 *
 * 1. Enregistre temporairement zaap:// comme protocole Windows
 * 2. Ouvre le navigateur sur auth.ankama.com
 * 3. L'user se connecte → redirect vers zaap://login?code=xxx
 * 4. Windows appelle notre handler qui écrit le code dans un fichier
 * 5. On lit le fichier et échange le code contre un token
 */

module.exports = function createOauthBrowser(deps) {
  deps = deps || {};
  // haapi peut être injecté (hot-module) ou fallback au require bundlé (factory)
  const haapi = deps.haapi || require('./haapi')();

const { execSync, exec, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { stringify } = require('querystring');

// Dossier de travail hors de l'app : APP_ROOT peut vivre dans OneDrive, qui
// synchronise (et verrouille) tout ce qu'on y dépose. Ces trois fichiers sont
// éphémères et n'ont rien à faire ailleurs que dans le temp du poste.
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stakk-oauth-'));
const CODE_FILE = path.join(WORK_DIR, 'code');

const ZAAP_KEY = 'HKCU\\Software\\Classes\\zaap';
const ZAAP_CMD_KEY = ZAAP_KEY + '\\shell\\open\\command';

function reg(args) {
  return spawnSync('reg', args, { windowsHide: true, encoding: 'utf8' });
}

// Mémorise le handler zaap:// existant pour pouvoir le remettre.
//
// Le vrai launcher Ankama utilise ce protocole. L'écraser sans le restaurer
// casse ses liens `zaap://` jusqu'à sa prochaine réinstallation — et la
// version précédente de ce module supprimait le .cmd en laissant la clé
// registre pointer dessus, donc sur un fichier absent.
// Extrait la donnée de la valeur par défaut d'une sortie `reg query … /ve`.
//
// Le nom de cette valeur est traduit — « (par défaut) » en français,
// « (Default) » en anglais — et la console Windows ne rend pas l'UTF-8, donc
// l'accent arrive abîmé quoi qu'on fasse. On ne s'appuie donc que sur le type
// `REG_SZ`, qui ne varie ni avec la langue ni avec l'encodage.
//
// Exporté pour être testable : se tromper ici efface le protocole zaap:// du
// launcher Ankama.
function parseRegDefault(stdout) {
  if (!stdout) return null;
  const m = stdout.match(/\sREG_SZ\s+([^\r\n]+)/);
  return m ? m[1].trim() : null;
}

function snapshotZaapHandler() {
  // latin1 : on veut les octets tels quels pour pouvoir les réécrire à
  // l'identique, y compris si le chemin contient un caractère accentué.
  const r = spawnSync('reg', ['QUERY', ZAAP_CMD_KEY, '/ve'], { windowsHide: true, encoding: 'latin1' });
  if (r.status !== 0 || !r.stdout) return { existait: false, commande: null };
  return { existait: true, commande: parseRegDefault(r.stdout) };
}

function restoreZaapHandler(snap) {
  try {
    if (snap && snap.existait) {
      if (snap.commande) {
        reg(['ADD', ZAAP_CMD_KEY, '/ve', '/d', snap.commande, '/f']);
      } else {
        // La clé existait mais on n'a pas su lire sa valeur. Supprimer serait
        // pire que tout : on laisserait l'utilisateur sans protocole zaap://
        // et sans moyen de savoir pourquoi. On signale et on ne touche à rien.
        console.error('[OAuth] handler zaap:// illisible — restauration impossible, '
          + 'relance le launcher Ankama s\'il ne s\'ouvre plus depuis un lien zaap://');
      }
    } else {
      // On avait créé la clé de toutes pièces : on la retire entièrement,
      // plutôt que de laisser un handler pointant vers un script supprimé.
      reg(['DELETE', ZAAP_KEY, '/f']);
    }
  } catch { /* best-effort : ne jamais faire échouer le login sur le ménage */ }
}

/**
 * Login OAuth via navigateur. Retourne { access_token, refresh_token }.
 */
async function oauthViaBrowser() {
  // Le flow repose sur l'enregistrement d'un protocole via `reg` : c'est
  // Windows-only. Échouer explicitement vaut mieux que d'ouvrir un navigateur
  // sur un login qui ne reviendra jamais.
  if (process.platform !== 'win32') {
    throw new Error('Login via navigateur : disponible sur Windows uniquement '
      + '(le retour zaap:// passe par le registre). Sur Mac, importe le compte '
      + 'depuis le launcher Ankama.');
  }
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  // Nettoyer le fichier de code
  try { fs.unlinkSync(CODE_FILE); } catch {}

  // Créer le handler script
  const handlerPath = path.join(WORK_DIR, 'zaap-handler.cmd');
  const capturePath = path.join(WORK_DIR, 'zaap-capture.js');

  fs.writeFileSync(capturePath,
    `const fs = require('fs');
const url = process.argv[2] || '';
const match = url.match(/code=([^&]+)/);
if (match) fs.writeFileSync(${JSON.stringify(CODE_FILE)}, match[1]);
`);

  fs.writeFileSync(handlerPath,
    `@echo off\r\n"${process.execPath}" "${capturePath}" "%1"\r\n`);

  // Enregistrer le protocole zaap://, après avoir mémorisé ce qu'il valait.
  const snap = snapshotZaapHandler();
  try {
    // spawnSync avec des arguments séparés : `reg` reçoit les chemins et les
    // guillemets tels quels, sans passer par l'échappement de cmd.exe où
    // `"%1"` et les espaces de Program Files se corrompaient.
    reg(['ADD', ZAAP_KEY, '/ve', '/d', 'URL:Zaap Protocol', '/f']);
    reg(['ADD', ZAAP_KEY, '/v', 'URL Protocol', '/d', '', '/f']);
    const r = reg(['ADD', ZAAP_CMD_KEY, '/ve', '/d', `"${handlerPath}" "%1"`, '/f']);
    if (r.status !== 0) throw new Error(r.stderr || 'reg add a échoué');
  } catch (e) {
    restoreZaapHandler(snap);
    console.error('[OAuth] Impossible d\'enregistrer le protocole zaap://', e.message);
    throw e;
  }

  console.log('[OAuth] Protocole zaap:// enregistré');

  // Ouvrir le navigateur
  const authUrl = `https://auth.ankama.com/login/ankama?code_challenge=${codeChallenge}&redirect_uri=${encodeURIComponent('zaap://login')}&client_id=102&direct=true&origin_tracker=${encodeURIComponent('https://www.ankama-launcher.com/launcher')}`;
  exec(`start "" "${authUrl}"`);

  console.log('[OAuth] Navigateur ouvert — connecte-toi puis reviens ici.');
  console.log('[OAuth] En attente du code...\n');

  // Attendre le code (max 120s)
  let code = null;
  for (let i = 0; i < 240 && !code; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      code = fs.readFileSync(CODE_FILE, 'utf8').trim();
    } catch {}
  }

  // Nettoyage — le handler zaap:// du launcher est remis en place quoi qu'il
  // arrive, y compris sur timeout.
  restoreZaapHandler(snap);
  try { fs.unlinkSync(CODE_FILE); } catch {}
  try { fs.unlinkSync(handlerPath); } catch {}
  try { fs.unlinkSync(capturePath); } catch {}

  if (!code) throw new Error('Timeout — pas de code reçu');
  console.log('[OAuth] Code reçu !');

  // Échanger le code
  const [err, tokenResp] = await haapi.request(
    { method: 'POST', path: '/token', headers: { 'content-type': 'application/x-www-form-urlencoded' } },
    stringify({ grant_type: 'authorization_code', code, redirect_uri: 'zaap://login', client_id: 102, code_verifier: codeVerifier }),
    'auth.ankama.com'
  );

  if (!tokenResp?.access_token) throw new Error('Échange token échoué: ' + JSON.stringify(tokenResp));

  return tokenResp;
}

function generateCodeVerifier() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  let v = ''; for (let i = 0; i < 64; i++) v += chars[Math.floor(Math.random() * chars.length)];
  return v;
}

  return { oauthViaBrowser, parseRegDefault };
};
