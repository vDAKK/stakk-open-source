'use strict';

/**
 * overlay-backend — Plugin de l'overlay ressources Dofus.
 *
 * Gère :
 *   - Routes /api/map-state, /api/map-resources, /api/map-grid
 *   - Routes /api/overlay/{start,stop,status}, /api/overlay/link
 *   - Cache dofusdb (map-positions, recoltables2, items)
 *   - Spawn/kill du sidecar Electron
 *   - Listener setMapUpdateHandler sur game-proxy (mapId → accountMapState)
 */

module.exports = function createOverlayBackend(deps) {
  const {
    fs, path, os, https,
    log, registerRoute,
    APP_ROOT,
  } = deps;
  // Defaults pour retro-compat avec les versions stakk.exe qui n'exposaient
  // pas encore WEB_PORT / setMapUpdateHandler dans la plugin API (< v1.4.10).
  const WEB_PORT = deps.WEB_PORT || 3000;
  const setMapUpdateHandler = deps.setMapUpdateHandler;
  // runningHandles : { "<accountId>:<gameKey>": { fridaHandle, proxyHandle } }
  // Sert à exposer les comptes LANCÉS dans /api/map-state même quand le proxy
  // n'a pas encore détecté de ChangeMapMessage (= aucun déplacement depuis le
  // login). Sinon l'overlay reste bloqué sur "aucun compte actif" jusqu'à ce
  // que l'user bouge.
  const runningHandles = deps.runningHandles || {};
  // La deps bag fournit déjà `spawn` (les plugins mac s'en servent pour leur
  // helper natif). Le prendre là plutôt que de le require() rend le lancement
  // des sidecars observable en test : sans ça, vérifier qu'activer la chasse
  // n'ouvre pas la grille des ressources demanderait de lancer deux Electron.
  const spawn = deps.spawn || require('child_process').spawn;
  const { parse: parseUrl } = require('url');

  // Safety net global : évite qu'une exception cachée dans stakk fasse
  // crasher tout le process. Log l'erreur dans le launchLog utilisateur.
  if (!process.__stakkSafetyNet) {
    process.__stakkSafetyNet = true;
    process.on('uncaughtException', (err) => {
      try { log(`[STAKK uncaughtException] ${err.stack || err.message || err}`); } catch {}
    });
    process.on('unhandledRejection', (reason) => {
      try { log(`[STAKK unhandledRejection] ${reason?.stack || reason?.message || reason}`); } catch {}
    });
  }

  // Wrap tous les handlers plugin dans un try/catch qui log + retourne une
  // erreur propre, au lieu de laisser remonter jusqu'au process.
  function safe(fn) {
    return (...args) => {
      try {
        const r = fn(...args);
        if (r && typeof r.then === 'function') {
          return r.catch(e => {
            log(`[overlay-backend] handler err: ${e.stack || e.message}`);
            return { error: e.message };
          });
        }
        return r;
      } catch (e) {
        log(`[overlay-backend] handler sync err: ${e.stack || e.message}`);
        return { error: e.message };
      }
    };
  }

  // ─── État partagé ──────────────────────────────────────────────────────
  // { [accountId]: { mapId, updatedAt } }
  const accountMapState = {};

  // ─── Routes (trajets) : persistées côté serveur ─────────────────────────
  // localStorage côté navigateur est isolé entre Electron (overlay) et le
  // navigateur par défaut (planner), même sur le même origin. Stocker côté
  // serveur est la seule façon de partager les trajets entre les deux.
  const ROUTES_FILE = path.join(os.homedir(), '.stakk', 'routes.json');
  let routesState = { routes: {}, activeRoute: '', version: 1 };
  try {
    const raw = fs.readFileSync(ROUTES_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      routesState = {
        routes: parsed.routes || {},
        activeRoute: typeof parsed.activeRoute === 'string' ? parsed.activeRoute : '',
        version: parsed.version || 1,
      };
    }
  } catch {}
  function saveRoutesState() {
    routesState.version = (routesState.version || 0) + 1;
    try {
      fs.mkdirSync(path.dirname(ROUTES_FILE), { recursive: true });
      fs.writeFileSync(ROUTES_FILE, JSON.stringify(routesState));
    } catch (e) { log(`[overlay-backend] routes save err: ${e.message}`); }
  }

  // Langue de l'UI, relayée à l'overlay et au planner. L'UI principale est
  // servie sur localhost et l'overlay sur 127.0.0.1 : leurs localStorage
  // sont isolés, donc la langue transite par le serveur.
  const OVERLAY_LANG_FILE = path.join(os.homedir(), '.stakk', 'overlay', 'lang.json');
  const OVERLAY_LANGS = ['fr', 'en', 'es', 'de', 'pt'];
  let overlayLang = 'fr';
  try {
    const parsed = JSON.parse(fs.readFileSync(OVERLAY_LANG_FILE, 'utf8'));
    if (OVERLAY_LANGS.includes(parsed.lang)) overlayLang = parsed.lang;
  } catch {}
  function saveOverlayLang() {
    try {
      fs.mkdirSync(path.dirname(OVERLAY_LANG_FILE), { recursive: true });
      fs.writeFileSync(OVERLAY_LANG_FILE, JSON.stringify({ lang: overlayLang }));
    } catch (e) { log(`[overlay-backend] lang save err: ${e.message}`); }
  }

  // Compte linké à l'overlay (null = auto-pick du plus récent)
  const OVERLAY_LINK_FILE = path.join(os.homedir(), '.stakk', 'overlay', 'link.json');
  let linkedAccountId = null;
  try {
    const raw = fs.readFileSync(OVERLAY_LINK_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.accountId === 'number') linkedAccountId = parsed.accountId;
  } catch {}
  function saveOverlayLink() {
    try {
      fs.mkdirSync(path.dirname(OVERLAY_LINK_FILE), { recursive: true });
      fs.writeFileSync(OVERLAY_LINK_FILE, JSON.stringify({ accountId: linkedAccountId }));
    } catch {}
  }

  // Copie automatique de la commande `/travel` pendant une chasse au trésor.
  //
  // La préférence vit ICI et pas dans le plugin de chasse : celui-ci n'expose
  // qu'une route de lecture, et un test lui interdit toute route qui écrit —
  // c'est la garantie qu'il n'agit jamais au nom du joueur. Une préférence
  // d'affichage n'a rien à faire là-dedans, et elle rejoint donc les autres
  // réglages du sidecar.
  //
  // Le serveur en est la SEULE source. Deux clients la lisent — la page web et
  // le raccourci Ctrl+Shift+C de l'overlay — et une copie locale de chaque
  // côté finirait par afficher deux vérités différentes.
  const OVERLAY_CHASSE_FILE = path.join(os.homedir(), '.stakk', 'overlay', 'chasse.json');
  let chasseCopie = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(OVERLAY_CHASSE_FILE, 'utf8'));
    if (typeof parsed.copie === 'boolean') chasseCopie = parsed.copie;
  } catch { /* jamais réglé, ou fichier illisible : le défaut suffit */ }
  function saveChasseCopie() {
    try {
      fs.mkdirSync(path.dirname(OVERLAY_CHASSE_FILE), { recursive: true });
      fs.writeFileSync(OVERLAY_CHASSE_FILE, JSON.stringify({ copie: chasseCopie }));
    } catch (e) { log(`[overlay-backend] chasse save err: ${e.message}`); }
  }

  // ─── Cache dofusdb ─────────────────────────────────────────────────────
  const DOFUSDB_HOST = 'api.dofusdb.fr';
  const DOFUSDB_TTL_MS = 24 * 3600 * 1000; // 24h
  const mapResourcesCache = new Map(); // mapId → { data, fetchedAt }
  const itemNamesCache = new Map();    // itemId → { fr, en, iconId, ... }

  function dofusdbFetch(apiPath) {
    return new Promise((resolve, reject) => {
      const req = https.get({
        host: DOFUSDB_HOST,
        path: apiPath,
        headers: { 'User-Agent': 'STAKK-Overlay/1.0', 'Accept': 'application/json' },
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`dofusdb ${res.statusCode}`));
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch (e) { reject(e); }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(8000, () => req.destroy(new Error('dofusdb timeout')));
    });
  }

  async function resolveItemNames(ids) {
    const missing = [...new Set(ids)].filter(id => !itemNamesCache.has(id));
    if (missing.length === 0) return;
    for (let i = 0; i < missing.length; i += 50) {
      const chunk = missing.slice(i, i + 50);
      const qs = chunk.map(id => `id[$in][]=${id}`).join('&') + '&$limit=50';
      try {
        const r = await dofusdbFetch(`/items?${qs}`);
        for (const item of r.data || []) {
          itemNamesCache.set(item.id, { ...(item.name || {}), iconId: item.iconId });
        }
        for (const id of chunk) {
          if (!itemNamesCache.has(id)) itemNamesCache.set(id, {});
        }
      } catch (e) {
        log(`[Dofusdb] items fetch KO: ${e.message}`);
      }
    }
  }

  async function getMapResources(mapId) {
    const cached = mapResourcesCache.get(mapId);
    if (cached && (Date.now() - cached.fetchedAt) < DOFUSDB_TTL_MS) return cached.data;
    const r = await dofusdbFetch(`/recoltables2?id=${mapId}`);
    const entry = (r.data && r.data[0]) || null;
    if (entry && entry.resources) {
      await resolveItemNames(entry.resources);
      entry.names = {};
      for (const id of entry.resources) {
        const n = itemNamesCache.get(id);
        if (n) entry.names[id] = n;
      }
    }
    mapResourcesCache.set(mapId, { data: entry, fetchedAt: Date.now() });
    return entry;
  }

  // Paginate un endpoint Feathers.js via $skip/$limit jusqu'à couvrir `total`.
  // Nécessaire quand la plage peut dépasser le $limit max du serveur (par ex.
  // vue étendue 41×41 = 1681 cells + doublons = potentiellement >2000 entrées).
  //
  // IMPORTANT : dofusdb CAPE silencieusement $limit à 50 (testé empiriquement).
  // Si on passe $limit=100, on reçoit quand même 50 items, et si on break sur
  // `batch.length < pageSize` on s'arrête après la 1re page → on perd les
  // pages suivantes. pageSize DOIT matcher le cap serveur (50), et on break
  // seulement sur page vide / total atteint.
  // Worker pool : exécute `fn(item)` sur chaque item avec au plus
  // `concurrency` in-flight en parallèle. Évite d'attaquer dofusdb avec
  // 50 requêtes simultanées (rate-limit probable) tout en restant bien
  // plus rapide qu'une boucle séquentielle.
  async function pmap(items, fn, concurrency = 8) {
    const results = new Array(items.length);
    let idx = 0;
    async function worker() {
      while (idx < items.length) {
        const i = idx++;
        results[i] = await fn(items[i]);
      }
    }
    const n = Math.min(concurrency, items.length);
    await Promise.all(Array.from({ length: n }, worker));
    return results;
  }

  // Paginate un endpoint Feathers.js via $skip/$limit jusqu'à couvrir `total`.
  // Dofusdb cape $limit à 50 (pas documenté) donc pageSize=50 pour matcher
  // la réponse réelle sans break prématuré. Le premier appel récupère le
  // `total` et les batches restants sont fetchés EN PARALLÈLE (cap 8) au lieu
  // d'en séquentiel, parce qu'avec radius=20 on a ~40 pages × ~300ms serial
  // = 12 secondes. Parallèle = ~1.5 sec.
  async function fetchAllPaginated(endpoint, qsBase, pageSize = 50, maxPages = 100) {
    const sep = qsBase ? '&' : '';
    const url = (skip) => `${endpoint}?${qsBase}${sep}$limit=${pageSize}&$skip=${skip}`;
    const first = await dofusdbFetch(url(0));
    const all = [...(first.data || [])];
    const total = Math.min(
      typeof first.total === 'number' ? first.total : Infinity,
      maxPages * pageSize
    );
    if (all.length >= total) return all;
    const skips = [];
    for (let skip = pageSize; skip < total; skip += pageSize) skips.push(skip);
    const batches = await pmap(skips,
      skip => dofusdbFetch(url(skip)).catch(e => {
        log(`[overlay-backend] paginate batch err skip=${skip}: ${e.message}`);
        return { data: [] };
      }),
      8
    );
    for (const r of batches) all.push(...(r.data || []));
    return all;
  }

  // Batch /recoltables2 par chunks d'IDs en parallèle. dofusdb accepte ~50
  // params de query avant de tronquer ; on reste conservateur à 40 IDs/batch.
  async function fetchResourcesForMapIds(mapIds, batchSize = 40) {
    if (mapIds.length === 0) return [];
    const batches = [];
    for (let i = 0; i < mapIds.length; i += batchSize) {
      batches.push(mapIds.slice(i, i + batchSize));
    }
    const results = await Promise.all(batches.map(ids => {
      const qs = ids.map(id => `id[$in][]=${id}`).join('&') + `&$limit=${batchSize * 2}`;
      return dofusdbFetch(`/recoltables2?${qs}`).catch(e => {
        log(`[overlay-backend] recoltables2 batch err (${ids.length} ids): ${e.message}`);
        return { data: [] };
      });
    }));
    const all = [];
    for (const r of results) {
      if (r && r.data) all.push(...r.data);
    }
    return all;
  }

  async function getMapGrid(centerMapId, radius = 1) {
    let center = null;
    const cached = mapResourcesCache.get(centerMapId);
    if (cached?.data?.pos) center = cached.data.pos;
    if (!center) {
      const r = await dofusdbFetch(`/map-positions?id=${centerMapId}`);
      center = r.data?.[0] || null;
    }
    if (!center) throw new Error(`mapId ${centerMapId} introuvable`);
    const xMin = center.posX - radius, xMax = center.posX + radius;
    const yMin = center.posY - radius, yMax = center.posY + radius;
    // En intérieur (cave, mine, donjon) on restreint au subAreaId du center.
    // Signal : center.hasPriorityOnWorldmap === false → c'est une map "fille"
    // qui partage le même worldMap+posX/posY que la surface au-dessus. Sans ce
    // filtre, la dédup par (posX,posY) préfère la surface (priority=true) et
    // l'overlay rebascule toujours sur la surface au lieu d'afficher la cave.
    const indoorZone = center.hasPriorityOnWorldmap === false;
    let posQs = `worldMap=${center.worldMap}` +
      `&posX[$gte]=${xMin}&posX[$lte]=${xMax}` +
      `&posY[$gte]=${yMin}&posY[$lte]=${yMax}`;
    if (indoorZone) posQs += `&subAreaId=${center.subAreaId}`;
    // Pagination : pour radius=1..3 une page suffit, mais radius=6 (big-map
    // 13x13 = 169 cells + doublons) peut dépasser le $limit max du serveur.
    const allMaps = await fetchAllPaginated('/map-positions', posQs);
    // Groupe toutes les maps par (posX,posY). Chaque case agrège les
    // ressources de toutes les maps qui y vivent — en intérieur ce sont les
    // maps parallèles de la même zone (mine → subArea 29), en extérieur ce
    // sont la map surface + ses caves/mines filles (priority=false) qu'on
    // accède depuis cette tuile. Ça permet à l'utilisateur en surface de voir
    // "fer ici si je rentre dans la mine" sans avoir à changer de map.
    const byPos = new Map();
    for (const m of allMaps) {
      const k = `${m.posX},${m.posY}`;
      const list = byPos.get(k) || [];
      list.push(m);
      byPos.set(k, list);
    }
    // Choix de la map "canonique" pour chaque case (celle dont on prend le
    // mapId affiché, le subAreaId, etc.) :
    //  - En intérieur : on prend la map dont subAreaId matche le center.
    //  - En extérieur : on préfère hasPriorityOnWorldmap=true (surface),
    //    sinon même subArea que le center, sinon première.
    function pickCanonical(list) {
      if (indoorZone) {
        return list.find(m => m.subAreaId === center.subAreaId) || list[0];
      }
      return (
        list.find(m => m.hasPriorityOnWorldmap) ||
        list.find(m => m.subAreaId === center.subAreaId) ||
        list[0]
      );
    }
    const cells = [];
    for (const list of byPos.values()) {
      const canon = pickCanonical(list);
      cells.push({
        mapId: canon.id,
        mapIds: list.map(m => m.id),
        posX: canon.posX, posY: canon.posY, subAreaId: canon.subAreaId,
        resources: [], details: {}, names: {},
      });
    }
    if (cells.length === 0) return { center, radius, cells: [] };
    // Batch la fetch de recoltables2 en chunks de 40 IDs en parallèle. En
    // intérieur on fetch tous les mapIds agrégés (plusieurs par cell).
    const allCellMapIds = [];
    for (const c of cells) {
      if (c.mapIds) allCellMapIds.push(...c.mapIds);
      else allCellMapIds.push(c.mapId);
    }
    const resEntries = await fetchResourcesForMapIds(allCellMapIds);
    const byMap = new Map();
    for (const e of resEntries) byMap.set(e.id, e);
    const allItemIds = [];
    for (const e of resEntries) {
      if (e.resources) allItemIds.push(...e.resources);
    }
    await resolveItemNames(allItemIds);
    const allNames = {};
    for (const id of new Set(allItemIds)) {
      const n = itemNamesCache.get(id);
      if (n) allNames[id] = n;
    }
    for (const cell of cells) {
      const ids = cell.mapIds || [cell.mapId];
      const mergedDetails = {};
      const resourceSet = new Set();
      for (const id of ids) {
        const e = byMap.get(id);
        if (!e) continue;
        for (const r of e.resources || []) resourceSet.add(r);
        for (const [k, v] of Object.entries(e.details || {})) {
          mergedDetails[k] = (mergedDetails[k] || 0) + v;
        }
      }
      cell.resources = [...resourceSet];
      cell.details = mergedDetails;
    }
    return { center, radius, cells, names: allNames, indoor: indoorZone };
  }

  // ─── Spawn / kill des sidecars Electron ────────────────────────────────
  //
  // Il y en a DEUX, indépendants : la grille des ressources et la chasse au
  // trésor. Chacun a sa fenêtre, sa position, son interrupteur et son
  // processus — activer la chasse n'affiche jamais la grille, et l'inverse est
  // vrai aussi. Ils ne se distinguent ici que par la variante passée au
  // bootstrap, qui choisit le `main` à charger.
  //
  // Deux processus Electron coûtent deux runtimes en mémoire. C'est le prix
  // de l'isolation : l'un qui tombe n'emporte pas l'autre.
  const SIDECARS = {
    ressources: { variante: 'ressources', bounds: 'overlay-bounds.json', libelle: 'Overlay' },
    chasse:     { variante: 'chasse',     bounds: 'chasse-bounds.json',  libelle: 'Chasse' },
  };
  const procs = { ressources: null, chasse: null };

  const enVie = (nom) => !!(procs[nom] && !procs[nom].killed);

  function startOverlay(nom = 'ressources') {
    const conf = SIDECARS[nom];
    if (!conf) return { ok: false, error: `overlay inconnu : ${nom}` };
    if (enVie(nom)) {
      return { ok: true, alreadyRunning: true, pid: procs[nom].pid };
    }
    // Cherche le binaire electron : d'abord à côté de l'exécutable (release),
    // sinon dans node_modules (dev npm start). require('electron') ne marche
    // pas en contexte hot-module donc on résout par path.
    //
    // Sur macOS le binaire ne s'appelle pas pareil et ne vit pas au même
    // endroit : il est enfoui dans un bundle `Electron.app`. Ne chercher que
    // `electron.exe` revenait à ne jamais démarrer l'overlay sur Mac — pas une
    // erreur visible, juste une fonctionnalité absente.
    //
    // La racine se cherche aussi via STAKK_APP_ROOT : dans un bundle .app,
    // APP_ROOT peut pointer sur le dossier de l'exécutable et non sur la racine
    // livrée. Même motif que la résolution de .license.
    const relatifs = process.platform === 'darwin'
      ? [
          path.join('electron', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
          path.join('node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
        ]
      : [
          path.join('electron', 'electron.exe'),
          path.join('node_modules', 'electron', 'dist', 'electron.exe'),
        ];
    const racines = [APP_ROOT, process.env.STAKK_APP_ROOT].filter(Boolean);
    let electronBin = null;
    for (const racine of racines) {
      for (const rel of relatifs) {
        const c = path.join(racine, rel);
        if (fs.existsSync(c)) { electronBin = c; break; }
      }
      if (electronBin) break;
    }
    if (!electronBin) {
      const quoi = process.platform === 'darwin' ? 'Electron.app' : 'electron.exe';
      return { ok: false, error: `${quoi} introuvable (ni bundlé ni dans node_modules)` };
    }
    // Le bootstrap se cherche sur les mêmes racines, et pour la même raison.
    let overlayMain = null, racineTrouvee = null;
    for (const racine of racines) {
      const c = path.join(racine, 'overlay', 'bootstrap.js');
      if (fs.existsSync(c)) { overlayMain = c; racineTrouvee = racine; break; }
    }
    if (!overlayMain) {
      return { ok: false, error: `overlay/bootstrap.js introuvable (racines : ${racines.join(', ')})` };
    }

    // Le `main` de la variante vit à côté du bootstrap, et les deux sont
    // BUNDLÉS dans l'exe — pas chargés à chaud. Un exe antérieur à la chasse
    // n'a ni `chasse-main.js` ni le bootstrap qui sait lire la variante : il
    // lancerait main.js, c'est-à-dire un SECOND overlay des ressources, à la
    // place de celui qu'on demande.
    //
    // Ce module-ci, lui, se met à jour à chaud et arrive donc chez des exe plus
    // anciens que lui. Il vérifie, plutôt que d'ouvrir la mauvaise fenêtre.
    const mainVariante = nom === 'chasse' ? 'chasse-main.js' : 'main.js';
    if (!fs.existsSync(path.join(racineTrouvee, 'overlay', mainVariante))) {
      return {
        ok: false,
        majRequise: true,
        error: `Cette version de STAKK n'a pas l'overlay « ${nom} ». Mets STAKK à jour pour l'utiliser.`,
      };
    }
    const stakkUrl = `http://127.0.0.1:${WEB_PORT}`;
    const overlayCacheDir = path.join(os.homedir(), '.stakk', 'overlay');
    try { fs.mkdirSync(overlayCacheDir, { recursive: true }); } catch {}
    const boundsFile = path.join(overlayCacheDir, conf.bounds);
    // ELECTRON_RUN_AS_NODE (VSCode) force le mode Node pur → on l'enlève.
    //
    // La variante passe par l'environnement et non par argv : Electron 33+
    // traite tout argument supplémentaire comme un script d'entrée de plus et
    // sort en silence si ce n'en est pas un.
    const overlayEnv = {
      ...process.env,
      STAKK_OVERLAY_BOUNDS: boundsFile,
      STAKK_CHASSE_BOUNDS: boundsFile,
      STAKK_OVERLAY_VARIANTE: conf.variante,
    };
    delete overlayEnv.ELECTRON_RUN_AS_NODE;
    const proc = spawn(electronBin, [overlayMain, stakkUrl], {
      cwd: APP_ROOT,
      env: overlayEnv,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    procs[nom] = proc;
    proc.stdout?.on('data', d => log(`[${conf.libelle}/out] ${d.toString().trim()}`));
    proc.stderr?.on('data', d => log(`[${conf.libelle}/err] ${d.toString().trim()}`));
    proc.on('exit', (code, sig) => {
      log(`[${conf.libelle}] sidecar fermé (code=${code} sig=${sig})`);
      // Ne pas effacer une référence qui pointe déjà sur un successeur : un
      // redémarrage rapide verrait l'ancien `exit` annuler le nouveau.
      if (procs[nom] === proc) procs[nom] = null;
    });
    proc.on('error', err => log(`[${conf.libelle}] spawn err: ${err.message}`));
    log(`[${conf.libelle}] sidecar démarré PID=${proc.pid}`);
    return { ok: true, pid: proc.pid };
  }

  function stopOverlay(nom = 'ressources') {
    if (!SIDECARS[nom]) return { ok: false, error: `overlay inconnu : ${nom}` };
    if (!enVie(nom)) return { ok: true, wasRunning: false };
    try { procs[nom].kill(); } catch (e) { return { ok: false, error: e.message }; }
    return { ok: true, wasRunning: true };
  }

  // Cleanup des sidecars au shutdown de STAKK
  process.on('exit', () => {
    for (const nom of Object.keys(procs)) { try { procs[nom]?.kill(); } catch {} }
  });

  // ─── Handlers qui ont besoin de l'URL pour parser la query ─────────────
  function mapResourcesHandler(_body, req) {
    const url = parseUrl(req.url, true);
    const mapId = parseInt(url.query.mapId, 10);
    if (!mapId) return { error: 'mapId requis (?mapId=...)' };
    return getMapResources(mapId).then(e => e || { mapId, resources: [] })
      .catch(e => ({ error: e.message }));
  }
  function mapGridHandler(_body, req) {
    const url = parseUrl(req.url, true);
    const mapId = parseInt(url.query.mapId, 10);
    // Cap à 50 = bbox 101x101 = ~10k maps potentielles, suffisant pour le
    // route planner. fetchAllPaginated/fetchResourcesForMapIds gèrent la
    // charge via batching parallèle. Radius < 1 → 1 (3x3 mini).
    const radius = Math.max(1, Math.min(50, parseInt(url.query.radius || '1', 10)));
    if (!mapId) return { error: 'mapId requis (?mapId=...)' };
    return getMapGrid(mapId, radius).catch(e => ({ error: e.message }));
  }

  // Construit l'état envoyé à l'overlay. Merge les comptes lancés (depuis
  // runningHandles) avec accountMapState : les comptes lancés sans mapId
  // détecté apparaissent avec mapId=null + running=true, ce qui permet à
  // l'overlay d'afficher "X compte(s) lancé(s) — bouge sur la map" plutôt
  // que "aucun compte actif" (qui laissait penser que STAKK ne voyait rien).
  function buildMapState() {
    const out = {};
    for (const [aid, v] of Object.entries(accountMapState)) {
      out[aid] = { ...v };
    }
    for (const key of Object.keys(runningHandles)) {
      const aid = key.split(':')[0];
      if (!aid) continue;
      if (out[aid]) {
        out[aid].running = true;
      } else {
        out[aid] = { mapId: null, updatedAt: 0, running: true };
      }
    }
    return out;
  }

  // ─── Enregistrement des routes (toutes wrappées safe) ──────────────────
  registerRoute('GET',  '/api/map-state',        safe(() => buildMapState()));
  registerRoute('GET',  '/api/map-resources',    safe(mapResourcesHandler));
  registerRoute('GET',  '/api/map-grid',         safe(mapGridHandler));
  registerRoute('POST', '/api/overlay/start',    safe(() => startOverlay('ressources')));
  registerRoute('POST', '/api/overlay/stop',     safe(() => stopOverlay('ressources')));
  // La chasse est un sidecar à part : son interrupteur l'est aussi.
  registerRoute('POST', '/api/overlay/chasse/start', safe(() => startOverlay('chasse')));
  registerRoute('POST', '/api/overlay/chasse/stop',  safe(() => stopOverlay('chasse')));
  registerRoute('GET',  '/api/overlay/status',   safe(() => ({
    // `running` et `pid` restent ceux de la grille des ressources : l'onglet
    // et le planner les lisent déjà sous ce nom, et les renommer casserait
    // une version publiée pour un gain nul.
    running: enVie('ressources'),
    pid: enVie('ressources') ? procs.ressources.pid : null,
    chasseRunning: enVie('chasse'),
    chassePid: enVie('chasse') ? procs.chasse.pid : null,
    chasseCopie,
  })));

  // L'interrupteur de copie du /travel. Le sidecar le relit à chaque sondage,
  // la page web l'affiche : les deux voient la même valeur.
  registerRoute('POST', '/api/overlay/chasse-copie', safe((body) => {
    // Un booléen, strictement. `"false"` — ce que rend un formulaire — passerait
    // pour vrai, et l'interrupteur afficherait le contraire de ce qu'il fait.
    if (!body || typeof body.actif !== 'boolean') return { error: 'actif (booléen) requis' };
    if (body.actif !== chasseCopie) { chasseCopie = body.actif; saveChasseCopie(); }
    return { ok: true, chasseCopie };
  }));
  // Routes : état complet (incluant un version counter pour que les clients
  // puissent détecter un changement via polling sans refetch inutile).
  registerRoute('GET',  '/api/overlay/routes',        safe(() => routesState));
  registerRoute('POST', '/api/overlay/routes',        safe((body) => {
    if (!body || typeof body.name !== 'string' || !body.name.trim()) return { error: 'name requis' };
    if (!Array.isArray(body.waypoints)) return { error: 'waypoints requis (array)' };
    const name = body.name.trim();
    routesState.routes[name] = {
      waypoints: body.waypoints,
      createdAt: routesState.routes[name]?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    saveRoutesState();
    return { ok: true, name, route: routesState.routes[name], version: routesState.version };
  }));
  registerRoute('POST', '/api/overlay/routes/delete', safe((body) => {
    const name = body?.name;
    if (!name || !routesState.routes[name]) return { error: 'route introuvable' };
    delete routesState.routes[name];
    if (routesState.activeRoute === name) routesState.activeRoute = '';
    saveRoutesState();
    return { ok: true, version: routesState.version };
  }));
  registerRoute('POST', '/api/overlay/routes/active', safe((body) => {
    const name = typeof body?.name === 'string' ? body.name : '';
    if (name && !routesState.routes[name]) return { error: 'route introuvable' };
    routesState.activeRoute = name;
    saveRoutesState();
    return { ok: true, activeRoute: name, version: routesState.version };
  }));

  // Langue courante de l'UI — lue par overlay/index.html et planner.html
  registerRoute('GET',  '/api/overlay/lang',     safe(() => ({ lang: overlayLang })));
  registerRoute('POST', '/api/overlay/lang',     safe((body) => {
    const next = body && typeof body.lang === 'string' ? body.lang.slice(0, 5).toLowerCase() : '';
    if (!OVERLAY_LANGS.includes(next)) return { error: 'langue inconnue' };
    if (next !== overlayLang) { overlayLang = next; saveOverlayLang(); }
    return { ok: true, lang: overlayLang };
  }));

  registerRoute('GET',  '/api/overlay/link',     safe(() => ({ accountId: linkedAccountId })));
  registerRoute('POST', '/api/overlay/link',     safe((body) => {
    const id = body && typeof body.accountId === 'number' ? body.accountId : null;
    linkedAccountId = id;
    saveOverlayLink();
    return { ok: true, accountId: linkedAccountId };
  }));

  // ─── Hook sur game-proxy pour recevoir les map changes ─────────────────
  if (typeof setMapUpdateHandler === 'function') {
    setMapUpdateHandler((accountId, mapId) => {
      accountMapState[accountId] = { mapId, updatedAt: Date.now() };
      log(`[Map] ${accountId} → mapId ${mapId}`);
    });
  }

  log('[overlay-backend] plugin chargé');
};
