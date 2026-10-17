'use strict';

/**
 * key-refresh.js — Plugin : refresh des clés HAAPI avec fallback OAuth2.
 *
 * Deux voies :
 *
 *  1. HAAPI (Api/RefreshApiKey). Quand Ankama révoque le service ('Unauthorized
 *     service \\Ankama\\Api') la voie est barrée même si le refresh_token est
 *     encore vivant. Ce plugin retombe sur OAuth2 grant_type=refresh_token,
 *     qui rotate la paire (key + refresh_token neufs) sans avoir besoin d'un
 *     APIKEY valide en header.
 *
 *  2. Sur rotation, les nouveaux tokens sont persistés.
 *
 * Cadence — on respecte la politique sparse documentée (20j threshold, 6h
 * check) pour éviter le pattern "même compte refreshé depuis 2 IPs toutes
 * les 30 min" si les comptes sont partagés (détectable côté Ankama).
 *
 * Désactiver ce plugin coupe tout renouvellement automatique des clés.
 */

module.exports = function createKeyRefresh(deps) {
  const { fs, path, https, log, registerRoute, on, DATA_DIR } = deps;
  const { stringify } = require('querystring');
  const zlib = require('zlib');

  const REFRESH_THRESHOLD_MS = 20 * 24 * 60 * 60 * 1000; // 20 jours
  const CHECK_INTERVAL_MS    = 6 * 60 * 60 * 1000;       // 6 heures
  const BOOT_DELAY_MS        = 15 * 1000;                // 15s après ready

  // Best-effort détection de la version Zaap depuis application.log — même
  // logique que haapi.js, dupliquée pour rester self-contained (le plugin
  // n'a pas accès à la factory haapi via la deps bag).
  function detectZaapVersion() {
    try {
      const appdata = process.platform === 'darwin'
        ? path.join(process.env.HOME || '', 'Library', 'Application Support', 'zaap')
        : path.join(process.env.APPDATA || '', 'zaap');
      const logPath = path.join(appdata, 'application.log');
      if (!fs.existsSync(logPath)) return null;
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
  const ZAAP_VERSION = detectZaapVersion() || '3.14.8';

  function request(opts, body, hostname) {
    opts.headers = {
      accept: '*/*', 'accept-encoding': 'gzip,deflate', 'accept-language': 'fr',
      connection: 'close', 'user-agent': 'Zaap ' + ZAAP_VERSION,
      ...(opts.headers || {}),
    };
    if (body) {
      opts.headers['content-length'] = body.length;
      if (!opts.headers['content-type']) opts.headers['content-type'] = 'application/x-www-form-urlencoded';
    }
    return new Promise((resolve) => {
      const buf = [];
      const req = https.request({ hostname: hostname || 'haapi.ankama.com', port: 443, ...opts }, (res) => {
        const onEnd = (raw) => {
          let json;
          try { json = JSON.parse(raw); } catch {}
          resolve({ status: res.statusCode, body: json || raw });
        };
        if (res.headers['content-encoding'] === 'gzip') {
          const gz = zlib.createGunzip();
          res.pipe(gz);
          gz.on('data', d => buf.push(d));
          gz.on('end', () => onEnd(Buffer.concat(buf).toString('utf8')));
        } else {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => onEnd(d));
        }
      });
      req.setTimeout(15000, () => req.destroy(new Error('timeout')));
      req.on('error', e => resolve({ error: e.message }));
      if (body) req.write(body);
      req.end();
    });
  }

  // Sonde lecture seule — l'autorité sur l'état d'une clé.
  //
  // SignOnWithApiKey ne rote rien et répond sans ambiguïté : 200 + account si
  // la clé vit, 403 « Unauthorized service » si Ankama l'a révoquée. C'est la
  // seule question à laquelle on sait répondre avec certitude, donc la seule
  // sur laquelle `keyDead` a le droit de s'appuyer.
  //
  // Retour : 'alive' | 'dead' | 'unknown'. `unknown` couvre la panne réseau et
  // le 5xx — on ne sait pas, donc on ne touche pas au drapeau.
  async function probeKey(key) {
    const r = await request(
      { method: 'POST', path: '/json/Ankama/v5/Account/SignOnWithApiKey', headers: { APIKEY: key } },
      'game=102',
      'haapi.ankama.com'
    );
    if (r.error) return 'unknown';
    if (r.status === 200 && r.body && r.body.account) return 'alive';
    if (r.status === 401 || r.status === 403) return 'dead';
    return 'unknown';
  }

  // Un certificat Shield est rattaché à la clé API qui l'a demandé. Renouveler
  // la clé détache le certificat, et CreateToken répond « Invalid security
  // parameters » au lancement suivant. Ces comptes ne se renouvellent donc
  // jamais tout seuls — ni ici, ni dans la boucle bundlée de web-server.js.
  function aUnCertificat(acc) {
    return !!(acc.customShield || acc.certificate);
  }

  // Tente HAAPI extend en priorité, puis OAuth2 rotate en fallback.
  // Retour : { ok: true, key, refreshToken, rotated, source } | { ok: false, error }
  async function refreshKeyPair(key, refreshToken) {
    const r1 = await request(
      { method: 'POST', path: '/json/Ankama/v5/Api/RefreshApiKey', headers: { APIKEY: key } },
      `refresh_token=${refreshToken}&long_life_token=true`,
      'haapi.ankama.com'
    );
    if (r1.body && r1.body.key) {
      return { ok: true, key: r1.body.key, refreshToken, rotated: false, source: 'haapi' };
    }
    const r2 = await request(
      { method: 'POST', path: '/token' },
      stringify({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: 102 }),
      'auth.ankama.com'
    );
    if (r2.body && r2.body.access_token) {
      return {
        ok: true,
        key: r2.body.access_token,
        refreshToken: r2.body.refresh_token || refreshToken,
        rotated: true,
        source: 'oauth2',
      };
    }
    const m1 = (r1.body && r1.body.message) || (r1.error || `HAAPI ${r1.status}`);
    const m2 = (r2.body && (r2.body.error_description || r2.body.error)) || (r2.error || `OAuth2 ${r2.status}`);
    return { ok: false, error: `HAAPI=${m1} | OAuth2=${m2}` };
  }

  // Liste les comptes à refresh — fichiers numériques dans DATA_DIR avec
  // age > REFRESH_THRESHOLD. Skip silencieux les fichiers JSON invalides.
  function staleAccounts(now = Date.now()) {
    if (!fs.existsSync(DATA_DIR)) return [];
    const out = [];
    for (const f of fs.readdirSync(DATA_DIR)) {
      if (!/^\d+$/.test(f)) continue;
      try {
        const full = path.join(DATA_DIR, f);
        const acc = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (!acc.key || !acc.refreshToken) continue;
        const age = acc.refreshDate ? now - acc.refreshDate : Infinity;
        if (age >= REFRESH_THRESHOLD_MS) out.push({ file: full, acc, age });
      } catch {}
    }
    return out;
  }

  let lastRunAt = 0;
  let inFlight = false;
  let lastResult = null;

  // Écriture partielle d'un fichier compte : on relit le disque juste avant
  // d'écrire et on n'applique que les champs demandés.
  //
  // Sans cette relecture, écrire l'objet lu au scan écrase tout ce qui a bougé
  // entre-temps — la clé fraîche que l'autre boucle de refresh vient de ranger,
  // les stats de lancement, la liste des personnages. C'est ainsi qu'un fichier
  // se retrouve avec un `refreshDate` récent et une clé révoquée dedans.
  //
  // Une valeur `undefined` dans `patch` supprime la clé.
  function patchAccountFile(file, patch) {
    let saved;
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { log(`[key-refresh] relecture KO ${file} — ${e.message}`); return null; }
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete saved[k]; else saved[k] = v;
    }
    try { fs.writeFileSync(file, JSON.stringify(saved, null, 4)); return saved; }
    catch (e) { log(`[key-refresh] écriture KO ${file} — ${e.message}`); return null; }
  }

  // Persiste keyDead sur le fichier compte. Idempotent — l'état de référence
  // est celui du disque, pas celui de la copie mémoire lue au scan.
  function markDeadFlag(file, acc, dead) {
    let cur;
    try { cur = !!JSON.parse(fs.readFileSync(file, 'utf8')).keyDead; }
    catch { cur = !!acc.keyDead; }
    if (cur === dead) return;
    patchAccountFile(file, { keyDead: dead ? true : undefined });
  }

  // Passe de validation — sonde chaque compte et met le drapeau keyDead à jour.
  // Ne renouvelle RIEN : c'est le point clé. Valider un compte fraîchement
  // importé en le renouvelant rotait sa clé et détachait son certificat, soit
  // exactement le dégât qu'on prétendait détecter.
  // Fenêtre pendant laquelle une sonde déjà faite fait autorité. Le démarrage
  // déclenche deux validations à quelques secondes d'intervalle (l'import émet
  // `accounts-imported`, puis le timer `ready` arrive) ; sonder deux fois
  // chaque compte pour une réponse qui n'a pas pu changer va à l'encontre de
  // la politique de trafic clairsemé décrite en tête de ce fichier.
  //
  // `force` contourne — un clic explicite dans l'UI doit toujours interroger
  // Ankama, sans quoi le bouton paraîtrait cassé.
  const VALIDATE_THROTTLE_MS = 5 * 60 * 1000;
  let lastValidateAt = 0;

  async function validateOnce({ force = false } = {}) {
    const depuis = Date.now() - lastValidateAt;
    if (!force && lastValidateAt && depuis < VALIDATE_THROTTLE_MS) {
      log(`[key-refresh] validation ignorée (déjà sondé il y a ${Math.round(depuis / 1000)}s)`);
      return { ok: true, skipped: true, scanned: 0, alive: 0, dead: 0, unknown: 0 };
    }
    lastValidateAt = Date.now();
    const list = listAllAccounts();
    let alive = 0, dead = 0, unknown = 0;
    for (const { file, acc } of list) {
      const etat = await probeKey(acc.key);
      if (etat === 'alive') { alive++; markDeadFlag(file, acc, false); }
      else if (etat === 'dead') {
        dead++;
        markDeadFlag(file, acc, true);
        log(`[key-refresh] ${acc.login}: clé révoquée par Ankama [keyDead]`);
      } else unknown++;
    }
    const res = { ok: true, scanned: list.length, alive, dead, unknown };
    log(`[key-refresh] validation: scanned=${res.scanned} vivantes=${alive} mortes=${dead} indeterminees=${unknown}`);
    return res;
  }

  async function runOnce({ force = false } = {}) {
    if (inFlight) return { ok: false, error: 'déjà en cours' };
    inFlight = true;
    try {
      // En mode force : scan TOUS les comptes même non-stale, pour réagir à
      // un signal « Ankama vient de tout révoquer ». Ce mode n'est plus
      // branché sur l'import — valider un compte fraîchement importé passe
      // par validateOnce(), qui sonde sans renouveler.
      // En mode normal : seulement ceux qui dépassent le threshold.
      const list = force ? listAllAccounts() : staleAccounts();
      if (list.length === 0) {
        const res = { ok: true, scanned: 0, refreshed: 0, rotated: 0, failed: 0, dead: 0 };
        lastRunAt = Date.now(); lastResult = res;
        return res;
      }
      let refreshed = 0, rotated = 0, failed = 0, dead = 0, shielded = 0;
      for (const { file, acc } of list) {
        // Un compte à certificat ne voit JAMAIS sa clé renouvelée, même si
        // Ankama vient de la refuser. Le certificat est rattaché à la clé qui
        // l'a demandé : une clé neuve ne le récupère pas, donc renouveler ne
        // répare rien et remplace « clé morte » par « Invalid security
        // parameters ». Le seul chemin est de réémettre un certificat.
        //
        // Le garde couvre les deux origines : Shield monocompte (customShield)
        // et import launcher (certificate seul). Seul ce dernier manquait, et
        // c'est lui qui perdait des clés.
        if (aUnCertificat(acc)) {
          shielded++;
          continue;
        }
        const r = await refreshKeyPair(acc.key, acc.refreshToken);
        if (!r.ok) {
          // L'échec d'un refresh ne dit rien de l'état de la clé : la voie
          // HAAPI répond « Unauthorized service '\Ankama\Api' » sur des clés
          // parfaitement vivantes (c'est même la raison d'être du fallback),
          // et la voie OAuth2 refuse un refresh_token valide exactement comme
          // un bidon. Lire ces messages pour en déduire une révocation
          // produisait des faux `keyDead`. On demande donc à Ankama.
          const etat = await probeKey(acc.key);
          log(`[key-refresh] ${acc.login}: refresh KO — ${r.error} [sonde: ${etat}]`);
          if (etat === 'dead') { markDeadFlag(file, acc, true); dead++; }
          else failed++;
          continue;
        }
        const ecrit = patchAccountFile(file, {
          key: r.key,
          refreshToken: r.refreshToken,
          refreshDate: Date.now(),
          keyDead: undefined, // ressuscité (re-login user, etc.)
        });
        if (!ecrit) { failed++; continue; }
        acc.key = r.key;
        acc.refreshToken = r.refreshToken;
        refreshed++;
        if (r.rotated) {
          rotated++;
          log(`[key-refresh] ${acc.login}: ROTATED via ${r.source} (clé+refreshToken renouvelés)`);
        } else {
          log(`[key-refresh] ${acc.login}: extended via ${r.source}`);
        }
      }
      const res = { ok: true, scanned: list.length, refreshed, rotated, failed, dead, shielded };
      if (shielded) {
        log(`[key-refresh] ${shielded} compte(s) à certificat laissé(s) intacts `
          + `(renouveler leur clé détacherait le certificat)`);
      }
      lastRunAt = Date.now(); lastResult = res;
      log(`[key-refresh] cycle: scanned=${res.scanned} extended=${res.refreshed - res.rotated} rotated=${res.rotated} dead=${res.dead} netfail=${res.failed}`);
      return res;
    } finally {
      inFlight = false;
    }
  }

  function listAllAccounts() {
    if (!fs.existsSync(DATA_DIR)) return [];
    const out = [];
    for (const f of fs.readdirSync(DATA_DIR)) {
      if (!/^\d+$/.test(f)) continue;
      try {
        const full = path.join(DATA_DIR, f);
        const acc = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (!acc.key || !acc.refreshToken) continue;
        out.push({ file: full, acc });
      } catch {}
    }
    return out;
  }

  // Routes locales (UI STAKK).
  registerRoute('GET', '/api/key-refresh/status', () => ({
    lastRunAt,
    inFlight,
    lastResult,
    nextRunIn: Math.max(0, CHECK_INTERVAL_MS - (Date.now() - lastRunAt)),
    thresholdMs: REFRESH_THRESHOLD_MS,
    intervalMs: CHECK_INTERVAL_MS,
    zaapVersion: ZAAP_VERSION,
  }));
  registerRoute('POST', '/api/key-refresh/now', (body) => runOnce({ force: !!(body && body.force) }));
  registerRoute('POST', '/api/key-refresh/validate', () => validateOnce({ force: true }));

  // Schedule : premier passage 15s après ready, puis toutes les 6h.
  on('ready', () => {
    const t1 = setTimeout(() => {
      // Sonde d'abord : elle rafraîchit les badges de l'UI sans rien roter, et
      // elle nettoie les `keyDead` posés à tort par les versions précédentes.
      validateOnce()
        .catch(e => log(`[key-refresh] boot validation err: ${e.message}`))
        .then(() => runOnce())
        .catch(e => log(`[key-refresh] boot err: ${e.message}`));
    }, BOOT_DELAY_MS);
    if (t1.unref) t1.unref();
    const tn = setInterval(() => { runOnce().catch(() => {}); }, CHECK_INTERVAL_MS);
    if (tn.unref) tn.unref();
  });

  // Trigger immédiat après un import : on SONDE chaque compte fraîchement
  // importé. Les comptes morts sont flaggés keyDead → l'UI peut afficher un
  // badge rouge dès le retour de l'import, plutôt que de laisser l'user
  // découvrir le problème à la première tentative de launch.
  //
  // Avant, cette validation passait par runOnce({force:true}), qui renouvelle.
  // Une clé launcher fraîchement importée était donc rotée dans la seconde,
  // ce qui détachait son certificat — et `shield/validate` émet lui-même cet
  // event, si bien qu'un certificat tout juste créé se faisait invalider.
  try {
    on('accounts-imported', () => {
      log('[key-refresh] accounts-imported → sonde de tous les comptes (sans renouvellement)');
      // Petit délai pour laisser web-server.js finir d'écrire les fichiers
      // (l'event est émis sync juste après le for-loop d'écriture, donc
      // setImmediate suffit ; on prend 200ms par sécurité I/O).
      setTimeout(() => {
        validateOnce().catch(e => log(`[key-refresh] post-import err: ${e.message}`));
      }, 200);
    });
  } catch {}

  log(`[key-refresh] plugin chargé — threshold=${REFRESH_THRESHOLD_MS / 86400000}j check=${CHECK_INTERVAL_MS / 3600000}h zaap=${ZAAP_VERSION}`);

  return { _validateOnce: validateOnce };
};
