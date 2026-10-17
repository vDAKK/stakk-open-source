'use strict';

/**
 * monde.js — quelle carte est au sud, et par quelle case y aller.
 *
 * C'est la moitié du travail d'une chasse au trésor : un indice dit « va vers
 * le sud », et il faut savoir où c'est et comment sortir. Les deux réponses
 * viennent du `world-graph` d'Ankama, extrait du client Unity et compilé par
 * `scripts/compiler-monde.js` — 8251 cartes, 25333 transitions.
 *
 * Rien n'est déduit des coordonnées. On pourrait croire qu'aller à l'est
 * revient à chercher la carte en `x + 1`, et c'est vrai 96 fois sur 100 : sur
 * les 25048 transitions cardinales vérifiées, 23965 mènent bien à la case
 * voisine attendue. Restent un millier de sorties qui ne bougent pas d'un
 * pouce en coordonnées (intérieurs, changements de niveau) ou qui décalent en
 * diagonale. Le graphe les connaît, le calcul non — donc c'est le graphe qui
 * décide, et les coordonnées ne servent qu'à situer et à mesurer une distance.
 *
 * ═══ Ce que le graphe ne dit pas ═════════════════════════════════════════
 *
 * Une carte peut être découpée en zones qui ne communiquent pas, et une sortie
 * partant d'une zone où l'on ne se trouve pas est inatteignable. Le compilateur
 * agrège par carte : `sorties()` peut donc rendre une case qu'on n'atteindra
 * pas. Ce n'est pas grave — un déplacement qui n'aboutit pas se détecte — mais
 * ça interdit de tenir une sortie pour acquise avant d'y être.
 *
 * Certaines transitions portent un critère (quête, objet). Elles sont
 * conservées mais écartées par défaut : les emprunter sans savoir les évaluer
 * ferait échouer le déplacement.
 *
 * Aucune I/O hors du chargement de la table.
 */

// Convention Dofus, vérifiée contre les coordonnées des 25048 transitions
// cardinales du graphe : est = x+1, sud = y+1, ouest = x-1, nord = y-1.
const EST = 0, SUD_EST = 1, SUD = 2, SUD_OUEST = 3;
const OUEST = 4, NORD_OUEST = 5, NORD = 6, NORD_EST = 7;

const DIRECTIONS = { EST, SUD_EST, SUD, SUD_OUEST, OUEST, NORD_OUEST, NORD, NORD_EST };
const NOMS = ['est', 'sud-est', 'sud', 'sud-ouest', 'ouest', 'nord-ouest', 'nord', 'nord-est'];

