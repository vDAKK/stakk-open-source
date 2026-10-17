'use strict';

/**
 * fm-engine.js — Moteur de décision Forgemagie. 100 % pur : aucune I/O, aucun
 * réseau, aucun état global. Il répond à une seule question, encore et encore :
 *
 *     « vu l'item actuel et l'inventaire de runes, quelle rune je jette ? »
 *
 * Le côté sale (paquets, sockets, timers) vit dans fm.js. Ici tout est
 * déterministe et testable, ce qui évite d'avoir à relancer Dofus pour
 * vérifier une règle de décision.
 *
 * Modèle
 * ------
 * Un PLAN décrit l'objectif : pour chaque stat forgeable de l'item, un
 * intervalle [goal, ceiling] et les 3 paliers de runes disponibles.
 *   - goal    : valeur à atteindre (on jette tant que current < goal)
 *   - ceiling : valeur à ne jamais dépasser (garde-fou anti-gaspillage)
 * Un ÉTAT décrit la réalité : valeur courante de chaque stat + stock de runes.
 *
 * Choix du palier — par ÉCART RESTANT (gap = goal - current) :
 *   gap >= seuilRa  → rune Ra   (gros pas, on est loin)
 *   gap >= seuilPa  → rune Pa
 *   sinon           → rune basique (finition, zéro dépassement)
 * Les seuils sont réglables ; par défaut seuil = montant de la rune, ce qui
 * garantit qu'on ne jette jamais une rune qui ferait dépasser `goal`.
 * Un palier absent de l'inventaire est ignoré et on redescend d'un cran.
 */

