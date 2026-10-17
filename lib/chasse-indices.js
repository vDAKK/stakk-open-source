'use strict';

/**
 * chasse-indices.js — où se trouve l'indice cherché.
 *
 * C'est la pièce qui manquait, et son absence explique tout ce qui n'allait
 * pas : sans elle, STAKK avançait d'une carte et posait un drapeau au hasard,
 * en espérant tomber juste. Sur une vraie chasse, l'indice `927` cherché vers
 * l'est depuis [2,9] se trouve en [7,9] — CINQ cartes plus loin. Le drapeau
 * posé sur la première carte n'avait aucune chance.
 *
 * ═══ La source ═══════════════════════════════════════════════════════════
 *
 *   GET https://api.dofusdb.fr/treasure-hunt?x=&y=&direction=&$limit=50&lang=fr
 *
 * Elle rend les cartes alignées dans la direction depuis (x, y), chacune avec
 * son `id` — le mapId du protocole — et ses `pois[]`, dont les identifiants
 * sont EXACTEMENT ceux que le protocole nous donne. Aucun pont à construire :
 *
 *     indice 965, nord depuis [3,22]  →  map 88081670 [3,17]
 *
 * et c'est très précisément la carte où le joueur avait validé à la main.
 *
 * ═══ Les phorreurs ═══════════════════════════════════════════════════════
 *
 * Deux familles d'indices se distinguent nettement :
 *
 *     ids ~860–1100   POI fixes — gravures, champignons, talismans
 *     ids ~2600 et +  PHORREURS — des créatures, donc mobiles
 *
 * Les seconds sont absents de l'API, et ce n'est pas une lacune : ils
 * apparaissent sur l'une des cartes de la direction et changent de place.
 * Vérifié — la carte où le joueur a validé l'indice 2673 ne porte, selon
 * l'API, que les POI 882 et 912. `resoudre()` rend donc `null` pour eux, et
 * c'est à l'appelant de retomber sur la recherche carte par carte.
 *
 * ═══ Réseau ══════════════════════════════════════════════════════════════
 *
 * Un appel par étape de chasse, mis en cache mémoire ET disque : une direction
 * depuis une carte donnée ne change pas. Panne réseau ou API muette : on rend
 * null, et la chasse retombe sur son ancien comportement plutôt que de
 * s'arrêter.
 */

const BASE = 'https://api.dofusdb.fr/treasure-hunt';
const DELAI_MS = 8000;

