'use strict';

/**
 * fm-data.js — Couche données Forgemagie (dofusdb).
 *
 * Fournit les 3 tables dont le moteur FM a besoin :
 *   - runes    : effectId → paliers de runes disponibles (basique / Pa / Ra)
 *   - effects  : effectId → libellé lisible ("Force", "Vitalité"…)
 *   - items    : recherche d'équipements FMables + leurs jets min/max
 *
 * Tout vient de api.dofusdb.fr (même source que overlay-backend). Les tables
 * runes/effects sont statiques entre deux MAJ Ankama → cache disque 7 jours.
 * La recherche d'items est memoïsée en RAM seulement (requêtes utilisateur).
 *
 * Encodage des effets, identique côté rune et côté item :
 *   { effectId, from, to }  →  from = jet mini, to = jet maxi (0 si fixe)
 * Une rune "Rune Pa Fo" = effectId 118, from 3 → +3 Force par jet réussi.
 * Un item FMable expose les mêmes effectId ; l'intersection avec la table de
 * runes donne exactement la liste des stats forgeables de cet item.
 */

module.exports = function createFmData(deps) {
  deps = deps || {};
  const https = deps.https || require('https');
  const fs    = deps.fs    || require('fs');
  const path  = deps.path  || require('path');
  const os    = deps.os    || require('os');
  const log   = deps.log   || (() => {});

  const HOST = 'api.dofusdb.fr';
  const CACHE_DIR = deps.cacheDir || path.join(os.homedir(), '.stakk');
  const CACHE_FILE = path.join(CACHE_DIR, 'fm-data.json');
  // Langues servies par l'UI. dofusdb renvoie les noms/descriptions dans
  // toutes : on les garde toutes en cache et on résout au moment de répondre,
  // pour que les noms d'items, de runes et de stats suivent la langue choisie.
  const LANGS = ['fr', 'en', 'es', 'de', 'pt'];
  const CACHE_VERSION = 2;   // 2 = tables multilingues (1 = fr/en seulement)
  let lang = 'fr';
  function setLang(l) { if (LANGS.includes(l)) lang = l; return lang; }
  // Choisit la traduction disponible : langue courante → fr → en.
  function pick(obj, fallback) {
    if (!obj) return fallback || '';
    return obj[lang] || obj.fr || obj.en || fallback || '';
  }
  function allLangs(obj, map) {
    const out = {};
    for (const l of LANGS) out[l] = map ? map(obj?.[l]) : (obj?.[l] || '');
    return out;
  }
  const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
  const PAGE = 50;              // dofusdb cape silencieusement $limit à 50
  const RUNE_TYPE_ID = 78;      // "Rune de forgemagie"
  // "Orbe de forgemagie" : remet les jets d'un item à neuf (tirage de craft).
  // Détruit au passage le puits ET les exotiques — c'est donc une remise à
  // zéro complète, à n'utiliser qu'après un exo raté qui a cassé l'item.
  const ORBE_TYPE_ID = 189;

  // Les exotiques courants : PA, PM, Portée, Invocation. Ce sont les
  // caractéristiques qu'on ajoute à un item qui ne les a pas.
  const EXO_EFFECT_IDS = [111, 128, 117, 182];

  // Types d'équipement forgeables. Un item est retenu s'il est `enhanceable`
  // ET d'un de ces types — le flag seul laisse passer des objets non portables.
  const GEAR_TYPE_IDS = new Set([
    1,  // Amulette
    2,  // Arc
    3,  // Baguette
    4,  // Bâton
    5,  // Dague
    6,  // Épée
    7,  // Marteau
    8,  // Pelle
    9,  // Anneau
    10, // Ceinture
    11, // Bottes
    16, // Chapeau
    17, // Cape
    19, // Familier
    21, // Sac à dos
    82, // Bouclier
    151,// Trophée
    254,// Dofus
  ]);

  function fetchJson(apiPath) {
    return new Promise((resolve, reject) => {
      const req = https.get({
        host: HOST,
        path: apiPath,
        headers: { 'User-Agent': 'STAKK-FM/1.0', 'Accept': 'application/json' },
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
      req.setTimeout(10000, () => req.destroy(new Error('dofusdb timeout')));
    });
  }

  // Parcourt toutes les pages d'un endpoint Feathers jusqu'à couvrir `total`.
  async function fetchAll(endpoint, qs) {
    const sep = qs ? '&' : '';
    const first = await fetchJson(`${endpoint}?${qs}${sep}$limit=${PAGE}&$skip=0`);
    const all = [...(first.data || [])];
    const total = typeof first.total === 'number' ? first.total : all.length;
    for (let skip = PAGE; skip < total; skip += PAGE) {
      const r = await fetchJson(`${endpoint}?${qs}${sep}$limit=${PAGE}&$skip=${skip}`);
      const batch = r.data || [];
      if (!batch.length) break;
      all.push(...batch);
    }
    return all;
  }

  // ─── Cache disque ────────────────────────────────────────────────────────

  let mem = null; // { runes, effects, fetchedAt }

  function readCache() {
    try {
      const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      // `orbes` a été ajouté après coup : un cache plus ancien doit être
      // refait, sinon la remise à neuf n'aurait aucun objet à utiliser.
      if (!raw || !raw.fetchedAt || !raw.runes || !raw.orbes) return null;
      // Cache v1 = libellés fr/en seulement : à refaire pour les autres langues.
      if (raw.v !== CACHE_VERSION) return null;
      if (Date.now() - raw.fetchedAt > CACHE_TTL_MS) return null;
      return raw;
    } catch { return null; }
  }

  function writeCache(data) {
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify(data));
    } catch (e) { log(`[fm-data] cache write KO: ${e.message}`); }
  }

  // ─── Libellés d'effets ───────────────────────────────────────────────────

  // dofusdb renvoie des gabarits type "#1{{~1~2 à }}#2 Force". On enlève les
  // placeholders (#1, #2, {{...}}) pour ne garder que le nom de la stat.
  function cleanEffectLabel(tpl) {
    if (!tpl) return '';
    return String(tpl)
      .replace(/\{\{[^}]*\}\}/g, ' ')
      .replace(/#\d/g, ' ')
      .replace(/[{}~]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  async function fetchEffectLabels(effectIds) {
    const out = {};
    const ids = [...new Set(effectIds)];
    for (let i = 0; i < ids.length; i += 40) {
      const chunk = ids.slice(i, i + 40);
      const qs = chunk.map(id => `id[$in][]=${id}`).join('&');
      try {
        const r = await fetchJson(`/effects?${qs}&$limit=${PAGE}`);
        for (const e of r.data || []) {
          out[e.id] = {
            ...allLangs(e.description, cleanEffectLabel),
            characteristic: typeof e.characteristic === 'number' ? e.characteristic : null,
          };
        }
      } catch (e) { log(`[fm-data] effects chunk KO: ${e.message}`); }
    }
    return out;
  }

  // ─── Table de runes ──────────────────────────────────────────────────────

  // Une rune = 1 seul effet, `from` = points donnés par jet. Pour un même
  // effectId on trouve jusqu'à 3 paliers (ex. Fo : 1 / 3 / 10). On les trie
  // par montant croissant : [basique, pa, ra]. Le tri par montant est plus sûr
  // que le préfixe de nom ("Rune Pa …") qui varie selon la langue.
  function buildRuneTable(runeItems) {
    const byEffect = {};
    for (const it of runeItems) {
      const effs = it.effects || [];
      if (effs.length !== 1) continue;         // "Rune de Signature", runes sans effet…
      const e = effs[0];
      const amount = e.from || 0;
      if (!e.effectId || amount <= 0) continue;
      (byEffect[e.effectId] = byEffect[e.effectId] || []).push({
        id: it.id,
        names: allLangs(it.name),
        level: it.level || 1,
        amount,
      });
    }
    for (const effectId of Object.keys(byEffect)) {
      byEffect[effectId].sort((a, b) => a.amount - b.amount);
    }
    return byEffect;
  }

  async function refresh() {
    log('[fm-data] refresh depuis dofusdb…');
    const runeItems = await fetchAll('/items', `typeId=${RUNE_TYPE_ID}`);
    const runes = buildRuneTable(runeItems);
    const effects = await fetchEffectLabels(Object.keys(runes).map(Number));
    // Orbes : triées par niveau, pour choisir la plus petite qui couvre l'item.
    let orbes = [];
    try {
      orbes = (await fetchAll('/items', `typeId=${ORBE_TYPE_ID}`))
        .map(it => ({ id: it.id, names: allLangs(it.name), level: it.level || 0 }))
        .sort((a, b) => a.level - b.level);
    } catch (e) { log(`[fm-data] orbes indisponibles: ${e.message}`); }
    const data = { runes, effects, orbes, fetchedAt: Date.now(), v: CACHE_VERSION };
    writeCache(data);
    mem = data;
    log(`[fm-data] ${runeItems.length} runes → ${Object.keys(runes).length} stats forgeables, ${orbes.length} orbe(s)`);
    return data;
  }

  // Projette les tables multilingues dans la langue courante : les appelants
  // (moteur, routes, journal) continuent de lire `.name` / un libellé plat.
  // Mémoïsé par (langue, date de fetch) — c'est reconstruit à chaque refresh
  // ou changement de langue, pas à chaque appel.
  let localizedMemo = null;
  function localize(data) {
    if (!data) return data;
    if (localizedMemo && localizedMemo.lang === lang && localizedMemo.at === data.fetchedAt) {
      return localizedMemo.tables;
    }
    const runes = {};
    for (const [effectId, tiers] of Object.entries(data.runes || {})) {
      runes[effectId] = tiers.map(r => ({ ...r, name: pick(r.names, String(r.id)) }));
    }
    const effects = {};
    for (const [id, e] of Object.entries(data.effects || {})) {
      effects[id] = { ...e, label: pick(e, '') };
    }
    const orbes = (data.orbes || []).map(o => ({ ...o, name: pick(o.names, String(o.id)) }));
    const tables = { ...data, runes, effects, orbes, lang };
    localizedMemo = { lang, at: data.fetchedAt, tables };
    return tables;
  }

  // Retourne { runes, effects, orbes } dans la langue courante.
  // Cache RAM → cache disque → réseau. `force` ignore les deux caches.
  async function getTables(force) {
    if (!force && mem) return localize(mem);
    if (!force) {
      const cached = readCache();
      if (cached) { mem = cached; return localize(mem); }
    }
    return localize(await refresh());
  }

  // ─── Items ───────────────────────────────────────────────────────────────

  const itemMemo = new Map(); // id → item normalisé

  function normalizeItem(raw, runes) {
    const stats = [];
    for (const e of raw.effects || []) {
      if (!e.effectId) continue;
      if (runes && !runes[e.effectId]) continue;   // stat sans rune = non forgeable
      stats.push({ effectId: e.effectId, from: e.from || 0, to: e.to || 0 });
    }
    return {
      id: raw.id,
      names: allLangs(raw.name),
      level: raw.level || 0,
      typeId: raw.typeId,
      typeNames: allLangs(raw.type?.name),
      iconId: raw.iconId,
      img: raw.iconId ? `https://api.dofusdb.fr/img/items/${raw.iconId}.png` : null,
      stats,
    };
  }

  // Vue d'un item dans la langue courante (le memo, lui, reste multilingue).
  function localizeItem(item) {
    if (!item) return item;
    return { ...item, name: pick(item.names, String(item.id)), typeName: pick(item.typeNames, '') };
  }

  function isGear(raw) {
    return !!raw && raw.enhanceable === true && GEAR_TYPE_IDS.has(raw.typeId);
  }

  // Recherche par nom, dans la langue de l'UI (dofusdb indexe un slug par
  // langue). Retourne uniquement des équipements FMables qui ont au moins une
  // stat forgeable.
  async function searchItems(query, limit) {
    const q = String(query || '').trim();
    if (q.length < 2) return [];
    const { runes } = await getTables();
    const qs = `slug.${lang}[$search]=${encodeURIComponent(slugify(q))}&$limit=${PAGE}`;
    let rows = [];
    try {
      const r = await fetchJson(`/items?${qs}`);
      rows = r.data || [];
    } catch (e) {
      log(`[fm-data] search KO: ${e.message}`);
      return [];
    }
    const out = [];
    for (const raw of rows) {
      if (!isGear(raw)) continue;
      const item = normalizeItem(raw, runes);
      if (!item.stats.length) continue;
      itemMemo.set(item.id, item);
      out.push(localizeItem(item));
      if (out.length >= (limit || 30)) break;
    }
    return out;
  }

  // dofusdb indexe des slugs sans accents ni ponctuation.
  function slugify(s) {
    return String(s)
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  async function getItem(id) {
    const key = Number(id);
    if (itemMemo.has(key)) return localizeItem(itemMemo.get(key));
    const { runes } = await getTables();
    const r = await fetchJson(`/items?id=${key}`);
    const raw = (r.data || [])[0];
    if (!raw) throw new Error(`item ${key} introuvable`);
    const item = normalizeItem(raw, runes);
    itemMemo.set(key, item);
    return localizeItem(item);
  }

  return {
    getTables, refresh, searchItems, getItem, EXO_EFFECT_IDS,
    // Langue de résolution des noms (items, runes, orbes) et des libellés
    setLang, LANGS,
    // exportés pour les tests
    _buildRuneTable: buildRuneTable,
    _cleanEffectLabel: cleanEffectLabel,
    _slugify: slugify,
    _isGear: isGear,
    _normalizeItem: normalizeItem,
    CACHE_FILE,
  };
};
