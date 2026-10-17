'use strict';

/**
 * fm-protocol.js — Décodage du canal jeu pour la forgemagie.
 *
 * Pourquoi ce fichier existe
 * --------------------------
 * Les messages d'échange de Dofus 3 sont du protobuf dont les noms de champs
 * ET les msgId changent à chaque build Ankama. Rien n'est donc hardcodé ici :
 * STAKK APPREND la forme des paquets à partir d'une capture où l'utilisateur
 * jette deux runes à la main, puis rejoue cette forme en n'en changeant que
 * l'identifiant de la rune.
 *
 * Deux briques, toutes deux pures (Buffer in → objet out, aucune I/O) :
 *
 *   1. analyzeCapture()  — lit le dump texte produit par fm.js, retrouve le
 *      couple (paquet « pose la rune », paquet « forge »), et localise dans le
 *      premier le varint qui porte l'uid de la rune.
 *
 *   2. scanObjectEntries() — repère dans un paquet serveur→client les triplets
 *      (gid, uid, quantité) d'objets connus, ce qui donne l'inventaire de
 *      runes sans connaître le schéma.
 *
 * Le rejeu ne change JAMAIS la longueur d'un paquet : un varint est réécrit
 * sur exactement le même nombre d'octets grâce à l'encodage non minimal
 * (protobuf l'autorise). Sans ça il faudrait recalculer tous les préfixes de
 * longueur des messages parents — source de bugs garantie.
 */

