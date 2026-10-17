'use strict';

/**
 * sub-tracker.js — Plugin : récupère la date de fin d'abonnement Ankama
 * par compte et par jeu via HAAPI, expose /api/account-subs pour l'UI.
 *
 * Flow :
 *   - Event 'launch' → refresh (si > 24h depuis le dernier fetch)
 *   - GET https://haapi.ankama.com/json/Ankama/v5/Game/ListWithApiKey
 *     (header APIKEY = clé du compte) → liste des jeux + date de fin d'abo
 *   - Écrit dans DATA_DIR/<accountId> les champs :
 *       subscriptions:         { [gameId]: { end: <ms> | null } }
 *       subscriptionsUpdatedAt: <ms>
 *       subscriptionsRaw:      [<entry>, ...]  // pour fallback UI
 *
 * Refresh conservateur : HAAPI sparse pour éviter la détection multi-IP sur
 * comptes partagés (voir memory auto-refresh). On ne re-fetch que si la
 * donnée locale a > 24h, et jamais en boucle — uniquement sur event launch
 * ou demande explicite via POST /api/account-subs/refresh.
 *
 * Proxy : pas de support SOCKS5 ici (simplicité). Si ça pose souci, on
 * pourra porter SocksHttpsAgent depuis haapi.js.
 */

module.exports = function createSubTracker(deps) {
  const { https, fs, path, on, registerRoute, log,
          loadAccounts, DATA_DIR } = deps;

  const MIN_REFRESH_MS = 24 * 60 * 60 * 1000;
  const REQUEST_TIMEOUT_MS = 10000;
  const HAAPI_HOST = 'haapi.ankama.com';

  function accountFile(accountId) {
    return path.join(DATA_DIR, String(accountId));
  }
  function readAccount(accountId) {
    try { return JSON.parse(fs.readFileSync(accountFile(accountId), 'utf8')); }
    catch { return null; }
  }
  function writeAccount(accountId, acc) {
    fs.writeFileSync(accountFile(accountId), JSON.stringify(acc, null, 4));
  }

  function haapiListSubs(apikey) {
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: HAAPI_HOST, port: 443,
        path: '/json/Ankama/v5/Game/ListWithApiKey',
        method: 'GET',
        headers: {
          'APIKEY': apikey,
          'Accept': '*/*',
          'Accept-Encoding': 'identity',
          'User-Agent': 'Zaap 4.6.1',
        },
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 120)}`));
          }
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error('JSON parse: ' + e.message)); }
        });
        res.on('error', reject);
      });
      req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end();
    });
  }

  // Normalise la date de fin d'un entry en timestamp ms.
  // Essaie plusieurs noms de champs car la shape exacte renvoyée par HAAPI
  // peut varier (subscription_end_date / end_date / expiration_date / expires).
  // Retourne null si aucune date exploitable.
  function extractEndMs(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const sub = entry.subscription && typeof entry.subscription === 'object' ? entry.subscription : entry;
    const candidates = [
      sub.subscription_end_date, sub.end_date, sub.expiration_date,
      sub.expires, sub.endDate, sub.subscriptionEndDate, sub.expire_date,
    ];
    for (const c of candidates) {
      if (c == null) continue;
      if (typeof c === 'number') {
        return c > 1e12 ? c : c * 1000;
      }
      const t = Date.parse(c);
      if (Number.isFinite(t)) return t;
    }
    return null;
  }

  function buildSubscriptionsMap(list) {
    const byId = {};
    for (const entry of Array.isArray(list) ? list : []) {
      const id = entry && (entry.id ?? entry.game_id ?? entry.gameId);
      if (id == null) continue;
      byId[String(id)] = { end: extractEndMs(entry) };
    }
    return byId;
  }

  const refreshing = new Set();
  async function refreshAccount(accountId, { force = false } = {}) {
    if (refreshing.has(accountId)) return;
    const acc = readAccount(accountId);
    if (!acc || !acc.key) return;
    const age = acc.subscriptionsUpdatedAt ? Date.now() - acc.subscriptionsUpdatedAt : Infinity;
    if (!force && age < MIN_REFRESH_MS) return;
    refreshing.add(accountId);
    try {
      const list = await haapiListSubs(acc.key);
      // Relecture pour éviter d'écraser une update concurrente (ex: character).
      const fresh = readAccount(accountId);
      if (!fresh) return;
      fresh.subscriptions = buildSubscriptionsMap(list);
      fresh.subscriptionsRaw = Array.isArray(list) ? list : null;
      fresh.subscriptionsUpdatedAt = Date.now();
      writeAccount(accountId, fresh);
      const count = Object.keys(fresh.subscriptions).length;
      log(`[sub-tracker] ${accountId}: ${count} abonnement(s) maj`);
    } catch (e) {
      log(`[sub-tracker] ${accountId} refresh KO: ${e.message}`);
    } finally {
      refreshing.delete(accountId);
    }
  }

  on('launch', ({ accountId }) => {
    refreshAccount(accountId).catch(() => {});
  });

  registerRoute('GET', '/api/account-subs', () => {
    const out = {};
    for (const a of loadAccounts()) {
      if (!a.subscriptions && !a.subscriptionsUpdatedAt) continue;
      out[a.accountId] = {
        subscriptions: a.subscriptions || {},
        raw: a.subscriptionsRaw || null,
        updatedAt: a.subscriptionsUpdatedAt || null,
      };
    }
    return out;
  });

  registerRoute('POST', '/api/account-subs/refresh', async (body) => {
    const accountId = body && body.accountId;
    if (accountId == null) throw new Error('accountId requis');
    await refreshAccount(parseInt(accountId, 10), { force: true });
    const acc = readAccount(parseInt(accountId, 10));
    return {
      ok: true,
      subscriptions: acc?.subscriptions || {},
      raw: acc?.subscriptionsRaw || null,
      updatedAt: acc?.subscriptionsUpdatedAt || null,
    };
  });

  log('[sub-tracker] plugin chargé');
  return {};
};
