'use strict';

/**
 * chasse-protocol.js — les messages de la chasse au trésor. Pur, aucune I/O.
 *
 * Une chasse est une suite d'étapes : le joueur reçoit un indice (« va vers le
 * sud, cherche un panneau »), traverse des cartes, pose un drapeau quand il
 * pense être arrivé, et creuse à la dernière étape.
 *
 * ═══ Ce qu'on sait, et d'où ══════════════════════════════════════════════
 *
 * La première version de ce module ne savait rien : elle attendait qu'une
 * capture révèle la structure, et refusait d'agir en attendant. Ce n'est plus
 * nécessaire. Le schéma protobuf complet du build est là — voir
 * `dofus-schema.js` — et il donne les trois messages, champ par champ :
 *
 *     hhv  TreasureHuntFlagRequest  { hgi questType = 1; int32 index = 2; }
 *     hgj  TreasureHuntDigRequest   { hgi questType = 1; }
 *     hhf  TreasureHuntEvent        { … drapeaux = 5; questType = 9; étapes = 10 }
 *
 * Les noms obfusqués viennent de `dofus-noms.js`, qui les tient d'une lecture
 * du binaire de `krm35/dofus-multi` : son code appelle littéralement
 * `send("TreasureHuntFlagRequest", { flyz, flza })`, et ces deux champs sont
 * exactement ceux de `hhv`. Deux sources indépendantes concordent donc.
 *
 * Correction d'une conclusion antérieure : `flza` et `fluj` avaient été
 * écartés ici comme « jetons d'un pool séquentiel sans rapport ». C'était
 * faux. Ce sont bien les champs — `flza` l'index du drapeau, `fluj` le type de
 * quête de la fouille — et le schéma le confirme ligne pour ligne.
 *
 * ═══ Ce qui reste incertain ══════════════════════════════════════════════
 *
 * Le schéma donne la FORME, pas le SENS. Les cinq variantes d'étape sont
 * distinguées ici par leur structure, et l'étiquette posée sur chacune est une
 * lecture, pas une certitude : la variante vide est presque sûrement la
 * fouille, celle qui ne porte qu'un enum le combat, celles qui portent une
 * direction les déplacements. `genre` dit l'étiquette, `variante` dit le champ
 * réel — de quoi corriger sans redécoder si l'une de ces lectures est fausse.
 *
 * ═══ Ce module ne construit rien ═════════════════════════════════════════
 *
 * Il a su fabriquer le drapeau et la fouille, du temps où STAKK chassait tout
 * seul. Ces trois constructeurs sont partis avec l'automatisation : l'overlay
 * observe et conseille, le joueur joue. Ce qu'on ne peut pas fabriquer, on ne
 * peut pas l'envoyer par mégarde — c'est la garantie la moins chère à tenir.
 *
 * ═══ Durée de vie ════════════════════════════════════════════════════════
 *
 * Tout ceci décrit UN build. Au patch suivant `hhf` désignera autre chose, et
 * la lecture rendrait des champs justes rattachés au mauvais message. D'où le
 * refus net : sans dictionnaire à jour, aucun type par défaut, donc aucune
 * lecture — l'overlay affiche « protocole non reconnu » plutôt qu'une
 * direction inventée.
 */

const DIRECTIONS = ['est', 'sud-est', 'sud', 'sud-ouest', 'ouest', 'nord-ouest', 'nord', 'nord-est'];