module.exports = function createFmProtocol(deps) {
  deps = deps || {};

  // Socle partagé. La factory arrive par la deps bag (un plugin ne require()
  // pas ses voisins), le require n'étant qu'un confort pour les tests.
  const createProtocolLearn = deps.createProtocolLearn === null
    ? null
    : (deps.createProtocolLearn || (() => {
        try { return require('./protocol-learn'); } catch { return null; }
      })());
  if (typeof createProtocolLearn !== 'function') {
    throw new Error('fm-protocol: socle protocol-learn indisponible');
  }
  const learn = createProtocolLearn();

  const {
    TYPE_URL_MARKER,
    readVarInt, varIntSize, encodeVarIntPadded, patchVarInt, replaceVarIntGrow,
    scanVarIntFields, parseStructured, splitFrames, typeNameOf,
    anyEnvelope, varIntField,
    findAnchoredTemplate, findFollowUpCommand, createFieldElector,
  } = learn;

  // Traducteur fourni par fm.js (langue de l'UI). Absent = exe plus ancien :
  // on retombe sur le texte français passé en repli.
  const translate = typeof deps.t === 'function' ? deps.t : () => null;
  function tx(key, fallback, vars) { return translate(key, vars) || fallback; }

  // ─── Lecture d'une capture ───────────────────────────────────────────────

  // Format écrit par fm.js : "HH:MM:SS.mmm DIR msgId=N len=L hex=…"
  const LINE_RE = /^(\d{2}:\d{2}:\d{2}\.\d{3})\s+(IN|OUT)\s+msgId=(\d+)\s+len=(\d+)\s+hex=([0-9a-f]*)$/i;

  function parseCapture(text) {
    const packets = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = LINE_RE.exec(line);
      if (!m) continue;
      packets.push({
        ts: m[1],
        dir: m[2].toUpperCase(),
        msgId: Number(m[3]),
        len: Number(m[4]),
        buf: Buffer.from(m[5], 'hex'),
      });
    }
    return packets;
  }

  // ─── Identification des paquets de forgemagie ────────────────────────────

  // Deux paquets sont « de même forme » s'ils ont le même msgId, la même
  // longueur, et diffèrent sur peu d'octets.
  function diffOffsets(a, b) {
    const out = [];
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) out.push(i);
    return out;
  }

  // Regroupe les octets divergents en plages contiguës.
  function toRanges(offsets) {
    const ranges = [];
    for (const off of offsets) {
      const last = ranges[ranges.length - 1];
      if (last && off === last.end + 1) last.end = off;
      else ranges.push({ start: off, end: off });
    }
    return ranges;
  }

  /**
   * Cherche, parmi les paquets sortants, le couple (pose de rune, forge).
   *
   * Hypothèses — toutes vérifiables dans le résultat retourné, aucune n'est
   * imposée silencieusement :
   *   - l'utilisateur a jeté 2 runes DIFFÉRENTES → le paquet « pose » apparaît
   *     ≥ 2 fois, même longueur, et diffère sur un varint (l'uid) ;
   *   - le paquet « forge » apparaît lui aussi ≥ 2 fois mais IDENTIQUE à
   *     l'octet près (il ne porte aucun paramètre) ;
   *   - « forge » suit « pose » dans le flux.
   */
  function findExchangeCandidates(packets) {
    const outs = packets.filter(p => p.dir === 'OUT' && p.buf.length > 0);
    const byMsg = new Map();
    for (const p of outs) {
      if (!byMsg.has(p.msgId)) byMsg.set(p.msgId, []);
      byMsg.get(p.msgId).push(p);
    }

    const moves = [];     // candidats « pose la rune »
    const readies = [];   // candidats « forge »

    for (const [msgId, list] of byMsg) {
      if (list.length < 2) continue;
      // Compare les paquets 2 à 2 en ne gardant que les paires de même longueur.
      for (let i = 0; i < list.length - 1; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i], b = list[j];
          if (a.buf.length !== b.buf.length) continue;
          const diffs = diffOffsets(a.buf, b.buf);

          if (diffs.length === 0) {
            // On garde TOUTES les positions, pas seulement la première : une
            // forge peut traîner avant la première pose (fin du jet précédent
            // au moment où la capture démarre). Ne dater le candidat que sur
            // son premier exemplaire le faisait rejeter à tort.
            readies.push({
              msgId, count: list.length, sample: a,
              index: outs.indexOf(a),
              indices: list.map(p => outs.indexOf(p)),
            });
            i = list.length; break;                  // un exemplaire suffit
          }

          const ranges = toRanges(diffs);
          if (ranges.length !== 1) continue;          // plusieurs zones → pas un simple uid
          const range = ranges[0];
          // La zone divergente doit correspondre à un varint entier des DEUX
          // côtés, sinon on regarde autre chose qu'un identifiant.
          const fieldsA = scanVarIntFields(a.buf).filter(f =>
            f.valueOffset <= range.start && f.valueOffset + f.valueLength > range.end);
          const fieldsB = scanVarIntFields(b.buf).filter(f =>
            f.valueOffset <= range.start && f.valueOffset + f.valueLength > range.end);
          if (!fieldsA.length || !fieldsB.length) continue;
          const fa = fieldsA[fieldsA.length - 1];     // le plus proche = le plus imbriqué
          const fb = fieldsB[fieldsB.length - 1];
          if (fa.valueOffset !== fb.valueOffset || fa.valueLength !== fb.valueLength) continue;
          if (fa.value === fb.value) continue;

          moves.push({
            msgId,
            count: list.length,
            sample: a,
            index: outs.indexOf(a),
            uid: {
              offset: fa.valueOffset,
              length: fa.valueLength,
              fieldNumber: fa.fieldNumber,
              observed: [fa.value, fb.value],
            },
          });
          i = list.length; break;
        }
      }
    }

    // « forge » doit venir APRÈS « pose » dans le flux : on écarte les couples
    // dans le mauvais ordre plutôt que de produire un profil qui inverserait
    // les deux paquets à l'exécution.
    moves.sort((a, b) => b.count - a.count || a.index - b.index);
    const move = moves[0] || null;
    // Un candidat « forge » est retenu dès qu'UNE de ses occurrences suit une
    // pose ; ce qui le précède n'invalide rien.
    let ready = move
      ? (readies
          .filter(r => (r.indices || [r.index]).some(i => i > move.index))
          .sort((a, b) => a.index - b.index)[0] || null)
      : (readies[0] || null);
    if (ready) ready.confidence = 'high';   // vu au moins deux fois à l'identique

    // Repli : le paquet de forge peut n'apparaître qu'UNE fois (l'utilisateur
    // pose plusieurs runes et ne forge qu'à un moment), auquel cas la règle
    // « répété à l'identique » le rate.
    //
    // On cherche donc une commande de jeu envoyée après N'IMPORTE QUELLE pose,
    // pas seulement après la dernière : une séquence réelle observée est
    // pose, pose, pose, FORGE, pose — la forge y est suivie d'une pose.
    // Marqué en confiance faible : c'est une déduction, pas une observation,
    // et l'essai à blanc sert à la valider.
    const fallbacks = [];
    if (move) {
      const firstMoveIndex = outs.findIndex(p => p.msgId === move.msgId);
      for (let i = firstMoveIndex + 1; i < outs.length; i++) {
        const p = outs[i];
        if (p.msgId === move.msgId) continue;
        // Une vraie commande de jeu porte l'enveloppe Any ; ça écarte les
        // keepalive et autres paquets de service.
        if (p.buf.indexOf(TYPE_URL_MARKER) === -1) continue;
        fallbacks.push({
          msgId: p.msgId, count: 1, sample: p, index: i, confidence: 'low',
          // Une forge suit immédiatement une pose : ce voisinage départage
          // les candidats bien mieux que leur simple position.
          afterMove: outs[i - 1] && outs[i - 1].msgId === move.msgId,
        });
      }
      fallbacks.sort((a, b) => (b.afterMove ? 1 : 0) - (a.afterMove ? 1 : 0) || a.index - b.index);
      if (!ready && fallbacks.length) ready = fallbacks[0];
    }

    return { move, ready, moveCandidates: moves, readyCandidates: readies, readyFallbacks: fallbacks };
  }

  /**
   * Construit le profil rejouable. Retourne { ok, profile, reason, detail }.
   * Jamais d'exception : un profil incomplet doit remonter à l'UI comme un
   * diagnostic lisible, pas comme un plantage.
   */
  function buildProfile(captureText, opts) {
    const packets = parseCapture(captureText);
    if (!packets.length) {
      return {
        ok: false, reason: 'empty',
        detail: tx('protoCaptureEmpty', 'capture vide ou format non reconnu'),
      };
    }
    const outCount = packets.filter(p => p.dir === 'OUT').length;
    const { move, ready, moveCandidates, readyCandidates } = findExchangeCandidates(packets);

    if (!move) {
      return {
        ok: false, reason: 'no-move',
        detail: tx('protoNoMove',
          `aucun paquet « pose de rune » identifié sur ${outCount} paquets sortants — `
          + 'il faut jeter DEUX runes de types différents pendant la capture', { n: outCount }),
        stats: { packets: packets.length, out: outCount, readyCandidates: readyCandidates.length },
      };
    }
    if (!ready) {
      return {
        ok: false, reason: 'no-ready',
        detail: tx('protoNoReady',
          'pose de rune identifiée, mais aucune commande de forge dans la capture — '
          + 'après avoir posé une rune, clique sur Forger avant d\'arrêter la capture'),
        stats: { packets: packets.length, out: outCount, moveCandidates: moveCandidates.length },
      };
    }

    return {
      ok: true,
      profile: {
        version: 1,
        createdAt: (opts && opts.now) || null,
        move: {
          msgId: move.msgId,
          template: move.sample.buf.toString('hex'),
          uidOffset: move.uid.offset,
          uidLength: move.uid.length,
          uidFieldNumber: move.uid.fieldNumber,
          observedUids: move.uid.observed,
        },
        ready: {
          msgId: ready.msgId,
          packet: ready.sample.buf.toString('hex'),
          // 'high' = vu plusieurs fois à l'identique ; 'low' = déduit d'un
          // seul exemplaire, à confirmer en essai à blanc.
          confidence: ready.confidence || 'high',
        },
      },
      stats: {
        packets: packets.length, out: outCount,
        moveCandidates: moveCandidates.length, readyCandidates: readyCandidates.length,
        readyGuessed: (ready.confidence || 'high') === 'low',
      },
    };
  }

  // ─── Profil intégré ──────────────────────────────────────────────────────
  //
  // La calibration reste le filet de sécurité, mais elle n'a pas à être un
  // passage obligé : la forme des deux messages est connue, seule change la
  // signature obfusquée de 3 lettres dans le type_url, qu'Ankama rebat à
  // chaque build. La disposition de l'enveloppe elle-même (NO_ID,
  // ENVELOPE_FIELD) est du ressort d'anyEnvelope, qui vit dans le socle
  // protocol-learn — rien à en garder ici.
  //
  // Signatures relevées sur le build d'août 2026. Ankama réobfusque ces noms
  // de types à chaque mise à jour : ce ne sont donc qu'une amorce. Dès que le
  // joueur pose une rune à la main, `learnMove`/`learnReady` réapprennent le
  // vrai format depuis le trafic (cf. apprentissage passif dans fm.js), ce qui
  // rend le mode Jeu autonome face aux MAJ.
  const DEFAULT_CODES = { move: 'kcj', ready: 'kqo' };

  /**
   * Profil utilisable sans aucune capture. `uidOffset` est calculé sur le
   * gabarit produit, donc il reste juste même si la longueur de la signature
   * change.
   */
  function defaultProfile(codes) {
    const c = { ...DEFAULT_CODES, ...(codes || {}) };
    const SAMPLE_UID = 1;   // gabarit : l'uid réel est substitué au moment du jet
    const moveValue = Buffer.concat([
      varIntField(1, SAMPLE_UID),      // objet
      varIntField(3, 1),               // slot d'échange
      varIntField(6, 1),               // quantité
    ]);
    const move = anyEnvelope(c.move, moveValue);
    // Position de l'uid dans le gabarit : juste après son tag (0x08), en
    // partant de la fin de la signature de type pour ne pas confondre avec un
    // 0x08 qui traînerait dans l'en-tête.
    const sigEnd = move.indexOf(Buffer.from(`type.ankama.com/${c.move}`, 'latin1'))
      + `type.ankama.com/${c.move}`.length;
    const uidOffset = move.indexOf(Buffer.from([0x08, SAMPLE_UID]), sigEnd) + 1;
    if (uidOffset <= 0) throw new Error('profil intégré: uid introuvable dans le gabarit');

    return {
      version: 2,
      source: 'builtin',
      codes: c,
      move: {
        msgId: null,
        template: move.toString('hex'),
        uidOffset,
        uidLength: 1,
        uidFieldNumber: 1,
        observedUids: [],
      },
      ready: {
        msgId: null,
        packet: anyEnvelope(c.ready, varIntField(2, 1)).toString('hex'),
        confidence: 'builtin',
      },
    };
  }


  // ─── Apprentissage passif du protocole ───────────────────────────────────
  //
  // Ankama réobfusque les noms de types (`type.ankama.com/kdr` → `.../kcj`) et
  // remanie l'enveloppe à chaque mise à jour du client. Figer un gabarit, c'est
  // donc casser la forge à la prochaine MAJ.
  //
  // La parade ne demande aucune manipulation : STAKK connaît les identifiants
  // d'inventaire de ses runes. Un paquet SORTANT qui contient l'un d'eux ne
  // peut être qu'une pose de rune — quel que soit le nom du type, la position
  // du champ ou la forme de l'enveloppe. On en fait le gabarit, et le paquet de
  // commande qui suit est le « forger ».

  /**
   * Reconnaît une pose de rune dans un paquet sortant.
   *
   * L'ancrage générique vit dans protocol-learn ; ici on ne fait que nommer
   * l'ancre (« un uid de rune ») et compléter le champ que le profil attend.
   */
  function learnMove(buf, knownUids) {
    const found = findAnchoredTemplate(buf, knownUids);
    if (!found) return null;
    return {
      msgId: null,
      template: found.template,
      uidOffset: found.uidOffset,
      uidLength: found.uidLength,
      uidFieldNumber: found.uidFieldNumber,
      typeName: found.typeName,
      observedUids: [found.anchor],
    };
  }

  /**
   * Reconnaît le « forger » : une commande de jeu d'un AUTRE type que la pose,
   * qui ne transporte aucun identifiant d'objet.
   */
  function learnReady(buf, moveTypeName, knownUids) {
    const found = findFollowUpCommand(buf, moveTypeName, knownUids);
    if (!found) return null;
    return { msgId: null, packet: found.packet, typeName: found.typeName, confidence: found.confidence };
  }

  // Deux profils sont équivalents s'ils produisent les mêmes octets : inutile
  // de réécrire le disque quand l'apprentissage confirme ce qu'on avait déjà.
  function sameProfile(a, b) {
    if (!a || !b) return false;
    return a.move && b.move
      && a.move.uidOffset === b.move.uidOffset
      && a.move.uidLength === b.move.uidLength
      && a.move.template === b.move.template
      && (a.ready && a.ready.packet) === (b.ready && b.ready.packet);
  }

  // Reconstruit le paquet « pose la rune » pour un autre uid.
  function buildMovePacket(profile, uid) {
    if (!profile || !profile.move) throw new Error('profil incomplet');
    const tpl = Buffer.from(profile.move.template, 'hex');
    return replaceVarIntGrow(tpl, profile.move.uidOffset, profile.move.uidLength, uid);
  }

  function buildReadyPacket(profile) {
    if (!profile || !profile.ready) throw new Error('profil incomplet');
    return Buffer.from(profile.ready.packet, 'hex');
  }

  // ─── Inventaire ──────────────────────────────────────────────────────────

  // Regroupe les varints d'un décodage par sous-message parent : une entrée
  // d'inventaire = un sous-message, donc un groupe.
  function groupVarints(fields) {
    const groups = new Map();
    for (const f of fields) {
      if (f.wire !== 0) continue;
      if (!groups.has(f.parentId)) groups.set(f.parentId, []);
      groups.get(f.parentId).push(f);
    }
    return groups;
  }

  // ─── Numéros de champs ancrés sur les gid connus ─────────────────────────
  //
  // Tout ce qui précède devine la SÉMANTIQUE des champs à partir de leur forme
  // (« le plus grand varint est l'uid », « le plus petit est la quantité »).
  // C'est faux dès qu'un champ voisin est plus grand que l'uid : relevé en
  // production, un identifiant fantôme à 143 325 921 574 au milieu d'un miroir
  // dont les 72 uid tenaient entre 633 330 678 et 635 117 570. Le serveur l'a
  // refusé trois fois, la rune a été écartée, le run coupé sur un faux
  // diagnostic de changement de protocole.
  //
  // On dispose pourtant d'un ancrage sûr : STAKK connaît TOUS les gid Dofus
  // (fm-data). Dans un sous-message décrivant un objet, le champ qui porte un
  // gid connu EST le champ gid — ce n'est plus une hypothèse de forme, c'est
  // une valeur reconnue. Les deux autres se déduisent alors par élimination, et
  // ce qu'on retient n'est pas une valeur mais un NUMÉRO DE CHAMP, valable pour
  // tous les messages du même build. Au patch suivant il se réapprend tout
  // seul, exactement comme learnMove/learnReady réapprennent la pose.
  //
  // Rien de tout ça n'est un préalable : tant que le mapping n'est pas appris,
  // les lecteurs gardent leur heuristique. Le mapping améliore, il ne
  // conditionne pas.

  // Un identifiant d'objet est grand et tient sur plusieurs octets — même règle
  // que learnMove, qui s'en sert déjà pour écarter slots et quantités.
  const UID_MIN_VALUE = 1e5;
  const UID_MIN_BYTES = 3;
  // Au-delà, ce n'est plus une quantité de pile.
  const QTY_MAX_VALUE = 1000000;

  // Seuils d'apprentissage. Deux axes, parce qu'ils ne couvrent pas le même
  // risque :
  //   - OBJETS distincts : un gid connu peut apparaître par coïncidence dans un
  //     champ qui n'en est pas un. Exiger que le MÊME triplet de numéros de
  //     champs se vérifie sur trois objets différents rend la coïncidence
  //     invraisemblable — il faudrait qu'elle se répète à l'identique trois
  //     fois, sur trois valeurs de gid différentes, au même numéro de champ.
  //     Trois est aussi le seuil retenu pour la médiane des uid dans fm-live :
  //     en dessous, un lot ne se juge pas lui-même.
  //   - MESSAGES distincts : un seul message ne prouve qu'une chose, la forme
  //     de ce message-là. Un lot d'inventaire à 72 objets reste UNE observation
  //     du fil. Deux messages qui s'accordent écartent le coup unique.
  const FIELDMAP_MIN_OBJECTS = 3;
  const FIELDMAP_MIN_PACKETS = 2;
  // Contradictions CONSÉCUTIVES avant de lâcher un mapping appris. Une seule
  // ne prouve rien (un autre message peut légitimement numéroter autrement) ;
  // trois d'affilée sans la moindre concordance, c'est un changement de build.
  const FIELDMAP_MAX_MISMATCH = 3;

  // Un échantillon ne sert qu'au diagnostic hors ligne (recalibrer-inventaire).
  // Tronqué, il ne se décoderait plus : au-delà on préfère ne rien garder.
  const FIELDMAP_SAMPLE_MAX = 8192;

  function normalizeFieldMap(map) {
    if (!map) return null;
    const int = v => (Number.isInteger(v) && v > 0 ? v : null);
    const gid = int(map.gid), uid = int(map.uid);
    if (!gid || !uid || gid === uid) return null;
    const qty = int(map.qty);
    return { gid, uid, qty: qty && qty !== gid && qty !== uid ? qty : null };
  }

  /**
   * Triplets candidats d'un paquet : un par sous-message où gid ET identifiant
   * se laissent désigner sans ambiguïté.
   *
   * Exigences volontairement sévères — c'est la matière première de
   * l'apprentissage, mieux vaut n'en tirer qu'un objet sur trois que d'y mêler
   * une lecture douteuse :
   *   - EXACTEMENT un champ porte un gid connu. Deux (un gid et un champ qui
   *     vaut le même nombre par hasard) → on passe, on ne tranche pas ;
   *   - EXACTEMENT un champ ressemble à un identifiant. C'est précisément le
   *     cas fantôme : deux grands varints dans le même sous-message, dont un
   *     seul est l'uid. L'heuristique choisissait le plus grand ; ici on
   *     s'abstient, et le mapping se fera sur les objets sains.
   *
   * @returns [{ gidField, uidField, gid, uid, qtyFields: [{fieldNumber, value}] }]
   */
  function scanFieldCandidates(buf, knownGids) {
    const gids = knownGids instanceof Set ? knownGids : new Set(knownGids || []);
    if (!gids.size || !buf || !buf.length) return [];
    const fields = parseStructured(buf);
    if (!fields.length) return [];

    const out = [];
    for (const group of groupVarints(fields).values()) {
      const gidFields = group.filter(f => gids.has(f.value));
      if (gidFields.length !== 1) continue;
      const gidField = gidFields[0];

      const uidFields = group.filter(f => f !== gidField
        && f.value >= UID_MIN_VALUE && f.valueLength >= UID_MIN_BYTES);
      if (uidFields.length !== 1) continue;
      const uidField = uidFields[0];

      out.push({
        gidField: gidField.fieldNumber,
        uidField: uidField.fieldNumber,
        gid: gidField.value,
        uid: uidField.value,
        // Tout le reste qui pourrait être une quantité. On n'en désigne aucune
        // ici : c'est le vote sur plusieurs objets qui départagera la quantité
        // d'une position ou d'un compteur.
        qtyFields: group
          .filter(f => f !== gidField && f !== uidField
            && f.value > 0 && f.value <= QTY_MAX_VALUE)
          .map(f => ({ fieldNumber: f.fieldNumber, value: f.value })),
      });
    }
    return out;
  }

  /**
   * Accumulateur d'observations : c'est lui qui décide quand un mapping est
   * assez étayé pour être retenu, et quand il ne l'est plus.
   *
   * Reprend le motif de learnMove/learnReady : apprentissage passif, aucun
   * réglage à faire, profil persistable par l'appelant (fm.js), et abandon dès
   * que l'observation contredit ce qui avait été retenu.
   *
   * @param opts.map     mapping rechargé du disque (facultatif)
   * @param opts.gids    gid ayant servi à l'apprentissage (diagnostic)
   * @param opts.sample  dernier message concordant, en hex (diagnostic)
   */
  function createFieldMapLearner(opts) {
    opts = opts || {};
    let sample = typeof opts.sample === 'string' ? opts.sample : null;
    let packetSeq = 0;
    let objectsSeen = 0;
    const gidsSeen = new Set((opts.gids || []).filter(Number.isFinite));
    const GIDS_SEEN_MAX = 32;

    // Le compte des preuves et l'élection elles-mêmes vivent dans le socle
    // (createFieldElector) : ce qui reste ici est propre aux objets Dofus —
    // extraire des triplets gid/uid/quantité d'un paquet, et les bornes qui
    // décident quand un mapping est assez étayé.
    const elector = createFieldElector({
      roles: ['gid', 'uid', 'qty'], primary: ['gid', 'uid'],
      minPrimary: FIELDMAP_MIN_OBJECTS, minPackets: FIELDMAP_MIN_PACKETS,
      maxMismatch: FIELDMAP_MAX_MISMATCH, map: opts.map,
      // Un même numéro de champ répété dans un sous-message fait élire un
      // mapping où gid et identifiant se confondent : impossible à exploiter.
      // Le socle ne peut pas le savoir, c'est donc à nous de le lui dire — et
      // avant qu'il ne le verrouille, sinon l'accumulation s'arrête sur un
      // mapping que toutes les lectures rejetteront ensuite.
      normalize: normalizeFieldMap,
    });

    /**
     * Alimente l'apprentissage avec un paquet serveur→client.
     * @returns null, { learned } ou { lost }
     */
    function observe(buf, knownGids) {
      const candidates = scanFieldCandidates(buf, knownGids);
      if (!candidates.length) return null;
      packetSeq++;
      objectsSeen += candidates.length;
      for (const c of candidates) {
        if (gidsSeen.size < GIDS_SEEN_MAX) gidsSeen.add(c.gid);
      }

      const r = elector.observe(candidates.map(c => ({
        gid: { field: c.gidField, value: c.gid },
        uid: { field: c.uidField, value: c.uid },
        qty: (c.qtyFields || []).map(q => ({ field: q.fieldNumber, value: q.value })),
      })));
      // L'échantillon ne sert qu'au diagnostic hors ligne : il doit rester le
      // dernier message qui CONFIRME le mapping retenu, jamais un paquet
      // discordant — même sous le seuil d'abandon, où observe() rend `null`
      // sans qu'on puisse le distinguer d'une confirmation sans interroger
      // l'électeur.
      if (buf.length <= FIELDMAP_SAMPLE_MAX && ((r && r.learned) || elector.concordant())) {
        sample = buf.toString('hex');
      }
      // L'électeur ne retient que du normalisé : ce qu'il rend l'est déjà.
      return r;
    }

    function reset() {
      sample = null;
      elector.reset();
    }

    // Tout ce qu'il faut pour ranger l'état sur disque et le relire tel quel.
    function state() {
      const map = elector.get();
      return {
        map: map && { ...map },
        gids: [...gidsSeen],
        sample,
        objects: objectsSeen,
        packets: packetSeq,
      };
    }

    return { observe, reset, state, map: () => { const m = elector.get(); return m && { ...m }; } };
  }

  /**
   * Repère les objets connus dans un paquet serveur→client.
   *
   * Principe : on connaît les gid des runes (dofusdb). On décode la structure
   * réelle du paquet, puis on cherche un SOUS-MESSAGE contenant un varint égal
   * à un gid connu. uid et quantité sont alors ses champs frères — pas de
   * fenêtre d'octets, donc aucun risque de rattacher l'uid de l'objet voisin.
   *
   * Le résultat porte un `confidence` : l'appelant doit pouvoir refuser
   * d'agir sur une lecture douteuse plutôt que d'envoyer un uid inventé.
   *
   * @param buf           paquet brut
   * @param knownGids     Set|Array de gid à chercher
   * @param opts.fieldMap numéros de champs appris (facultatif)
   */
  function scanObjectEntries(buf, knownGids, opts) {
    const gids = knownGids instanceof Set ? knownGids : new Set(knownGids || []);
    if (!gids.size || !buf || !buf.length) return [];

    const fields = parseStructured(buf);
    if (!fields.length) return [];

    const map = normalizeFieldMap(opts && opts.fieldMap);
    // Regroupe par message parent : une entrée d'inventaire = un sous-message.
    const groups = groupVarints(fields);

    const out = [];
    const seen = new Set();
    // Quantité au jugé : le plus petit varint positif qui reste. Sert de repli
    // quand aucun mapping n'est appris, ET quand le mapping n'a pas su
    // désigner le champ quantité — auquel cas gid et identifiant restent
    // ancrés, seule la quantité reste devinée.
    const guessQty = (group, gidField, uidField) => {
      let qtyField = null;
      for (const f of group) {
        if (f === gidField || f === uidField) continue;
        if (f.value <= 0 || f.value > 100000) continue;
        if (!qtyField || f.value < qtyField.value) qtyField = f;
      }
      return qtyField;
    };
    const push = (gidField, uidField, qtyField) => {
      const key = `${gidField.value}:${uidField.value}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        gid: gidField.value,
        uid: uidField.value,
        quantity: qtyField ? qtyField.value : 1,
        gidOffset: gidField.valueOffset,
        uidOffset: uidField.valueOffset,
        uidLength: uidField.valueLength,
        // Un uid crédible est nettement plus grand que le gid et tient sur
        // plusieurs octets ; sinon on marque la lecture comme faible.
        confidence: uidField.value > UID_MIN_VALUE && uidField.valueLength >= UID_MIN_BYTES
          ? 'high' : 'low',
      });
    };

    for (const group of groups.values()) {
      // Lecture ancrée : le sous-message relève du schéma appris dès que son
      // champ gid porte un gid connu. On lit alors chaque rôle à son numéro,
      // sans plus rien déduire de la taille des valeurs — c'est ce qui écarte
      // le champ voisin que l'heuristique prenait pour un identifiant.
      if (map) {
        const gidField = group.find(f => f.fieldNumber === map.gid && gids.has(f.value));
        if (gidField) {
          const uidField = group.find(f => f.fieldNumber === map.uid);
          // Le schéma promet un identifiant à ce numéro : s'il manque, ce
          // sous-message n'est pas l'objet qu'on croit. On n'invente rien.
          if (!uidField) continue;
          push(gidField, uidField, map.qty != null
            ? group.find(f => f.fieldNumber === map.qty)
            : guessQty(group, gidField, uidField));
          continue;
        }
        // Sinon le schéma ne s'applique pas à ce sous-message (autre message,
        // autre numérotation) : repli sur l'heuristique, comme avant.
      }

      const gidField = group.find(f => gids.has(f.value));
      if (!gidField) continue;

      // uid = plus grand varint du MÊME sous-message, hors gid.
      let uidField = null;
      for (const f of group) {
        if (f === gidField) continue;
        if (!uidField || f.value > uidField.value) uidField = f;
      }
      if (!uidField || uidField.value <= gidField.value) continue;

      push(gidField, uidField, guessQty(group, gidField, uidField));
    }
    return out;
  }

  /**
   * Lit les effets d'un item dans un paquet serveur→client.
   *
   * Un effet Dofus est un sous-message minimal { actionId, valeur }. On cherche
   * donc les sous-messages qui contiennent un varint égal à un effectId attendu
   * ET exactement un autre varint : celui-ci est la valeur. Dès qu'il y a
   * ambiguïté (3 varints ou plus dans le même sous-message), on ne devine pas —
   * l'effet est ignoré. Une lecture partielle vaut mieux qu'une valeur inventée
   * qui ferait croire au moteur que l'objectif est atteint.
   *
   * @param buf        paquet brut
   * @param effectIds  Set|Array des effectId attendus (ceux de l'item)
   * @param maxValue   borne de plausibilité (défaut 100000)
   * @returns { [effectId]: valeur }
   */
  function scanEffects(buf, effectIds, maxValue) {
    const wanted = effectIds instanceof Set ? effectIds : new Set(effectIds || []);
    if (!wanted.size || !buf || !buf.length) return {};
    const cap = maxValue || 100000;

    return collectEffects(buf, parseStructured(buf), wanted, cap, null);
  }

  /**
   * Idem, mais restreint aux effets de l'objet dont le gid est `itemGid`.
   *
   * Indispensable en vrai : un paquet d'échange décrit AUSSI les runes, et
   * chaque rune porte son propre { effectId, valeur }. Sans ce filtrage on lit
   * « Vitalité 15 » alors que c'est le contenu d'une Rune Pa Vi, pas la stat
   * de l'item — et le moteur croit l'objectif atteint.
   *
   * On isole le plus petit sous-message contenant le gid de l'item, puis on ne
   * garde que les effets situés dans ses bornes.
   */
  function scanItemEffects(buf, itemGid, effectIds, maxValue) {
    const wanted = effectIds instanceof Set ? effectIds : new Set(effectIds || []);
    if (!wanted.size || !buf || !buf.length || !itemGid) return {};
    const fields = parseStructured(buf);
    if (!fields.length) return {};

    const nodes = fields.filter(f => f.node);
    const gidFields = fields.filter(f => f.wire === 0 && f.value === itemGid);
    if (!gidFields.length) return {};

    let best = {};
    for (const gidField of gidFields) {
      // Plus petit sous-message englobant le gid.
      let scope = null;
      for (const n of nodes) {
        if (n.start <= gidField.valueOffset && gidField.valueOffset < n.end) {
          if (!scope || (n.end - n.start) < (scope.end - scope.start)) scope = n;
        }
      }
      if (!scope) continue;
      const got = collectEffects(buf, fields, wanted, maxValue || 100000, scope);
      if (Object.keys(got).length > Object.keys(best).length) best = got;
    }
    return best;
  }

  // Cœur commun : regroupe les varints par sous-message et retient les couples
  // { effectId attendu, valeur }. `scope` limite aux offsets d'un sous-message.
  function collectEffects(buf, fields, wanted, cap, scope) {
    const groups = new Map();
    for (const f of fields) {
      if (f.wire !== 0) continue;
      if (scope && (f.valueOffset < scope.start || f.valueOffset >= scope.end)) continue;
      if (!groups.has(f.parentId)) groups.set(f.parentId, []);
      groups.get(f.parentId).push(f);
    }

    const out = {};
    for (const group of groups.values()) {
      if (group.length !== 2) continue;                  // { actionId, valeur }
      const [a, b] = group;
      let idField = null, valField = null;
      if (wanted.has(a.value) && !wanted.has(b.value)) { idField = a; valField = b; }
      else if (wanted.has(b.value) && !wanted.has(a.value)) { idField = b; valField = a; }
      else continue;                                     // les deux (ou aucun) → ambigu
      if (valField.value <= 0 || valField.value > cap) continue;
      // Un même effet peut apparaître plusieurs fois (jet mini/maxi d'un item
      // non forgé) : on garde la dernière occurrence, qui correspond à l'état
      // courant dans les paquets d'échange.
      out[idField.value] = valField.value;
    }
    return out;
  }

  /**
   * Repère les mises à jour de quantité d'objets déjà connus.
   *
   * Quand une pile change, le serveur n'envoie pas l'objet complet mais un
   * message minimal { identifiant, nouvelle quantité } — sans gid. Il échappe
   * donc à scanObjectEntries, qui a besoin du gid pour reconnaître un objet.
   * Sans ce complément, une pile consommée reste éternellement « disponible »
   * dans notre miroir, et on finit par jouer un identifiant mort.
   *
   * On s'appuie sur les identifiants DÉJÀ connus : un sous-message qui
   * contient exactement deux varints dont l'un est un uid suivi, l'autre est
   * la quantité.
   *
   * PIÈGE, et c'est le cœur du problème : un message de DÉPLACEMENT d'objet a
   * exactement la même forme, { identifiant, position }. Sur la seule forme,
   * rien ne les distingue — une position 0 se lit alors « quantité 0 » et
   * retire la pile du miroir en pleine forge. Dès que le numéro du champ
   * quantité est connu (cf. createFieldMapLearner), on ne lit plus que
   * celui-là : un déplacement porte sa position à un autre numéro et cesse
   * d'être confondu. Tant qu'il n'est pas appris, l'heuristique reste en place.
   *
   * @param buf           paquet brut
   * @param knownUids     Set|Array des identifiants suivis
   * @param opts.fieldMap numéros de champs appris (facultatif)
   * @returns [{ uid, quantity }]
   */
  function scanQuantityUpdates(buf, knownUids, opts) {
    const uids = knownUids instanceof Set ? knownUids : new Set(knownUids || []);
    if (!uids.size || !buf || !buf.length) return [];

    const fields = parseStructured(buf);
    if (!fields.length) return [];

    const map = normalizeFieldMap(opts && opts.fieldMap);
    const groups = groupVarints(fields);

    const out = [];
    const seen = new Set();
    for (const group of groups.values()) {
      if (group.length !== 2) continue;              // { uid, quantité }
      const [a, b] = group;
      let uidField = null, qtyField = null;
      if (uids.has(a.value) && !uids.has(b.value)) { uidField = a; qtyField = b; }
      else if (uids.has(b.value) && !uids.has(a.value)) { uidField = b; qtyField = a; }
      else continue;
      if (qtyField.value < 0 || qtyField.value > QTY_MAX_VALUE) continue;
      // Numéro de champ établi : tout ce qui n'est pas à ce numéro n'est pas
      // une quantité, quelle que soit sa tête.
      if (map && map.qty != null && qtyField.fieldNumber !== map.qty) continue;
      if (seen.has(uidField.value)) continue;
      seen.add(uidField.value);
      out.push({ uid: uidField.value, quantity: qtyField.value });
    }
    return out;
  }

  /**
   * Repère les suppressions d'objets déjà connus.
   *
   * Quand une pile est ENTIÈREMENT consommée, le serveur n'annonce pas une
   * quantité à zéro : il envoie un message de suppression qui ne porte qu'un
   * seul champ, l'identifiant. Il échappe donc à scanObjectEntries (pas de
   * gid) ET à scanQuantityUpdates (qui exige deux varints). Sans ce
   * complément, la pile morte reste dans le miroir et on finit par jouer un
   * identifiant que le serveur ignore en silence.
   *
   * On s'appuie sur les identifiants DÉJÀ connus : un sous-message dont
   * l'UNIQUE champ est un varint égal à un uid suivi. « Unique » se compte sur
   * TOUS les champs du sous-message, pas seulement les varints : un groupe
   * { uid, effets… } décrit un objet, pas sa disparition.
   *
   * Ce qui pourrait produire un tel groupe sans être une suppression : un
   * message entrant qui ne référence qu'un objet (sélection, accusé), ou tout
   * simplement un champ isolé quelconque — le reliquat de l'atelier en est un.
   * Le risque reste tenu :
   *   - un uid inconnu ne déclenche jamais rien, et on exige en plus un grand
   *     nombre sur plusieurs octets (même règle que learnMove), ce qui écarte
   *     les compteurs, slots, quantités et autres petits champs isolés ;
   *   - la direction est filtrée par l'appelant : une pose de rune part VERS
   *     le serveur et ne passe donc jamais par ici ;
   *   - une suppression lue à tort est rattrapée dès le prochain paquet
   *     d'objet complet, qui réinscrit la pile — et l'appelant garde la
   *     dernière pile connue d'une rune pour ne pas bloquer le run.
   *
   * @param buf           paquet brut (serveur→client)
   * @param knownUids     Set|Array des identifiants suivis
   * @param opts.fieldMap numéros de champs appris (facultatif)
   * @returns [uid] identifiants annoncés supprimés
   */
  function scanObjectDeletions(buf, knownUids, opts) {
    const uids = knownUids instanceof Set ? knownUids : new Set(knownUids || []);
    if (!uids.size || !buf || !buf.length) return [];

    const fields = parseStructured(buf);
    if (!fields.length) return [];

    const map = normalizeFieldMap(opts && opts.fieldMap);
    const groups = new Map();
    for (const f of fields) {
      if (!groups.has(f.parentId)) groups.set(f.parentId, []);
      groups.get(f.parentId).push(f);
    }

    const out = [];
    const seen = new Set();
    for (const group of groups.values()) {
      if (group.length !== 1) continue;              // { identifiant }, rien d'autre
      const uidField = group[0];
      if (uidField.wire !== 0) continue;
      if (!uids.has(uidField.value)) continue;
      if (uidField.valueLength < UID_MIN_BYTES || uidField.value < UID_MIN_VALUE) continue;
      // Un identifiant d'objet vit au numéro de champ appris. Ailleurs, c'est
      // un champ isolé qui vaut par hasard un uid suivi — pas une suppression.
      if (map && uidField.fieldNumber !== map.uid) continue;
      if (seen.has(uidField.value)) continue;
      seen.add(uidField.value);
      out.push(uidField.value);
    }
    return out;
  }

  /**
   * Retrouve les emplacements d'une valeur connue dans un paquet.
   *
   * Sert à apprendre un champ dont on ne connaît pas le rôle mais dont on
   * connaît la valeur affichée par le jeu — le reliquat, typiquement. Plutôt
   * que de deviner quel champ c'est, on demande sa valeur à l'utilisateur une
   * fois et on retient son CHEMIN dans la structure.
   *
   * @returns [{ path, value }] chemins où cette valeur apparaît
   */
  function findFieldPaths(buf, value) {
    const out = [];
    for (const f of parseStructured(buf)) {
      if (f.wire !== 0 || f.value !== value) continue;
      if (!out.some(o => o.path === f.path)) out.push({ path: f.path, value: f.value });
    }
    return out;
  }

  /** Lit la valeur d'un champ repéré par son chemin. Null si absent. */
  function readFieldPath(buf, path) {
    if (!path) return null;
    for (const f of parseStructured(buf)) {
      if (f.wire === 0 && f.path === path) return f.value;
    }
    return null;
  }

  // Agrège plusieurs paquets en un stock { gid: quantité } + table gid → uid.
  // Les lectures `low` sont ignorées par défaut : mieux vaut un stock vide
  // (le moteur dira « plus de rune ») qu'un uid inventé envoyé au serveur.
  function buildStock(entries, opts) {
    const acceptLow = !!(opts && opts.acceptLow);
    const stock = {};
    const uids = {};
    for (const e of entries) {
      if (e.confidence !== 'high' && !acceptLow) continue;
      stock[e.gid] = (stock[e.gid] || 0) + e.quantity;
      (uids[e.gid] = uids[e.gid] || []).push(e.uid);
    }
    return { stock, uids };
  }

  return {
    readVarInt, varIntSize, encodeVarIntPadded, patchVarInt, replaceVarIntGrow,
    scanVarIntFields, parseStructured, splitFrames,
    parseCapture, findExchangeCandidates, buildProfile,
    defaultProfile, DEFAULT_CODES,
    learnMove, learnReady, typeNameOf, sameProfile,
    buildMovePacket, buildReadyPacket,
    scanObjectEntries, buildStock, scanEffects, scanItemEffects, scanQuantityUpdates,
    scanObjectDeletions,
    scanFieldCandidates, createFieldMapLearner, normalizeFieldMap,
    FIELDMAP_MIN_OBJECTS, FIELDMAP_MIN_PACKETS, FIELDMAP_MAX_MISMATCH,
    findFieldPaths, readFieldPath,
    _diffOffsets: diffOffsets,
    _toRanges: toRanges,
  };
};
