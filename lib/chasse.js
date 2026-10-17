'use strict';

/**
 * chasse.js — Plugin Chasse au trésor, en OBSERVATEUR.
 *
 * Une chasse enchaîne des étapes : lire l'indice, traverser les cartes dans la
 * direction indiquée, poser un drapeau au bon endroit, creuser à la dernière.
 *
 * ═══ Ce que ce module fait, et ce qu'il ne fait plus ═════════════════════
 *
 * Il a chassé tout seul : il traversait les cartes, posait les drapeaux,
 * creusait. Ça marchait, et c'était le geste le plus exposé de tout STAKK —
 * des dizaines de paquets fabriqués par carte, sur des dizaines de cartes.
 *
 * Il ne fait plus qu'observer. Il lit l'état de la chasse dans le trafic,
 * résout l'indice en carte cible, compte les cartes, et le dit. Le joueur
 * copie le `/travel`, marche, pose son drapeau. Aucun paquet ne part d'ici :
 * les constructeurs ont été retirés de `chasse-protocol.js`, il n'y a donc
 * rien à envoyer même par erreur.
 *
 * ═══ Pourquoi on ne mémorise presque rien ═══════════════════════════════
 *
 * Le serveur tient le compte : le nombre de drapeaux posés donne l'étape en
 * cours, et le dernier drapeau donne d'où partir. L'événement de chasse dit
 * tout — un redémarrage de STAKK au milieu d'une chasse reprend au bon endroit
 * sans rien avoir gardé.
 *
 * ═══ Les phorreurs ══════════════════════════════════════════════════════
 *
 * Deux familles d'indices. Les identifiants ~860 à 1100 sont des points
 * d'intérêt fixes, que `chasse-indices` résout en carte précise. Ceux à ~2600
 * et plus sont des phorreurs : des créatures, donc mobiles, qu'aucune base ne
 * peut situer. Pour eux il n'y a pas de `/travel` — seulement la direction, et
 * le fait de dire s'ils sont sur la carte où l'on se trouve.
 */

