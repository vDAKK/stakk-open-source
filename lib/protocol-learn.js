'use strict';

/**
 * protocol-learn.js — Socle d'apprentissage de protocole, sans schéma.
 *
 * Les messages de Dofus 3 sont du protobuf dont les noms de types et la
 * disposition des champs changent à chaque build Ankama. Rien n'est donc
 * encodé en dur : on lit la structure telle qu'elle passe sur le fil, et on
 * apprend la forme des paquets depuis le trafic.
 *
 * Ce module ne connaît ni les runes, ni les prix, ni les ressources. Il ne
 * sait que deux choses : parcourir un protobuf sans schéma, et retrouver un
 * champ en s'ancrant sur une valeur déjà connue. Les heuristiques métier
 * vivent chez ses consommateurs (fm-protocol, chasse-protocol).
 *
 * Aucune I/O dans la couche pure : Buffer in → objet out.
 */

module.exports = function createProtocolLearn(deps) {
  deps = deps || {};

  // ─── Varints ─────────────────────────────────────────────────────────────

  const MAX_VARINT_BYTES = 10;

  // Lecture non signée. Renvoie { value, length } ou null si tronqué.
  // `value` est un Number : les uid Dofus dépassent 2^32 mais restent très
  // en dessous de 2^53, donc on accumule en flottant plutôt qu'en OR bit-à-bit
  // (qui wrap à 32 bits et corromprait silencieusement les gros uid).
  function readVarInt(buf, offset) {
    let value = 0;
    let shift = 1;
    for (let i = offset; i < buf.length && i - offset < MAX_VARINT_BYTES; i++) {
      const b = buf[i];
      value += (b & 0x7f) * shift;
      if ((b & 0x80) === 0) return { value, length: i - offset + 1 };
      shift *= 128;
    }
    return null;
  }

  // Nombre d'octets de l'encodage minimal.
  function varIntSize(value) {
    let n = 1, v = Math.floor(value);
    while (v >= 128) { v = Math.floor(v / 128); n++; }
    return n;
  }

  /**
   * Encode `value` sur EXACTEMENT `byteLen` octets. Les octets de bourrage
   * portent le bit de continuation, ce qui reste un varint valide pour tout
   * décodeur protobuf conforme. Permet de substituer un uid par un autre sans
   * décaler un seul octet du paquet.
   */
  function encodeVarIntPadded(value, byteLen) {
    if (!Number.isFinite(value) || value < 0) throw new Error('varint: valeur invalide');
    if (byteLen < 1 || byteLen > MAX_VARINT_BYTES) throw new Error('varint: longueur invalide');
    if (varIntSize(value) > byteLen) {
      throw new Error(`varint: ${value} ne tient pas sur ${byteLen} octet(s)`);
    }
    const out = Buffer.alloc(byteLen);
    let v = Math.floor(value);
    for (let i = 0; i < byteLen; i++) {
      out[i] = (v % 128) | (i === byteLen - 1 ? 0 : 0x80);
      v = Math.floor(v / 128);
    }
    return out;
  }

  // Remplace le varint situé à `offset` (de longueur `byteLen`) par `value`.
  // Retourne un nouveau Buffer de longueur identique.
  function patchVarInt(buf, offset, byteLen, value) {
    if (offset < 0 || offset + byteLen > buf.length) throw new Error('patch: hors limites');
    const out = Buffer.from(buf);
    encodeVarIntPadded(value, byteLen).copy(out, offset);
    return out;
  }

  // ─── Parcours structurel ─────────────────────────────────────────────────

  // Numéro de champ maximal autorisé par protobuf. Sert à écarter les tags
  // fantaisistes qu'un balayage à l'aveugle finit toujours par fabriquer.
  const MAX_FIELD_NUMBER = 536870911;           // 2^29 - 1

  // Énumère les champs varint (wire type 0) plausibles d'un buffer. On ne
  // décode pas l'arbre protobuf complet — impossible sans schéma — mais on
  // repère les couples (tag, varint) bien formés, ce qui suffit pour diffing
  // et recherche d'identifiants.
  //
  // Le TAG EST UN VARINT, et pas un octet. Le lire sur un octet marchait
  // jusqu'au champ 15 et devenait faux ensuite, en silence : pour le champ 16
  // le tag vaut 80 01, l'octet 0x80 passe le test de wire type et 0x80 >> 3
  // rend 16, si bien que le numéro de champ tombait juste PAR COÏNCIDENCE
  // — mais la valeur était lue à partir du 0x01, second octet du tag, et la
  // fonction rendait 1 au lieu de la vraie valeur. Ce n'était donc pas une
  // cécité dont on aurait pu se douter, c'était une lecture fausse et muette,
  // dans la fonction qui sert à l'ancrage de la forgemagie.
  function scanVarIntFields(buf, startAt) {
    const out = [];
    for (let i = startAt || 0; i < buf.length; i++) {
      const tag = readVarInt(buf, i);
      if (!tag) continue;
      if (tag.value % 8 !== 0) continue;         // seulement wire type 0
      const fieldNumber = Math.floor(tag.value / 8);
      if (fieldNumber < 1 || fieldNumber > MAX_FIELD_NUMBER) continue;
      const v = readVarInt(buf, i + tag.length);
      if (!v) continue;
      out.push({
        tagOffset: i,
        tagLength: tag.length,
        fieldNumber,
        wire: 0,
        valueOffset: i + tag.length,
        valueLength: v.length,
        value: v.value,
      });
    }
    return out;
  }

  // ─── Parse structurel ────────────────────────────────────────────────────
  //
  // scanVarIntFields() suffit pour comparer deux paquets de même forme, mais
  // il produit aussi des champs fantômes (un octet AU MILIEU d'un varint peut
  // ressembler à un tag). Pour lire un inventaire il faut la vraie structure :
  // on décode donc séquentiellement, en descendant dans les sous-messages.
  // Un décodage séquentiel est auto-vérifiant — s'il ne tombe pas pile sur la
  // fin de la zone, c'est que l'hypothèse était fausse et on rejette.

  const MAX_DEPTH = 6;

  function parseFields(buf, start, end, depth, out, path, parentId) {
    let i = start;
    while (i < end) {
      const tagInfo = readVarInt(buf, i);
      if (!tagInfo) return false;
      const fieldNumber = Math.floor(tagInfo.value / 8);
      const wire = tagInfo.value % 8;
      if (fieldNumber === 0) return false;
      let p = i + tagInfo.length;

      if (wire === 0) {
        const v = readVarInt(buf, p);
        if (!v) return false;
        out.push({
          fieldNumber, wire, parentId,
          path: path.concat(fieldNumber).join('.'),
          value: v.value, valueOffset: p, valueLength: v.length,
        });
        p += v.length;
      } else if (wire === 2) {
        const l = readVarInt(buf, p);
        if (!l) return false;
        const s = p + l.length, e = s + l.value;
        if (e > end) return false;
        const sub = [];
        const subId = `${path.concat(fieldNumber).join('.')}@${s}`;
        if (l.value > 0 && depth < MAX_DEPTH &&
            parseFields(buf, s, e, depth + 1, sub, path.concat(fieldNumber), subId)) {
          // On garde la BORNE du sous-message : c'est ce qui permet ensuite de
          // dire « ces effets appartiennent à cet objet-là », et pas à l'objet
          // voisin. Sans ça on lit les effets des runes comme s'ils étaient
          // ceux de l'item.
          out.push({
            node: true, fieldNumber, parentId, id: subId, start: s, end: e,
            // Position et taille du préfixe de longueur : indispensables pour
            // réécrire ce message si son contenu change de taille.
            lenOffset: p, lenBytes: l.length, contentLen: l.value,
          });
          out.push(...sub);
        } else {
          out.push({
            fieldNumber, wire, parentId,
            path: path.concat(fieldNumber).join('.'),
            bytesOffset: s, bytesLength: l.value,
          });
        }
        p = e;
      } else if (wire === 1) {
        p += 8;
        if (p > end) return false;
      } else if (wire === 5) {
        p += 4;
        if (p > end) return false;
      } else {
        return false;                     // wire types 3/4 (groupes) : obsolètes
      }
      i = p;
    }
    return i === end;
  }

  /**
   * Découpe un chunk TCP en trames applicatives.
   *
   * Le canal jeu de Dofus 3 est une SUITE de <varint longueur><message
   * protobuf> — vérifié sur capture réelle : 71 chunks sur 77 se décomposent
   * intégralement ainsi, pour 134 messages. Un chunk porte donc souvent
   * plusieurs messages, et un message peut être coupé en fin de chunk.
   *
   * @returns { frames: [{start, length}], complete: bool }
   */
  function splitFrames(buf) {
    const frames = [];
    let i = 0;
    while (i < buf.length) {
      const l = readVarInt(buf, i);
      if (!l || l.value === 0) return { frames, complete: false };
      const start = i + l.length;
      const end = start + l.value;
      if (end > buf.length) return { frames, complete: false };   // coupé par TCP
      // lenOffset/lenBytes servent à réécrire la longueur quand le contenu
      // change de taille (substitution d'un uid plus large, par exemple).
      frames.push({ start, length: l.value, lenOffset: i, lenBytes: l.length });
      i = end;
    }
    return { frames, complete: true };
  }

  /**
   * Décode un chunk du canal jeu en champs protobuf à plat.
   *
   * Trois hypothèses, dans l'ordre : découpage en trames (le vrai format),
   * puis payload à l'offset 2, puis à l'offset 0. Les deux replis couvrent les
   * variantes de cadrage et les paquets fabriqués par les tests. Retourne []
   * si aucune ne donne un décodage complet et cohérent — mieux vaut ne rien
   * lire que lire n'importe quoi.
   */
  function parseStructured(buf) {
    if (!buf || buf.length < 2) return [];

    // On met les hypothèses en concurrence et on garde celle qui explique le
    // PLUS d'octets. Sans cet arbitrage, un premier « cadre » qui se décode
    // par hasard ferait accepter une lecture partielle et le reste du chunk
    // serait perdu en silence — c'est comme ça qu'un inventaire de 2 objets
    // n'en rendait qu'un.
    let best = null, bestCovered = 0;

    const { frames } = splitFrames(buf);
    if (frames.length) {
      const out = [];
      let covered = 0;
      for (const f of frames) {
        const sub = [];
        // La trame elle-même est un message englobant : sa longueur devra
        // être recalculée si son contenu change de taille.
        sub.push({
          node: true, frame: true, parentId: null, id: `f@${f.start}`,
          start: f.start, end: f.start + f.length,
          lenOffset: f.lenOffset, lenBytes: f.lenBytes, contentLen: f.length,
        });
        // Une trame illisible n'invalide pas les autres : sur un chunk qui en
        // porte plusieurs, on garde ce qui est exploitable.
        if (parseFields(buf, f.start, f.start + f.length, 0, sub, [], `f@${f.start}`)) {
          out.push(...sub);
          covered += f.length;
        }
      }
      if (covered > bestCovered) { best = out; bestCovered = covered; }
    }

    for (const start of [2, 0]) {
      const out = [];
      if (parseFields(buf, start, buf.length, 0, out, [], `root@${start}`)) {
        const covered = buf.length - start;
        if (covered > bestCovered) { best = out; bestCovered = covered; }
      }
    }
    return best || [];
  }

  /**
   * Remplace un varint par une valeur qui ne tient PAS dans la place initiale.
   *
   * Cas réel : le gabarit appris pendant la calibration portait un uid sur 4
   * octets, mais l'objet visé en demande 6. On ne peut plus se contenter d'un
   * encodage rembourré : il faut allonger le varint ET recalculer, de proche
   * en proche, la longueur de tous les messages qui l'englobent — y compris
   * la trame elle-même. Un seul préfixe oublié et le serveur reçoit une bouse.
   */
  function replaceVarIntGrow(buf, offset, oldLen, value) {
    const bytes = encodeVarIntPadded(value, varIntSize(value));
    if (bytes.length === oldLen) return patchVarInt(buf, offset, oldLen, value);

    const fields = parseStructured(buf);
    const ancestors = fields
      .filter(f => f.node && f.start <= offset && offset < f.end)
      .sort((a, b) => (a.end - a.start) - (b.end - b.start));   // du plus interne au plus externe
    if (!ancestors.length) {
      throw new Error('impossible d\'allonger le varint : structure du gabarit illisible');
    }

    // Édition du varint lui-même, puis des longueurs englobantes. Le delta
    // s'accumule vers l'extérieur : agrandir une longueur interne agrandit
    // aussi le contenu de celle qui la contient.
    const edits = [{ offset, oldLen, bytes }];
    let delta = bytes.length - oldLen;
    for (const node of ancestors) {
      const newLen = node.contentLen + delta;
      const newBytes = encodeVarIntPadded(newLen, varIntSize(newLen));
      edits.push({ offset: node.lenOffset, oldLen: node.lenBytes, bytes: newBytes });
      delta += newBytes.length - node.lenBytes;
    }

    edits.sort((a, b) => a.offset - b.offset);
    const parts = [];
    let cursor = 0;
    for (const e of edits) {
      if (e.offset < cursor) throw new Error('éditions du gabarit qui se chevauchent');
      parts.push(buf.subarray(cursor, e.offset), e.bytes);
      cursor = e.offset + e.oldLen;
    }
    parts.push(buf.subarray(cursor));
    return Buffer.concat(parts);
  }

  // Marqueur d'enveloppe Any, stable d'un build Dofus à l'autre (seul le code
  // de 3 lettres qui suit change).
  const TYPE_URL_MARKER = Buffer.from('type.ankama.com/', 'latin1');

  // Nom de type porté par l'enveloppe Any, ou null si le paquet n'en a pas.
  //
  // La chaîne est un champ protobuf longueur-préfixé : `0a <len>
  // "type.ankama.com/XXX"`. C'est cette longueur qui borne le nom, pas le jeu
  // de caractères. S'arrêter au premier octet non imprimable marche presque
  // toujours — et échoue silencieusement quand la payload qui suit commence
  // dans l'ASCII : le nom lu devient « lva) », ne correspond à aucun type
  // connu, et le paquet est ignoré sans que rien ne le signale.
  function typeNameOf(buf) {
    const at = buf.indexOf(TYPE_URL_MARKER);
    if (at === -1) return null;
    const debut = at + TYPE_URL_MARKER.length;

    // Le préfixe précède le marqueur. Sa taille varie : `13` tient sur un
    // octet, une URL plus longue en prendrait deux.
    for (let tete = at - 1; tete >= at - 3 && tete >= 0; tete--) {
      const prefixe = readVarInt(buf, tete);
      if (!prefixe) continue;
      if (tete + prefixe.length !== at) continue;
      if (prefixe.value < TYPE_URL_MARKER.length) continue;
      // La longueur couvre le marqueur ET le nom : le nom finit donc à
      // `at + longueur`.
      const fin = at + prefixe.value;
      if (fin > buf.length) continue;
      // Le tag du champ doit précéder la longueur : `0a` = champ 1, bytes.
      if (tete > 0 && buf[tete - 1] !== 0x0a) continue;
      return buf.toString('latin1', debut, fin) || null;
    }

    // Préfixe illisible (paquet tronqué, cadrage inattendu) : on retombe sur
    // la lecture par caractères plutôt que de ne rien rendre du tout.
    let fin = debut;
    while (fin < buf.length && buf[fin] >= 0x21 && buf[fin] <= 0x7e) fin++;
    return buf.toString('latin1', debut, fin) || null;
  }

  // ─── Profil intégré ──────────────────────────────────────────────────────
  //
  // Forme observée sur le vrai canal (Dofus 3, juillet 2026) :
  //   <varint longueur>
  //   1a <len>                       champ 3 = enveloppe
  //     08 ff…01                     champ 1 = -1 (pas d'identifiant)
  //     12 <len>                     champ 2 = Any
  //       0a 13 "type.ankama.com/XXX"
  //       12 <len>                   valeur du Any
  //         pose  : 08 01  10 <uid>  20 01     (slot, objet, quantité)
  //         forge : 08 01                      (slot)
  const NO_ID = Buffer.from('ffffffffffffffffff01', 'hex');   // -1 sur 64 bits

  // Disposition de l'enveloppe observée sur ce build :
  //   <longueur> field2 { field1 = Any(type, payload), field2 = -1 }
  // Le build de juillet utilisait field3 { field1 = -1, field2 = Any } — d'où
  // l'importance de ne jamais figer cette structure côté lecture. Ces deux
  // constantes appartiennent au socle : c'est lui qui construit l'enveloppe
  // (anyEnvelope), fm-protocol.js n'en garde plus de copie.
  const ENVELOPE_FIELD = 2;

  function anyEnvelope(code, value) {
    const any = Buffer.concat([
      lenPrefixed(1, Buffer.from(`type.ankama.com/${code}`, 'latin1')),
      lenPrefixed(2, value),
    ]);
    const body = Buffer.concat([
      lenPrefixed(1, any),
      Buffer.from([0x10]), NO_ID,
    ]);
    const wrapped = lenPrefixed(ENVELOPE_FIELD, body);
    return Buffer.concat([encodeVarIntPadded(wrapped.length, varIntSize(wrapped.length)), wrapped]);
  }

  /**
   * Tag protobuf : (numéroDeChamp << 3) | wireType, encodé COMME UN VARINT.
   *
   * L'écrire sur un seul octet ne marche que jusqu'au champ 15 : au-delà le
   * tag dépasse 127 et l'octet débordait en silence, produisant un buffer que
   * plus rien ne savait relire — les lecteurs rendaient simplement une liste
   * vide, sans la moindre erreur. Or Ankama réobfusque les numéros de champ à
   * chaque build et dépasse couramment 15.
   *
   * Multiplication et non décalage : `fieldNumber << 3` repasse en entier
   * 32 bits signé et corromprait les numéros de champ les plus hauts que
   * protobuf autorise (jusqu'à 2^29-1).
   */
  function fieldTag(fieldNumber, wireType) {
    if (!Number.isInteger(fieldNumber) || fieldNumber < 1) {
      throw new Error('tag: numéro de champ invalide');
    }
    const tag = fieldNumber * 8 + wireType;
    return encodeVarIntPadded(tag, varIntSize(tag));
  }

  function lenPrefixed(fieldNumber, payload) {
    const len = encodeVarIntPadded(payload.length, varIntSize(payload.length));
    return Buffer.concat([fieldTag(fieldNumber, 2), len, payload]);
  }

  function varIntField(fieldNumber, value) {
    return Buffer.concat([
      fieldTag(fieldNumber, 0),
      encodeVarIntPadded(value, varIntSize(value)),
    ]);
  }

  // ─── Ancrage sortant ─────────────────────────────────────────────────────
  //
  // Un paquet client→serveur qui transporte une valeur que STAKK connaît déjà
  // (identifiant d'objet, de cellule…) désigne de lui-même l'action qui la
  // porte — quel que soit le nom du type, la position du champ ou la forme de
  // l'enveloppe. C'est ce qui rend l'apprentissage insensible aux MAJ.

  const ANCHOR_MIN_BYTES = 3;   // un identifiant est grand : ça écarte slot et quantité
  const ANCHOR_MIN_VALUE = 1e5;

  function findAnchoredTemplate(buf, anchors, opts) {
    opts = opts || {};
    if (!buf || !buf.length) return null;
    const requireTypeUrl = opts.requireTypeUrl !== false;
    if (requireTypeUrl && buf.indexOf(TYPE_URL_MARKER) === -1) return null;
    const set = anchors instanceof Set ? anchors : new Set(anchors || []);
    if (!set.size) return null;

    const minBytes = opts.minBytes || ANCHOR_MIN_BYTES;
    const minValue = opts.minValue || ANCHOR_MIN_VALUE;

    for (const f of scanVarIntFields(buf)) {
      if (f.valueLength < minBytes || f.value < minValue) continue;
      if (!set.has(f.value)) continue;
      return {
        template: buf.toString('hex'),
        uidOffset: f.valueOffset,
        uidLength: f.valueLength,
        uidFieldNumber: f.fieldNumber,
        typeName: typeNameOf(buf),
        anchor: f.value,
      };
    }
    return null;
  }

  // ─── Appariement action → confirmation ───────────────────────────────────
  //
  // Une action de jeu se joue en deux paquets : celui qui désigne la cible
  // (rune, ressource) et la commande qui la valide. Le second se reconnaît en
  // creux — même canal, type différent, aucune valeur connue à bord.

  const PAIR_WINDOW_MS = 20000;

  function findFollowUpCommand(buf, excludeTypeName, anchors) {
    if (!buf || !buf.length) return null;
    if (buf.indexOf(TYPE_URL_MARKER) === -1) return null;
    const name = typeNameOf(buf);
    if (!name || (excludeTypeName && name === excludeTypeName)) return null;
    const set = anchors instanceof Set ? anchors : new Set(anchors || []);
    for (const f of scanVarIntFields(buf)) {
      // Porte une valeur connue : c'est une action, pas une confirmation.
      if (f.valueLength >= ANCHOR_MIN_BYTES && set.has(f.value)) return null;
    }
    return { packet: buf.toString('hex'), typeName: name, confidence: 'high' };
  }

  function createPairLearner(opts) {
    opts = opts || {};
    const windowMs = opts.windowMs || PAIR_WINDOW_MS;
    const now = opts.now || Date.now;
    let pending = null;

    function feed(buf, anchors) {
      const move = findAnchoredTemplate(buf, anchors);
      // Une nouvelle action remplace la précédente : c'est toujours la plus
      // récente que la confirmation qui suit valide.
      if (move) { pending = { move, at: now() }; return null; }
      if (!pending || now() - pending.at > windowMs) { pending = null; return null; }
      const ready = findFollowUpCommand(buf, pending.move.typeName, anchors);
      if (!ready) return null;
      const pair = { move: pending.move, ready };
      pending = null;
      return pair;
    }

    return { feed, reset: () => { pending = null; } };
  }

  // ─── Ancrage entrant : élection de champs ────────────────────────────────
  //
  // On ne sait pas quel numéro de champ porte quoi, mais on connaît des
  // VALEURS (gid d'items, par exemple). Chaque paquet fournit des candidats ;
  // on n'élit qu'au quorum de preuves, et jamais en cas d'égalité : deux
  // dispositions également étayées, c'est qu'on ne sait pas — et retenir la
  // mauvaise coûte plus cher que d'attendre la preuve suivante.

  function createFieldElector(opts) {
    opts = opts || {};
    const roles = opts.roles || [];
    const primary = opts.primary || roles.slice(0, 2);
    const minPrimary = opts.minPrimary || 3;
    const minPackets = opts.minPackets || 2;
    const maxMismatch = opts.maxMismatch || 3;
    const secondary = roles.filter(r => !primary.includes(r));
    // Filtre de plausibilité fourni par le consommateur : le socle compte des
    // preuves, lui seul sait ce qu'un mapping veut dire. Il s'applique DANS le
    // scrutin, pas après. Après le verrouillage, un mapping que le consommateur
    // rejette à chaque lecture serait quand même livré aux lecteurs et persisté,
    // sans qu'aucune trace d'apprentissage soit émise. Mais entre l'élection et
    // le verrouillage ce n'est pas mieux : rien ne retire une paire de
    // l'accumulation — seul l'abandon d'un mapping VERROUILLÉ vide `pairs` —
    // donc une paire refusée qui a atteint le quorum resterait au scrutin à
    // demeure, stérile seule et bloquante à deux par la règle de non-arbitrage.
    // La disposition saine qui arrive ensuite ne serait plus jamais élue.
    // Rendre null vaut donc « celle-là n'est pas une candidate ».
    //
    // Contrat : normalize peut refuser un mapping en rendant null, ou ajuster
    // un rôle SECONDAIRE. Il ne doit jamais changer un numéro de champ
    // PRIMAIRE — la vérification de concordance compare les candidats au
    // mapping retenu sur ces champs-là, et ne les y retrouverait jamais :
    // verrouillage puis abandon, sans fin.
    const normalize = typeof opts.normalize === 'function' ? opts.normalize : (m => m);

    let map = (opts.map && normalize(opts.map)) || null;
    let mismatches = 0;
    // Concordance du DERNIER observe() avec un mapping déjà retenu : true/false
    // quand un mapping était actif au moment de l'appel, null sinon (phase
    // d'accumulation, ou aucun candidat). Un consommateur qui doit distinguer
    // « rien n'a changé parce que ça concorde » de « rien n'a changé parce
    // qu'on est sous le seuil d'abandon » n'a que ça pour le savoir — observe()
    // rend `null` dans les deux cas.
    let lastConcordant = null;
    // clé = numéros de champ des rôles primaires joints par ':'
    const pairs = new Map();

    function bucket(store, key) {
      let b = store.get(key);
      if (!b) store.set(key, b = { keys: new Set(), packets: new Set(), values: new Set(), sub: new Map() });
      return b;
    }
    function enough(b) { return b.keys.size >= minPrimary && b.packets.size >= minPackets; }

    let packetSeq = 0;

    // Mapping décrit par une paire : ses rôles primaires viennent de la clé,
    // ses rôles secondaires d'un second vote interne à la paire.
    function mappingOf(key, p) {
      const fields = key.split(':').map(Number);
      const out = {};
      primary.forEach((role, i) => { out[role] = fields[i]; });

      for (const role of secondary) {
        let cands = [...(p.sub.get(role) || new Map()).entries()].filter(([, e]) => enough(e));
        // Un champ figé sur une seule valeur est plus probablement une
        // position ou un slot qu'une quantité — sauf si aucun ne varie.
        const varying = cands.filter(([, e]) => e.values.size > 1);
        if (varying.length) cands = varying;
        out[role] = cands.length === 1 ? cands[0][0] : null;
      }
      return out;
    }

    function elect() {
      const ready = [...pairs.entries()]
        .filter(([, p]) => enough(p))
        .map(([key, p]) => normalize(mappingOf(key, p)))
        .filter(Boolean);
      if (ready.length !== 1) return null;          // 0 = pas assez, 2+ = égalité
      return ready[0];
    }

    function keyOf(c) { return primary.map(r => c[r].field).join(':'); }
    // Identité d'un objet observé : le DERNIER rôle primaire (par convention,
    // le plus spécifique — l'identifiant d'instance, pas le type). Compter la
    // paire complète surcompterait : un même identifiant revu à côté d'un
    // autre champ de type ferait croire à deux objets distincts là où un seul
    // a été vu.
    function idOf(c) { return c[primary[primary.length - 1]].value; }

    function observe(candidates) {
      if (!candidates || !candidates.length) { lastConcordant = null; return null; }
      packetSeq++;

      if (map) {
        const concordant = candidates.some(c => primary.every(r => c[r].field === map[r]));
        lastConcordant = concordant;
        if (concordant) { mismatches = 0; return null; }
        if (++mismatches < maxMismatch) return null;
        const lost = map;
        map = null; mismatches = 0; pairs.clear();
        return { lost };
      }
      lastConcordant = null;

      for (const c of candidates) {
        const b = bucket(pairs, keyOf(c));
        b.keys.add(idOf(c));
        b.packets.add(packetSeq);
        for (const role of secondary) {
          for (const s of (c[role] || [])) {
            let store = b.sub.get(role);
            if (!store) b.sub.set(role, store = new Map());
            const sb = bucket(store, s.field);
            sb.keys.add(idOf(c));
            sb.packets.add(packetSeq);
            sb.values.add(s.value);
          }
        }
      }

      const elected = elect();
      if (!elected) return null;
      map = elected;
      return { learned: elected };
    }

    return {
      observe,
      get: () => map,
      // Le dernier observe() a-t-il confirmé un mapping déjà retenu ? Sert au
      // consommateur qui doit distinguer une confirmation d'une discordance
      // encore sous le seuil d'abandon — observe() rend `null` dans les deux
      // cas, lui seul les distingue.
      concordant: () => lastConcordant,
      reset: () => { map = null; mismatches = 0; lastConcordant = null; pairs.clear(); },
    };
  }

  // ─── Cycle de vie d'un profil ────────────────────────────────────────────
  //
  // La partie chère n'est pas de trouver le champ, c'est de savoir quand on a
  // le droit de remplacer ce qu'on avait. Un gabarit qui obtient des réponses
  // du serveur est intouchable : sans cette garde, n'importe quel paquet
  // sortant portant un identifiant connu pouvait écraser une pose qui
  // forgeait très bien (vécu le 12/08/2026 — un simple déplacement d'objet).
  //
  // La preuve porte sur le GABARIT et non sur le compte, et elle vit sur
  // disque : sinon un redémarrage rouvrait la porte à l'écrasement alors que
  // le profil, lui, avait bel et bien répondu la veille.

  function createProfileStore(opts) {
    const { fs, path, dir, feature, accountId } = opts;
    const builtin = opts.builtin || (() => null);
    const isEquivalent = opts.isEquivalent || (() => false);
    const log = opts.log || (() => {});
    const file = path.join(dir, `${feature}-protocol-${accountId}.json`);
    const relearnCbs = [];
    let stale = false;

    function readFile() {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch { return null; }
    }

    // Un profil `builtin` sur disque n'est qu'une photo d'un gabarit intégré
    // d'une version passée : le garder masquerait le gabarit courant.
    function learned() {
      const p = readFile();
      return p && p.source !== 'builtin' && p.move ? p : null;
    }

    function get() { return learned() || builtin(); }

    function write(profile) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(profile, null, 2));
    }

    function templateOf(p) { return p && p.move ? p.move.template : null; }

    function isProven() {
      const p = readFile();
      const t = p && p.provenTemplate;
      if (!t) return false;
      return templateOf(get()) === t;
    }

    function markProven() {
      const cur = get();
      const t = templateOf(cur);
      if (!t) return;
      // On repart de ce qui est RÉELLEMENT sur le disque, pas du seul profil
      // « appris » : le consommateur range dans ce fichier des annotations qui
      // ne relèvent pas du cycle de vie (le chemin du reliquat, par exemple), y
      // compris quand le gabarit en place est l'intégré — cas où learned() rend
      // null. Repartir de learned() les effaçait à chaque preuve reposée.
      // Un fichier de source builtin reste ignoré par get() pour la résolution
      // du gabarit : le préserver ici ne masque donc rien.
      //
      // Rien sur disque du tout : on note la preuve à côté d'une copie du
      // profil courant, sinon elle n'aurait nulle part où vivre.
      const base = readFile() || { ...cur };
      try { write({ ...base, provenTemplate: t }); }
      catch (e) { log(`[protocol] preuve non persistée: ${e.message}`); }
    }

    function notifyRelearn() {
      for (const cb of relearnCbs) { try { cb(); } catch { /* un abonné cassé n'arrête rien */ } }
    }

    function learn(candidate) {
      if (!candidate || !candidate.move) return { error: 'candidat incomplet' };
      const cur = get();
      if (isEquivalent(cur, candidate)) return { skipped: 'equivalent' };
      if (isProven()) return { skipped: 'proven' };
      // La preuve se mérite via markProven(), jamais via un champ qui traînerait
      // dans le candidat : sinon un appelant distrait injecterait une preuve
      // jamais obtenue, ce qui viole l'invariant le plus sensible du store.
      const { provenTemplate, ...toWrite } = candidate;
      try { write(toWrite); }
      catch (e) { return { error: e.message }; }
      stale = false;
      notifyRelearn();
      return { saved: true };
    }

    function dropLearned() {
      const appris = learned();
      if (!appris) return false;
      // Jeter l'appris n'a de sens que s'il y a un gabarit intégré vers qui se
      // replier : sans lui on retire au consommateur son dernier profil, et il
      // n'aurait plus rien à envoyer.
      const base = builtin();
      if (!base) return false;
      // Inutile de jeter un profil qui produit déjà les mêmes octets que
      // l'intégré : le problème serait ailleurs. Le supprimer quand même
      // annoncerait un repli qui ne change pas un octet, et ferait redépenser
      // toute une série de jets muets avant le vrai diagnostic.
      if (isEquivalent(appris, base)) return false;
      try { fs.unlinkSync(file); }
      catch (e) { log(`[protocol] suppression du profil appris KO: ${e.message}`); return false; }
      notifyRelearn();
      return true;
    }

    // Plus aucun jet n'obtient de réponse : les faits démentent la preuve.
    // On l'efface, sinon une preuve accordée à tort verrouillerait
    // l'apprentissage définitivement — la persistance a supprimé la soupape
    // qu'était le redémarrage. Exposée au consommateur : lui seul sait à quel
    // moment de son escalade la preuve cesse d'être crédible, et il doit
    // pouvoir la retirer sans pour autant déclarer le protocole périmé.
    function forgetProof() {
      const p = readFile();
      if (!p || !p.provenTemplate) return;
      const { provenTemplate, ...reste } = p;
      try { write(reste); }
      catch (e) { log(`[protocol] preuve non effacée: ${e.message}`); }
    }

    function flagStale() {
      forgetProof();
      if (stale) return false;
      stale = true;
      return true;
    }

    return {
      get, learn, markProven, isProven, forgetProof, dropLearned,
      flagStale, isStale: () => stale,
      onRelearn: cb => { if (typeof cb === 'function') relearnCbs.push(cb); },
      path: file,
    };
  }

  return {
    MAX_VARINT_BYTES, TYPE_URL_MARKER,
    readVarInt, varIntSize, encodeVarIntPadded, patchVarInt, replaceVarIntGrow,
    scanVarIntFields, parseStructured, splitFrames, typeNameOf,
    anyEnvelope, lenPrefixed, varIntField, fieldTag,
    findAnchoredTemplate, findFollowUpCommand, createPairLearner,
    createFieldElector, createProfileStore,
  };
};
