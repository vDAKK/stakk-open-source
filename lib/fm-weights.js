'use strict';

/**
 * fm-weights.js — Poids de forgemagie par caractéristique.
 *
 * En forgemagie, chaque caractéristique a un COEFFICIENT. Le poids d'une rune
 * vaut « points apportés × coefficient ». C'est cette grandeur qui gouverne
 * tout le reste :
 *
 *   - une ligne ne peut pas dépasser 101 de poids (sauf si son poids naturel
 *     est déjà au-dessus) : c'est la limite d'overmax ;
 *   - quand un jet échoue et détruit une ligne plus lourde que la rune posée,
 *     la différence part en RELIQUAT (aussi appelé puits) ;
 *   - un exotique se pose quand le reliquat couvre le poids de sa rune :
 *     PA = 100, PM = 90, Portée = 51.
 *
 * Sources croisées (juillet 2026) :
 *   - https://tofus.fr/fiches/forgemagie.php
 *   - https://wiki-dofus.eu/w/Forgemagie
 *   - https://laforgemagiedofus.blogspot.com/p/les-runes.html
 *   - https://dafous.app/guides/poids-runes-fm.html
 *
 * Les caractéristiques principales sont concordantes d'une source à l'autre.
 * Plusieurs secondaires ne le sont PAS (coup critique 10 ou 30, résistances 2
 * ou 6, dommages pièges 5 ou 15) : elles sont marquées `uncertain`. Le moteur
 * ne doit pas fonder une décision coûteuse sur un poids incertain — mieux vaut
 * l'ignorer que se tromper.
 *
 * Contrôle de cohérence : le coefficient doit rendre le poids de la rune de
 * base égal à 1 pour les caractéristiques « à 1 point », et les paliers Pa/Ra
 * pèsent alors 3 et 10. Vitalité 0,2 × 5 = 1, Initiative 0,1 × 10 = 1 : la
 * règle se vérifie sur les données dofusdb (voir test).
 */

module.exports = function createFmWeights() {
  // effectId → { coef, label, uncertain? }
  const COEFFICIENTS = {
    // ── Principales : concordantes partout ────────────────────────────────
    118: { coef: 1,    label: 'Force' },
    126: { coef: 1,    label: 'Intelligence' },
    123: { coef: 1,    label: 'Chance' },
    119: { coef: 1,    label: 'Agilité' },
    125: { coef: 0.2,  label: 'Vitalité' },
    124: { coef: 3,    label: 'Sagesse' },
    174: { coef: 0.1,  label: 'Initiative' },
    158: { coef: 0.25, label: 'Pods' },
    138: { coef: 2,    label: 'Puissance' },

    // ── Exotiques : le cœur du sujet, unanimes ────────────────────────────
    111: { coef: 100,  label: 'PA' },
    128: { coef: 90,   label: 'PM' },
    117: { coef: 51,   label: 'Portée' },
    182: { coef: 30,   label: 'Invocation' },

    // ── Dommages ──────────────────────────────────────────────────────────
    112: { coef: 20,   label: 'Dommages' },
    414: { coef: 5,    label: 'Dommages Poussée' },
    418: { coef: 5,    label: 'Dommages Critiques' },
    422: { coef: 5,    label: 'Dommages Terre' },
    424: { coef: 5,    label: 'Dommages Feu' },
    426: { coef: 5,    label: 'Dommages Eau' },
    428: { coef: 5,    label: 'Dommages Air' },
    430: { coef: 5,    label: 'Dommages Neutre' },
    220: { coef: 30,   label: 'Dommages Renvoyés' },

    // ── Divers, plusieurs sources d'accord ────────────────────────────────
    176: { coef: 3,    label: 'Prospection' },
    178: { coef: 10,   label: 'Soin' },
    752: { coef: 4,    label: 'Fuite' },
    753: { coef: 4,    label: 'Tacle' },

    // ── Contradictoires entre sources : à ne pas exploiter aveuglément ────
    115: { coef: 10,   label: 'Coup Critique',      uncertain: true }, // 10 ou 30
    225: { coef: 5,    label: 'Dommages Pièges',    uncertain: true }, // 5 ou 15
    226: { coef: 3,    label: 'Puissance Pièges',   uncertain: true },
    160: { coef: 7,    label: '% Résistance PA',    uncertain: true },
    161: { coef: 7,    label: '% Résistance PM',    uncertain: true },
    240: { coef: 6,    label: '% Résistance Terre', uncertain: true }, // 2 ou 6
    241: { coef: 6,    label: '% Résistance Eau',   uncertain: true },
    242: { coef: 6,    label: '% Résistance Air',   uncertain: true },
    243: { coef: 6,    label: '% Résistance Feu',   uncertain: true },
    244: { coef: 6,    label: '% Résistance Neutre',uncertain: true },
    416: { coef: 2,    label: '% Résistance Poussée', uncertain: true },
    420: { coef: 2,    label: '% Résistance Critique', uncertain: true },
  };

  // Limite d'overmax : une ligne ne peut pas dépasser ce poids, sauf si son
  // poids naturel (jet max de l'item) est déjà au-dessus.
  const MAX_LINE_WEIGHT = 101;

  /** Coefficient d'une caractéristique, ou null si inconnu. */
  function coefOf(effectId) {
    const e = COEFFICIENTS[effectId];
    return e ? e.coef : null;
  }

  function isUncertain(effectId) {
    const e = COEFFICIENTS[effectId];
    return !!(e && e.uncertain);
  }

  /**
   * Poids d'un jet : points × coefficient. Null si la caractéristique est
   * inconnue — l'appelant doit alors s'abstenir de raisonner dessus.
   */
  function weightOf(effectId, points) {
    const coef = coefOf(effectId);
    if (coef === null || !Number.isFinite(points)) return null;
    return round2(points * coef);
  }

  /** Poids d'une rune telle que la décrit fm-data ({ id, amount }). */
  function runeWeight(effectId, tier) {
    if (!tier || !Number.isFinite(tier.amount)) return null;
    return weightOf(effectId, tier.amount);
  }

  /**
   * Poids maximal encore posable sur une ligne.
   *
   * La limite est 101, mais un item dont le jet max pèse déjà davantage garde
   * son poids naturel comme plafond : on ne « rabote » pas un item.
   */
  function lineHeadroom(effectId, currentValue, itemMaxValue) {
    const cur = weightOf(effectId, currentValue);
    if (cur === null) return null;
    const natural = weightOf(effectId, itemMaxValue || 0) || 0;
    const cap = Math.max(MAX_LINE_WEIGHT, natural);
    return round2(cap - cur);
  }

  /**
   * Reliquat produit par un jet raté : poids détruit moins poids de la rune.
   * Négatif ou nul ⇒ pas de reliquat.
   */
  function residualFrom(destroyedWeight, runeWeightValue) {
    if (!Number.isFinite(destroyedWeight) || !Number.isFinite(runeWeightValue)) return 0;
    return Math.max(0, round2(destroyedWeight - runeWeightValue));
  }

  /**
   * Reliquat nécessaire pour poser un exotique : le poids de sa rune.
   * PA = 100, PM = 90, Portée = 51.
   */
  function exoCost(effectId, points) {
    return weightOf(effectId, points == null ? 1 : points);
  }

  function round2(n) { return Math.round(n * 100) / 100; }

  return {
    COEFFICIENTS, MAX_LINE_WEIGHT,
    coefOf, isUncertain, weightOf, runeWeight,
    lineHeadroom, residualFrom, exoCost,
  };
};
