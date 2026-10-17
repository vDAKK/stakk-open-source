'use strict';

/**
 * fm-live.js — Transport « vrai jeu » de la forgemagie.
 *
 * Implémente le contrat attendu par fm.js :
 *     readStock()  → { [runeGid]: quantité }
 *     readStats()  → { [effectId]: valeur }
 *     throwRune()  → { ok, stats }
 *
 * Il est OBSERVATEUR d'abord, émetteur ensuite : les paquets serveur→client
 * passent par observe() et alimentent en continu deux vues (inventaire de
 * runes, effets de l'item posé). Un jet consiste alors à rejouer le paquet
 * « pose la rune » du profil de calibration avec l'uid voulu, puis le paquet
 * « forge », et à attendre que la vue des effets bouge.
 *
 * Règles de sûreté — toutes délibérées, aucune n'est là pour faire joli :
 *   - rien n'est envoyé tant qu'on n'a pas observé AU MOINS UNE FOIS les
 *     effets de l'item (`ready()` faux → fm.js refuse de démarrer). Envoyer
 *     des paquets en aveugle à un serveur Ankama est le meilleur moyen de se
 *     faire flag ;
 *   - un uid de rune n'est utilisé que s'il vient d'une lecture `high` ;
 *   - un jet sans réponse dans le délai imparti est un ÉCHEC franc, jamais un
 *     succès supposé : le moteur ne doit pas croire qu'une stat a monté.
 *
 * Aucune I/O directe : le canal, l'horloge et les timers sont injectés, donc
 * tout est testable sans Dofus.
 */