module.exports = function createMonde(deps) {
  deps = deps || {};

  const table = deps.table || chargerTable();
  const sortiesParMap = table.sorties || {};
  const coordsParMap = table.coords || {};

  function chargerTable() {
    const zlib = require('zlib');
    const fs = require('fs');
    const path = require('path');
    return JSON.parse(zlib.gunzipSync(
      fs.readFileSync(path.join(__dirname, 'monde.json.gz'))).toString('utf8'));
  }

  /** { x, y, monde } ou null si la carte est inconnue. */
  function coords(mapId) {
    const c = coordsParMap[mapId];
    return c ? { x: c[0], y: c[1], monde: c[2] } : null;
  }

  const estConnue = (mapId) => !!sortiesParMap[mapId] || !!coordsParMap[mapId];

  /**
   * Les sorties d'une carte dans une direction : `{ map, cellule, critere }`.
   *
   * Plusieurs sorties par direction est le cas normal — une carte a souvent
   * plusieurs cases de bord menant à la même voisine. Elles sont rendues
   * telles quelles, au moteur de choisir la plus proche.
   */
  function sorties(mapId, direction, options) {
    options = options || {};
    const parDir = sortiesParMap[mapId];
    const liste = parDir && parDir[direction];
    if (!liste) return [];
    return liste
      .map(e => ({ map: e[0], cellule: e[1], critere: e[2] || null }))
      .filter(e => options.avecCritere ? true : !e.critere);
  }

  /**
   * La carte voisine dans une direction, ou null.
   *
   * Quand plusieurs sorties mènent ailleurs, on prend la plus fréquente —
   * c'est-à-dire la destination portée par le plus de cases de bord, qui est
   * la voisine « pleine » plutôt qu'un recoin accessible par une seule case.
   */
  function voisine(mapId, direction, options) {
    const liste = sorties(mapId, direction, options);
    if (!liste.length) return null;
    const compte = new Map();
    for (const e of liste) compte.set(e.map, (compte.get(e.map) || 0) + 1);
    let gagnante = null, max = 0;
    for (const [m, n] of compte) if (n > max) { gagnante = m; max = n; }
    return { map: gagnante, cellules: liste.filter(e => e.map === gagnante).map(e => e.cellule) };
  }

  /**
   * Avance de `pas` cartes dans une direction. Rend la suite des cartes
   * traversées, la dernière en tête de liste inverse — ou une liste plus
   * courte si le monde s'arrête avant.
   *
   * Une boucle est coupée net : certaines zones se rebouclent sur elles-mêmes,
   * et suivre une direction indéfiniment tournerait en rond sans fin.
   */
  function suivre(mapId, direction, pas, options) {
    const chemin = [];
    const vues = new Set([mapId]);
    let courante = mapId;
    for (let i = 0; i < pas; i++) {
      const v = voisine(courante, direction, options);
      if (!v || vues.has(v.map)) break;
      vues.add(v.map);
      chemin.push(v);
      courante = v.map;
    }
    return chemin;
  }

  /**
   * L'itinéraire d'une carte à une autre, par le graphe.
   *
   * Marcher « vers l'est » ne mène pas à une carte précise : si le personnage
   * n'est pas sur la même ligne que la cible, il longera indéfiniment sans
   * jamais l'atteindre. C'est exactement ce qui est arrivé — cible en [7,9],
   * personnage en [2,10], et une marche vers l'est qui ne pouvait pas aboutir.
   *
   * On parcourt donc le graphe en largeur : le premier chemin trouvé est le
   * plus court en nombre de cartes.
   *
   * @returns {Array<{map:number, cellules:number[]}>} les sauts à enchaîner,
   *          vide si on y est déjà, null si aucun chemin sous `maxCartes`.
   */
  function itineraire(depuis, vers, maxCartes) {
    if (!Number.isInteger(depuis) || !Number.isInteger(vers)) return null;
    if (depuis === vers) return [];
    const plafond = Number.isInteger(maxCartes) ? maxCartes : 60;

    const vus = new Set([depuis]);
    let front = [[depuis, []]];
    for (let profondeur = 0; profondeur < plafond && front.length; profondeur++) {
      const suivant = [];
      for (const [carte, chemin] of front) {
        const parDir = sortiesParMap[carte];
        if (!parDir) continue;
        for (const dir of Object.keys(parDir)) {
          for (const e of sorties(carte, Number(dir))) {
            if (vus.has(e.map)) continue;
            const etape = { map: e.map, cellules: sorties(carte, Number(dir))
              .filter(x => x.map === e.map).map(x => x.cellule) };
            const suite = chemin.concat([etape]);
            if (e.map === vers) return suite;
            vus.add(e.map);
            suivant.push([e.map, suite]);
          }
        }
      }
      front = suivant;
    }
    return null;
  }

  /** Distance de Manhattan entre deux cartes, ou null si l'une est inconnue. */
  function distance(a, b) {
    const ca = coords(a), cb = coords(b);
    if (!ca || !cb) return null;
    return Math.abs(ca.x - cb.x) + Math.abs(ca.y - cb.y);
  }

  /** Les cartes situées à ces coordonnées. Plusieurs, souvent : intérieurs. */
  function cartesEn(x, y, monde) {
    const trouvees = [];
    for (const [id, c] of Object.entries(coordsParMap)) {
      if (c[0] !== x || c[1] !== y) continue;
      if (monde !== undefined && c[2] !== monde) continue;
      trouvees.push(Number(id));
    }
    return trouvees;
  }

  const nomDirection = (d) => NOMS[d] || null;
  const nbCartes = () => Object.keys(coordsParMap).length;

  return {
    DIRECTIONS, NOMS,
    coords, estConnue, sorties, voisine, suivre, itineraire, distance, cartesEn,
    nomDirection, nbCartes,
  };
};

module.exports.DIRECTIONS = DIRECTIONS;
module.exports.NOMS = NOMS;