module.exports = function createChasseProtocol(deps) {
  deps = deps || {};

  const schema = deps.schema === null ? null : (deps.schema || (() => {
    try { return require('./dofus-schema')(); } catch { return null; }
  })());

  const noms = deps.noms === null ? null : (deps.noms || (() => {
    try { return require('./dofus-noms')({ schema }); } catch { return null; }
  })());

  const createProtocolLearn = deps.createProtocolLearn === null
    ? null
    : (deps.createProtocolLearn || (() => {
        try { return require('./protocol-learn'); } catch { return null; }
      })());
  if (typeof createProtocolLearn !== 'function') {
    throw new Error('chasse-protocol: socle protocol-learn indisponible');
  }
  const learn = createProtocolLearn();

  // Les types viennent du dictionnaire, et SEULEMENT s'il décrit le schéma
  // chargé. Un dictionnaire périmé pointerait sur des messages devenus autre
  // chose : mieux vaut se déclarer aveugle que poser un drapeau au hasard.
  const parDefaut = (noms && noms.estAJour())
    ? {
        drapeau: noms.nom('TreasureHuntFlagRequest'),
        fouille: noms.nom('TreasureHuntDigRequest'),
        etape: noms.nom('TreasureHuntEvent'),
        demande: noms.nom('TreasureHuntStateRequest'),
      }
    : { drapeau: null, fouille: null, etape: null, demande: null };

  // Injectables : de quoi corriger un nom sans republier le module, le temps
  // que le dictionnaire soit régénéré après un patch.
  const types = Object.assign({}, parDefaut, deps.types || {});

  const utilisable = () => !!(schema && types.etape && schema.estConnu(types.etape));

  // ─── Lecture de l'état d'une chasse ──────────────────────────────────────

  /**
   * Le type porteur des étapes, déduit de la forme de l'événement.
   *
   * L'événement de chasse a deux champs répétés de sous-messages : les étapes
   * et les drapeaux. Les étapes sont un `oneof` — tous leurs champs sont
   * eux-mêmes des sous-messages — tandis qu'un drapeau porte un enum et un
   * entier. Ce critère les sépare sans nommer ni `hgx` ni `hha`.
   */
  let typeEtape;
  function typeDesEtapes() {
    if (typeEtape !== undefined) return typeEtape;
    typeEtape = null;
    const champs = schema.champsDe(types.etape) || {};
    for (const c of Object.values(champs)) {
      if (!c.r) continue;
      const sous = schema.champsDe(c.t);
      if (!sous || !Object.keys(sous).length) continue;
      if (Object.values(sous).every(s => !!schema.champsDe(s.t))) { typeEtape = c.t; break; }
    }
    return typeEtape;
  }

  /**
   * Les cinq variantes d'étape, reconnues à leur forme.
   *
   * L'ordre du `oneof` de `hgx` est fixe (1 à 5) ; ce sont les étiquettes qui
   * sont interprétées. Le champ direction est repéré par son type — l'enum des
   * huit directions Dofus — et non par sa position, qui bouge d'un build à
   * l'autre.
   */
  function lireVariante(etape) {
    if (!etape || typeof etape !== 'object') return null;
    const champsX = schema.champsDe(typeDesEtapes()) || {};
    for (const num of Object.keys(champsX).map(Number).sort((a, b) => a - b)) {
      const branche = champsX[num];
      const corps = etape[branche.n];
      if (corps === undefined || corps === null) continue;

      const champs = schema.champsDe(branche.t) || {};
      const nbChamps = Object.keys(champs).length;
      // La direction se repère à son TYPE — l'enum partagé par les variantes
      // de déplacement — et non à sa position, qui bouge d'un build à l'autre.
      let direction = null, autres = [];
      for (const c of Object.values(champs)) {
        const v = typeof corps === 'object' ? corps[c.n] : undefined;
        if (direction === null && estEnumDirection(c.t)) direction = (v === undefined ? 0 : v);
        else if (v !== undefined) autres.push(v);
      }

      // Il n'y a que trois genres, et le nombre attaché à une étape N'EST PAS
      // un nombre de cartes.
      //
      // C'est l'erreur qui a fait abandonner la chasse à la seconde où on
      // l'armait : lu comme un compte, `940` envoyait le moteur chercher une
      // carte à 940 pas de là. Les coordonnées l'infirment sans appel — une
      // étape portant `965` a fait passer le personnage de [3,22] à [3,17],
      // soit CINQ cartes. Le nombre est un identifiant d'indice, et la
      // distance n'est pas donnée : c'est au serveur de valider.
      //
      // Les deux variantes directionnelles diffèrent sans doute par le type
      // de cible — point d'intérêt ou indice — mais elles se parcourent de la
      // même façon, donc on ne les sépare pas ici. `variante` garde la trace.
      let genre;
      if (nbChamps === 0) genre = 'fouille';          // aucune donnée : creuser
      else if (direction === null) genre = 'combat';  // pas de direction : se battre
      else genre = 'indice';                          // aller vers une cible

      return {
        genre,
        variante: branche.n,
        direction,
        directionNom: direction === null ? null : (DIRECTIONS[direction] || null),
        indice: autres.length ? autres[0] : null,
        parametres: autres,
        brut: corps,
      };
    }
    return null;
  }

  /**
   * Le type de l'enum des directions, déduit du schéma.
   *
   * Les variantes de déplacement portent toutes la même direction ; celle du
   * combat porte un enum qui lui est propre. L'enum le PLUS PARTAGÉ entre les
   * variantes est donc la direction. Aucun nom en dur : un patch qui rebat
   * `lbo` ne casse rien.
   */
  let typeDirection;
  function directionDeLaGrappe() {
    if (typeDirection !== undefined) return typeDirection;
    const champsX = schema.champsDe(typeDesEtapes());
    if (!champsX) return (typeDirection = null);
    const compte = new Map();
    for (const branche of Object.values(champsX)) {
      for (const c of Object.values(schema.champsDe(branche.t) || {})) {
        if (schema.estEnum(c.t)) compte.set(c.t, (compte.get(c.t) || 0) + 1);
      }
    }
    let gagnant = null, max = 0;
    for (const [t, n] of compte) if (n > max) { gagnant = t; max = n; }
    // Un enum présent dans une seule variante ne prouve rien : c'est peut-être
    // celui du combat. On exige qu'il soit partagé.
    return (typeDirection = max >= 2 ? gagnant : null);
  }

  const estEnumDirection = (type) => type === directionDeLaGrappe();

  /**
   * Lit l'état d'une chasse : le type de quête, les drapeaux posés, les étapes.
   *
   * Accepte aussi bien le corps du message que son enveloppe `Any`. Rend null
   * si le protocole n'est pas utilisable ou si le paquet n'est pas une chasse —
   * mieux vaut l'absence qu'une lecture inventée qui ferait poser un drapeau
   * au hasard.
   */
  // Compteurs de diagnostic.
  //
  // Ils ne coûtent rien — `lireEtape` extrait déjà l'enveloppe de chaque
  // paquet — et ils tranchent la seule question qu'on se pose quand l'overlay
  // reste vide : le message de chasse n'arrive pas, ou il arrive et n'est pas
  // lu ? Sans eux les deux cas se ressemblent, et on en est réduit à supposer.
  const compteurs = { paquets: 0, enveloppes: 0, chasse: 0, lues: 0 };
  const diagnostic = () => Object.assign({}, compteurs);

  function lireEtape(buf) {
    if (!buf || !buf.length || !utilisable()) return null;
    compteurs.paquets++;

    let corps = buf;
    const enveloppe = essayerAny(buf);
    if (enveloppe) {
      compteurs.enveloppes++;
      if (enveloppe.nom !== types.etape) return null;
      compteurs.chasse++;
      corps = enveloppe.brut;
    } else if (buf.includes(Buffer.from(schema.PREFIXE_TYPE_URL, 'latin1'))) {
      // Un type_url présent mais illisible : le paquet est cadré autrement que
      // prévu. Le décoder comme un corps nu inventerait des étapes.
      return null;
    }

    const decode = schema.decoder(types.etape, corps);
    if (!decode) return null;

    const champs = schema.champsDe(types.etape);
    const drapeaux = [], etapes = [];
    const scalaires = {};
    let questType = null, depart = null;

    // Les étapes et les drapeaux sont les deux champs RÉPÉTÉS porteurs de
    // sous-messages ; on les sépare par leur type, pas par leur numéro. Le
    // type de quête est l'enum simple — celui que la requête de drapeau
    // attend en retour.
    for (const c of Object.values(champs)) {
      const v = decode[c.n];
      if (v === undefined) continue;
      if (!c.r) {
        if (typeof v === 'number') scalaires[c.n] = v;
        if (questType === null && schema.estEnum(c.t)) questType = v;
        // La carte de DÉPART de la chasse. C'est le seul scalaire 64 bits de
        // l'événement, et sa valeur est bien une carte : relevée à 88085249,
        // elle tombe en [10,22] — exactement le « Départ [10,22] » que le jeu
        // affiche. Elle sert d'origine à la première étape, quand aucun
        // drapeau n'a encore été posé ; la déduire de la position du
        // personnage supposait qu'il n'ait pas bougé depuis.
        else if (depart === null && (c.t === 'int64' || c.t === 'uint64')) depart = v;
        continue;
      }
      if (!Array.isArray(v)) continue;
      if (c.t === typeDesEtapes()) {
        for (const e of v) { const l = lireVariante(e); if (l) etapes.push(l); }
      } else if (schema.champsDe(c.t)) {
        for (const d of v) drapeaux.push(lireDrapeau(c.t, d));
      }
    }

    const compteur = lireCompteur(scalaires, champs);
    compteurs.lues++;
    return {
      questType, depart, drapeaux, etapes, scalaires,
      etapeNum: compteur.num, etapesTotal: compteur.total,
      derniereEtape: compteur.total !== null && compteur.num + 1 >= compteur.total,
      brut: decode,
    };
  }

  /**
   * Le compteur d'étapes de la chasse — « ÉTAPE 2/5 » dans le jeu.
   *
   * À ne pas confondre avec la liste d'indices : celle-ci décrit la seule étape
   * EN COURS, et c'est en la prenant pour la progression globale que l'onglet
   * a pu afficher « Étape 5/5 » alors que la chasse n'en était qu'à sa
   * deuxième.
   *
   * Aucun nom n'est écrit en dur. Le total est repéré parce qu'il est porté
   * DEUX FOIS — relevé en jeu, deux champs valent 5 pour une chasse de cinq
   * étapes — et le numéro courant est le plus petit champ qui lui est
   * inférieur. Vérifié sur deux relevés : au premier, aucun champ ne portait
   * l'index (donc 0, et le jeu affichait « 1/5 ») ; au second il valait 1, et
   * la carte de départ avait changé d'étape.
   *
   * Rend `{ num: 0, total: null }` quand la forme ne s'y prête pas : le
   * compteur disparaît de l'affichage plutôt que de mentir.
   */
  function lireCompteur(scalaires, champs) {
    if (!champs) return { num: 0, total: null };

    // Les entiers 32 bits SIMPLES du message, dans l'ordre de leurs numéros de
    // champ. On part de ce que le schéma DÉCLARE, pas de ce que le paquet
    // porte : un index à 0 n'est pas émis en proto3, et se fier aux seuls
    // champs présents faisait alors élire « essais restants » à sa place —
    // « ÉTAPE 1/5 » s'affichait 5/5.
    const declares = Object.keys(champs).map(Number).sort((a, b) => a - b)
      .map(n => champs[n])
      .filter(c => !c.r && /^u?int32$/.test(c.t))
      .map(c => ({ nom: c.n, valeur: scalaires[c.n] === undefined ? 0 : scalaires[c.n] }));
    if (!declares.length) return { num: 0, total: null };

    // Le total est porté DEUX FOIS — relevé en jeu, deux champs valent 5 pour
    // une chasse de cinq étapes.
    const compte = new Map();
    for (const d of declares) if (d.valeur > 0) compte.set(d.valeur, (compte.get(d.valeur) || 0) + 1);
    let total = null;
    for (const [v, n] of compte) if (n >= 2 && (total === null || v > total)) total = v;
    if (total === null) return { num: 0, total: null };

    // Le numéro d'étape : le premier entier du message qui ne soit pas le
    // total. Les compteurs qui suivent — essais restants et consorts —
    // viennent après lui dans l'ordre des champs.
    const num = declares.find(d => d.valeur !== total);
    return { num: num ? num.valeur : 0, total };
  }

  // Un drapeau porte son état et la carte visée : l'état est l'enum, la carte
  // le grand entier. Repérés par leur type, pas par leur numéro de champ.
  function lireDrapeau(type, valeur) {
    const champs = schema.champsDe(type) || {};
    let etat = null, mapId = null;
    for (const c of Object.values(champs)) {
      const v = valeur[c.n];
      if (v === undefined) continue;
      if (c.t === 'int64' || c.t === 'uint64') mapId = v;
      else if (etat === null) etat = v;
    }
    // Un drapeau POSÉ n'est pas un drapeau VALIDÉ. Le serveur l'inscrit dès
    // qu'on le pose, sans état, puis y met 1 s'il était bon — et le retire
    // purement et simplement s'il était mauvais. Confondre les deux faisait
    // cocher l'indice au premier pas, et surtout faisait croire au moteur que
    // l'étape suivante avait commencé alors que la réponse n'était pas venue.
    //
    // Seul l'état 1 a été observé pour « validé ». L'enum en compte trois :
    // toute autre valeur est traitée comme non validée, ce qui fait attendre
    // plutôt que sauter une étape.
    return { etat, valide: etat === 1, mapId, brut: valeur };
  }

  // Le paquet arrive avec son cadre : on ne le décode pas à plat, on en
  // extrait l'`Any`. Sans ce détour, le type_url se lisait comme le premier
  // champ du message et une récolte passait pour un événement de chasse.
  function essayerAny(buf) {
    try { return schema.extraireAny(buf); } catch { return null; }
  }

  // ─── Où est le personnage ────────────────────────────────────────────────

  /**
   * La carte annoncée par le serveur, lue sur le MESSAGE, pas sur son contenu.
   *
   * La version précédente reconnaissait une annonce de map à la présence
   * d'éléments interactifs. Ça marche pour la récolte, qui ne s'intéresse
   * qu'aux cartes qui en portent — mais une chasse traverse des cartes vides,
   * et sur celles-là la position n'était jamais mise à jour. Le personnage
   * arrivait, le plugin l'ignorait, et le trajet suivant partait d'une case
   * inconnue.
   *
   * On identifie donc le message par son NOM, et on lit `map_id` — qu'Ankama a
   * laissé en clair. `MapCurrentEvent` sert de second porteur : il ne donne que
   * la carte, ce qui suffit à savoir qu'on a changé d'endroit.
   *
   * Rend `{ mapId }` ou null. La case, elle, reste du ressort de l'appelant :
   * elle vit dans un autre message.
   */
  function lireCarteAnnoncee(buf) {
    if (!buf || !buf.length || !schema || !noms || !noms.estAJour()) return null;
    let any;
    try { any = schema.extraireAny(buf); } catch { return null; }
    if (!any || !any.contenu) return null;

    for (const sens of ['MapComplementaryInformationEvent', 'MapCurrentEvent']) {
      if (any.nom !== noms.nom(sens)) continue;
      const champs = schema.champsDe(any.nom) || {};
      // La carte : le champ nommé `map_id` s'il existe, sinon l'unique entier
      // 64 bits du message — c'est ce que porte MapCurrentEvent.
      for (const c of Object.values(champs)) {
        if (c.r) continue;
        const v = any.contenu[c.n];
        if (!Number.isFinite(v)) continue;
        if (c.n === 'map_id' || c.t === 'int64' || c.t === 'uint64') return { mapId: v, message: sens };
      }
    }
    return null;
  }

  /**
   * Ce paquet d'acteurs contient-il le PNJ `npcId` ?
   *
   * Les phorreurs sont des PNJ, et leur identifiant d'indice EST leur
   * identifiant de PNJ — vérifié : 2673 « Phorreur méfiant », 2674 « Phorreur
   * rusé », 2675 « Phorreur espiègle », exactement les indices d'une chasse
   * réelle. Contrairement aux points d'intérêt fixes, ils se déplacent : aucune
   * base ne peut dire où ils sont, il faut les voir.
   *
   * Le sous-arbre décrivant un acteur est entièrement obfusqué et profond : y
   * repérer LE champ du PNJ demanderait une capture dédiée. On décode donc
   * l'acteur avec le schéma — ça, on sait le faire exactement — puis on
   * cherche la valeur dans tout l'arbre.
   *
   * C'est une heuristique, et elle est assumée : un identifiant peut apparaître
   * ailleurs (un « look », une cellule). Elle n'est consultée que si l'indice
   * courant est DÉJÀ confirmé phorreur par la base des PNJ, ce qui écarte les
   * collisions sur une carte quelconque ; et depuis que la chasse observe au
   * lieu d'agir, un faux positif coûte un joueur qui regarde autour de lui pour
   * rien — pas un paquet envoyé.
   */
  function acteursContiennent(buf, npcId) {
    if (!buf || !buf.length || !Number.isInteger(npcId) || !utilisable() || !noms) return false;
    if (!noms.estAJour()) return false;
    // Deux messages portent la liste d'acteurs, et il faut les deux : `jsn`
    // annonce ceux qui ARRIVENT pendant qu'on est là, `jss` donne ceux qui
    // sont DÉJÀ là quand c'est nous qui arrivons. Le cas courant est le
    // second — n'écouter que le premier laissait invisible un phorreur posté
    // sur la carte avant nous.
    const acceptes = [
      noms.nom('GameRolePlayShowActorsEvent'),
      noms.nom('MapComplementaryInformationEvent'),
    ].filter(Boolean);
    if (!acceptes.length) return false;
    let any;
    try { any = schema.extraireAny(buf); } catch { return false; }
    if (!any || !acceptes.includes(any.nom) || !any.contenu) return false;
    return contient(any.contenu, npcId, 0);
  }

  function contient(noeud, valeur, profondeur) {
    if (profondeur > 12 || noeud === null || noeud === undefined) return false;
    if (typeof noeud === 'number') return noeud === valeur;
    if (Buffer.isBuffer(noeud)) return false;
    if (Array.isArray(noeud)) return noeud.some(v => contient(v, valeur, profondeur + 1));
    if (typeof noeud === 'object') {
      for (const v of Object.values(noeud)) if (contient(v, valeur, profondeur + 1)) return true;
    }
    return false;
  }

  // ─── Les réponses du serveur ─────────────────────────────────────────────

  /**
   * Les messages par lesquels le serveur répond à une action de chasse.
   *
   * Dérivés, pas écrits en dur : ce sont les messages de la grappe de la
   * chasse qui portent un champ nommé `result`. Ils sont trois, et il n'y en a
   * que quatre dans tout le schéma — la grappe suffit donc à les isoler.
   *
   * On ne cherche PAS à savoir lequel est le drapeau et lequel la fouille, ni
   * ce que vaut leur `result` : ces enums ne sont pas nommés, et deviner ce
   * que signifie la valeur 3 serait exactement le genre de supposition qui a
   * déjà coûté cher ici. Ce qu'on en tire est plus modeste et plus sûr : le
   * serveur a parlé. Au moteur de regarder ensuite si l'étape a avancé.
   */
  let cacheReponses;
  function reponses() {
    if (cacheReponses) return cacheReponses;
    cacheReponses = [];
    if (!utilisable() || !noms) return cacheReponses;
    const grappe = new Set();
    for (const t of [types.etape, types.drapeau, types.fouille]) {
      if (t) for (const v of noms.voisinage(t, 14)) grappe.add(v);
    }
    for (const m of grappe) {
      const champs = schema.champsDe(m);
      if (champs && Object.values(champs).some(c => c.n === 'result')) cacheReponses.push(m);
    }
    return cacheReponses;
  }

  /** Ce paquet est-il une réponse du serveur à une action de chasse ? */
  function estReponse(buf) {
    if (!buf || !buf.length || !utilisable()) return false;
    const any = essayerAny(buf);
    return !!any && reponses().includes(any.nom);
  }

  // ─── Reconnaissance ──────────────────────────────────────────────────────

  /** Ce paquet est-il l'un des messages de chasse connus ? */
  function estMessageChasse(buf) {
    if (!buf || !buf.length) return false;
    let n = null;
    if (schema) {
      const any = essayerAny(buf);
      if (any) n = any.nom;
    }
    if (n === null) {
      try { n = learn.typeNameOf(buf); } catch { return false; }
    }
    // `typeNameOf` rend null hors enveloppe Any, et un type non identifié vaut
    // null lui aussi : comparer sans ce garde ferait passer n'importe quel
    // paquet pour un message de chasse — qui servirait alors de modèle.
    if (!n) return false;
    return n === types.drapeau || n === types.fouille || n === types.etape;
  }

  return {
    DIRECTIONS,
    types,
    utilisable,
    lireEtape,
    lireCarteAnnoncee,
    acteursContiennent,
    reponses,
    estReponse,
    estMessageChasse,
    diagnostic,
  };
};