module.exports = function createChasse(deps) {
  const {
    log, registerRoute,
    setPacketHandler,
    createProtocolLearn,
    createChasseProtocol,
    createChasseIndices,
  } = deps;

  const maintenant = deps.now || Date.now;
  const doLog = typeof log === 'function' ? log : () => {};

  if (typeof registerRoute !== 'function') {
    doLog('[chasse] plugin inactif : API incomplète');
    return { actif: false };
  }

  let chasseProto;
  try {
    // Un plugin ne require() pas ses voisins : le socle arrive par la deps bag.
    if (typeof createProtocolLearn !== 'function' || typeof createChasseProtocol !== 'function') {
      throw new Error('socle ou protocole non injectés');
    }
    chasseProto = createChasseProtocol({
      createProtocolLearn,
      schema: deps.schemaDofus,
      noms: deps.nomsDofus,
      types: deps.typesChasse,
    });
  } catch (e) {
    doLog(`[chasse] plugin inactif : ${e.message}`);
    return { actif: false };
  }

  const monde = deps.monde || null;

  // Résolveur d'indices. Absent — hôte trop ancien, ou réseau coupé — l'overlay
  // affiche la direction sans la cible, ce qui reste utile.
  let indices = null;
  try {
    if (typeof createChasseIndices === 'function') {
      indices = createChasseIndices({ log: doLog, fichier: deps.cacheIndices || null });
    }
  } catch (e) {
    doLog(`[chasse] résolveur d'indices indisponible : ${e.message}`);
  }

  // ─── L'état d'une chasse ─────────────────────────────────────────────────

  // accountId → ce qu'on sait de sa chasse. Rien n'est persisté : le serveur
  // est la source, et un redémarrage se rattrape au premier paquet reçu.
  const etats = new Map();
  function etatDe(accountId) {
    let e = etats.get(accountId);
    if (!e) {
      e = {
        mapId: null, x: null, y: null,
        etape: null, direction: null, indice: null,
        origine: null, etapeNum: null, etapesTotal: null,
        cible: null,          // { map, x, y, nom }
        cartes: null,         // nombre de cartes jusqu'à la cible
        phorreur: null,       // { nom } dès que l'indice est identifié comme tel
        phorreurIci: false,
        at: 0,
      };
      etats.set(accountId, e);
    }
    return e;
  }

  // Résolutions en cours. Sans ce verrou, chaque paquet reçu pendant l'appel
  // réseau en relancerait un : une étape ne change pas entre deux lectures.
  const enCours = new Set();

  function resoudreCible(accountId, e) {
    if (!indices || !Number.isInteger(e.indice) || e.direction === null) return;
    // L'indice se cherche depuis l'ORIGINE de l'étape, pas depuis là où se
    // trouve le personnage : entre le drapeau et maintenant, le joueur a pu
    // marcher. Partir de sa position ferait résoudre l'indice dans le vide.
    const c = (monde && Number.isInteger(e.origine)) ? monde.coords(e.origine) : null;
    if (!c) return;
    const cle = `${accountId}:${c.x},${c.y},${e.direction},${e.indice}`;
    if (enCours.has(cle)) return;
    enCours.add(cle);
    (async () => {
      // L'identifiant d'indice d'un phorreur EST son identifiant de PNJ —
      // vérifié sur 2673 « Phorreur méfiant », 2674 « Phorreur rusé », 2675
      // « Phorreur espiègle ». On interroge donc la base des PNJ plutôt que de
      // déduire d'une absence, qui confondrait « mobile » et « hors de portée ».
      const phorreur = await indices.estPhorreur(e.indice);
      if (phorreur) {
        // Un phorreur se déplace : aucune base ne dit où il est, donc pas de
        // cible et pas de /travel. Seulement la direction, et sa présence ici.
        e.phorreur = phorreur;
        e.cible = null;
        e.cartes = null;
        e.at = maintenant();
        return;
      }
      e.phorreur = null;
      const cible = await indices.resoudre(c.x, c.y, e.direction, e.indice);
      e.cible = cible;
      // Le compte de cartes, lui, part de là où le joueur EST : c'est ce qu'il
      // lui reste à parcourir, pas la longueur de l'étape.
      e.cartes = cible ? cartesJusqua(monde, e.mapId, cible.map) : null;
      e.at = maintenant();
    })()
      .catch(err => doLog(`[chasse] résolution impossible : ${err.message}`))
      .then(() => enCours.delete(cle));
  }

  // ─── La lecture du trafic ────────────────────────────────────────────────

  const tapInstalled = typeof setPacketHandler === 'function'
    ? setPacketHandler((accountId, dir, msgId, buf) => {
        // Ce gestionnaire tourne sur CHAQUE paquet du canal jeu, en synchrone.
        // Il ne fait que LIRE, et tout y est enveloppé : une exception ici
        // couperait le trafic du joueur.
        //
        // Seuls les paquets entrants comptent. La position vient de ce que le
        // SERVEUR annonce, pas de ce que le client demande : une demande de
        // changement de carte peut être refusée, une annonce jamais.
        if (dir !== 'in') return;
        const e = etatDe(accountId);

        try {
          const carte = chasseProto.lireCarteAnnoncee(buf);
          if (carte && Number.isInteger(carte.mapId) && carte.mapId !== e.mapId) {
            e.mapId = carte.mapId;
            const c = monde && monde.coords(carte.mapId);
            e.x = c ? c.x : null;
            e.y = c ? c.y : null;
            e.phorreurIci = false;   // nouvelle carte, présence à reconstater
            e.cartes = e.cible ? cartesJusqua(monde, e.mapId, e.cible.map) : null;
            e.at = maintenant();
            resoudreCible(accountId, e);
          }
        } catch { /* lecture best-effort : jamais bloquante */ }

        try {
          const evenement = chasseProto.lireEtape(buf);
          if (evenement) {
            const courante = etapeCourante(evenement);
            const indice = courante && Number.isInteger(courante.indice) ? courante.indice : null;
            const direction = courante && Number.isInteger(courante.direction) ? courante.direction : null;
            const origine = origineDe(evenement);
            // Une étape identique relue — le serveur renvoie l'état complet à
            // chaque drapeau — ne doit pas jeter une cible déjà résolue : ce
            // serait un appel réseau de plus, et l'overlay clignoterait.
            const nouvelle = indice !== e.indice || direction !== e.direction || origine !== e.origine;
            e.etape = courante ? courante.genre : null;
            e.direction = direction;
            e.indice = indice;
            e.origine = origine;
            e.etapeNum = evenement.etapeNum;
            e.etapesTotal = evenement.etapesTotal;
            if (nouvelle) {
              e.cible = null;
              e.cartes = null;
              e.phorreur = null;
              e.phorreurIci = false;
              resoudreCible(accountId, e);
            }
            e.at = maintenant();
          }
        } catch { /* idem */ }

        // Présence du phorreur : seulement si l'indice EN EST un. Chercher un
        // identifiant quelconque dans l'arbre des acteurs sans cette condition
        // ferait afficher « ICI » sur une coïncidence.
        try {
          if (e.phorreur && !e.phorreurIci && Number.isInteger(e.indice)
              && chasseProto.acteursContiennent(buf, e.indice)) {
            doLog(`[chasse] phorreur ${e.indice} sur la carte (compte ${accountId})`);
            e.phorreurIci = true;
            e.at = maintenant();
          }
        } catch { /* idem */ }
      })
    : null;

  // ─── La route, en lecture seule ──────────────────────────────────────────

  function safe(fn) {
    return (...args) => {
      try { return fn(...args); }
      catch (err) { doLog(`[chasse] handler err: ${err.stack || err.message}`); return { error: err.message }; }
    };
  }

  const qs = (req) => {
    try { return require('url').parse(req.url, true).query || {}; }
    catch { return {}; }
  };

  registerRoute('GET', '/api/chasse/etat', safe((_body, req) => {
    const accountId = Number(qs(req).accountId);
    if (!Number.isFinite(accountId)) return { error: 'accountId requis (?accountId=...)' };
    const e = etatDe(accountId);
    const nomDir = (monde && Number.isInteger(e.direction)) ? monde.nomDirection(e.direction) : null;
    return {
      // Ce que l'overlay affiche.
      mapId: e.mapId, x: e.x, y: e.y,
      etape: e.etape,
      // Numérotation de la chasse, pour un « 2/5 » lisible. Elle compte les
      // ÉTAPES, pas les indices révélés : les confondre affichait « 5/5 » sur
      // une chasse qui n'en était qu'à sa deuxième.
      etapeNum: e.etapeNum,
      etapesTotal: e.etapesTotal,
      origine: e.origine,
      direction: e.direction,
      directionNom: nomDir,
      indice: e.indice,
      cible: e.cible,                       // { map, x, y, nom } ou null
      cartes: e.cartes,                     // nombre de cartes, ou null
      phorreur: e.phorreur ? e.phorreur.nom : null,
      phorreurIci: e.phorreurIci,
      // La commande à copier. Null pour un phorreur : il se déplace, aucune
      // coordonnée ne le désigne.
      travel: e.cible ? `/travel ${e.cible.x},${e.cible.y}` : null,
      // De quoi expliquer un écran vide plutôt que de le laisser muet.
      protocoleConnu: !!chasseProto.types.etape,
      resolveur: !!indices,
      graphe: !!monde,
      tap: !!tapInstalled,
      // Compteurs de lecture. Une fenêtre vide a deux causes qui se
      // ressemblent : le message de chasse n'arrive pas, ou il arrive et n'est
      // pas lu. `chasse` contre `lues` les sépare, et évite d'en être réduit à
      // supposer laquelle des deux on regarde.
      lecture: typeof chasseProto.diagnostic === 'function' ? chasseProto.diagnostic() : null,
      at: e.at,
    };
  }));

  doLog(`[chasse] observateur chargé — protocole ${chasseProto.types.etape ? 'connu' : 'NON identifié'}`
    + `, graphe ${monde ? 'chargé' : 'absent'}, aucune émission`);

  return {
    actif: true,
    _etat: etatDe,
    _protocol: chasseProto,
  };
};