module.exports = function createFmEngine(deps) {
  deps = deps || {};

  // ─── Construction du plan ────────────────────────────────────────────────

  /**
   * @param item    { id, name, stats:[{effectId, from, to}] }  (fm-data)
   * @param tables  { runes: {effectId: [tiers…]}, effects: {effectId:{fr}} }
   * @param config  {
   *                  targets: { [effectId]: [goal, ceiling] },
   *                  thresholds: { [effectId]: [seuilPa, seuilRa] },  // optionnel
   *                }
   */
  function buildPlan(item, tables, config) {
    if (!item || !Array.isArray(item.stats)) throw new Error('item invalide');
    const runes = (tables && tables.runes) || {};
    const labels = (tables && tables.effects) || {};
    // Table de poids, facultative. Quand elle est là, le moteur refuse les
    // runes qui feraient franchir la limite de poids d'une ligne — elles ne
    // passeraient jamais en jeu.
    const weights = (config && config.weights) || null;
    const cfgTargets = (config && config.targets) || {};
    const cfgThresholds = (config && config.thresholds) || {};

    const cfgPhases = (config && config.phases) || {};
    const byEffect = new Map();
    for (const s of item.stats) byEffect.set(String(s.effectId), s);

    // On part des stats DEMANDÉES, pas de celles de l'item : un exo porte sur
    // une caractéristique que l'item n'a pas encore (PA, PM, PO…), elle est
    // donc absente de item.stats et serait perdue si on itérait dessus.
    const targets = [];
    for (const key of Object.keys(cfgTargets)) {
      const effectId = Number(key);
      const tiers = runes[effectId];
      if (!tiers || !tiers.length) continue;         // pas de rune → hors de portée
      const asked = cfgTargets[key];
      if (!asked) continue;
      const goal = num(asked[0]);
      if (goal === null || goal <= 0) continue;
      const ceiling = num(asked[1]);
      const th = cfgThresholds[key] || [];
      const s = byEffect.get(key);
      // Une caractéristique absente de l'item est un exo : par défaut on la
      // travaille APRÈS les autres, comme le ferait un joueur.
      const phase = cfgPhases[key] != null ? Number(cfgPhases[key]) : (s ? 0 : 1);
      targets.push({
        effectId,
        label: labels[effectId]?.fr || `Effet ${effectId}`,
        itemMin: s ? s.from : 0,
        itemMax: s ? (s.to || s.from) : 0,
        onItem: !!s,
        phase: Number.isFinite(phase) ? phase : 0,
        goal,
        ceiling: ceiling === null ? Infinity : Math.max(ceiling, goal),
        tiers,                                        // trié croissant par fm-data
        thresholdPa: num(th[0]),
        thresholdRa: num(th[1]),
        // Poids d'un point de cette caractéristique, et poids maximal que la
        // ligne peut porter. `null` quand le coefficient est inconnu ou
        // douteux : on s'abstient alors plutôt que d'interdire à tort.
        coef: weightCoef(weights, effectId),
        weightCap: weightCap(weights, effectId, s ? (s.to || s.from) : 0),
      });
    }
    if (!targets.length) throw new Error('aucune stat forgeable sélectionnée');
    return { itemId: item.id, itemName: item.name, targets };
  }

  // Coefficient exploitable : on écarte les caractéristiques dont les sources
  // se contredisent, une interdiction fondée sur un chiffre douteux coûterait
  // plus cher que pas d'interdiction du tout.
  function weightCoef(weights, effectId) {
    if (!weights || typeof weights.coefOf !== 'function') return null;
    if (typeof weights.isUncertain === 'function' && weights.isUncertain(effectId)) return null;
    const c = weights.coefOf(effectId);
    return Number.isFinite(c) && c > 0 ? c : null;
  }

  // Poids maximal d'une ligne : 101, sauf si le poids naturel de l'item le
  // dépasse déjà — on ne rabote pas un item au-dessus de la norme.
  function weightCap(weights, effectId, naturalMax) {
    const coef = weightCoef(weights, effectId);
    if (coef === null) return null;
    const cap = weights.MAX_LINE_WEIGHT || 101;
    return Math.max(cap, coef * (naturalMax || 0));
  }

  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  // Plan par défaut : la fourchette naturelle de l'item — objectif = jet
  // mini, plafond = jet maxi.
  //
  // C'est le point de départ le plus lisible : on voit d'emblée ce que l'item
  // peut donner sans overmax, et on relève ensuite ce qu'on veut vraiment.
  // Un plafond au jet max interdit l'overmax : c'est délibéré par défaut,
  // l'utilisateur l'ouvre quand il le décide.
  function defaultTargets(item, tables) {
    const runes = (tables && tables.runes) || {};
    const out = {};
    for (const s of item.stats || []) {
      if (!runes[s.effectId]) continue;
      out[s.effectId] = [s.from, s.to || s.from];
    }
    return out;
  }

  // Borne haute proposée à l'UI pour l'axe des sliders : on laisse de la marge
  // au-dessus du jet max pour permettre l'overmax, sans partir dans l'absurde.
  function axisMax(stat) {
    const max = stat.to || stat.from || 1;
    if (max <= 20) return Math.max(max * 4, 10);
    if (max <= 150) return max * 2;
    return Math.ceil(max * 1.3);
  }

  // ─── Choix de la rune ────────────────────────────────────────────────────

  // Seuil imposé par l'utilisateur pour un palier, ou null s'il n'en a pas
  // fixé. Par défaut il n'y en a AUCUN : c'est le plafond qui gouverne.
  function tierThreshold(target, index) {
    if (index === 2 && target.thresholdRa !== null) return target.thresholdRa;
    if (index === 1 && target.thresholdPa !== null) return target.thresholdPa;
    return null;
  }

  /**
   * Un palier est-il jouable ?
   *
   * C'est la PLACE SOUS LE PLAFOND qui décide, pas l'écart à l'objectif.
   * Raisonner sur l'écart menait à une absurdité : sur une plage 20–25, une
   * stat à 19 n'acceptait plus qu'une rune +1 alors qu'une +3 (→ 22) reste
   * dans la plage et donne un meilleur item. L'objectif est un plancher à
   * atteindre, le plafond la seule limite.
   *
   * Exception nécessaire : si aucun palier ne rentre sous le plafond alors
   * que l'objectif n'est pas atteint, on autorise le plus fin à déborder —
   * sinon une plage serrée (objectif = plafond) ne pourrait jamais se finir,
   * la forgemagie n'ayant pas de grain plus petit.
   */
  function tierAllowed(target, index, current) {
    const tier = target.tiers[index];
    if (!tier) return false;
    if (current >= target.ceiling) return false;

    const th = tierThreshold(target, index);
    if (th !== null && target.goal - current < th) return false;

    // Limite de poids du jeu : au-delà, la rune ne passe jamais. Inutile de
    // la jeter — c'est de la rune perdue et du temps perdu.
    if (target.coef !== null && target.weightCap !== null) {
      if ((current + tier.amount) * target.coef > target.weightCap) return false;
    }

    if (current + tier.amount <= target.ceiling) return true;

    return index === 0
      && !target.tiers.some((t, i) => i > 0 && current + t.amount <= target.ceiling);
  }

  /**
   * Rune à jeter pour une stat donnée, ou null si rien à faire.
   * @param target  entrée de plan.targets
   * @param current valeur actuelle de la stat sur l'item
   * @param stock   { [runeId]: quantité } — inventaire de runes du perso
   */
  function pickRune(target, current, stock) {
    if (target.goal - current <= 0) return null;     // objectif atteint
    stock = stock || {};
    // Du plus gros palier au plus petit : le premier autorisé et en stock.
    for (let i = target.tiers.length - 1; i >= 0; i--) {
      if (!tierAllowed(target, i, current)) continue;
      const tier = target.tiers[i];
      if (!(stock[tier.id] > 0)) continue;
      return tier;
    }
    return null;
  }

  /**
   * Stat suivante à travailler.
   *
   * Deux règles, dans cet ordre :
   *   1. On ne passe à la phase suivante que si la précédente est finie. Un
   *      exo se tente APRÈS avoir sécurisé les stats de base — le tenter avant
   *      revient à gaspiller des runes sur un objet qu'on va encore modifier.
   *   2. Dans une phase, on prend la stat la plus éloignée de son objectif en
   *      proportion, pour répartir l'effort au lieu de s'acharner sur une.
   */
  function nextTarget(plan, state) {
    const pending = plan.targets.filter(t => t.goal - currentOf(state, t.effectId) > 0);
    if (!pending.length) return null;
    const phase = Math.min(...pending.map(t => t.phase || 0));

    let best = null, bestScore = 0;
    for (const t of pending) {
      if ((t.phase || 0) !== phase) continue;
      const current = currentOf(state, t.effectId);
      if (!pickRune(t, current, state.stock)) continue;
      const score = (t.goal - current) / Math.max(t.goal, 1);
      if (score > bestScore) { bestScore = score; best = t; }
    }
    return best;
  }

  // Phase en cours : la plus basse dont il reste du travail.
  function currentPhase(plan, state) {
    const pending = plan.targets.filter(t => t.goal - currentOf(state, t.effectId) > 0);
    return pending.length ? Math.min(...pending.map(t => t.phase || 0)) : null;
  }

  function currentOf(state, effectId) {
    const v = state && state.stats && state.stats[effectId];
    return typeof v === 'number' ? v : 0;
  }

  /**
   * Décision suivante du moteur.
   * @param plan  buildPlan()
   * @param state { stats:{[effectId]:valeur}, stock:{[runeId]:qté} }
   * @returns { type:'throw', runeId, runeName, amount, effectId, label, current, goal }
   *        | { type:'done' }
   *        | { type:'blocked', reason, missing:[…] }
   */
  function nextAction(plan, state) {
    const pending = plan.targets.filter(t => t.goal - currentOf(state, t.effectId) > 0);
    if (!pending.length) return { type: 'done' };

    const target = nextTarget(plan, state);
    if (!target) {
      // Il reste du travail mais aucune rune utilisable : on dit précisément
      // ce qui manque pour que l'UI affiche autre chose que "échec". On ne
      // parle que de la phase en cours, pas des exos qu'on n'a pas commencés.
      const phase = currentPhase(plan, state);
      const missing = [];
      for (const t of pending.filter(x => (x.phase || 0) === phase)) {
        const current = currentOf(state, t.effectId);
        const usable = t.tiers.filter((_, i) => tierAllowed(t, i, current));
        missing.push({
          effectId: t.effectId,
          label: t.label,
          current,
          goal: t.goal,
          runes: usable.map(tier => ({ id: tier.id, name: tier.name })),
        });
      }
      return { type: 'blocked', reason: 'no-rune', missing };
    }

    const current = currentOf(state, target.effectId);
    const tier = pickRune(target, current, state.stock);
    return {
      type: 'throw',
      runeId: tier.id,
      runeName: tier.name,
      amount: tier.amount,
      effectId: target.effectId,
      label: target.label,
      current,
      goal: target.goal,
      phase: target.phase || 0,
      exo: !target.onItem,
    };
  }

  // ─── Application d'un résultat ───────────────────────────────────────────

  /**
   * Met à jour l'état après un jet. Les stats sont TOUJOURS relues depuis le
   * jeu (`observed`) plutôt que devinées : la FM peut faire baisser d'autres
   * stats, et un jet raté ne monte rien. `observed` = { effectId: valeur }.
   * Le stock est décrémenté d'une rune, quel que soit le résultat.
   */
  function applyResult(state, action, observed) {
    const next = {
      stats: { ...(state.stats || {}) },
      stock: { ...(state.stock || {}) },
      thrown: (state.thrown || 0) + 1,
    };
    if (action && action.runeId != null) {
      const left = (next.stock[action.runeId] || 0) - 1;
      if (left > 0) next.stock[action.runeId] = left;
      else delete next.stock[action.runeId];
    }
    if (observed && typeof observed === 'object') {
      for (const [k, v] of Object.entries(observed)) {
        if (typeof v === 'number') next.stats[k] = v;
      }
    }
    return next;
  }

  // Progression 0..1 pour la barre de l'UI. Moyenne des stats, une stat
  // au-delà de son objectif compte pour 1 (pas plus).
  function progress(plan, state) {
    if (!plan.targets.length) return 1;
    let sum = 0;
    for (const t of plan.targets) {
      const start = t.itemMin || 0;
      const span = Math.max(t.goal - start, 1);
      const done = Math.min(Math.max(currentOf(state, t.effectId) - start, 0), span);
      sum += done / span;
    }
    return sum / plan.targets.length;
  }

  // Délai humain entre deux jets. rng injectable pour les tests.
  function throwDelay(range, rng) {
    const r = Array.isArray(range) ? range : [500, 1000];
    const lo = Math.max(0, Math.min(r[0], r[1]));
    const hi = Math.max(0, Math.max(r[0], r[1]));
    const rand = typeof rng === 'function' ? rng : Math.random;
    return Math.round(lo + rand() * (hi - lo));
  }

  return {
    buildPlan, defaultTargets, axisMax,
    pickRune, nextTarget, nextAction, applyResult, currentPhase,
    progress, throwDelay,
    _tierThreshold: tierThreshold,
    _tierAllowed: tierAllowed,
    _currentOf: currentOf,
  };
};