module.exports = function createChasseIndices(deps) {
  deps = deps || {};
  const https = deps.https || require('https');
  const fs = deps.fs || require('fs');
  const path = deps.path || require('path');
  const doLog = deps.log || (() => {});
  const langue = deps.langue || 'fr';

  // Cache mémoire : clé « x,y,direction ».
  const memoire = new Map();
  const fichier = deps.fichier || null;
  if (fichier) {
    try {
      const j = JSON.parse(fs.readFileSync(fichier, 'utf8'));
      for (const [k, v] of Object.entries(j)) memoire.set(k, v);
    } catch { /* pas encore de cache, ou illisible */ }
  }

  function sauver() {
    if (!fichier) return;
    try {
      fs.mkdirSync(path.dirname(fichier), { recursive: true });
      fs.writeFileSync(fichier, JSON.stringify(Object.fromEntries(memoire)));
    } catch (e) { doLog(`[indices] cache non sauvegardé : ${e.message}`); }
  }

  function demander(url) {
    return new Promise((resolve) => {
      let fini = false;
      const finir = (v) => { if (!fini) { fini = true; resolve(v); } };
      try {
        const req = https.get(url, { headers: { 'User-Agent': 'STAKK' } }, (res) => {
          if (res.statusCode !== 200) { res.resume(); return finir(null); }
          let corps = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { corps += c; });
          res.on('end', () => { try { finir(JSON.parse(corps)); } catch { finir(null); } });
        });
        req.setTimeout(DELAI_MS, () => { req.destroy(); finir(null); });
        req.on('error', () => finir(null));
      } catch { finir(null); }
    });
  }

  /**
   * Les cartes alignées dans une direction, avec leurs points d'intérêt.
   *
   * @returns {Array<{map:number, x:number, y:number, pois:Array<{id:number,nom:string}>}>}
   */
  async function cartesDansLaDirection(x, y, direction) {
    const cle = `${x},${y},${direction}`;
    if (memoire.has(cle)) return memoire.get(cle);

    const url = `${BASE}?x=${x}&y=${y}&direction=${direction}&$limit=50&lang=${langue}`;
    const j = await demander(url);
    if (!j || !Array.isArray(j.data)) {
      doLog(`[indices] API muette pour ${cle}`);
      return null;      // pas de mise en cache d'un échec
    }
    const cartes = j.data.map(m => ({
      map: m.id, x: m.posX, y: m.posY,
      pois: (m.pois || []).map(p => ({ id: p.id, nom: (p.name && (p.name[langue] || p.name.fr)) || String(p.id) })),
    }));
    memoire.set(cle, cartes);
    sauver();
    return cartes;
  }

  /**
   * La carte portant l'indice `indice`, en partant de (x, y) vers `direction`.
   *
   * Rend `{ map, x, y, nom, distance }`, ou null — indice mobile (phorreur),
   * hors de portée, ou API injoignable. Dans tous ces cas l'appelant doit
   * retomber sur la recherche carte par carte : rendre une carte au hasard
   * serait pire que ne rien rendre.
   */
  async function resoudre(x, y, direction, indice) {
    if (!Number.isInteger(indice)) return null;
    const cartes = await cartesDansLaDirection(x, y, direction);
    if (!cartes) return null;
    for (const c of cartes) {
      const poi = c.pois.find(p => p.id === indice);
      if (!poi) continue;
      // Distance calculée sur les COORDONNÉES, pas sur le rang dans la liste :
      // rien ne garantit que l'API rende toutes les cartes intermédiaires, et
      // un rang pris pour une distance donnerait un nombre faux dans le
      // journal — celui-là même sur lequel on juge si la cible est plausible.
      const d = Math.abs(c.x - x) + Math.abs(c.y - y);
      return { map: c.map, x: c.x, y: c.y, nom: poi.nom, distance: d };
    }
    return null;
  }

  /**
   * Cet indice est-il connu de l'API, où que ce soit dans cette direction ?
   *
   * Sert à distinguer « cible hors de portée » de « indice mobile » : un
   * phorreur n'apparaît dans AUCUNE liste, un POI fixe hors de portée non plus.
   * On ne tranche donc pas ici — c'est une information, pas un verdict.
   */
  /**
   * Cet indice est-il un PHORREUR ?
   *
   * Leur identifiant d'indice EST leur identifiant de PNJ — vérifié sur trois
   * indices d'une chasse réelle : 2673 « Phorreur méfiant », 2674 « Phorreur
   * rusé », 2675 « Phorreur espiègle ». On interroge donc la table des PNJ.
   *
   * On ne se contente pas de « absent de la base des POI » : un indice peut
   * aussi être hors de portée, ou l'API muette. Prendre ces cas pour des
   * phorreurs ferait marcher le personnage sans jamais poser de drapeau.
   *
   * Rend `{ nom }` ou null. Mis en cache, y compris les réponses négatives —
   * un indice ne change pas de nature.
   */
  async function estPhorreur(indice) {
    if (!Number.isInteger(indice)) return null;
    const cle = `npc:${indice}`;
    if (memoire.has(cle)) return memoire.get(cle);
    const j = await demander(`https://api.dofusdb.fr/npcs?id=${indice}&lang=${langue}`);
    if (!j || !Array.isArray(j.data)) return null;   // API muette : on ne fige rien
    const d = j.data[0];
    const nom = d && d.name && (d.name[langue] || d.name.fr);
    const r = (nom && /phorreur/i.test(nom)) ? { nom } : null;
    memoire.set(cle, r);
    sauver();
    return r;
  }

  const enCache = (x, y, direction) => memoire.has(`${x},${y},${direction}`);
  const taille = () => memoire.size;

  return { resoudre, estPhorreur, cartesDansLaDirection, enCache, taille, BASE };
};