/**
 * L'étape à chercher : la DERNIÈRE révélée.
 *
 * L'événement ne décrit pas une étape mais la LISTE des indices révélés
 * jusqu'ici — et c'est le piège de ce module. Lire `genre`, `direction` et
 * `indice` à la racine de l'événement rend `undefined` sur les trois : ils
 * vivent dans chaque entrée de `etapes`. La fenêtre restait donc vide alors
 * que les événements arrivaient et se décodaient parfaitement.
 *
 * Le dernier est le bon, et ce n'est pas une déduction : une capture montre
 * que chaque drapeau correct RÉVÈLE l'indice suivant — 1 indice, drapeau bon,
 * 2 indices. La liste est le compteur fiable. `etapeNum`, lui, compte les
 * étapes de la CHASSE et ne sert qu'à l'affichage « 2/5 ».
 */
function etapeCourante(evenement) {
  const etapes = (evenement && Array.isArray(evenement.etapes)) ? evenement.etapes : [];
  return etapes.length ? etapes[etapes.length - 1] : null;
}

/**
 * La carte d'où part l'étape courante.
 *
 * Le dernier drapeau posé — bon ou mauvais, le personnage y est allé — ou, sur
 * la première étape, la carte de départ que l'événement porte.
 *
 * Surtout PAS la position courante du joueur : entre le drapeau et maintenant
 * il a pu marcher, et l'indice se résoudrait alors depuis un endroit qui n'a
 * jamais servi de point de départ.
 */