module.exports = function createFmLive(deps) {
  deps = deps || {};
  const protocol = deps.protocol;
  if (!protocol) throw new Error('fm-live: protocol requis');

  const setTimeoutFn = deps.setTimeout || setTimeout;
  const clearTimeoutFn = deps.clearTimeout || clearTimeout;
  const now = deps.now || (() => Date.now());

  // Traducteur fourni par fm.js (langue de l'UI). Absent = exe plus ancien :
  // on retombe sur le texte français passé en repli.
  const translate = typeof deps.t === 'function' ? deps.t : () => null;
  function tx(key, fallback, vars) { return translate(key, vars) || fallback; }

  // Attente maximale d'une réponse. Volontairement courte : au-delà, c'est
  // que le serveur n'a rien à dire, et faire patienter l'utilisateur plusieurs
  // secondes par jet raté rendait le réglage de cadence illisible.
  // Réglages de cadence. Volontairement serrés : sur un aller-retour réseau
  // de quelques dizaines de millisecondes, attendre des secondes par jet rend
  // la forge interminable. Chacun est surchargeable par run.
  const DEFAULT_THROW_TIMEOUT_MS = 2000;   // silence total du serveur
  const DEFAULT_READY_DELAY_MS = 50;       // pose → forge
  const DEFAULT_GRACE_MS = 250;            // valeur qui arrive juste après la réponse

  /**
   * @param opts.profile     profil de calibration (fm-protocol.buildProfile)
   * @param opts.channel     { sendToServer(buf) } fourni par game-proxy
   * @param opts.runeGids    gid des runes à suivre dans l'inventaire
   * @param opts.effectIds   effectId de l'item à suivre
   * @param opts.log         (optionnel)
   */
  function create(opts) {
    const { profile, channel, runeGids, effectIds, itemGid } = opts || {};
    if (!profile || !profile.move || !profile.ready) throw new Error('fm-live: profil de calibration incomplet');
    // Le profil est relu À CHAQUE JET, jamais figé à la création.
    //
    // Ankama rebat les signatures obfusquées en cours de session : STAKK les
    // réapprend tout seul dès qu'une rune est posée à la main, mais
    // l'observateur, lui, reste armé. En gardant le profil capturé à
    // l'armement, on continuait à émettre l'ANCIEN gabarit — le serveur
    // ignorait chaque paquet en silence, et les identifiants parfaitement
    // valides sortaient du miroir au bout de trois refus. Constaté le
    // 12/08/2026 : profil réappris à 10:23:28, run relancé à 10:23:30, toujours
    // muet, alors que le bon gabarit était déjà sur disque.
    const readProfile = typeof opts.getProfile === 'function' ? opts.getProfile : null;
    // Le gabarit a-t-il déjà obtenu une réponse du serveur ? Renseigné par
    // fm.js, qui suit les jets aboutis. Sert à séparer un échec de forgemagie
    // d'un paquet que le serveur n'a pas compris.
    const profileProven = typeof opts.isProfileProven === 'function'
      ? (() => { try { return !!opts.isProfileProven(); } catch { return false; } })
      : (() => false);
    function currentProfile() {
      if (!readProfile) return profile;
      let p = null;
      try { p = readProfile(); } catch { p = null; }
      // Un profil incomplet ne remplace jamais celui qui marchait : mieux vaut
      // le gabarit d'hier que pas de gabarit du tout.
      return (p && p.move && p.ready) ? p : profile;
    }
    if (!channel || typeof channel.sendToServer !== 'function') throw new Error('fm-live: canal de jeu absent');
    const gids = new Set(runeGids || []);
    const effects = new Set(effectIds || []);
    if (!effects.size) throw new Error('fm-live: aucun effet à suivre');
    const log = opts.log || (() => {});
    const throwTimeout = opts.throwTimeoutMs || DEFAULT_THROW_TIMEOUT_MS;
    // Délai laissé à une valeur mise à jour après une première réponse aux
    // valeurs inchangées. Borne le coût d'un échec réel de forgemagie.
    const graceMs = opts.graceMs == null ? DEFAULT_GRACE_MS : opts.graceMs;
    const readyDelay = opts.readyDelayMs == null ? DEFAULT_READY_DELAY_MS : opts.readyDelayMs;

    // Essai à blanc : on fait TOUT sauf envoyer. Ça valide la chaîne complète
    // (profil de calibration, résolution d'uid, lecture d'inventaire et de
    // stats) contre le vrai état du jeu, sans qu'un seul octet parte. Les
    // résultats de jet sont alors simulés — c'est un test de tuyauterie, pas
    // une prédiction de forgemagie.
    let dryRun = !!opts.dryRun;
    const planned = [];        // paquets qui AURAIENT été envoyés
    let shadow = null;         // stats simulées pendant l'essai à blanc

    // ─── Miroir d'inventaire ─────────────────────────────────────────────
    //
    // Indexé par IDENTIFIANT d'objet, pas par gid : c'est l'identifiant qui
    // part dans le paquet, et c'est lui qui périme. Une simple accumulation
    // par gid ne sait jamais retirer une pile consommée, et on finit par
    // jouer un identifiant mort que le serveur refuse.
    //
    // Le miroir est alimenté par deux sources :
    //   - les objets complets   { uid, gid, quantité }
    //   - les mises à jour      { uid, nouvelle quantité }   ← sans gid
    // Une quantité qui tombe à zéro retire l'objet.
    const objects = new Map();   // uid → { gid, qty, seq }
    // Refus consécutifs par identifiant : un seul ne prouve rien, et
    // supprimer la seule pile connue d'une rune bloque tout le run.
    const rejectStreak = new Map();
    const REJECTS_BEFORE_DROP = 3;

    // `seq` compte en séquence et pas en millisecondes : deux événements du
    // même millième de seconde seraient indiscernables, et on prendrait un
    // refus serveur pour un écho.
    let observeSeq = 0;

    // ─── Numéros de champs d'inventaire ──────────────────────────────────
    //
    // Ancre la lecture sur une valeur CONNUE (un gid Dofus) au lieu de deviner
    // le rôle des champs d'après leur taille. L'accumulateur peut être fourni
    // par fm.js — il est alors partagé avec la veille d'inventaire, qui voit
    // passer le sac complet à la connexion du personnage, soit la meilleure
    // matière première qui soit. À défaut on en crée un, pour que le transport
    // reste utilisable seul.
    const fieldLearner = opts.fieldLearner
      || (typeof protocol.createFieldMapLearner === 'function'
        ? protocol.createFieldMapLearner({ map: opts.fieldMap })
        : null);
    // Tant que rien n'est appris, `null` : les lecteurs gardent leur
    // heuristique et STAKK reste opérationnel dès le premier lancement.
    function fieldMap() {
      return fieldLearner ? fieldLearner.map() : (opts.fieldMap || null);
    }

    function learnFields(buf) {
      if (!fieldLearner) return;
      const news = fieldLearner.observe(buf, gids);
      if (!news) return;
      if (news.learned) {
        log(`[fm-live] champs d'inventaire appris : gid=${news.learned.gid}, `
          + `identifiant=${news.learned.uid}, quantité=`
          + `${news.learned.qty == null ? 'indéterminée' : news.learned.qty}`);
        if (typeof opts.onFieldMapLearned === 'function') {
          try { opts.onFieldMapLearned(fieldLearner.state()); } catch { /* journal only */ }
        }
      } else if (news.lost) {
        log('[fm-live] les champs d\'inventaire appris ne concordent plus avec le trafic — '
          + 'mapping abandonné, réapprentissage en cours');
        if (typeof opts.onFieldMapLost === 'function') {
          try { opts.onFieldMapLost(); } catch { /* journal only */ }
        }
      }
    }

    // ─── Plausibilité des identifiants ───────────────────────────────────
    //
    // Les identifiants d'objets d'un même personnage sont alloués dans une
    // plage très serrée — relevé réel : 72 piles entre 633 330 678 et
    // 635 117 570, soit 0,3 % d'écart. Un identifiant qui dépasse cette plage
    // de plusieurs ordres de grandeur n'est pas un objet : c'est un champ
    // voisin pris pour un uid par scanObjectEntries, qui retient le PLUS GRAND
    // varint du sous-message et se trompe donc toujours vers le haut. Vécu :
    // un intrus 225 fois au-dessus des autres, refusé par le serveur à chaque
    // jet, la rune concernée échouant systématiquement jusqu'à l'arrêt du run
    // sur un diagnostic trompeur.
    //
    // La règle est RELATIVE à la médiane des identifiants connus, donc elle
    // suit les uid de Dofus s'ils grandissent un jour — contrairement à un
    // plafond en dur, qui deviendrait faux à la première refonte. Deux partis
    // pris :
    //   - elle ne coupe que par le HAUT. Un objet ancien porte légitimement un
    //     identifiant plus petit que les autres, et les artefacts de lecture
    //     sont par construction plus grands ;
    //   - la médiane (et pas la moyenne) résiste aux intrus eux-mêmes : un lot
    //     de 73 objets dont un aberrant garde une référence saine.
    // Le facteur laisse deux ordres de grandeur au-dessus de la référence,
    // quand la plage réelle en occupe moins d'un millième : la marge est
    // énorme pour un objet légitime, et l'intrus observé la dépasse largement.
    const UID_PLAUSIBLE_FACTOR = 100;
    // En dessous de trois identifiants, la médiane ne veut rien dire : au
    // premier objet observé il n'y a rien à quoi se comparer, et refuser
    // d'amorcer le miroir serait pire que tout.
    const UID_MIN_SAMPLE = 3;

    function medianOf(values) {
      const s = values.slice().sort((a, b) => a - b);
      const mid = s.length >> 1;
      return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    }

    /**
     * Référence de plausibilité pour un lot d'identifiants qui arrive.
     *
     * Le lot est inclus dans l'échantillon : au rechargement du disque le
     * miroir est vide, mais les 73 piles rendues d'un coup se jugent très bien
     * entre elles — sinon un intrus placé en tête du fichier passerait faute
     * de comparaison. Retourne null quand on ne sait pas juger.
     */
    function uidReference(batch) {
      const sample = [...objects.keys()];
      for (const uid of batch || []) if (Number.isFinite(uid)) sample.push(uid);
      if (sample.length < UID_MIN_SAMPLE) return null;
      return medianOf(sample);
    }

    // `reference` vient de uidReference() : null = pas d'avis, on laisse entrer.
    function implausibleUid(uid, reference) {
      return reference !== null && uid > reference * UID_PLAUSIBLE_FACTOR;
    }

    function upsertObject(uid, gid, qty, seq) {
      const prev = objects.get(uid);
      if (qty <= 0) { objects.delete(uid); return; }
      objects.set(uid, { gid: gid != null ? gid : (prev ? prev.gid : null), qty, seq });
    }

    function stockByGid() {
      const out = {};
      for (const o of objects.values()) {
        if (o.gid == null) continue;
        out[o.gid] = (out[o.gid] || 0) + o.qty;
      }
      return out;
    }

    function uidsOf(gid) {
      const out = [];
      for (const [uid, o] of objects) {
        if (String(o.gid) === String(gid) && o.qty > 0) out.push({ uid, seq: o.seq, qty: o.qty });
      }
      return out;
    }

    // Vrai si cette pile est la SEULE encore connue pour sa rune. Une pile sans
    // gid ne compte pour rien dans le stock : la retirer ne bloque rien.
    function isLastStack(gid, uid) {
      if (gid == null) return false;
      const list = uidsOf(gid);
      return list.length === 1 && list[0].uid === uid;
    }
    let stats = null;          // { effectId: valeur } ou null tant qu'inconnu

    // ─── Reliquat ────────────────────────────────────────────────────────
    //
    // Le jeu l'affiche dans l'atelier, donc le serveur l'envoie — mais rien
    // ne permet de deviner QUEL champ c'est. On l'apprend une fois par sa
    // valeur (l'utilisateur la lit à l'écran), on retient son chemin dans la
    // structure, puis on le suit tout seul.
    let reliquatPath = opts.reliquatPath || null;
    let reliquat = null;
    // Derniers paquets décrivant l'item : base de l'apprentissage.
    const recentItemPackets = [];
    const RECENT_MAX = 6;

    // Fenêtre d'enregistrement autour d'un jet. Le reliquat n'est PAS dans le
    // message qui décrit l'item (vérifié : deux relevés, mêmes champs, alors
    // que les stats avaient chuté). Il arrive donc dans un autre message —
    // celui qui annonce le résultat du jet. On garde tout ce qui entre entre
    // l'envoi et la résolution, c'est un très petit nombre de paquets.
    let throwWindow = null;
    const THROW_WINDOW_MAX = 24;

    // Tampon glissant de TOUT ce qui entre. Les jets faits à la main dans le
    // jeu ne passent pas par throwRune : sans ce tampon, il n'y a rien à
    // examiner après un échec manuel.
    const recentAny = [];
    const RECENT_ANY_MAX = 30;

    // ─── Traque automatique du reliquat ──────────────────────────────────
    //
    // Quand un jet rate, il détruit du poids. Ce poids détruit moins celui de
    // la rune part en reliquat — et on sait calculer les deux. Il suffit donc
    // de repérer, à chaque chute de stats, le champ dont la valeur a augmenté
    // d'à peu près ce montant. Un champ qui le fait DEUX fois de suite n'est
    // pas une coïncidence.
    const drops = [];          // { destroyed, fields: Map(path → valeur) }
    const DROPS_MAX = 4;
    // Une chute d'un ou deux points de poids ne prouve rien : n'importe quel
    // compteur qui s'incrémente collerait. On n'accepte de conclure que sur
    // une destruction franche.
    const MIN_DESTROYED = 5;
    const weightOf = typeof opts.weightOf === 'function' ? opts.weightOf : null;
    let statsSeenAt = 0;
    let statsVersion = 0;      // incrémenté à CHAQUE observation, même identique
    const waiters = [];        // résolveurs en attente d'une nouvelle version

    /**
     * Une chute de stats vient d'être observée : on en déduit le poids
     * détruit, et on note les champs du paquet courant. Deux chutes suffisent
     * ensuite à isoler le reliquat (cf. matchReliquat).
     */
    function recordDrop(before, after, buf) {
      if (!weightOf) return;
      let destroyed = 0;
      for (const [k, v] of Object.entries(before || {})) {
        const now = (after || {})[k];
        if (typeof now !== 'number' || now >= v) continue;
        const w = weightOf(Number(k), v - now);
        if (w === null) return;                    // coefficient inconnu : on s'abstient
        destroyed += w;
      }
      if (destroyed <= 0) return;

      const fields = new Map();
      for (const f of protocol.parseStructured(buf)) {
        if (f.wire === 0) fields.set(f.path, f.value);
      }

      // Déjà repéré : on ne cherche plus, on surveille.
      if (reliquatPath) { verifyReliquat(fields, destroyed); return; }

      drops.push({ destroyed, fields });
      if (drops.length > DROPS_MAX) drops.shift();
      matchReliquat();
    }

    /**
     * Cherche le champ dont la progression colle au poids détruit.
     *
     * On exige que ça tienne sur DEUX chutes : un seul relevé laisserait
     * passer n'importe quel compteur qui monte.
     */
    function matchReliquat() {
      if (reliquatPath || drops.length < 2) return;
      const last = drops[drops.length - 1];
      const prev = drops[drops.length - 2];
      // La chute de référence doit être franche, sinon la coïncidence est
      // plus probable que la découverte.
      if (last.destroyed < MIN_DESTROYED) return;

      const candidates = [];
      for (const [path, value] of last.fields) {
        if (!prev.fields.has(path)) continue;
        const delta = value - prev.fields.get(path);
        if (delta <= 0) continue;
        // La hausse doit être du même ordre que le poids détruit : le
        // reliquat absorbe ce poids, moins celui de la rune posée. On tolère
        // donc jusqu'à la valeur détruite, mais pas une miette non plus.
        if (delta <= last.destroyed + 0.5 && delta >= last.destroyed / 3) {
          candidates.push({ path, delta });
        }
      }
      if (candidates.length !== 1) return;         // ambigu : on ne tranche pas
      reliquatPath = candidates[0].path;
      reliquat = last.fields.get(reliquatPath);
      log(`[fm-live] reliquat repéré automatiquement : champ ${reliquatPath} = ${reliquat} ` +
          `(hausse ${candidates[0].delta} pour ${last.destroyed} de poids détruit)`);
      if (typeof opts.onReliquatLearned === 'function') {
        try { opts.onReliquatLearned(reliquatPath, reliquat); } catch { /* journal only */ }
      }
    }

    /**
     * Contrôle continu : à chaque nouvelle chute, le champ retenu doit
     * augmenter. S'il reste figé alors que du poids a été détruit, c'est
     * qu'on s'est trompé de champ — on le relâche plutôt que de fonder des
     * décisions coûteuses dessus.
     */
    function verifyReliquat(fields, destroyed) {
      if (!reliquatPath || destroyed < MIN_DESTROYED) return;
      const now = fields.get(reliquatPath);
      if (now === undefined) return;               // absent de ce paquet : sans avis
      if (reliquat !== null && now <= reliquat) {
        log(`[fm-live] le champ ${reliquatPath} n'a pas bougé malgré ${destroyed} de poids détruit — ` +
            'ce n\'était pas le reliquat, on repart en recherche');
        reliquatPath = null;
        reliquat = null;
        drops.length = 0;
        if (typeof opts.onReliquatLost === 'function') {
          try { opts.onReliquatLost(); } catch { /* journal only */ }
        }
      }
    }

    function bumpStats(next) {
      stats = next;
      // Le vrai jeu vient de parler : l'ardoise simulée de l'essai à blanc est
      // périmée. Sans ça, poser un item neuf pendant un essai resterait
      // invisible — readStats continuerait à servir les valeurs simulées de
      // l'exemplaire précédent.
      if (dryRun) shadow = null;
      statsSeenAt = now();
      statsVersion++;
      while (waiters.length) waiters.shift()(statsVersion);
    }

    /** Alimente les vues avec un paquet serveur→client. */
    function observe(buf) {
      if (!buf || !buf.length) return;

      // Enregistrement pendant un jet : sert à traquer le reliquat.
      if (throwWindow && throwWindow.length < THROW_WINDOW_MAX) {
        throwWindow.push(Buffer.from(buf));
      }
      recentAny.push(Buffer.from(buf));
      if (recentAny.length > RECENT_ANY_MAX) recentAny.shift();

      if (gids.size) {
        // 0. Apprentissage des numéros de champs, AVANT toute lecture : un
        //    paquet qui vient d'établir le mapping doit déjà en profiter.
        learnFields(buf);
        const fmap = fieldMap();

        // 1. Objets complets : { uid, gid, quantité }.
        const entries = protocol.scanObjectEntries(buf, gids, { fieldMap: fmap });
        if (entries.length) {
          observeSeq++;
          const reference = uidReference(entries.map(e => e.uid));
          for (const e of entries) {
            if (e.confidence !== 'high') continue;
            if (implausibleUid(e.uid, reference)) {
              log(`[fm-live] identifiant ${e.uid} (rune ${e.gid}) invraisemblable — ` +
                  `${Math.round(e.uid / reference)}× la médiane du miroir, ignoré`);
              continue;
            }
            upsertObject(e.uid, e.gid, e.quantity, observeSeq);
          }
        }

        // 2. Mises à jour de quantité : { uid, nouvelle quantité }, sans gid.
        //    C'est ce qui permet de retirer une pile consommée du miroir au
        //    lieu de la croire éternellement disponible.
        if (objects.size && typeof protocol.scanQuantityUpdates === 'function') {
          const updates = protocol.scanQuantityUpdates(buf, [...objects.keys()], { fieldMap: fmap });
          if (updates.length) {
            observeSeq++;
            for (const u of updates) {
              const prev = objects.get(u.uid);
              if (!prev) continue;
              upsertObject(u.uid, prev.gid, u.quantity, observeSeq);
            }
          }
        }

        // 3. Suppressions : { identifiant } seul, sans quantité. Une pile
        //    entièrement consommée n'est pas annoncée à zéro, elle DISPARAÎT ;
        //    sans ça elle resterait au miroir et on jouerait un identifiant
        //    mort jusqu'à ce que les refus serveur finissent par l'écarter.
        //    Ce paquet vient du serveur : aucun risque de confondre avec une
        //    pose de rune, qui part dans l'autre sens.
        if (objects.size && typeof protocol.scanObjectDeletions === 'function') {
          for (const uid of protocol.scanObjectDeletions(buf, [...objects.keys()], { fieldMap: fmap })) {
            const o = objects.get(uid);
            if (!o) continue;
            // Même garde-fou que sur les refus serveur : une lecture isolée ne
            // prouve rien, et supprimer la seule pile connue d'une rune bloque
            // tout le run. On la garde ; si elle est vraiment morte, les refus
            // successifs l'écarteront.
            if (isLastStack(o.gid, uid)) {
              log(`[fm-live] suppression de l'identifiant ${uid} ignorée — dernière pile connue de la rune ${o.gid}`);
              continue;
            }
            objects.delete(uid);
            log(`[fm-live] identifiant ${uid} (rune ${o.gid}) supprimé par le serveur — retiré du miroir`);
          }
        }
      }

      // Lecture SCOPÉE à l'item quand on connaît son gid : les paquets
      // d'échange décrivent aussi les runes, et chaque rune porte son propre
      // { effectId, valeur }. Sans le scope, une Rune Pa Vi ferait croire
      // « Vitalité 15 » sur l'item. Vérifié sur capture réelle.
      const got = (itemGid && typeof protocol.scanItemEffects === 'function')
        ? protocol.scanItemEffects(buf, itemGid, effects)
        : protocol.scanEffects(buf, effects);
      if (Object.keys(got).length) {
        // Ce paquet parle de l'item : on le garde sous le coude pour pouvoir
        // y retrouver le reliquat quand l'utilisateur nous donnera sa valeur.
        recentItemPackets.push(Buffer.from(buf));
        if (recentItemPackets.length > RECENT_MAX) recentItemPackets.shift();
        if (reliquatPath && typeof protocol.readFieldPath === 'function') {
          const v = protocol.readFieldPath(buf, reliquatPath);
          if (v !== null) reliquat = v;
        }
        // Le message décrit l'item EN ENTIER : une caractéristique suivie qui
        // n'y figure pas a été détruite, elle vaut donc zéro.
        //
        // Fusionner avec l'état précédent était un bug grave : une ligne
        // rasée gardait sa dernière valeur connue, STAKK la croyait encore
        // atteinte, jugeait la phase de base terminée et enchaînait sur l'exo
        // alors qu'il ne restait qu'une ligne debout.
        const before = stats;
        const next = {};
        for (const eid of effects) next[eid] = got[eid] != null ? got[eid] : 0;
        if (before) recordDrop(before, next, buf);
        bumpStats(next);
      }
    }

    /**
     * Injecte un stock lu ailleurs (typiquement à la connexion du personnage,
     * quand le serveur envoie l'inventaire complet — bien avant que
     * l'utilisateur ouvre l'atelier). Sans ça l'observateur ne connaît que les
     * runes passées sur le fil depuis son armement, soit presque rien.
     */
    /** Miroir complet, pour le sauvegarder sur disque. */
    function exportObjects() {
      const out = [];
      for (const [uid, o] of objects) out.push({ uid, gid: o.gid, qty: o.qty });
      return out;
    }

    function seedObjects(seed) {
      observeSeq++;
      const list = (seed || []).filter(o => o && o.uid != null);
      // Le lot rechargé du disque porte l'historique du personnage, intrus
      // compris : il se juge sur lui-même plutôt que sur un miroir vide.
      const reference = uidReference(list.map(o => o.uid));
      for (const o of list) {
        if (implausibleUid(o.uid, reference)) {
          log(`[fm-live] identifiant ${o.uid} (rune ${o.gid}) invraisemblable — ` +
              `${Math.round(o.uid / reference)}× la médiane du stock, écarté`);
          continue;
        }
        upsertObject(o.uid, o.gid, o.qty, observeSeq);
      }
    }

    /**
     * Apprend l'emplacement du reliquat à partir de sa valeur affichée.
     *
     * On ne retient un chemin que s'il est UNIQUE parmi les paquets récents :
     * une valeur qui apparaît à plusieurs endroits (ou nulle part) ne permet
     * pas de conclure, et retenir le mauvais champ serait pire que rien.
     */
    function learnReliquat(value) {
      if (!protocol || typeof protocol.findFieldPaths !== 'function') {
        return { ok: false, reason: 'unsupported' };
      }
      if (!recentItemPackets.length) {
        return { ok: false, reason: 'no-packet', detail: 'aucun paquet d\'atelier observé — ouvre l\'atelier d\'abord' };
      }
      // Un chemin n'est retenu que s'il porte cette valeur dans le paquet le
      // plus récent, et qu'il est le seul.
      const last = recentItemPackets[recentItemPackets.length - 1];
      const paths = protocol.findFieldPaths(last, value);
      if (!paths.length) {
        return {
          ok: false, reason: 'not-found',
          detail: tx('liveResidueNotFound', `valeur ${value} absente du dernier paquet d'atelier`, { value }),
        };
      }
      if (paths.length > 1) {
        return {
          ok: false, reason: 'ambiguous',
          detail: tx('liveResidueAmbiguous',
            `valeur ${value} présente à ${paths.length} endroits — refais un jet puis réessaie avec une autre valeur`,
            { value, n: paths.length }),
          paths: paths.map(p => p.path),
        };
      }
      reliquatPath = paths[0].path;
      reliquat = value;
      return { ok: true, path: reliquatPath, value };
    }

    /**
     * Champs du dernier paquet d'atelier, à plat.
     *
     * Sert à traquer le reliquat : en protobuf, un champ à zéro est OMIS.
     * Un reliquat nul n'apparaît donc nulle part, et il suffit de comparer
     * la liste des champs entre « reliquat = 0 » et « reliquat ≠ 0 » pour
     * voir surgir le bon.
     */
    function dumpLastItemPacket() {
      if (!recentItemPackets.length) return null;
      const buf = recentItemPackets[recentItemPackets.length - 1];
      const fields = protocol.parseStructured(buf)
        .filter(f => f.wire === 0)
        .map(f => ({ path: f.path, value: f.value }));
      return { length: buf.length, fields };
    }

    /**
     * Tout ce que le serveur a envoyé pendant le dernier jet.
     *
     * C'est le seul endroit où le reliquat peut se cacher : le message qui
     * décrit l'item ne le porte pas, donc il voyage dans le message de
     * résultat. On rend les paquets à plat, en signalant celui qui décrit
     * l'item pour pouvoir l'écarter du regard.
     */
    function dumpLastThrow(useRecent) {
      // Les jets faits à la main ne passent pas par throwRune : on retombe
      // alors sur le tampon glissant, qui contient forcément la réponse.
      const source = (!useRecent && lastThrowPackets && lastThrowPackets.length)
        ? lastThrowPackets
        : recentAny.slice(-12);
      if (!source.length) return null;
      return {
        source: (!useRecent && lastThrowPackets && lastThrowPackets.length) ? 'jet' : 'récent',
        drops: drops.map(d => ({ destroyed: d.destroyed })),
        packets: source.map(buf => ({
          length: buf.length,
          describesItem: itemGid
            ? Object.keys(protocol.scanItemEffects(buf, itemGid, effects)).length > 0
            : false,
          fields: protocol.parseStructured(buf)
            .filter(f => f.wire === 0)
            .map(f => ({ path: f.path, value: f.value })),
        })),
      };
    }
    let lastThrowPackets = null;

    /** Vrai quand on a assez observé pour agir sans deviner. */
    function ready() {
      return stats !== null && Object.keys(stats).length > 0;
    }

    function diagnostic() {
      if (ready()) return null;
      return tx('liveNoItemStats',
        'aucun effet d\'item lu sur le canal — ouvre l\'atelier de forgemagie '
        + 'et pose l\'item, STAKK doit voir ses stats avant de jeter quoi que ce soit');
    }

    async function readStats() {
      if (!ready()) throw new Error(diagnostic());
      return { ...(dryRun && shadow ? shadow : stats) };
    }

    // Bascule essai à blanc ↔ envoi réel. Repart d'une ardoise propre : les
    // stats simulées d'un essai précédent ne doivent jamais fuiter dans un run
    // qui envoie vraiment.
    function setDryRun(v) {
      dryRun = !!v;
      shadow = null;
      planned.length = 0;
    }

    async function readStock() {
      return stockByGid();
    }

    /**
     * Résout l'identifiant de pile à jouer pour une rune, à partir de l'état
     * COURANT du miroir. Rend null quand plus aucune pile n'est connue.
     *
     * CONTRAT — le moteur ne désigne jamais qu'un gid. L'uid n'existe qu'entre
     * cet appel et `buildMovePacket`, deux instructions plus loin : l'intervalle
     * pendant lequel il pourrait périmer est nul. Retenir un uid plus tôt (au
     * moment de choisir la rune, par exemple) laissait la pile disparaître
     * entre-temps — consommée, fusionnée ou déplacée — et le serveur ignorait
     * alors le paquet EN SILENCE, sans la moindre erreur.
     *
     * Choix quand plusieurs piles portent le même gid, dans cet ordre :
     *   1. les piles fraîchement refusées passent en dernier. Un refus isolé ne
     *      prouve rien (un jet peut rester sans réponse pour d'autres raisons),
     *      donc on ne les élimine pas — on les évite tant qu'il reste mieux ;
     *   2. l'observation la plus FRAÎCHE (`seq` le plus grand). Une pile que le
     *      serveur vient de décrire est vivante ; les identifiants anciens sont
     *      justement ceux qui ont le plus de chances d'être périmés ;
     *   3. à fraîcheur égale, la pile la plus GROSSE. Le cas est courant : un
     *      inventaire complet annonce toutes les piles dans le même paquet,
     *      donc avec la même fraîcheur. La grosse pile survit à plus de jets,
     *      son identifiant reste donc valide plus longtemps, et on évite de
     *      vider une pile de 1 pour la voir disparaître au jet suivant ;
     *   4. à égalité complète, le plus petit identifiant. Ça n'a aucune vertu
     *      en soi, ça rend juste le choix DÉTERMINISTE au lieu de dépendre de
     *      l'ordre des champs dans le paquet.
     */
    function resolveUid(gid) {
      const list = uidsOf(gid);
      if (!list.length) return null;
      const better = (a, b) => {
        if (a.seq !== b.seq) return a.seq > b.seq;
        if (a.qty !== b.qty) return a.qty > b.qty;
        return a.uid < b.uid;
      };
      // Si tout est suspect on rejoue quand même le meilleur : mieux vaut un
      // refus de plus qu'un blocage définitif.
      const clean = list.filter(o => !(rejectStreak.get(o.uid) > 0));
      let best = null;
      for (const o of (clean.length ? clean : list)) if (!best || better(o, best)) best = o;
      return best ? best.uid : null;
    }

    function statsDiffer(a, b) {
      for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
        if ((a || {})[k] !== (b || {})[k]) return true;
      }
      return false;
    }

    /**
     * Attend un CHANGEMENT réel des stats de l'item, pas juste un paquet.
     *
     * Observé en vrai : le serveur répond d'abord par un paquet qui redonne
     * les valeurs INCHANGÉES, et la nouvelle valeur n'arrive qu'ensuite. En
     * s'arrêtant au premier paquet, tous les jets étaient comptés « raté »
     * alors que la stat montait bel et bien.
     *
     * Un vrai échec de forgemagie ne produit jamais de changement : on lui
     * laisse `graceMs` après la première réponse, puis on conclut.
     */
    async function waitForChange(before, timeoutMs, graceMs) {
      const deadline = now() + timeoutMs;
      // La grâce court À PARTIR de la première réponse, une seule fois. La
      // réarmer à chaque paquet faisait durer tous les jets jusqu'à
      // l'échéance : l'atelier redécrit l'item en continu, donc il y a
      // toujours un paquet de plus avant la fin de la grâce. Relevé en vrai :
      // 2,1 s par jet pour un serveur qui répond en 35 ms.
      let graceDeadline = null;
      for (;;) {
        const limit = graceDeadline === null ? deadline : Math.min(graceDeadline, deadline);
        const budget = Math.max(0, limit - now());
        if (budget <= 0) return { changed: statsDiffer(stats, before), answered: graceDeadline !== null };
        const bumped = await waitForStats(budget);
        if (statsDiffer(stats, before)) return { changed: true, answered: true };
        // Plus rien ne vient. `answered` dit si le serveur avait répondu au
        // moins une fois : c'est ce qui sépare une FM ratée d'un paquet ignoré.
        if (!bumped) return { changed: false, answered: graceDeadline !== null };
        if (graceDeadline === null) graceDeadline = now() + graceMs;
      }
    }

    function waitForStats(timeoutMs) {
      return new Promise(resolve => {
        let done = false;
        const timer = setTimeoutFn(() => {
          if (done) return;
          done = true;
          const i = waiters.indexOf(onBump);
          if (i >= 0) waiters.splice(i, 1);
          resolve(false);
        }, timeoutMs);
        function onBump() {
          if (done) return;
          done = true;
          clearTimeoutFn(timer);
          resolve(true);
        }
        waiters.push(onBump);
      });
    }

    const sleep = ms => new Promise(r => setTimeoutFn(r, ms));

    // Consomme une rune dans les vues locales. Le serveur ne renvoie pas
    // toujours l'inventaire complet après une consommation.
    function consume(uid) {
      const o = objects.get(uid);
      if (!o) return;
      upsertObject(uid, o.gid, o.qty - 1, o.seq);
    }

    /**
     * Écarte un identifiant que le serveur vient de refuser.
     *
     * Un uid lu à la connexion peut être périmé : la pile a été consommée,
     * déplacée ou fusionnée depuis. Le serveur répond alors « objet indisponible »
     * et s'obstiner ne ferait que répéter le même refus.
     */
    // Piles retirées sur refus, gardées de côté au cas où le verdict serait à
    // refaire (cf. clearRejects). Bornée par la taille de l'inventaire.
    const droppedByReject = new Map();   // uid → { gid, qty, seq }

    function dropUid(uid) {
      const o = objects.get(uid);
      if (o) droppedByReject.set(uid, { ...o });
      objects.delete(uid);
    }

    /**
     * Annule les verdicts de refus : ardoises remises à zéro ET piles écartées
     * réinjectées.
     *
     * Appelé quand le gabarit de pose vient de changer. Les refus encaissés
     * sous l'ancien format ne disaient rien des identifiants — c'est le paquet
     * qui était mauvais. Garder les ardoises ferait écarter une pile saine au
     * premier vrai refus ; ne pas rendre les piles déjà retirées laissait le
     * moteur sans rien à jouer juste après avoir retrouvé le bon gabarit,
     * et le run mourait sur « plus de rune jetable ».
     *
     * @returns nombre de piles réinjectées
     */
    function clearRejects() {
      rejectStreak.clear();
      let back = 0;
      for (const [uid, o] of droppedByReject) {
        if (objects.has(uid)) continue;
        objects.set(uid, { ...o });
        back++;
      }
      droppedByReject.clear();
      return back;
    }

    /**
     * Jette une rune : pose + forge, puis attend la relecture des effets.
     * @param runeGid gid de la rune choisie par le moteur
     * @param action  décision du moteur (porte `amount` et `effectId`)
     */
    async function throwRune(runeGid, action) {
      if (!ready()) throw new Error(diagnostic());
      const before = { ...(dryRun && shadow ? shadow : stats) };

      // Résolution au DERNIER moment : l'uid est lu ici et consommé à la ligne
      // suivante (cf. resolveUid).
      const uid = resolveUid(runeGid);
      if (uid == null) {
        // Plus aucune pile pour ce gid : c'est une absence de RUNE, pas une
        // panne technique. Le code permet à fm.js d'enchaîner sur son message
        // d'absence de rune au lieu de couper le run sur « jet impossible ».
        const err = new Error(tx('liveNoReliableUid',
          `aucun identifiant fiable pour la rune ${runeGid} dans l'inventaire`, { rune: runeGid }));
        err.code = 'no-stack';
        err.runeGid = runeGid;
        throw err;
      }
      const active = currentProfile();
      const move = protocol.buildMovePacket(active, uid);

      if (dryRun) {
        // Les mêmes octets sont construits (donc les mêmes erreurs de profil
        // sortent), ils ne partent simplement pas.
        const ready_ = protocol.buildReadyPacket(active);
        const entry = {
          runeGid, uid,
          moveHex: move.toString('hex'),
          readyHex: ready_.toString('hex'),
          moveLength: move.length,
        };
        planned.push(entry);
        if (typeof opts.onDryRun === 'function') {
          try { opts.onDryRun(entry); } catch { /* le journal ne doit rien casser */ }
        }
        consume(uid);
        const amount = action && Number.isFinite(action.amount) ? action.amount : 0;
        const effectId = action && action.effectId;
        shadow = { ...before };
        if (effectId != null && amount > 0) {
          shadow[effectId] = (shadow[effectId] || 0) + amount;
        }
        return { ok: amount > 0, stats: { ...shadow }, dryRun: true, planned: entry };
      }

      if (!channel.sendToServer(move)) throw new Error(tx('liveChannelClosed', 'envoi impossible (canal fermé)'));
      if (readyDelay > 0) await sleep(readyDelay);
      if (!channel.sendToServer(protocol.buildReadyPacket(active))) {
        throw new Error(tx('liveChannelClosed', 'envoi impossible (canal fermé)'));
      }

      const seqAtSend = observeSeq;
      throwWindow = [];                       // on enregistre la réponse
      const { changed, answered } = await waitForChange(before, throwTimeout, graceMs);
      lastThrowPackets = throwWindow;
      throwWindow = null;
      const after = { ...stats };

      // Le serveur a-t-il seulement pris l'objet en compte ? S'il n'a rien
      // dit du tout — ni paquet d'atelier, ni écho de la pile — c'est un refus
      // (« objet indisponible ») et non un échec de forgemagie : l'identifiant
      // est mort, on l'écarte au lieu de rejouer le même refus.
      //
      // `answered` est décisif : une forgemagie ratée ne fait pas toujours
      // bouger une stat, mais le serveur redécrit TOUJOURS l'item. Sans cette
      // preuve, un échec de FM ordinaire passait pour un refus et sortait une
      // pile saine du miroir au bout de trois.
      const o = objects.get(uid);
      const echoed = !!o && o.seq > seqAtSend;
      const silent = !changed && !answered && !statsDiffer(after, before) && !echoed;

      // Un gabarit PROUVÉ a déjà obtenu des réponses du serveur. Une rune qui
      // part sans rien changer n'est alors pas un paquet ignoré : c'est
      // l'échec ORDINAIRE de la forgemagie, celui qui consomme la rune et du
      // reliquat sans toucher à une seule stat. Rien de ce qu'on surveille ne
      // bouge — ni effet suivi, ni écho de pile — d'où la confusion.
      //
      // Vécu le 12/08/2026 : quatre jets encaissés, puis six échecs de FM
      // normaux comptés comme des refus. STAKK a retiré deux piles saines de
      // son miroir puis arrêté le run sur « protocole périmé », alors que la
      // forge fonctionnait neuf secondes plus tôt.
      if (silent && !profileProven()) {
        const streak = (rejectStreak.get(uid) || 0) + 1;
        rejectStreak.set(uid, streak);
        if (streak >= REJECTS_BEFORE_DROP) {
          dropUid(uid);
          rejectStreak.delete(uid);
          log(`[fm-live] identifiant ${uid} (rune ${runeGid}) refusé ${streak} fois — retiré du miroir`);
          return { ok: false, stats: after, rejected: true, dropped: true, uid };
        }
        log(`[fm-live] rune ${runeGid} sans réponse (identifiant ${uid}, ${streak}/${REJECTS_BEFORE_DROP}) — mise de côté`);
        return { ok: false, stats: after, rejected: true, uid, streak };
      }

      // Le serveur a répondu : cet identifiant est bon, on efface son ardoise.
      rejectStreak.delete(uid);

      // Le serveur a repris la main sur cette pile : sa quantité fait foi,
      // inutile de la décrémenter nous-mêmes.
      if (!echoed) consume(uid);
      if (!changed && !statsDiffer(after, before)) {
        // Jet parti mais sans effet : c'est l'échec normal de la forgemagie.
        return { ok: false, stats: after, timeout: !echoed };
      }
      return { ok: true, stats: after };
    }

    return {
      get name() { return dryRun ? 'dry' : 'live'; },
      observe, ready, diagnostic,
      readStock, readStats, throwRune,
      seedObjects, exportObjects, setDryRun, learnReliquat, clearRejects,
      dumpLastItemPacket, dumpLastThrow,
      reliquatPath: () => reliquatPath,
      reliquat: () => reliquat,
      fieldMap,
      isDryRun: () => dryRun,
      plannedPackets: () => planned.slice(),
      // exposés pour les tests et le diagnostic UI
      _state: () => {
        const uids = {};
        for (const [uid, o] of objects) {
          if (o.gid == null) continue;
          (uids[o.gid] = uids[o.gid] || []).push(uid);
        }
        return {
          stock: stockByGid(), uids,
          objects: objects.size,
          stats: stats && { ...stats }, statsVersion, statsSeenAt,
          reliquat, reliquatPath, itemPackets: recentItemPackets.length,
          fieldMap: fieldMap(),
          dryRun, planned: planned.length,
        };
      },
    };
  }

  return { create, DEFAULT_THROW_TIMEOUT_MS, DEFAULT_READY_DELAY_MS, DEFAULT_GRACE_MS };
};