function origineDe(evenement) {
  const drapeaux = (evenement && Array.isArray(evenement.drapeaux)) ? evenement.drapeaux : [];
  for (let i = drapeaux.length - 1; i >= 0; i--) {
    if (Number.isInteger(drapeaux[i] && drapeaux[i].mapId)) return drapeaux[i].mapId;
  }
  return Number.isInteger(evenement && evenement.depart) ? evenement.depart : null;
}

// Plafond de sauts. Une étape de chasse ne traverse jamais vingt cartes : un
// itinéraire plus long signale une cible mal résolue, pas un long voyage. Le
// même plafond bornait la recherche du temps de la chasse automatique.
const CARTES_MAX = 20;

/**
 * Combien de cartes jusqu'à la cible, ou null.
 *
 * Le graphe décide, pas les coordonnées : sur les 25048 transitions cardinales
 * du monde, un millier ne bougent pas d'une case en x/y (intérieurs,
 * changements de niveau) ou décalent en diagonale. Un `|Δx| + |Δy|` s'y trompe,
 * et l'overlay afficherait un chiffre faux — pire qu'un chiffre absent, parce
 * que le joueur y croirait.
 */
function cartesJusqua(monde, depuis, vers) {
  if (!monde || typeof monde.itineraire !== 'function') return null;
  if (!Number.isInteger(depuis) || !Number.isInteger(vers)) return null;
  const chemin = monde.itineraire(depuis, vers, CARTES_MAX);
  return Array.isArray(chemin) ? chemin.length : null;
}

module.exports.cartesJusqua = cartesJusqua;
module.exports.etapeCourante = etapeCourante;
module.exports.origineDe = origineDe;
module.exports.CARTES_MAX = CARTES_MAX;
