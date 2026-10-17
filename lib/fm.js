'use strict';

/**
 * fm.js — Plugin Forgemagie.
 *
 * Assemble les trois couches :
 *   fm-data.js    → items / runes / libellés (dofusdb)
 *   fm-engine.js  → quelle rune jeter (pur, testé)
 *   ce fichier    → boucle d'exécution, routes HTTP, transport
 *
 * ── Transports ────────────────────────────────────────────────────────────
 * Le moteur ne sait pas parler à Dofus ; il délègue à un TRANSPORT qui
 * implémente trois méthodes :
 *
 *   readStock()            → { [runeGid]: quantité }   runes en inventaire
 *   readStats()            → { [effectId]: valeur }    stats de l'item posé
 *   throwRune(runeGid)     → { ok, stats }             jette une rune, relit
 *
 * Deux transports existent :
 *   - 'sim'  : simulateur local. Aucun Dofus requis. Sert à valider toute la
 *              chaîne (UI, boucle, journal, arrêt) et à s'entraîner.
 *   - 'live' : vrai jeu via le tap paquets du game-proxy. Nécessite une
 *              CALIBRATION préalable (voir plus bas) : sans elle il refuse de
 *              démarrer plutôt que d'envoyer des paquets au hasard.
 *
 * ── Calibration ───────────────────────────────────────────────────────────
 * Les msgId et l'encodage des messages d'échange changent à chaque build
 * Dofus (champs protobuf réobfusqués). Plutôt que de hardcoder des valeurs qui
 * casseront à la prochaine MAJ, STAKK les APPREND : l'utilisateur ouvre un
 * atelier de forgemagie et jette deux runes différentes à la main pendant que
 * le plugin enregistre le canal. Le dump est écrit dans
 * ~/.stakk/fm-capture-<accountId>.log et sert de base au décodage.
 */

module.exports = function createFm(deps) {
  const {
    fs, path, os, https,
    on, registerRoute, log,
    loadConfig, saveConfig,
    setPacketHandler, getGameChannel,
    DATA_DIR,
  } = deps;

  // Un plugin ne require() pas ses voisins : les factories arrivent par la
  // deps bag ; le require n'est qu'un confort pour les tests locaux. Si elles
  // manquent, on se désactive proprement au lieu de faire planter le
  // chargement des plugins.
  let createFmData, createFmEngine, createFmProtocol, createFmLive;
  try {
    createFmData = deps.createFmData || require('./fm-data');
    createFmEngine = deps.createFmEngine || require('./fm-engine');
    createFmLive = deps.createFmLive === null ? null : (deps.createFmLive || require('./fm-live'));
    // `null` explicite = l'exe sait qu'il ne l'a pas → on ne tente pas le
    // require de repli (qui ne marche qu'en dev, sur l'arborescence source).
    createFmProtocol = deps.createFmProtocol === null
      ? null
      : (deps.createFmProtocol || require('./fm-protocol'));
  } catch { /* résolu juste après */ }
  if (typeof createFmData !== 'function' || typeof createFmEngine !== 'function') {
    log('[fm] désactivé : cette version de STAKK ne fournit pas fm-data/fm-engine');
    return {};
  }
  // fm-protocol n'est requis que pour la calibration : son absence dégrade la
  // fonctionnalité (mode Jeu indisponible) sans couper l'onglet.
  // tx() = m() restreint aux clés connues : un sous-module plus récent que
  // ce dictionnaire garde alors son propre texte de repli au lieu
  // d'afficher un nom de clé.
  const tx = (key, vars) => (MSG.fr[key] ? m(key, vars) : null);
  // Socle partagé d'apprentissage : parcours protobuf sans schéma, appariement
  // action/confirmation et cycle de vie des profils. Même motif que fm-data et
  // fm-engine — la factory arrive par la deps bag, le require n'est qu'un repli
  // pour le dev et le bundle, et un `null` explicite coupe aussi ce repli.
  // Résolu AVANT createFmProtocol : fm-protocol.js a besoin de ce même socle
  // (il lève sans lui) et, chargé en hot, ne peut pas le retrouver par son
  // propre require — il faut le lui transmettre explicitement ci-dessous.
  const createProtocolLearn = deps.createProtocolLearn === null
    ? null
    : (deps.createProtocolLearn || (() => {
        try { return require('./protocol-learn'); } catch { return null; }
      })());
  // fm-protocol lève si le socle protocol-learn lui manque (cf. plus bas) : un
  // exe qui ne connaît pas encore protocol-learn ferait alors exploser CETTE
  // factory avant même d'atteindre son propre garde-fou, ce qui compromettrait
  // le chargement des autres plugins. On absorbe donc l'exception ici et on
  // laisse la dégradation habituelle (learn absent → log + return {}) faire
  // son travail juste après. On transmet notre propre créateur déjà résolu
  // (null compris) : fm-protocol.js, hot-loadé, n'a pas d'autre moyen de
  // l'obtenir que par cette deps bag.
  let protocol = null;
  if (typeof createFmProtocol === 'function') {
    try { protocol = createFmProtocol({ t: tx, createProtocolLearn }); }
    catch (e) {
      protocol = null;
      log(`[fm] fm-protocol indisponible (mode Jeu désactivé) : ${e.message}`);
    }
  }
  const learn = typeof createProtocolLearn === 'function' ? createProtocolLearn() : null;
  // Sans lui, plus rien ne dit quel gabarit envoyer ni quand on a le droit de
  // le remplacer : la forge n'a plus de sens. On se désactive comme ci-dessus
  // plutôt que de lever — une exception ici couperait le chargement de tous
  // les autres plugins.
  if (!learn) {
    log('[fm] désactivé : cette version de STAKK ne fournit pas protocol-learn');
    return {};
  }
  // Poids de forgemagie : sert à afficher le coût d'un exotique et la marge
  // restante sur chaque ligne. Facultatif — son absence ne bloque rien.
  const createFmWeights = deps.createFmWeights === null
    ? null
    : (deps.createFmWeights || (() => { try { return require('./fm-weights'); } catch { return null; } })());
  const weights = typeof createFmWeights === 'function' ? createFmWeights() : null;
  const liveFactory = (protocol && typeof createFmLive === 'function')
    ? createFmLive({ protocol, t: tx })
    : null;

  const STAKK_DIR = path.join(os.homedir(), '.stakk');
  const data = createFmData({ https, fs, path, os, log, cacheDir: STAKK_DIR });
  const engine = createFmEngine();

  const MAX_LOG = 200;
  const MAX_HISTORY = 120;
  const MAX_THROWS = 2000;          // garde-fou dur contre une boucle folle
  // sim = local pur ; dry = parcours réel sans envoi ; live = envoi effectif.
  const TRANSPORTS = new Set(['sim', 'dry', 'live']);
  const REJECTS_BEFORE_DROP_LABEL = 3;        // doit suivre fm-live
  const WAIT_ITEM_POLL_MS = 500;              // sondage pendant l'attente d'un item
  const WAIT_ITEM_TIMEOUT_MS = 3 * 60 * 1000; // au-delà, on considère l'user parti
  // Refus d'affilée tolérés avant de conclure que le protocole est périmé.
  // 6 = deux piles différentes épuisant chacune ses 3 tentatives.
  const NO_ANSWER_LIMIT = 6;

  // ─── i18n des messages du journal ────────────────────────────────────────
  // Le journal et l'historique de forge sont affichés tels quels dans l'UI :
  // les messages doivent donc suivre la langue choisie par l'utilisateur.
  // Elle est écrite par le plugin overlay-backend dans ~/.stakk/overlay/lang.json
  // (l'UI la pousse via POST /api/overlay/lang) ; on la relit avec un petit TTL
  // pour ne pas toucher au disque à chaque ligne de log.
  const LANG_FILE = path.join(STAKK_DIR, 'overlay', 'lang.json');
  const LANG_TTL_MS = 5000;
  let langCache = { lang: 'fr', at: 0 };
  function uiLang() {
    if (Date.now() - langCache.at < LANG_TTL_MS) return langCache.lang;
    let lang = 'fr';
    try {
      const parsed = JSON.parse(fs.readFileSync(LANG_FILE, 'utf8'));
      if (MSG[parsed.lang]) lang = parsed.lang;
    } catch { /* pas encore choisie → français */ }
    langCache = { lang, at: Date.now() };
    return lang;
  }
  // Libellé d'une stat : fm-data récent expose `label` déjà résolu dans la
  // langue courante ; un fm-data plus ancien (module hot pas encore mis à
  // jour) n'a que des champs par langue. On accepte les deux.
  function effLabel(tables, effectId, fallback) {
    const e = tables && tables.effects ? tables.effects[effectId] : null;
    if (!e) return fallback;
    return e.label || e[uiLang()] || e.fr || e.en || fallback;
  }

  // m('cle', { var: valeur }) — les {var} du message sont substitués.
  function m(key, vars) {
    const table = MSG[uiLang()] || MSG.fr;
    let s = table[key] || MSG.fr[key] || key;
    if (vars) for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(String(vars[k]));
    return s;
  }

  const MSG = {
    fr: {
      protocolStale: 'aucun jet n\'obtient de réponse — le format d\'échange a changé côté Dofus. Pose une rune à la main dans l\'atelier : STAKK réapprend le protocole tout seul, puis relance.',
      protocolFallback: 'le protocole appris ne répond plus — retour au gabarit intégré, la forge repart toute seule',
      liveNoItemStats: 'aucun effet d\'item lu sur le canal — ouvre l\'atelier de forgemagie et pose l\'item, STAKK doit voir ses stats avant de jeter quoi que ce soit',
      liveResidueNotFound: 'valeur {value} absente du dernier paquet d\'atelier',
      liveResidueAmbiguous: 'valeur {value} présente à {n} endroits — refais un jet puis réessaie avec une autre valeur',
      liveNoReliableUid: 'aucun identifiant fiable pour la rune {rune} dans l\'inventaire',
      liveChannelClosed: 'envoi impossible (canal fermé)',
      protoCaptureEmpty: 'capture vide ou format non reconnu',
      protoNoMove: 'aucun paquet « pose de rune » identifié sur {n} paquets sortants — il faut jeter DEUX runes de types différents pendant la capture',
      protoNoReady: 'pose de rune identifiée, mais aucune commande de forge dans la capture — après avoir posé une rune, clique sur Forger avant d\'arrêter la capture',
      fmEffectFallback: 'Effet',
      notCalibrated: 'protocole FM indisponible — fais une capture puis analyse-la',
      notArmed: "observation de l'atelier pas encore prête",
      itemMismatch: 'observation armée sur « {name} », pas sur l\'item choisi',
      queueDone: '{n} exemplaire(s) terminé(s) — file épuisée',
      startRun: 'démarrage{which} — {item} ({n} stat(s), transport {transport})',
      resumeRun: 'reprise après changement de réglages — {item}',
      initialReadFailed: 'lecture initiale impossible : {msg}',
      doneIn: 'terminé en {n} jet(s)',
      noUsableRune: 'aucune utilisable',
      blocked: 'plus de rune jetable — {detail}',
      stockKnown: "stock connu : {n} type(s) d'objet. STAKK ne lit que ce qui passe sur le réseau ; si le compte tournait déjà avant l'installation, relance le personnage pour que le serveur renvoie ton inventaire complet.",
      guardrail: 'garde-fou : {n} jets atteints, arrêt',
      throwFailed: 'jet impossible : {msg}',
      exoWon: 'EXO {label} obtenu — forge arrêtée',
      runeDropped: '{rune} : identifiant refusé {n} fois, retiré du stock',
      runeNoAnswer: '{rune} sans réponse du jeu — je réessaierai avec une autre pile',
      throwResult: '{rune} sur {label} → {value}/{goal}{failed}',
      failedSuffix: ' (raté)',
      itemRuined: "item ruiné — il ne reste que {pct} % de son poids d'origine",
      brokenNoOrb: "item cassé et pas d'orbe disponible",
      gamePace: "réponse du jeu en {s} s — c'est elle qui cadence, pas le réglage",
      swapItem: 'exemplaire terminé — retire-le et pose le suivant ({n} restant(s)), la forge reprend toute seule',
      newItemDetected: 'nouvel exemplaire détecté — reprise',
      noItemInTime: 'aucun exemplaire posé dans le délai — file interrompue',
      orbNeeded: 'item cassé mais aucune orbe en inventaire — pour un item niveau {level} il faut : {names}',
      noKnownOrb: 'aucune orbe connue',
      orbUsed: 'item cassé — remise à neuf avec {name}',
      orbRejected: 'orbe refusée par le jeu',
      itemReset: 'item remis à neuf — on repart sur les stats de base',
      orbResetFailed: 'remise à neuf impossible : {msg}',
      runAlready: 'un run FM tourne déjà sur ce compte',
      dryNotSent: '[essai à blanc] non envoyé : pose {len} o (rune {rune}, uid {uid}) + forge',
      stopRequested: 'arrêt demandé',
      tapUnavailable: 'tap paquets indisponible sur cette version',
      analyzerUnavailable: 'analyseur de protocole indisponible sur cette version',
      stopCaptureFirst: "arrête la capture avant de l'analyser",
      noCapture: "aucune capture trouvée — lance une capture d'abord",
      residueValueRequired: 'valeur du reliquat requise',
      notArmedOpenWorkshop: "observation non armée — ouvre l'atelier d'abord",
      notArmedShort: 'observation non armée',
      accountDisconnected: 'compte déconnecté',
      accountDisconnectedRun: 'compte déconnecté — run arrêté',
      captureHowto1: "# Mode d'emploi : ouvre un atelier de forgemagie, pose l'item,",
      captureHowto2: "# jette UNE rune A, puis UNE rune B d'un autre type. Puis stoppe.",
    },
    en: {
      protocolStale: 'no throw gets an answer — the exchange format changed on the Dofus side. Place one rune by hand in the workshop: STAKK relearns the protocol on its own, then start again.',
      protocolFallback: 'the learned protocol stopped answering — falling back to the built-in template, forging resumes on its own',
      liveNoItemStats: 'no item effect read on the channel — open the smithmagic workshop and place the item, STAKK must see its stats before throwing anything',
      liveResidueNotFound: 'value {value} is absent from the last workshop packet',
      liveResidueAmbiguous: 'value {value} appears in {n} places — do another throw then retry with a different value',
      liveNoReliableUid: 'no reliable identifier for rune {rune} in the inventory',
      liveChannelClosed: 'send failed (channel closed)',
      protoCaptureEmpty: 'empty capture or unrecognised format',
      protoNoMove: 'no “rune placement” packet identified out of {n} outgoing packets — you must throw TWO runes of different types during the capture',
      protoNoReady: 'rune placement identified, but no forge command in the capture — after placing a rune, click Forge before stopping the capture',
      fmEffectFallback: 'Effect',
      notCalibrated: 'smithmagic protocol unavailable — run a capture then analyse it',
      notArmed: 'workshop observation not ready yet',
      itemMismatch: 'observation armed on “{name}”, not on the selected item',
      queueDone: '{n} copy/copies finished — queue empty',
      startRun: 'starting{which} — {item} ({n} stat(s), transport {transport})',
      resumeRun: 'resuming after settings change — {item}',
      initialReadFailed: 'initial read failed: {msg}',
      doneIn: 'done in {n} throw(s)',
      noUsableRune: 'none usable',
      blocked: 'no throwable rune left — {detail}',
      stockKnown: 'known stock: {n} item type(s). STAKK only reads what goes over the network; if the account was already running before the install, restart the character so the server sends your full inventory.',
      guardrail: 'safety net: {n} throws reached, stopping',
      throwFailed: 'throw failed: {msg}',
      exoWon: 'EXO {label} landed — forging stopped',
      runeDropped: '{rune}: identifier rejected {n} times, removed from stock',
      runeNoAnswer: '{rune} got no answer from the game — I will retry with another stack',
      throwResult: '{rune} on {label} → {value}/{goal}{failed}',
      failedSuffix: ' (failed)',
      itemRuined: 'item ruined — only {pct} % of its original weight is left',
      brokenNoOrb: 'item broken and no orb available',
      gamePace: 'the game answered in {s} s — it sets the pace, not the setting',
      swapItem: 'copy finished — remove it and place the next one ({n} left), forging resumes on its own',
      newItemDetected: 'new copy detected — resuming',
      noItemInTime: 'no copy placed in time — queue interrupted',
      orbNeeded: 'item broken but no orb in the inventory — for a level {level} item you need: {names}',
      noKnownOrb: 'no known orb',
      orbUsed: 'item broken — resetting it with {name}',
      orbRejected: 'orb rejected by the game',
      itemReset: 'item reset — starting again from the base stats',
      orbResetFailed: 'reset failed: {msg}',
      runAlready: 'a smithmagic run is already going on this account',
      dryNotSent: '[dry run] not sent: place {len} B (rune {rune}, uid {uid}) + forge',
      stopRequested: 'stop requested',
      tapUnavailable: 'packet tap unavailable on this version',
      analyzerUnavailable: 'protocol analyser unavailable on this version',
      stopCaptureFirst: 'stop the capture before analysing it',
      noCapture: 'no capture found — run a capture first',
      residueValueRequired: 'residue value required',
      notArmedOpenWorkshop: 'observation not armed — open the workshop first',
      notArmedShort: 'observation not armed',
      accountDisconnected: 'account disconnected',
      accountDisconnectedRun: 'account disconnected — run stopped',
      captureHowto1: '# How to: open a smithmagic workshop, place the item,',
      captureHowto2: '# throw ONE rune A, then ONE rune B of another type. Then stop.',
    },
    es: {
      protocolStale: 'ninguna tirada obtiene respuesta — el formato de intercambio cambió en Dofus. Coloca una runa a mano en el taller: STAKK vuelve a aprender el protocolo solo, y luego reinicia.',
      protocolFallback: 'el protocolo aprendido ya no responde — se vuelve a la plantilla integrada, la forja continúa sola',
      liveNoItemStats: 'ningún efecto de objeto leído en el canal — abre el taller de forjamagia y coloca el objeto, STAKK debe ver sus características antes de lanzar nada',
      liveResidueNotFound: 'el valor {value} no está en el último paquete del taller',
      liveResidueAmbiguous: 'el valor {value} aparece en {n} sitios — haz otra tirada y reintenta con otro valor',
      liveNoReliableUid: 'ningún identificador fiable para la runa {rune} en el inventario',
      liveChannelClosed: 'envío imposible (canal cerrado)',
      protoCaptureEmpty: 'captura vacía o formato no reconocido',
      protoNoMove: 'ningún paquete de «colocación de runa» identificado entre {n} paquetes salientes — hay que lanzar DOS runas de tipos distintos durante la captura',
      protoNoReady: 'colocación de runa identificada, pero ningún comando de forja en la captura — tras colocar una runa, haz clic en Forjar antes de detener la captura',
      fmEffectFallback: 'Efecto',
      notCalibrated: 'protocolo de forjamagia no disponible — haz una captura y analízala',
      notArmed: 'la observación del taller aún no está lista',
      itemMismatch: 'observación activada en «{name}», no en el objeto elegido',
      queueDone: '{n} ejemplar(es) terminado(s) — cola vacía',
      startRun: 'inicio{which} — {item} ({n} característica(s), transporte {transport})',
      resumeRun: 'reanudando tras el cambio de ajustes — {item}',
      initialReadFailed: 'lectura inicial imposible: {msg}',
      doneIn: 'terminado en {n} tirada(s)',
      noUsableRune: 'ninguna utilizable',
      blocked: 'no quedan runas lanzables — {detail}',
      stockKnown: 'stock conocido: {n} tipo(s) de objeto. STAKK solo lee lo que pasa por la red; si la cuenta ya estaba en marcha antes de la instalación, reinicia el personaje para que el servidor envíe tu inventario completo.',
      guardrail: 'límite de seguridad: {n} tiradas alcanzadas, parando',
      throwFailed: 'tirada imposible: {msg}',
      exoWon: 'EXO {label} conseguido — forja detenida',
      runeDropped: '{rune}: identificador rechazado {n} veces, retirado del stock',
      runeNoAnswer: '{rune} sin respuesta del juego — lo reintentaré con otra pila',
      throwResult: '{rune} en {label} → {value}/{goal}{failed}',
      failedSuffix: ' (fallo)',
      itemRuined: 'objeto arruinado — solo queda el {pct} % de su peso original',
      brokenNoOrb: 'objeto roto y sin orbe disponible',
      gamePace: 'el juego respondió en {s} s — es él quien marca el ritmo, no el ajuste',
      swapItem: 'ejemplar terminado — retíralo y coloca el siguiente ({n} restante(s)), la forja se reanuda sola',
      newItemDetected: 'nuevo ejemplar detectado — reanudando',
      noItemInTime: 'ningún ejemplar colocado a tiempo — cola interrumpida',
      orbNeeded: 'objeto roto pero sin orbe en el inventario — para un objeto de nivel {level} necesitas: {names}',
      noKnownOrb: 'ningún orbe conocido',
      orbUsed: 'objeto roto — restaurándolo con {name}',
      orbRejected: 'orbe rechazado por el juego',
      itemReset: 'objeto restaurado — volvemos a las características de base',
      orbResetFailed: 'restauración imposible: {msg}',
      runAlready: 'ya hay una ejecución de forjamagia en esta cuenta',
      dryNotSent: '[prueba en vacío] no enviado: colocar {len} B (runa {rune}, uid {uid}) + forjar',
      stopRequested: 'parada solicitada',
      tapUnavailable: 'captura de paquetes no disponible en esta versión',
      analyzerUnavailable: 'analizador de protocolo no disponible en esta versión',
      stopCaptureFirst: 'detén la captura antes de analizarla',
      noCapture: 'ninguna captura encontrada — lanza una captura primero',
      residueValueRequired: 'valor del remanente necesario',
      notArmedOpenWorkshop: 'observación no activada — abre primero el taller',
      notArmedShort: 'observación no activada',
      accountDisconnected: 'cuenta desconectada',
      accountDisconnectedRun: 'cuenta desconectada — ejecución detenida',
      captureHowto1: '# Instrucciones: abre un taller de forjamagia, coloca el objeto,',
      captureHowto2: '# lanza UNA runa A y luego UNA runa B de otro tipo. Después detén.',
    },
    de: {
      protocolStale: 'kein Wurf erhält eine Antwort — das Austauschformat hat sich auf Dofus-Seite geändert. Setze eine Rune von Hand in der Werkstatt ein: STAKK lernt das Protokoll von selbst neu, dann starte erneut.',
      protocolFallback: 'das gelernte Protokoll antwortet nicht mehr — zurück zur eingebauten Vorlage, das Schmieden läuft von selbst weiter',
      liveNoItemStats: 'kein Gegenstandseffekt auf dem Kanal gelesen — öffne die Schmiedemagie-Werkstatt und lege den Gegenstand ein, STAKK muss seine Werte sehen, bevor es etwas wirft',
      liveResidueNotFound: 'Wert {value} fehlt im letzten Werkstattpaket',
      liveResidueAmbiguous: 'Wert {value} kommt an {n} Stellen vor — mach einen weiteren Wurf und versuche es mit einem anderen Wert',
      liveNoReliableUid: 'keine verlässliche Kennung für Rune {rune} im Inventar',
      liveChannelClosed: 'Senden nicht möglich (Kanal geschlossen)',
      protoCaptureEmpty: 'leere Aufzeichnung oder unbekanntes Format',
      protoNoMove: 'kein „Rune einsetzen“-Paket unter {n} ausgehenden Paketen erkannt — du musst während der Aufzeichnung ZWEI Runen unterschiedlichen Typs werfen',
      protoNoReady: 'Runeneinsatz erkannt, aber kein Schmiedebefehl in der Aufzeichnung — klicke nach dem Einsetzen einer Rune auf Schmieden, bevor du die Aufzeichnung stoppst',
      fmEffectFallback: 'Effekt',
      notCalibrated: 'Schmiedemagie-Protokoll nicht verfügbar — mach eine Aufzeichnung und analysiere sie',
      notArmed: 'Werkstatt-Beobachtung noch nicht bereit',
      itemMismatch: 'Beobachtung auf „{name}“ aktiviert, nicht auf dem gewählten Gegenstand',
      queueDone: '{n} Exemplar(e) fertig — Warteschlange leer',
      startRun: 'Start{which} — {item} ({n} Eigenschaft(en), Transport {transport})',
      resumeRun: 'Fortsetzung nach Einstellungsänderung — {item}',
      initialReadFailed: 'erstes Auslesen fehlgeschlagen: {msg}',
      doneIn: 'fertig nach {n} Wurf/Würfen',
      noUsableRune: 'keine brauchbare',
      blocked: 'keine werfbare Rune mehr — {detail}',
      stockKnown: 'bekannter Bestand: {n} Gegenstandstyp(en). STAKK liest nur, was über das Netzwerk läuft; lief das Konto schon vor der Installation, starte den Charakter neu, damit der Server dein vollständiges Inventar sendet.',
      guardrail: 'Sicherung: {n} Würfe erreicht, Abbruch',
      throwFailed: 'Wurf nicht möglich: {msg}',
      exoWon: 'EXO {label} erhalten — Schmieden gestoppt',
      runeDropped: '{rune}: Kennung {n}-mal abgelehnt, aus dem Bestand entfernt',
      runeNoAnswer: '{rune} ohne Antwort des Spiels — ich versuche es mit einem anderen Stapel',
      throwResult: '{rune} auf {label} → {value}/{goal}{failed}',
      failedSuffix: ' (misslungen)',
      itemRuined: 'Gegenstand ruiniert — nur noch {pct} % seines ursprünglichen Gewichts',
      brokenNoOrb: 'Gegenstand zerbrochen und kein Orb verfügbar',
      gamePace: 'das Spiel antwortete in {s} s — es gibt den Takt vor, nicht die Einstellung',
      swapItem: 'Exemplar fertig — nimm es heraus und lege das nächste ein ({n} übrig), das Schmieden läuft von selbst weiter',
      newItemDetected: 'neues Exemplar erkannt — Fortsetzung',
      noItemInTime: 'kein Exemplar rechtzeitig eingelegt — Warteschlange abgebrochen',
      orbNeeded: 'Gegenstand zerbrochen, aber kein Orb im Inventar — für einen Gegenstand der Stufe {level} brauchst du: {names}',
      noKnownOrb: 'kein bekannter Orb',
      orbUsed: 'Gegenstand zerbrochen — Zurücksetzen mit {name}',
      orbRejected: 'Orb vom Spiel abgelehnt',
      itemReset: 'Gegenstand zurückgesetzt — weiter mit den Grundwerten',
      orbResetFailed: 'Zurücksetzen nicht möglich: {msg}',
      runAlready: 'auf diesem Konto läuft bereits ein Schmiedemagie-Durchlauf',
      dryNotSent: '[Trockenlauf] nicht gesendet: Einsetzen {len} B (Rune {rune}, uid {uid}) + Schmieden',
      stopRequested: 'Stopp angefordert',
      tapUnavailable: 'Paket-Tap in dieser Version nicht verfügbar',
      analyzerUnavailable: 'Protokoll-Analyse in dieser Version nicht verfügbar',
      stopCaptureFirst: 'stoppe die Aufzeichnung, bevor du sie analysierst',
      noCapture: 'keine Aufzeichnung gefunden — starte zuerst eine Aufzeichnung',
      residueValueRequired: 'Restwert erforderlich',
      notArmedOpenWorkshop: 'Beobachtung nicht aktiviert — öffne zuerst die Werkstatt',
      notArmedShort: 'Beobachtung nicht aktiviert',
      accountDisconnected: 'Konto getrennt',
      accountDisconnectedRun: 'Konto getrennt — Durchlauf gestoppt',
      captureHowto1: '# Anleitung: öffne eine Schmiedemagie-Werkstatt, lege den Gegenstand ein,',
      captureHowto2: '# wirf EINE Rune A, dann EINE Rune B eines anderen Typs. Dann stoppen.',
    },
    pt: {
      protocolStale: 'nenhuma rolagem obtém resposta — o formato de troca mudou no lado do Dofus. Coloca uma runa à mão na oficina: o STAKK reaprende o protocolo sozinho, depois recomeça.',
      protocolFallback: 'o protocolo aprendido deixou de responder — regresso ao modelo integrado, a forja continua sozinha',
      liveNoItemStats: 'nenhum efeito de item lido no canal — abre a oficina de forjamagia e coloca o item, o STAKK precisa de ver as características antes de lançar seja o que for',
      liveResidueNotFound: 'valor {value} ausente do último pacote da oficina',
      liveResidueAmbiguous: 'valor {value} presente em {n} sítios — faz outra rolagem e tenta com outro valor',
      liveNoReliableUid: 'nenhum identificador fiável para a runa {rune} no inventário',
      liveChannelClosed: 'envio impossível (canal fechado)',
      protoCaptureEmpty: 'captura vazia ou formato não reconhecido',
      protoNoMove: 'nenhum pacote de «colocação de runa» identificado em {n} pacotes enviados — tens de lançar DUAS runas de tipos diferentes durante a captura',
      protoNoReady: 'colocação de runa identificada, mas nenhum comando de forja na captura — depois de colocar uma runa, clica em Forjar antes de parar a captura',
      fmEffectFallback: 'Efeito',
      notCalibrated: 'protocolo de forjamagia indisponível — faz uma captura e analisa-a',
      notArmed: 'observação da oficina ainda não está pronta',
      itemMismatch: 'observação armada em «{name}», não no item escolhido',
      queueDone: '{n} exemplar(es) concluído(s) — fila esgotada',
      startRun: 'início{which} — {item} ({n} característica(s), transporte {transport})',
      resumeRun: 'retoma após alteração das definições — {item}',
      initialReadFailed: 'leitura inicial impossível: {msg}',
      doneIn: 'concluído em {n} rolagem(ns)',
      noUsableRune: 'nenhuma utilizável',
      blocked: 'sem runas lançáveis — {detail}',
      stockKnown: 'estoque conhecido: {n} tipo(s) de item. O STAKK só lê o que passa pela rede; se a conta já estava a correr antes da instalação, reinicia o personagem para que o servidor envie o inventário completo.',
      guardrail: 'proteção: {n} rolagens atingidas, parando',
      throwFailed: 'rolagem impossível: {msg}',
      exoWon: 'EXO {label} conseguido — forja parada',
      runeDropped: '{rune}: identificador recusado {n} vezes, retirado do estoque',
      runeNoAnswer: '{rune} sem resposta do jogo — vou tentar com outra pilha',
      throwResult: '{rune} em {label} → {value}/{goal}{failed}',
      failedSuffix: ' (falhou)',
      itemRuined: 'item arruinado — resta apenas {pct} % do peso original',
      brokenNoOrb: 'item quebrado e sem orbe disponível',
      gamePace: 'o jogo respondeu em {s} s — é ele que dita o ritmo, não a configuração',
      swapItem: 'exemplar concluído — retira-o e coloca o seguinte ({n} restante(s)), a forja recomeça sozinha',
      newItemDetected: 'novo exemplar detectado — retomando',
      noItemInTime: 'nenhum exemplar colocado a tempo — fila interrompida',
      orbNeeded: 'item quebrado mas sem orbe no inventário — para um item de nível {level} precisas de: {names}',
      noKnownOrb: 'nenhum orbe conhecido',
      orbUsed: 'item quebrado — restaurando com {name}',
      orbRejected: 'orbe recusado pelo jogo',
      itemReset: 'item restaurado — recomeçamos pelas características de base',
      orbResetFailed: 'restauração impossível: {msg}',
      runAlready: 'já existe uma execução de forjamagia nesta conta',
      dryNotSent: '[ensaio a seco] não enviado: colocar {len} B (runa {rune}, uid {uid}) + forjar',
      stopRequested: 'parada solicitada',
      tapUnavailable: 'tap de pacotes indisponível nesta versão',
      analyzerUnavailable: 'analisador de protocolo indisponível nesta versão',
      stopCaptureFirst: 'para a captura antes de a analisar',
      noCapture: 'nenhuma captura encontrada — lança uma captura primeiro',
      residueValueRequired: 'valor do resíduo necessário',
      notArmedOpenWorkshop: 'observação não armada — abre primeiro a oficina',
      notArmedShort: 'observação não armada',
      accountDisconnected: 'conta desconectada',
      accountDisconnectedRun: 'conta desconectada — execução parada',
      captureHowto1: '# Modo de uso: abre uma oficina de forjamagia, coloca o item,',
      captureHowto2: '# lança UMA runa A e depois UMA runa B de outro tipo. Depois para.',
    },
  };

  // Les handlers de route reçoivent (body, req) : la query string est à
  // parser soi-même (cf. commentaire du dispatcher dans web-server.js).
  const parseUrl = require('url').parse;
  function qs(req) {
    try { return parseUrl(req && req.url ? req.url : '', true).query || {}; }
    catch { return {}; }
  }

  // runs[accountId] = { plan, state, status, log[], startedAt, stop, config }
  const runs = new Map();

  function nowIso() { return new Date().toISOString(); }

  function pushLog(run, level, message) {
    run.log.push({ t: Date.now(), level, message });
    if (run.log.length > MAX_LOG) run.log.shift();
    log(`[fm:${run.accountId}] ${message}`);
  }

  /**
   * Historique détaillé d'un jet, à la manière du jeu.
   *
   * Le journal texte ne montrait que la stat visée. Or un jet de forgemagie
   * touche souvent PLUSIEURS lignes — c'est même l'information la plus utile :
   * savoir ce qu'on a cassé pour gagner un point. On enregistre donc toutes
   * les variations, plus le mouvement du reliquat.
   */
  function pushHistory(run, action, result, statsBefore, reliquatBefore) {
    const after = run.state.stats || {};
    const deltas = [];
    for (const key of new Set([...Object.keys(statsBefore), ...Object.keys(after)])) {
      const b = statsBefore[key] || 0;
      const a = after[key] || 0;
      if (a === b) continue;
      deltas.push({
        effectId: Number(key),
        label: run.labels[key] || `#${key}`,
        before: b, after: a, delta: a - b,
      });
    }
    // Le plus gros mouvement d'abord : c'est ce qu'on regarde en premier.
    deltas.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));

    const reliquatAfter = typeof run.transport.reliquat === 'function'
      ? run.transport.reliquat() : null;

    // Poids détruit : la somme des pertes, avec la table de coefficients.
    let lost = null;
    if (weights) {
      lost = 0;
      for (const d of deltas) {
        if (d.delta >= 0) continue;
        const w = weights.weightOf(d.effectId, -d.delta);
        if (w === null) { lost = null; break; }
        lost += w;
      }
      if (lost !== null) lost = Math.round(lost * 100) / 100;
    }

    run.history.push({
      t: Date.now(),
      rune: action.runeName,
      runeGid: action.runeId,
      amount: action.amount,
      target: action.label,
      exo: !!action.exo,
      ok: !!result.ok,
      rejected: !!result.rejected,
      deltas,
      lostWeight: lost || null,
      reliquat: (reliquatBefore !== null || reliquatAfter !== null)
        ? { before: reliquatBefore, after: reliquatAfter,
            delta: (reliquatAfter || 0) - (reliquatBefore || 0) }
        : null,
    });
    if (run.history.length > MAX_HISTORY) run.history.shift();
  }

  function publicRun(run) {
    if (!run) return null;
    return {
      accountId: run.accountId,
      status: run.status,
      transport: run.transportName,
      itemId: run.plan?.itemId ?? null,
      itemName: run.plan?.itemName ?? null,
      startedAt: run.startedAt,
      thrown: run.state?.thrown || 0,
      totalThrown: run.totalThrown || 0,
      orbesUsed: run.orbesUsed || 0,
      // Exo décroché : l'UI s'en sert pour alerter et la forge s'arrête là.
      exoWon: run.exoWon || null,
      // Enchaînement multi-exemplaires : où on en est dans la file.
      queue: run.config?.all
        ? { index: (run.itemIndex || 0) + 1, total: run.copies || 1, finished: run.itemsDone || 0 }
        : null,
      progress: run.plan ? engine.progress(run.plan, run.state) : 0,
      stats: run.state?.stats || {},
      stock: run.state?.stock || {},
      phase: run.plan && run.state ? engine.currentPhase(run.plan, run.state) : null,
      targets: (run.plan?.targets || []).map(t => ({
        effectId: t.effectId, label: t.label, goal: t.goal,
        ceiling: t.ceiling === Infinity ? null : t.ceiling,
        itemMin: t.itemMin, itemMax: t.itemMax,
        phase: t.phase || 0, exo: !t.onItem,
        current: run.state?.stats?.[t.effectId] ?? 0,
      })),
      log: run.log.slice(-60),
      history: (run.history || []).slice(-40),
      error: run.error || null,
    };
  }

  // ─── Config persistée ────────────────────────────────────────────────────
  // Rangée dans config.json sous la clé `fm`, comme organizer/click-broadcast.

  function loadFmConfig() {
    const cfg = loadConfig() || {};
    return cfg.fm || { presets: {}, delay: [500, 1000], transport: 'sim' };
  }
  function saveFmConfig(fmCfg) {
    const cfg = loadConfig() || {};
    cfg.fm = fmCfg;
    saveConfig(cfg);
  }

  // ─── Transport simulé ────────────────────────────────────────────────────
  //
  // Modèle volontairement simple et ASSUMÉ approximatif : la probabilité de
  // réussite chute quand la stat dépasse le jet max de l'item (overmax), ce qui
  // reproduit le ressenti sans prétendre singer les vraies formules Ankama.
  // Il sert à valider la chaîne logicielle, pas à prédire un résultat de FM.
  function createSimTransport(plan, opts) {
    const rng = opts?.rng || Math.random;
    const stats = {};
    for (const t of plan.targets) stats[t.effectId] = t.itemMin;
    const stock = {};
    for (const t of plan.targets) for (const tier of t.tiers) stock[tier.id] = 200;

    // Le plan peut changer en cours de run (route retarget). Une stat ou un
    // palier ajoutés après coup doivent apparaître ici, sinon le moteur les
    // croit hors stock et bloque le run sur un stock pourtant infini.
    function seedFromPlan() {
      for (const t of plan.targets) {
        if (stats[t.effectId] === undefined) stats[t.effectId] = t.itemMin;
        for (const tier of t.tiers) if (stock[tier.id] === undefined) stock[tier.id] = 200;
      }
    }

    // Remet un exemplaire neuf dans l'atelier (mode « tous les exemplaires »).
    function nextItem() {
      for (const t of plan.targets) stats[t.effectId] = t.itemMin;
      return true;
    }

    function successRate(target, current) {
      const span = Math.max((target.itemMax || target.itemMin) - target.itemMin, 1);
      const over = (current - target.itemMin) / span;
      return Math.max(0.15, Math.min(0.9, 0.9 - 0.55 * over));
    }

    return {
      name: 'sim',
      nextItem,
      async readStock() { seedFromPlan(); return { ...stock }; },
      async readStats() { seedFromPlan(); return { ...stats }; },
      async throwRune(runeGid, action) {
        const target = plan.targets.find(t => t.effectId === action.effectId);
        if (stock[runeGid] > 0) stock[runeGid]--;
        const ok = rng() < successRate(target, stats[action.effectId]);
        if (ok) stats[action.effectId] += action.amount;
        return { ok, stats: { ...stats } };
      },
    };
  }

  // ─── Transport live ──────────────────────────────────────────────────────
  //
  // Il s'appuie sur un profil protocole appris par calibration. Tant que le
  // profil n'existe pas, on refuse de démarrer : envoyer des paquets devinés à
  // un serveur Ankama est le meilleur moyen de se faire flag.
  //
  // Le cycle de vie du profil — quel gabarit fait foi, quand il a le droit
  // d'être remplacé, quand il est périmé — appartient au socle : c'est la même
  // mécanique pour la forgemagie, l'hdv ou la récolte. Ici on ne fournit que ce
  // qui est propre à la FM : le gabarit intégré et le test d'équivalence.
  const stores = new Map();   // accountId → ProfileStore

  function storeFor(accountId) {
    let s = stores.get(accountId);
    if (s) return s;
    s = learn.createProfileStore({
      fs, path, dir: STAKK_DIR, feature: 'fm', accountId,
      // La forme des messages d'échange est connue ; seule la signature
      // obfusquée du type_url change d'un build Ankama à l'autre. Le gabarit
      // intégré couvre donc le cas courant sans rien demander à l'utilisateur.
      builtin: () => {
        if (!protocol || typeof protocol.defaultProfile !== 'function') return null;
        try { return protocol.defaultProfile(); }
        catch (e) { log(`[fm] profil intégré indisponible: ${e.message}`); return null; }
      },
      isEquivalent: (a, b) => !!(protocol && protocol.sameProfile && protocol.sameProfile(a, b)),
      log,
    });
    s.onRelearn(() => repairAfterRelearn(accountId));
    stores.set(accountId, s);
    return s;
  }

  // Annotations qui ne relèvent PAS du cycle de vie : chemin du reliquat,
  // profil issu d'une calibration manuelle. Le store ne parle que
  // d'apprentissage, de preuve et de péremption ; ces écritures-là passent donc
  // à côté de lui, mais dans SON fichier — d'où le chemin emprunté au store.
  function loadProfileFile(accountId) {
    try { return JSON.parse(fs.readFileSync(storeFor(accountId).path, 'utf8')); }
    catch { return null; }
  }
  function saveProfileFile(accountId, profile) {
    // La preuve vit sur disque depuis qu'elle doit survivre au redémarrage :
    // l'écraser au passage rouvrirait la porte à l'écrasement du gabarit par
    // un paquet sortant quelconque. On la recopie tant qu'elle porte sur le
    // même gabarit.
    const prev = loadProfileFile(accountId);
    const preuve = prev && prev.provenTemplate
      && profile && profile.move && profile.move.template === prev.provenTemplate
      ? { provenTemplate: prev.provenTemplate } : null;
    fs.mkdirSync(STAKK_DIR, { recursive: true });
    fs.writeFileSync(storeFor(accountId).path,
      JSON.stringify({ ...profile, ...preuve }, null, 2));
  }
  // Résumé sans les octets bruts : c'est ce qui remonte à l'UI.
  function profileSummary(profile) {
    if (!profile || !profile.move) return null;
    return {
      moveMsgId: profile.move.msgId,
      readyMsgId: profile.ready ? profile.ready.msgId : null,
      uidOffset: profile.move.uidOffset,
      uidLength: profile.move.uidLength,
      observedUids: profile.move.observedUids || [],
      // 'low' quand le paquet de forge a été déduit d'un seul exemplaire :
      // l'UI doit le dire et pousser vers l'essai à blanc.
      readyConfidence: (profile.ready && profile.ready.confidence) || 'high',
      createdAt: profile.createdAt || null,
    };
  }

  // ─── Veille inventaire ───────────────────────────────────────────────────
  //
  // Le serveur envoie l'inventaire complet à la CONNEXION du personnage. Si on
  // n'écoute qu'à partir du moment où l'utilisateur ouvre l'atelier, on ne
  // connaît que les runes qui passent ensuite — c'est-à-dire presque rien, et
  // le moteur s'arrête sur « plus de rune » alors que le sac est plein.
  //
  // On écoute donc dès le lancement du compte, pendant une fenêtre bornée
  // (le temps que l'inventaire arrive), puis on s'arrête : scanner chaque
  // paquet en permanence coûterait cher pour rien.
  const STOCK_WATCH_MS = 3 * 60 * 1000;
  const stockWatchers = new Map();  // accountId → { stock, uids, until }

  // Liste des gid de runes, préchargée : la veille tourne dans le tap, elle ne
  // peut pas attendre une promesse.
  let runeGids = null;
  data.getTables()
    .then(t => {
      const set = new Set();
      for (const tiers of Object.values(t.runes || {})) for (const tier of tiers) set.add(tier.id);
      // Les ORBES aussi : sans elles, la veille au lancement ne les voit pas
      // passer et la remise à neuf croit n'en avoir aucune en inventaire.
      for (const o of t.orbes || []) set.add(o.id);
      runeGids = [...set];
      log(`[fm] veille inventaire prête (${runeGids.length} objets suivis)`);
    })
    .catch(e => log(`[fm] table de runes indisponible: ${e.message}`));

  // ─── Miroir persistant ───────────────────────────────────────────────────
  //
  // Le serveur n'envoie l'inventaire complet qu'à la connexion du personnage.
  // Sans sauvegarde, un simple redémarrage de STAKK ramène le miroir à zéro
  // et il faut relancer le perso pour le reconstruire — insupportable à
  // l'usage. On le range donc sur disque.
  //
  // Un identifiant devenu périmé entre-temps est sans danger : le serveur le
  // refuse au premier essai et le transport l'écarte tout seul.
  function inventoryPath(accountId) {
    return path.join(STAKK_DIR, `fm-inventory-${accountId}.json`);
  }

  function loadInventory(accountId) {
    try {
      const raw = JSON.parse(fs.readFileSync(inventoryPath(accountId), 'utf8'));
      if (!raw || !Array.isArray(raw.objects)) return [];
      return raw.objects;
    } catch { return []; }
  }

  function saveInventory(accountId, objects) {
    if (!objects || !objects.length) return;
    try {
      fs.mkdirSync(STAKK_DIR, { recursive: true });
      fs.writeFileSync(inventoryPath(accountId),
        JSON.stringify({ savedAt: new Date().toISOString(), objects }));
    } catch (e) { log(`[fm] sauvegarde inventaire KO: ${e.message}`); }
  }

  // ─── Numéros de champs d'inventaire ──────────────────────────────────────
  //
  // Même dossier et même logique que fm-protocol-<accountId>.json : appris
  // passivement depuis le trafic, rangé sur disque, rechargé au démarrage,
  // effacé dès qu'il cesse de concorder. Fichier séparé du profil de protocole
  // à dessein : les deux s'apprennent indépendamment, et le profil intégré
  // (`source: builtin`) est ignoré au rechargement — y loger le mapping le
  // ferait disparaître à chaque démarrage.
  //
  // Voir recalibrer-inventaire.js pour l'inspecter ou le remettre à zéro.
  function fieldMapPath(accountId) {
    return path.join(STAKK_DIR, `fm-fields-${accountId}.json`);
  }
  function loadFieldMapState(accountId) {
    try { return JSON.parse(fs.readFileSync(fieldMapPath(accountId), 'utf8')); }
    catch { return null; }
  }
  function saveFieldMapState(accountId, state) {
    // Écriture par fichier temporaire puis renommage : le script de
    // recalibration peut lire pendant que STAKK écrit sans tomber sur un
    // JSON tronqué.
    try {
      fs.mkdirSync(STAKK_DIR, { recursive: true });
      const tmp = `${fieldMapPath(accountId)}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ savedAt: new Date().toISOString(), ...state }, null, 2));
      fs.renameSync(tmp, fieldMapPath(accountId));
    } catch (e) { log(`[fm] sauvegarde des champs d'inventaire KO: ${e.message}`); }
  }
  function clearFieldMapState(accountId) {
    try { fs.unlinkSync(fieldMapPath(accountId)); } catch { /* absent : rien à faire */ }
  }

  // Un accumulateur par compte, partagé entre la veille d'inventaire et le
  // transport : la veille voit le sac complet à la connexion, l'atelier voit
  // les mouvements de piles — les deux nourrissent le même apprentissage.
  const fieldLearners = new Map();
  function fieldLearnerFor(accountId) {
    if (!protocol || typeof protocol.createFieldMapLearner !== 'function') return null;
    const hit = fieldLearners.get(accountId);
    if (hit) return hit;
    const saved = loadFieldMapState(accountId) || {};
    const learner = protocol.createFieldMapLearner({
      map: saved.map, gids: saved.gids, sample: saved.sample,
    });
    fieldLearners.set(accountId, learner);
    return learner;
  }

  function noteFieldMap(accountId, learner, news) {
    if (!news) return;
    if (news.learned) {
      saveFieldMapState(accountId, learner.state());
      log(`[fm] champs d'inventaire appris (compte ${accountId}) : gid=${news.learned.gid}, `
        + `identifiant=${news.learned.uid}, quantité=`
        + `${news.learned.qty == null ? 'indéterminée' : news.learned.qty}`);
    } else if (news.lost) {
      clearFieldMapState(accountId);
      log(`[fm] champs d'inventaire invalidés (compte ${accountId}) — réapprentissage en cours`);
    }
  }

  function persistObserver(accountId) {
    const obs = observers.get(accountId);
    if (!obs) return;
    try { saveInventory(accountId, obs.live.exportObjects()); }
    catch (e) { log(`[fm] export inventaire KO: ${e.message}`); }
  }

  function startStockWatch(accountId) {
    // Miroir indexé par identifiant d'objet, comme dans le transport : c'est
    // l'identifiant qui périme, pas le gid.
    stockWatchers.set(accountId, { objects: new Map(), until: Date.now() + STOCK_WATCH_MS });
  }

  function watchStock(accountId, buf) {
    const w = stockWatchers.get(accountId);
    if (!w || !protocol || !runeGids) return;
    if (Date.now() > w.until) { stockWatchers.delete(accountId); return; }

    // L'inventaire de connexion est la meilleure matière première pour
    // apprendre les numéros de champs : des dizaines d'objets dont on connaît
    // les gid, dans le même message.
    const learner = fieldLearnerFor(accountId);
    if (learner) noteFieldMap(accountId, learner, learner.observe(buf, runeGids));
    const fieldMap = learner ? learner.map() : null;

    const entries = protocol.scanObjectEntries(buf, runeGids, { fieldMap });
    for (const e of entries) {
      if (e.confidence !== 'high') continue;
      if (e.quantity > 0) w.objects.set(e.uid, { uid: e.uid, gid: e.gid, qty: e.quantity });
      else w.objects.delete(e.uid);
    }

    // Mises à jour de quantité des piles déjà repérées : sans elles, une pile
    // consommée pendant la fenêtre de veille resterait annoncée disponible.
    if (w.objects.size && typeof protocol.scanQuantityUpdates === 'function') {
      for (const u of protocol.scanQuantityUpdates(buf, [...w.objects.keys()], { fieldMap })) {
        const prev = w.objects.get(u.uid);
        if (!prev) continue;
        if (u.quantity > 0) w.objects.set(u.uid, { ...prev, qty: u.quantity });
        else w.objects.delete(u.uid);
      }
    }

    // L'inventaire de connexion est ce qu'il y a de plus coûteux à obtenir :
    // on le range sur disque sans attendre qu'une observation soit armée.
    const now = Date.now();
    if (w.objects.size && now - (w.savedAt || 0) > 10000) {
      w.savedAt = now;
      saveInventory(accountId, [...w.objects.values()]);
    }
  }

  // ─── Recollage du flux ───────────────────────────────────────────────────
  //
  // Le proxy livre des chunks TCP bruts : un message de jeu peut être coupé
  // en deux, et deux messages peuvent arriver collés. Sans recollage, tout
  // chunk incomplet est perdu — c'est ainsi qu'un inventaire volumineux ne
  // rendait qu'une poignée d'objets alors que le sac en contient bien plus.
  //
  // On accumule donc par compte et on ne livre que des messages complets.
  const inbound = new Map();          // accountId → reste non consommé
  const MAX_LEFTOVER = 256 * 1024;    // garde-fou si le flux se désynchronise

  function feedInbound(accountId, buf, sink) {
    if (!protocol) { sink(buf); return; }        // pas de découpeur : on passe tel quel
    const prev = inbound.get(accountId);
    const data = prev && prev.length ? Buffer.concat([prev, buf]) : buf;

    let off = 0;
    for (;;) {
      const len = protocol.readVarInt(data, off);
      if (!len || len.value === 0) break;
      const start = off + len.length;
      const end = start + len.value;
      if (end > data.length) break;              // message incomplet : on attend la suite
      // On transmet le message AVEC son préfixe de longueur : c'est la forme
      // que le décodeur sait lire.
      sink(data.subarray(off, end));
      off = end;
    }

    const leftover = data.subarray(off);
    // Si le reste enfle sans jamais se résoudre, c'est que l'hypothèse de
    // cadrage ne tient pas sur ce flux : on repart de zéro plutôt que de
    // gonfler indéfiniment.
    inbound.set(accountId, leftover.length > MAX_LEFTOVER ? Buffer.alloc(0) : Buffer.from(leftover));
  }

  // observers[accountId] = { live, itemId, itemName, armedAt }
  // L'observateur est armé AVANT le run : il écoute le canal et n'agit pas.
  // C'est lui qui devient le transport une fois qu'il a vu les stats de
  // l'item — d'où la séparation « armer » / « démarrer ».
  const observers = new Map();

  function fail(message, code) {
    const e = new Error(message);
    e.code = code;
    return e;
  }

  // Réglages de cadence, communs à tous les runs du compte. Rangés dans la
  // config pour survivre aux redémarrages.
  function loadTuning() {
    const cfg = loadFmConfig();
    const t = cfg.tuning || {};
    const clamp = (v, lo, hi, def) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
    };
    return {
      throwTimeoutMs: clamp(t.throwTimeoutMs, 500, 10000, 2000),
      graceMs: clamp(t.graceMs, 0, 3000, 250),
      readyDelayMs: clamp(t.readyDelayMs, 0, 1000, 50),
    };
  }

  async function armLive(accountId, itemId) {
    const tuning = loadTuning();
    if (!liveFactory) throw fail('mode Jeu indisponible sur cette version', 'NO_LIVE');
    const profile = storeFor(accountId).get();
    if (!profile) {
      throw fail('protocole FM indisponible — fais une capture puis analyse-la', 'NOT_CALIBRATED');
    }
    const channel = getGameChannel ? getGameChannel(accountId) : null;
    if (!channel) {
      throw fail('aucun canal de jeu actif pour ce compte — lance Dofus d\'abord', 'NO_CHANNEL');
    }
    const item = await data.getItem(Number(itemId));
    const tables = await data.getTables();
    const effectIds = item.stats.map(s => s.effectId).filter(id => tables.runes[id]);
    if (!effectIds.length) throw fail('cet item n\'a aucune stat forgeable', 'NO_STATS');
    // On suit aussi le gid de l'ITEM : ça donne le nombre d'exemplaires en
    // inventaire, seule source honnête pour le mode « tous les exemplaires ».
    // On suit TOUTES les runes connues, pas seulement celles des stats de
    // l'item : un exo porte par définition sur une caractéristique que l'item
    // n'a pas, et sa rune serait sinon invisible dans l'inventaire.
    const runeGids = [item.id];
    for (const tiers of Object.values(tables.runes || {})) {
      for (const tier of tiers) runeGids.push(tier.id);
    }
    // Les orbes sont suivies pareil : il faut leur identifiant en inventaire
    // pour pouvoir en poser une.
    for (const o of tables.orbes || []) runeGids.push(o.id);

    const live = liveFactory.create({
      profile, channel, runeGids, effectIds,
      // Le profil peut être réappris pendant que l'observation est armée :
      // le transport doit relire le profil COURANT à chaque jet, sinon il
      // émet l'ancien gabarit jusqu'au prochain réarmement.
      getProfile: () => storeFor(accountId).get(),
      // Une fois le gabarit prouvé, un jet qui ne change rien est un échec de
      // forgemagie ordinaire (rune et reliquat consommés, stats intactes) —
      // surtout pas un refus à imputer à la pile. Preuve DE SESSION
      // uniquement : voir le commentaire de provenThisSession.
      isProfileProven: () => provenThisSession.holds(accountId),
      itemGid: item.id,
      // Cadence : réglable pour ceux qui veulent enchaîner vite.
      throwTimeoutMs: tuning.throwTimeoutMs,
      graceMs: tuning.graceMs,
      readyDelayMs: tuning.readyDelayMs,
      // Chemin du reliquat déjà appris pour ce compte, s'il existe.
      reliquatPath: profile.reliquatPath || null,
      // Numéros de champs d'inventaire : accumulateur partagé avec la veille,
      // donc déjà nourri par l'inventaire de connexion.
      fieldLearner: fieldLearnerFor(accountId),
      onFieldMapLearned: (state) => saveFieldMapState(accountId, state),
      onFieldMapLost: () => clearFieldMapState(accountId),
      // Poids : permet au transport de calculer ce qu'un jet raté a détruit,
      // donc de repérer le reliquat tout seul.
      weightOf: weights ? ((eid, pts) => weights.weightOf(eid, pts)) : null,
      onReliquatLost: () => {
        const p = loadProfileFile(accountId);
        if (p && p.reliquatPath) {
          delete p.reliquatPath;
          try { saveProfileFile(accountId, p); } catch {}
        }
        log(`[fm] champ du reliquat invalidé pour le compte ${accountId} — recherche relancée`);
      },
      onReliquatLearned: (path, value) => {
        const p = storeFor(accountId).get() || {};
        p.reliquatPath = path;
        try { saveProfileFile(accountId, p); } catch (e) { log(`[fm] sauvegarde reliquat KO: ${e.message}`); }
        log(`[fm] reliquat appris tout seul (compte ${accountId}) : ${path} = ${value}`);
      },
      log: (m) => log(m),
      // Le rapport d'essai à blanc est routé vers le run en cours, s'il y en
      // a un : l'observateur survit aux runs, le callback non.
      onDryRun: (entry) => {
        const o = observers.get(accountId);
        if (o && typeof o.onPlanned === 'function') o.onPlanned(entry);
      },
    });
    // Amorce : d'abord le miroir sauvegardé (survit à un redémarrage de
    // STAKK), puis ce que la veille a vu depuis la connexion, qui est plus
    // frais et prend donc le dessus.
    const saved = loadInventory(accountId);
    if (saved.length) {
      live.seedObjects(saved);
      log(`[fm] stock rechargé depuis le disque : ${saved.length} pile(s)`);
    }
    const watched = stockWatchers.get(accountId);
    if (watched && watched.objects.size) {
      live.seedObjects([...watched.objects.values()]);
      log(`[fm] stock amorcé depuis la veille : ${watched.objects.size} pile(s) de runes`);
    }

    const entry = { live, itemId: item.id, itemName: item.name, armedAt: Date.now() };
    // Sauvegarde régulière : une session de forge fait bouger l'inventaire en
    // continu, et on veut retrouver l'état au prochain démarrage.
    entry.saveTimer = setInterval(() => persistObserver(accountId), 15000);
    if (typeof entry.saveTimer.unref === 'function') entry.saveTimer.unref();
    observers.set(accountId, entry);
    log(`[fm] observation armée compte ${accountId} sur ${item.name}`);
    return liveStatus(accountId);
  }

  function disarmLive(accountId) {
    const obs = observers.get(accountId);
    if (!obs) return false;
    // On garde le miroir avant de tout lâcher : c'est le seul état coûteux à
    // reconstruire (il faut relancer le personnage).
    persistObserver(accountId);
    if (obs.saveTimer) clearInterval(obs.saveTimer);
    return observers.delete(accountId);
  }

  function liveStatus(accountId) {
    const obs = observers.get(accountId);
    const profile = storeFor(accountId).get();
    const source = profile ? (profile.source === 'builtin' ? 'builtin' : 'learned') : null;
    if (!obs) {
      return {
        available: !!liveFactory,
        armed: false,
        calibrated: !!profile,
        profileSource: source,
        channel: !!(getGameChannel && getGameChannel(accountId)),
      };
    }
    const s = obs.live._state();
    return {
      available: true,
      armed: true,
      itemId: obs.itemId,
      itemName: obs.itemName,
      ready: obs.live.ready(),
      diagnostic: obs.live.diagnostic(),
      stats: s.stats || {},
      stock: s.stock,
      observations: s.statsVersion,
      copies: itemCopies(accountId),
      calibrated: true,
      profileSource: source,
      channel: true,
      // Identifiants retenus par gid : c'est ce qui part réellement dans le
      // paquet, donc la première chose à regarder quand le serveur refuse.
      uids: s.uids,
      // Reliquat : null tant qu'on ne sait pas où il se trouve.
      reliquat: s.reliquat,
      reliquatKnown: !!s.reliquatPath,
      itemPackets: s.itemPackets,
    };
  }

  // Nombre d'exemplaires de l'item repérés en inventaire (0 si rien vu).
  function itemCopies(accountId) {
    const obs = observers.get(accountId);
    if (!obs) return 0;
    const uids = obs.live._state().uids[obs.itemId];
    return uids ? uids.length : 0;
  }

  // Transport live = l'observateur armé, à condition qu'il ait vu l'item.
  // `dryRun` rejoue tout le parcours sans envoyer : mêmes vérifications, mêmes
  // octets construits, aucun paquet sur le réseau.
  function createLiveTransport(accountId, plan, dryRun, onPlanned) {
    const obs = observers.get(accountId);
    if (!obs) {
      if (!storeFor(accountId).get()) {
        throw fail(m('notCalibrated'), 'NOT_CALIBRATED');
      }
      throw fail(m('notArmed'), 'NOT_ARMED');
    }
    if (obs.itemId !== plan.itemId) {
      throw fail(m('itemMismatch', { name: obs.itemName }), 'ITEM_MISMATCH');
    }
    if (!obs.live.ready()) throw fail(obs.live.diagnostic(), 'NOT_OBSERVED');
    obs.live.setDryRun(!!dryRun);
    obs.onPlanned = typeof onPlanned === 'function' ? onPlanned : null;
    return obs.live;
  }

  // ─── Boucle d'exécution ──────────────────────────────────────────────────

  function sleep(ms, signal) {
    return new Promise(resolve => {
      const id = setTimeout(resolve, ms);
      if (signal) signal.onAbort = () => { clearTimeout(id); resolve(); };
    });
  }

  /**
   * Boucle principale. En mode « tous les exemplaires » elle enchaîne :
   * un exemplaire jusqu'au bout, puis attente du suivant, et ainsi de suite.
   * Toute issue autre que « terminé » (bloqué, erreur, arrêt) coupe la file :
   * insister sur l'exemplaire suivant après un échec ne ferait que gaspiller
   * des runes.
   */
  // `resume` sert à relancer un run arrêté sans repartir de zéro : les
  // compteurs de file survivent, seul le premier exemplaire est repris.
  async function runLoop(run, opts) {
    const resume = !!(opts && opts.resume);
    if (!resume) {
      run.totalThrown = 0;
      run.itemsDone = 0;
      run.itemIndex = 0;
    }
    let first = true;
    for (; ; run.itemIndex++) {
      await runOneItem(run, { resume: resume && first });
      first = false;
      run.totalThrown += run.state?.thrown || 0;
      if (run.status !== 'done') return;
      run.itemsDone++;

      if (!run.config.all) return;
      if (run.itemsDone >= (run.copies || 1)) {
        pushLog(run, 'success', m('queueDone', { n: run.itemsDone }));
        return;
      }
      const ok = await waitNextItem(run);
      if (!ok) return;
    }
  }

  async function runOneItem(run, opts) {
    const resume = !!(opts && opts.resume);
    const { plan } = run;
    run.status = 'running';
    if (resume) {
      pushLog(run, 'info', m('resumeRun', { item: plan.itemName }));
    } else {
      const which = run.config.all ? ` [${run.itemIndex + 1}/${run.copies}]` : '';
      pushLog(run, 'info', m('startRun', { which, item: plan.itemName, n: plan.targets.length, transport: run.transportName }));
    }

    try {
      // Relecture systématique, y compris en reprise : l'item et le sac ont pu
      // bouger pendant que le run était arrêté.
      const stats = await run.transport.readStats();
      const stock = await run.transport.readStock();
      run.state = { stats, stock, thrown: resume ? ((run.state && run.state.thrown) || 0) : 0 };
    } catch (e) {
      run.status = 'error';
      run.error = m('initialReadFailed', { msg: e.message });
      pushLog(run, 'error', run.error);
      return;
    }

    while (run.status === 'running') {
      const action = engine.nextAction(plan, run.state);

      if (action.type === 'done') {
        run.status = 'done';
        pushLog(run, 'success', m('doneIn', { n: run.state.thrown }));
        return;
      }
      if (action.type === 'blocked') {
        run.status = 'blocked';
        // Seul ce blocage se lève par un réglage (un plafond relevé rend une
        // rune jouable). Les deux autres (protocole périmé, item cassé sans
        // orbe) relancer la boucle enverrait des paquets que le serveur
        // ignore — un moyen sûr de se faire repérer. La route retarget ne
        // tente donc une reprise que sur cette valeur.
        run.blockedReason = 'no-rune';
        const detail = action.missing
          .map(x => `${x.label} ${x.current}/${x.goal} (runes: ${x.runes.map(r => r.name).join(', ') || m('noUsableRune')})`)
          .join(' ; ');
        run.error = m('blocked', { detail });
        pushLog(run, 'warn', run.error);
        // Le stock vient de ce qui est passé sur le réseau. Si l'observation a
        // été armée après la connexion du personnage, l'inventaire initial est
        // déjà loin et STAKK n'en connaît qu'une bribe — il faut le dire, sinon
        // « plus de rune » alors que le sac est plein est incompréhensible.
        if (run.transportName !== 'sim') {
          const seen = Object.keys(run.state.stock || {}).length;
          pushLog(run, 'info', m('stockKnown', { n: seen }));
        }
        return;
      }
      if (run.state.thrown >= MAX_THROWS) {
        run.status = 'error';
        run.error = m('guardrail', { n: MAX_THROWS });
        pushLog(run, 'error', run.error);
        return;
      }

      // Mémorise qu'un exo a été tenté : c'est la condition pour qu'une
      // remise à neuf ait un sens (l'orbe détruit les exos).
      if (action.exo) run.exoAttempted = true;

      const throwStartedAt = Date.now();
      // Photo d'avant : c'est la comparaison qui donne l'historique détaillé,
      // comme celui du jeu — toutes les lignes touchées, pas seulement la
      // stat visée.
      const statsBefore = { ...(run.state.stats || {}) };
      const reliquatBefore = typeof run.transport.reliquat === 'function'
        ? run.transport.reliquat() : null;

      let result;
      try {
        result = await run.transport.throwRune(action.runeId, action);
      } catch (e) {
        // Plus aucune pile résoluble pour cette rune : le miroir l'a perdue
        // entre la décision et l'envoi (pile consommée, fusionnée, déplacée).
        // Rien n'est parti sur le réseau. Ce n'est donc pas une panne, mais une
        // rupture de stock : on retire la rune du stock connu et on rend la
        // main au moteur, qui redescendra d'un palier ou annoncera l'absence de
        // rune. Couper le run sur une erreur technique pour ça était trompeur.
        if (e && e.code === 'no-stack') {
          pushLog(run, 'warn', m('throwFailed', { msg: e.message }));
          delete run.state.stock[action.runeId];
          continue;
        }
        run.status = 'error';
        run.error = m('throwFailed', { msg: e.message });
        pushLog(run, 'error', run.error);
        return;
      }
      if (run.status !== 'running') return;   // stop demandé pendant le jet

      run.state = engine.applyResult(run.state, action, result.stats);
      pushHistory(run, action, result, statsBefore, reliquatBefore);

      // Exo décroché : on s'arrête là. Continuer à forger risquerait de le
      // faire sauter, et c'est de toute façon l'objectif de la session.
      if (action.exo && !result.rejected
          && (run.state.stats[action.effectId] || 0) >= action.goal) {
        run.exoWon = { effectId: action.effectId, label: action.label,
                       value: run.state.stats[action.effectId] };
        run.status = 'done';
        pushLog(run, 'success', m('exoWon', { label: action.label }));
        return;
      }
      // Un refus serveur n'est pas un échec de forgemagie : la rune n'est pas
      // partie. On le dit clairement et on relit le stock, que le transport
      // vient de corriger en écartant l'identifiant mort.
      if (result.rejected) {
        pushLog(run, 'warn', result.dropped
          ? m('runeDropped', { rune: action.runeName, n: REJECTS_BEFORE_DROP_LABEL })
          : m('runeNoAnswer', { rune: action.runeName }));
        // Des refus isolés arrivent (pile périmée). Une SÉRIE de refus, elle,
        // demande une conclusion — mais laquelle ? Deux causes seulement, et
        // l'information pour les séparer est là :
        //   - toute la série porte sur UNE SEULE rune : ce sont ses piles qui
        //     sont mortes, et le paquet est bien formé puisqu'on n'a jamais
        //     essayé autre chose. Accuser le protocole ici était le message
        //     trompeur observé en production. On écarte donc la rune et on
        //     laisse le moteur continuer (autre palier, ou absence de rune) ;
        //   - la série touche PLUSIEURS runes, donc plusieurs piles fraîchement
        //     résolues, et le serveur ignore tout : là, c'est le gabarit qu'il
        //     ne comprend plus.
        run.noAnswerStreak = (run.noAnswerStreak || 0) + 1;
        (run.noAnswerRunes || (run.noAnswerRunes = new Set())).add(action.runeId);
        if (run.noAnswerStreak >= NO_ANSWER_LIMIT) {
          // Le gabarit ne fait plus ses preuves : il redevient remplaçable.
          // La preuve persistée vivant sur disque, ne pas l'effacer ici la
          // laisserait survivre au redémarrage et refuser à jamais la pose
          // manuelle.
          forgetProfileProof(run.accountId);
          provenLogged.delete(run.accountId);
          if (run.noAnswerRunes.size < 2) {
            delete run.state.stock[action.runeId];
            run.noAnswerStreak = 0;
            run.noAnswerRunes.clear();
            continue;
          }
          // Plusieurs runes muettes d'affilée : ce ne sont plus les piles, mais
          // le gabarit. Un profil APPRIS peut être un faux positif — on repart
          // sur l'intégré et on poursuit, au lieu de couper le run et de
          // renvoyer l'utilisateur à une pose manuelle.
          const store = storeFor(run.accountId);
          const abandonne = ((store.get() || {}).codes || {}).move;
          if (store.dropLearned()) {
            log(`[fm] le protocole appris (pose=${abandonne}) ne donne aucune réponse — `
              + `retour au gabarit intégré (pose=${((store.get() || {}).codes || {}).move})`);
            run.noAnswerStreak = 0;
            run.noAnswerRunes.clear();
            pushLog(run, 'warn', m('protocolFallback'));
            continue;
          }
          flagProfileStale(run.accountId);
          run.status = 'blocked';
          // Aucun réglage ne rend un gabarit périmé à nouveau valide : ne pas
          // laisser traîner un 'no-rune' d'un blocage précédent qui, lui,
          // autoriserait une reprise à tort.
          run.blockedReason = 'protocol-stale';
          run.error = m('protocolStale');
          pushLog(run, 'error', run.error);
          return;
        }
        try { run.state.stock = await run.transport.readStock(); }
        catch { /* on garde la vue précédente */ }
      } else {
        run.noAnswerStreak = 0;
        if (run.noAnswerRunes) run.noAnswerRunes.clear();
        // Le serveur a repondu a ce jet : le gabarit qui l'a construit est
        // desormais protege contre l'apprentissage passif. Uniquement en mode
        // Jeu : ni la simulation ni l'essai a blanc n'envoient quoi que ce
        // soit, et depuis que la preuve vit sur disque, l'accorder a un run
        // simule verrouillerait le gabarit bien au-dela de la session.
        if (run.transportName === 'live') markProfileProven(run.accountId);
        // Une stat absente de l'item vaut 0, pas `undefined` : c'est le cas
        // nominal d'un exo (PA, PM, PO, Invocation), dont la ligne n'apparaît
        // qu'une fois l'exo réussi. Sans ça le journal affichait « undefined/1 ».
        const value = run.state.stats[action.effectId] ?? 0;
        pushLog(run, result.ok ? 'ok' : 'fail',
          m('throwResult', { rune: action.runeName, label: action.label, value, goal: action.goal,
                             failed: result.ok ? '' : m('failedSuffix') }));
      }

      // Item cassé par un exo raté : on le remet à neuf plutôt que de
      // remonter des jets sur une base ruinée, puis on reprend au début.
      if (run.config.orbe && isBrokenItem(run, plan, run.state.stats)) {
        const ratio = itemWeightRatio(plan, run.state.stats);
        pushLog(run, 'warn', m('itemRuined', { pct: Math.round(ratio * 100) }));
        const tables = await data.getTables();
        const done = await useOrbe(run, tables);
        if (!done) {
          run.status = 'blocked';
          // Idem : un item cassé sans orbe disponible ne se répare pas en
          // changeant un objectif ou une cadence.
          run.blockedReason = 'broken-no-orb';
          run.error = m('brokenNoOrb');
          return;
        }
        run.exoAttempted = false;   // repartir propre après la remise à neuf
      }

      // Le délai est une CADENCE, pas une pause qui s'ajoute. En mode jeu, un
      // jet passe des secondes à attendre la réponse du serveur : ajouter le
      // délai par-dessus donnait un rythme sans rapport avec le réglage.
      // On ne dort donc que le temps qui manque pour tenir l'intervalle.
      const target = engine.throwDelay(run.config.delay);
      const elapsed = Date.now() - throwStartedAt;
      const remaining = Math.max(0, target - elapsed);
      if (elapsed > target + 1500) {
        pushLog(run, 'info', m('gamePace', { s: (elapsed / 1000).toFixed(1) }));
      }
      if (remaining > 0) await sleep(remaining, run.abort);
    }
  }

  /**
   * Attend l'exemplaire suivant dans l'atelier.
   *
   * En simulation, le transport le fournit lui-même. En jeu (et en essai à
   * blanc) STAKK ne sait pas retirer puis reposer un objet — ce message-là
   * n'est pas couvert par la calibration — donc il DEMANDE le changement et
   * repart tout seul dès qu'il voit un item non forgé dans l'atelier.
   * Mieux vaut une pause explicite qu'un paquet inventé.
   *
   * @returns true si un nouvel exemplaire est prêt, false si on doit s'arrêter
   */
  async function waitNextItem(run) {
    if (typeof run.transport.nextItem === 'function') {
      run.status = 'running';
      run.transport.nextItem();
      return true;
    }

    run.status = 'waiting-item';
    const left = (run.copies || 1) - run.itemsDone;
    pushLog(run, 'warn', m('swapItem', { n: left }));

    const deadline = Date.now() + WAIT_ITEM_TIMEOUT_MS;
    while (run.status === 'waiting-item') {
      await sleep(WAIT_ITEM_POLL_MS, run.abort);
      if (run.status !== 'waiting-item') return false;      // arrêt demandé
      let stats;
      try { stats = await run.transport.readStats(); }
      catch { continue; }                                    // atelier fermé un instant
      if (isFreshItem(run.plan, stats)) {
        run.status = 'running';
        pushLog(run, 'info', m('newItemDetected'));
        return true;
      }
      if (Date.now() > deadline) {
        run.status = 'stopped';
        run.error = m('noItemInTime');
        pushLog(run, 'warn', run.error);
        return false;
      }
    }
    return false;
  }

  /**
   * L'item est-il cassé ?
   *
   * Une stat qui passe sous son jet mini ne suffit pas : ça arrive en forge
   * normale, et un point en dessous ne veut rien dire. Le vrai critère est la
   * PERTE DE POIDS : un exo raté fait s'effondrer plusieurs lignes d'un coup.
   *
   * On compare donc le poids total actuel au poids naturel de l'item (somme
   * des jets maxi). En dessous du seuil, l'item est ruiné et le remonter
   * coûterait plus cher que de le repartir à neuf.
   *
   * Et on ne déclenche qu'après une TENTATIVE D'EXO : c'est le seul cas où la
   * remise à neuf a un sens, puisque l'orbe détruit justement les exos.
   */
  function itemWeightRatio(plan, stats) {
    if (!weights || !stats) return null;
    let current = 0, natural = 0;
    for (const t of plan.targets) {
      if (!t.onItem) continue;
      const nat = weights.weightOf(t.effectId, t.itemMax || t.itemMin);
      const cur = weights.weightOf(t.effectId, stats[t.effectId] || 0);
      if (nat === null || cur === null) continue;   // coefficient inconnu
      natural += nat;
      current += cur;
    }
    if (natural <= 0) return null;
    return current / natural;
  }

  // La perte de poids suffit : exiger en plus qu'un exo ait été tenté ratait
  // le cas le plus courant — un jet désastreux en forge normale, qui laisse
  // l'item dans un état pire que ce qu'une orbe rendrait. L'option est de
  // toute façon décochée par défaut.
  function isBrokenItem(run, plan, stats) {
    const ratio = itemWeightRatio(plan, stats);
    if (ratio === null) return false;
    return ratio < (run.config.brokenRatio || 0.5);
  }

  /**
   * Remet l'item à neuf avec une orbe.
   *
   * L'orbe rejette les stats comme au craft — et détruit au passage le puits
   * ET les exotiques. On ne l'utilise donc qu'après un exo raté, jamais en
   * cours de route.
   */
  async function useOrbe(run, tables) {
    const stock = await run.transport.readStock();
    // La plus petite orbe qui couvre le niveau de l'item : inutile de gâcher
    // une magistrale sur un item niveau 62.
    const level = run.itemLevel || 200;
    // Une orbe ne couvre que les items jusqu'à SON niveau : pour un item 65,
    // la mineure (60) ne convient pas, il faut monter à la 120.
    const eligible = (tables.orbes || []).filter(o => o.level >= level);
    const candidate = eligible
      .filter(o => stock[o.id] > 0)
      .sort((a, b) => a.level - b.level)[0];
    if (!candidate) {
      const names = eligible.map(o => `${o.name} (niv ${o.level})`).join(', ');
      pushLog(run, 'warn', m('orbNeeded', { level, names: names || m('noKnownOrb') }));
      return false;
    }
    pushLog(run, 'info', m('orbUsed', { name: candidate.name }));
    try {
      const r = await run.transport.throwRune(candidate.id, { effectId: null, amount: 0 });
      if (r.rejected) { pushLog(run, 'warn', m('orbRejected')); return false; }
      run.state = engine.applyResult(run.state, { runeId: candidate.id }, r.stats);
      run.orbesUsed = (run.orbesUsed || 0) + 1;
      pushLog(run, 'ok', m('itemReset'));
      return true;
    } catch (e) {
      pushLog(run, 'warn', m('orbResetFailed', { msg: e.message }));
      return false;
    }
  }

  // Un exemplaire est « neuf » si au moins une stat visée est repassée sous
  // son objectif. C'est le signal le plus fiable sans savoir lire l'uid de
  // l'objet posé : un item déjà forgé reste au-dessus.
  function isFreshItem(plan, stats) {
    if (!stats || !Object.keys(stats).length) return false;
    return plan.targets.some(t => {
      const v = stats[t.effectId];
      return typeof v === 'number' && v < t.goal;
    });
  }

  // ─── Capture protocole ───────────────────────────────────────────────────

  const captures = new Map(); // accountId → { stream, file, count, startedAt }

  function capturePath(accountId) {
    return path.join(STAKK_DIR, `fm-capture-${accountId}.log`);
  }

  function startCapture(accountId) {
    stopCapture(accountId);
    fs.mkdirSync(STAKK_DIR, { recursive: true });
    const file = capturePath(accountId);
    const stream = fs.createWriteStream(file, { flags: 'w' });
    stream.write(`# STAKK FM capture — account=${accountId} start=${nowIso()}\n`);
    stream.write(m('captureHowto1') + '\n');
    stream.write(m('captureHowto2') + '\n');
    stream.write('# Format: HH:MM:SS.mmm DIR msgId=NNN len=LLL hex=…\n#\n');
    captures.set(accountId, { stream, file, count: 0, startedAt: Date.now() });
    log(`[fm] capture ON compte ${accountId} → ${file}`);
    return { file };
  }

  function stopCapture(accountId) {
    const cap = captures.get(accountId);
    if (!cap) return null;
    try { cap.stream.end(); } catch {}
    captures.delete(accountId);
    log(`[fm] capture OFF compte ${accountId} — ${cap.count} paquet(s) → ${cap.file}`);
    return { file: cap.file, count: cap.count };
  }


  // ─── Apprentissage passif du protocole ───────────────────────────────────
  //
  // Les signatures de types Ankama changent à chaque mise à jour du client :
  // un gabarit figé finit toujours par envoyer des messages que le serveur
  // ignore, et la forge tourne dans le vide sans rien dire d'utile.
  //
  // On apprend donc en continu, sans rien demander à l'utilisateur : dès qu'il
  // pose une rune LUI-MÊME, le paquet sortant contient l'identifiant d'une de
  // ses runes — identifiant que STAKK connaît déjà par son miroir d'inventaire.
  // Ce paquet devient le gabarit de pose, et la commande de jeu qui suit
  // devient le « forger ». Une MAJ Dofus est ainsi rattrapée à la première
  // pose manuelle, sans capture ni calibration.
  // L'appariement « pose puis commande » est générique : il vit dans le socle.
  // Ne reste ici que la fenêtre de LÉGITIMITÉ (l'atelier ouvert) et la source
  // des ancres (le miroir d'inventaire), qui, elles, sont propres à la FM.
  const pairLearners = new Map();   // accountId → PairLearner

  function pairLearnerFor(accountId) {
    let p = pairLearners.get(accountId);
    if (!p) pairLearners.set(accountId, p = learn.createPairLearner({ windowMs: 20000 }));
    return p;
  }

  // Un seul log par compte quand un paquet est écarté au profit d'un gabarit
  // qui répond : sans ça, chaque déplacement d'objet en remettrait une ligne.
  const provenLogged = new Set();

  /**
   * Preuve DE SESSION : ce gabarit a-t-il obtenu une réponse du serveur depuis
   * que STAKK tourne ? Volontairement en mémoire, alors que le store range la
   * sienne sur disque — ce ne sont pas la même question, et elles n'ont pas la
   * même durée de vie utile :
   *
   *   « l'apprentissage passif a-t-il le droit d'écraser ce gabarit ? »
   *     → preuve PERSISTÉE (store.isProven). Un redémarrage ne doit pas
   *       rouvrir la porte à l'écrasement d'un gabarit qui forge très bien.
   *
   *   « un jet muet compte-t-il comme un refus ? »
   *     → preuve DE SESSION, celle-ci. C'est la PORTE DE SORTIE de
   *       l'utilisateur. Tant qu'un gabarit passe pour prouvé, fm-live lit un
   *       jet muet comme un échec de forgemagie ordinaire, donc la série de
   *       refus ne monte jamais et l'escalade « protocole périmé » n'est
   *       jamais atteinte. Si on persistait cette preuve-là aussi, une MAJ
   *       Ankama sur un gabarit prouvé condamnerait le compte : le run
   *       tournerait dans le vide indéfiniment et même un redémarrage n'y
   *       changerait rien — il ne resterait que la remise à zéro manuelle du
   *       profil. En la lavant à chaque démarrage, les jets muets redeviennent
   *       des refus, l'escalade repart, et l'utilisateur retrouve le message
   *       qui l'invite à poser une rune à la main.
   *
   * On retient le TEMPLATE et pas un booléen : le profil peut changer en cours
   * de session (réapprentissage, repli sur l'intégré), et une preuve accordée
   * à l'ancien gabarit ne vaut rien pour le nouveau.
   *
   * Le store ne connaît pas cette preuve-là : tout ce qui invalide la preuve
   * persistée (flagStale, effacement du fichier de profil…) doit donc passer
   * par forgetProfileProof, jamais par le store seul — la règle vaut aussi
   * pour les futurs consommateurs du store (prix d'hôtel de vente, récolte).
   */
  const provenThisSession = (() => {
    const byAccount = new Map();   // accountId → template hex prouvé
    const templateInUse = (accountId) => {
      const p = storeFor(accountId).get();
      return (p && p.move && p.move.template) || null;
    };
    return {
      holds(accountId) {
        const t = byAccount.get(accountId);
        return !!t && templateInUse(accountId) === t;
      },
      mark(accountId) {
        const t = templateInUse(accountId);
        if (t) byAccount.set(accountId, t);
      },
      forget(accountId) { byAccount.delete(accountId); },
    };
  })();

  // Le serveur a répondu à un jet : les deux preuves se posent d'un coup.
  function markProfileProven(accountId) {
    provenThisSession.mark(accountId);
    // La preuve persistée ne barre que l'apprentissage passif : inutile de
    // réécrire le fichier à chaque jet réussi si elle y est déjà.
    const store = storeFor(accountId);
    if (!store.isProven()) store.markProven();
  }

  // Les faits démentent la preuve : les deux tombent ensemble. Ne retirer que
  // la persistée laisserait fm-live continuer à lire les jets muets comme des
  // échecs ordinaires jusqu'au prochain redémarrage.
  function forgetProfileProof(accountId) {
    provenThisSession.forget(accountId);
    storeFor(accountId).forgetProof();
  }

  // Identifiants d'objets connus pour ce compte : miroir de l'observateur, ou
  // à défaut la veille d'inventaire (l'atelier peut être ouvert avant qu'une
  // observation soit armée).
  const uidCache = new Map();      // accountId → { at, uids }
  const UID_CACHE_MS = 3000;
  function knownUidsFor(accountId) {
    const hit = uidCache.get(accountId);
    if (hit && Date.now() - hit.at < UID_CACHE_MS) return hit.uids;
    const out = new Set();
    const obs = observers.get(accountId);
    if (obs) {
      try { for (const o of obs.live.exportObjects()) out.add(o.uid); } catch {}
    }
    const w = stockWatchers.get(accountId);
    if (w) for (const uid of w.objects.keys()) out.add(uid);
    uidCache.set(accountId, { at: Date.now(), uids: out });
    return out;
  }

  /**
   * Répare le miroir après un changement de gabarit.
   *
   * Tant que STAKK émettait l'ancien format, le serveur ignorait chaque paquet
   * en silence — ce que le transport ne peut pas distinguer d'un identifiant
   * périmé. Il a donc écarté des piles saines au bout de trois « refus », et
   * mis les autres sur la touche. Ces verdicts ne valent plus rien maintenant
   * qu'on parle de nouveau la bonne langue : on efface les ardoises et on
   * réinjecte ce que la veille d'inventaire a vu, qui n'a jamais été affecté.
   */
  function repairAfterRelearn(accountId) {
    const obs = observers.get(accountId);
    if (!obs) return;
    const before = obs.live.exportObjects().length;
    // Le transport rend d'abord les piles qu'il avait lui-même écartées : il
    // est la seule source qui les connaisse à coup sûr.
    try { obs.live.clearRejects(); } catch { /* transport plus ancien */ }
    // Puis la veille d'inventaire, qui n'a jamais été affectée par les refus.
    const watched = stockWatchers.get(accountId);
    if (watched && watched.objects.size) obs.live.seedObjects([...watched.objects.values()]);
    const after = obs.live.exportObjects().length;
    if (after > before) {
      log(`[fm] miroir réparé après réapprentissage : ${after - before} pile(s) récupérée(s)`);
    }
  }

  function learnFromOutbound(accountId, buf) {
    // Sans fm-protocol, il n'y a ni gabarit intégré ni test d'équivalence : le
    // store écrirait alors un profil là où l'ancien code n'écrivait rien. La
    // garde est ici plutôt que déduite de la chaîne builtin/isEquivalent — un
    // invariant qui ne tient que par un raisonnement à trois étages ne tient pas.
    if (!protocol || typeof protocol.learnMove !== 'function') return;
    // Uniquement quand l'atelier est ouvert sur un item. La veille d'inventaire
    // seule ne suffit pas : elle démarre au lancement du compte, donc pendant
    // tout l'échange de connexion — et un paquet de cet échange portant un uid
    // connu se faisait prendre pour une pose de rune. Constaté le 10/08/2026 :
    // un gabarit valide (kcr/kqo) écrasé 32 s avant l'ouverture de l'atelier par
    // un gabarit fantaisiste (jbn/kmv), rendant la forge muette. Une pose de
    // rune n'existe que dans l'atelier : c'est la seule fenêtre légitime.
    if (!observers.has(accountId)) return;
    const uids = knownUidsFor(accountId);
    if (!uids.size) return;

    const pair = pairLearnerFor(accountId).feed(buf, uids);
    if (!pair) return;

    const candidat = {
      version: 2,
      source: 'auto',
      codes: { move: pair.move.typeName, ready: pair.ready.typeName },
      move: {
        msgId: null, template: pair.move.template,
        uidOffset: pair.move.uidOffset, uidLength: pair.move.uidLength,
        uidFieldNumber: pair.move.uidFieldNumber, typeName: pair.move.typeName,
        observedUids: [pair.move.anchor],
      },
      ready: { msgId: null, packet: pair.ready.packet, typeName: pair.ready.typeName,
        confidence: pair.ready.confidence },
      createdAt: new Date().toISOString(),
    };
    // Confirmation du profil déjà en place et gabarit prouvé sont tranchés par
    // le store : il ne reste ici que ce qu'il ne peut pas dire — le texte du
    // journal. La réparation du miroir, elle, part de son rappel onRelearn.
    const res = storeFor(accountId).learn(candidat);
    if (res.skipped === 'proven') {
      // Le gabarit en place forge réellement : ce paquet est autre chose qu'une
      // pose (déplacement, rangement, empilement…). On n'y touche pas.
      if (!provenLogged.has(accountId)) {
        provenLogged.add(accountId);
        // Nommer le gabarit qui l'emporte : c'est la seule ligne qui dit à
        // l'utilisateur POURQUOI sa pose manuelle n'a rien changé.
        const enPlace = ((storeFor(accountId).get() || {}).codes || {}).move;
        log(`[fm] paquet « ${candidat.codes.move} » ignoré : le gabarit en place `
          + `(${enPlace}) obtient des réponses du jeu`);
      }
      return;
    }
    if (res.error) { log(`[fm] écriture du protocole appris KO: ${res.error}`); return; }
    if (res.saved) {
      log(`[fm] protocole réappris depuis le jeu : pose=${candidat.codes.move} `
        + `forge=${candidat.codes.ready} (uid sur ${candidat.move.uidLength} octet(s) `
        + `à l'offset ${candidat.move.uidOffset})`);
    }
  }

  // Dernier recours, une fois le repli automatique épuisé : c'est le gabarit
  // intégré lui-même qui ne passe plus, et seule une pose manuelle peut
  // apprendre la nouvelle signature.
  function flagProfileStale(accountId) {
    // flagStale() n'efface que la preuve PERSISTÉE — le store ignore l'autre.
    // On retire donc les deux ici plutôt que de compter sur l'appelant pour
    // l'avoir déjà fait : un protocole déclaré périmé dont la preuve de
    // session survivrait ferait relire les jets muets comme des échecs
    // ordinaires, et l'escalade ne repartirait jamais.
    forgetProfileProof(accountId);
    if (!storeFor(accountId).flagStale()) return;
    log(`[fm] aucun jet n'obtient de réponse — protocole probablement périmé. `
      + `Pose une rune à la main dans l'atelier : STAKK réapprend le format tout seul.`);
  }

  // Tap global : n'écrit que si une capture est armée pour ce compte.
  // Le handler est volontairement minimal — il tourne sur CHAQUE paquet jeu.
  const tapInstalled = setPacketHandler ? setPacketHandler((accountId, dir, msgId, buf) => {
    const cap = captures.get(accountId);
    if (cap) {
      cap.count++;
      const ts = new Date().toISOString().slice(11, 23);
      // Paquet ENTIER : une troncature casserait à la fois le découpage en
      // trames et le gabarit rejoué. 8 Ko couvre largement les plus gros
      // messages observés (~500 o) sans faire exploser le dump.
      const hex = buf.subarray(0, 8192).toString('hex');
      cap.stream.write(`${ts} ${dir.toUpperCase().padEnd(3)} msgId=${msgId} len=${buf.length} hex=${hex}\n`);
    }
    // Sortants : apprentissage du protocole d'échange. Coût nul tant qu'aucun
    // atelier n'est observé (knownUidsFor renvoie un ensemble vide).
    if (dir === 'out') {
      try { learnFromOutbound(accountId, buf); }
      catch (e) { log(`[fm] apprentissage protocole KO compte ${accountId}: ${e.message}`); }
      return;
    }

    // Alimente l'observateur live : seuls les paquets serveur→client portent
    // l'inventaire et les effets de l'item.
    if (dir === 'in') {
      const obs = observers.get(accountId);
      const watching = stockWatchers.has(accountId);
      if (!obs && !watching) return;             // rien à alimenter : coût nul
      // Recollage d'abord : sinon un message coupé entre deux chunks est
      // simplement perdu, et c'est le cas des gros inventaires.
      feedInbound(accountId, buf, (frame) => {
        if (obs) {
          try { obs.live.observe(frame); }
          catch (e) { log(`[fm] observe KO compte ${accountId}: ${e.message}`); }
        } else {
          // Pas d'observation armée : on garde quand même l'inventaire de
          // départ sous le coude, c'est le seul moment où il passe.
          try { watchStock(accountId, frame); }
          catch (e) { log(`[fm] veille stock KO compte ${accountId}: ${e.message}`); }
        }
      });
    }
  }) : false;

  if (!tapInstalled) {
    log('[fm] tap paquets indisponible (game-proxy trop ancien) — capture et transport live désactivés');
  }

  // ─── Routes ──────────────────────────────────────────────────────────────

  registerRoute('GET', '/api/fm/tables', async () => {
    const { runes, effects } = await data.getTables();
    return { runes, effects };
  });

  registerRoute('POST', '/api/fm/tables/refresh', async () => {
    const { runes } = await data.refresh();
    return { ok: true, stats: Object.keys(runes).length };
  });

  registerRoute('GET', '/api/fm/items', async (body, req) => {
    const query = qs(req);
    // Recherche et libellés dans la langue de l'UI (slug dofusdb par langue).
    if (data.setLang) data.setLang(uiLang());
    const items = await data.searchItems(query.q || query.query || '');
    return { items };
  });

  registerRoute('GET', '/api/fm/item', async (body, req) => {
    const id = Number(qs(req).id);
    if (!Number.isFinite(id)) throw new Error('id requis');
    if (data.setLang) data.setLang(uiLang());
    const item = await data.getItem(id);
    const tables = await data.getTables();
    const onItem = new Set(item.stats.map(s => s.effectId));
    // Exos proposables : PA / PM / PO, uniquement ceux que l'item n'a pas
    // déjà et pour lesquels une rune existe.
    const exos = (data.EXO_EFFECT_IDS || [])
      .filter(eid => !onItem.has(eid) && tables.runes[eid])
      .map(eid => ({
        effectId: eid,
        label: effLabel(tables, eid, `${m('fmEffectFallback')} ${eid}`),
        tiers: tables.runes[eid],
        // Reliquat qu'il faudra avoir accumulé pour le poser : PA 100,
        // PM 90, Portée 51.
        cost: weights ? weights.exoCost(eid) : null,
      }));
    return {
      item,
      defaults: engine.defaultTargets(item, tables),
      axis: Object.fromEntries(item.stats.map(s => [s.effectId, engine.axisMax(s)])),
      runes: Object.fromEntries(item.stats
        .filter(s => tables.runes[s.effectId])
        .map(s => [s.effectId, tables.runes[s.effectId]])),
      labels: Object.fromEntries([
        ...item.stats.map(s => [s.effectId, effLabel(tables, s.effectId, '')]),
        ...exos.map(e => [e.effectId, e.label]),
      ]),
      exos,
      // Poids par stat : coût d'un point, marge avant le plafond de 101, et
      // fiabilité du coefficient (certaines sources se contredisent sur les
      // caractéristiques secondaires).
      weights: weights ? Object.fromEntries(item.stats.map(s => [s.effectId, {
        coef: weights.coefOf(s.effectId),
        uncertain: weights.isUncertain(s.effectId),
        natural: weights.weightOf(s.effectId, s.to || s.from),
        headroom: weights.lineHeadroom(s.effectId, s.to || s.from, s.to || s.from),
      }])) : null,
      maxLineWeight: weights ? weights.MAX_LINE_WEIGHT : null,
    };
  });

  registerRoute('GET', '/api/fm/config', () => loadFmConfig());

  registerRoute('POST', '/api/fm/config', (body) => {
    const cfg = loadFmConfig();
    if (body && typeof body === 'object') {
      if (Array.isArray(body.delay)) cfg.delay = [Number(body.delay[0]) || 0, Number(body.delay[1]) || 0];
      if (TRANSPORTS.has(body.transport)) cfg.transport = body.transport;
      if (body.preset && body.preset.key) {
        cfg.presets = cfg.presets || {};
        cfg.presets[body.preset.key] = body.preset.value;
      }
      if (body.deletePreset) {
        cfg.presets = cfg.presets || {};
        delete cfg.presets[body.deletePreset];
      }
      // Cadence : attente maximale d'une réponse, fenêtre de grâce, délai
      // entre la pose et la forge.
      if (body.tuning && typeof body.tuning === 'object') {
        cfg.tuning = { ...(cfg.tuning || {}), ...body.tuning };
      }
    }
    saveFmConfig(cfg);
    return cfg;
  });

  registerRoute('GET', '/api/fm/status', (body, req) => {
    const id = Number(qs(req).accountId);
    if (Number.isFinite(id)) return { run: publicRun(runs.get(id)) };
    return { runs: [...runs.values()].map(publicRun) };
  });

  // Signature stable du PLAN reconstruit. Sert à savoir si un retarget change
  // réellement quelque chose. Seul le PLAN peut débloquer un run bloqué —
  // rendre une rune jouable — ni la cadence ni l'orbe n'y changent rien : la
  // comparaison porte donc sur `targets`, pas sur les réglages bruts reçus.
  // Comparer les réglages bruts avait deux effets fâcheux : régler la cadence
  // sur un run bloqué changeait la signature et déclenchait une reprise qui se
  // rebloquait aussitôt ; et sans initialisation au démarrage, le tout premier
  // push — même identique aux réglages de départ — provoquait ce même cycle.
  function planSignature(targets) {
    return JSON.stringify((targets || [])
      .map(t => ({
        effectId: t.effectId, goal: t.goal,
        ceiling: t.ceiling === Infinity ? null : t.ceiling,
        phase: t.phase, thresholdPa: t.thresholdPa, thresholdRa: t.thresholdRa,
      }))
      .sort((a, b) => a.effectId - b.effectId));
  }

  registerRoute('POST', '/api/fm/start', async (body) => {
    const accountId = Number(body && body.accountId);
    if (!Number.isFinite(accountId)) throw new Error('accountId requis');
    const existing = runs.get(accountId);
    if (existing && existing.status === 'running') throw new Error(m('runAlready'));

    // Noms de runes et libellés de stats du journal : langue de l'UI.
    if (data.setLang) data.setLang(uiLang());
    const item = await data.getItem(Number(body.itemId));
    const tables = await data.getTables();
    const plan = engine.buildPlan(item, tables, {
      targets: body.targets || {},
      thresholds: body.thresholds || {},
      // Ordre de travail : les exos passent après les stats de base, sauf si
      // l'utilisateur en décide autrement.
      phases: body.phases || {},
      // Poids : permet au moteur de refuser les runes qui feraient franchir
      // la limite de poids d'une ligne.
      weights,
    });

    const cfg = loadFmConfig();
    const delay = Array.isArray(body.delay) ? body.delay : cfg.delay;
    const transportName = TRANSPORTS.has(body.transport) ? body.transport : 'sim';

    // Mode « tous les exemplaires » : en jeu le nombre vient de l'inventaire
    // observé (jamais deviné) ; en simulation l'utilisateur choisit combien il
    // veut voir défiler.
    const all = !!(body && body.all);
    let copies = 1;
    if (all) {
      copies = transportName === 'sim'
        ? Math.max(1, Math.min(50, Number(body.copies) || 1))
        : Math.max(1, itemCopies(accountId));
    }

    const run = {
      accountId,
      plan,
      itemLevel: item.level || 200,
      config: {
        delay, all,
        orbe: !!(body && body.orbe),
        // Part du poids d'origine en dessous de laquelle l'item est jugé
        // ruiné. 0,5 par défaut : la moitié du poids parti, c'est un exo qui
        // a mal tourné, pas une forge normale.
        brokenRatio: Number.isFinite(Number(body && body.brokenRatio))
          ? Math.min(0.95, Math.max(0.05, Number(body.brokenRatio)))
          : 0.5,
      },
      copies,
      itemIndex: 0,
      itemsDone: 0,
      totalThrown: 0,
      transportName,
      status: 'starting',
      // Amorcée au plan de départ : sans ça, le tout premier retarget — même
      // envoyant des réglages identiques — se voyait « changé » et déclenchait
      // un cycle reprise/reblocage inutile.
      lastRetargetSig: planSignature(plan.targets),
      blockedReason: null,
      log: [],
      history: [],
      // Libellés de TOUTES les stats de l'item, pas seulement des cibles :
      // un jet peut casser une ligne qu'on ne visait pas, et c'est
      // précisément ce qu'on veut voir.
      labels: Object.fromEntries(item.stats.map(s =>
        [s.effectId, effLabel(tables, s.effectId, `#${s.effectId}`)])),
      startedAt: Date.now(),
      error: null,
      abort: {},
      state: { stats: {}, stock: {}, thrown: 0 },
    };
    // 'dry' partage tout le chemin de 'live' (calibration, observation,
    // résolution d'uid, construction des paquets) et s'arrête juste avant
    // l'envoi. C'est le mode à utiliser pour valider un profil sur le vrai
    // jeu sans risque.
    // Mode Jeu : on arme l'observation à la volée si elle ne l'est pas. Le
    // profil étant intégré, l'utilisateur n'a plus aucune étape préalable —
    // il choisit son item et il lance.
    if ((transportName === 'live' || transportName === 'dry') && !observers.has(accountId)) {
      await armLive(accountId, plan.itemId);
    }
    run.transport = (transportName === 'live' || transportName === 'dry')
      ? createLiveTransport(accountId, plan, transportName === 'dry',
          (entry) => pushLog(run, 'info',
            m('dryNotSent', { len: entry.moveLength, rune: entry.runeGid, uid: entry.uid })))
      : createSimTransport(plan);

    runs.set(accountId, run);
    runLoop(run).catch(e => {
      run.status = 'error';
      run.error = e.message;
      pushLog(run, 'error', `boucle interrompue: ${e.message}`);
    });
    return { ok: true, run: publicRun(run) };
  });

  registerRoute('POST', '/api/fm/stop', (body) => {
    const accountId = Number(body && body.accountId);
    const run = runs.get(accountId);
    if (!run) return { ok: false, reason: 'aucun run' };
    // 'waiting-item' compte comme actif : sinon un arrêt demandé pendant
    // l'attente d'un exemplaire serait ignoré et la file repartirait.
    if (run.status === 'running' || run.status === 'starting' || run.status === 'waiting-item') {
      run.status = 'stopped';
      pushLog(run, 'info', m('stopRequested'));
      try { run.abort.onAbort && run.abort.onAbort(); } catch {}
    }
    return { ok: true, run: publicRun(run) };
  });

  // Réglages modifiables en cours de run. Le plan est reconstruit par le même
  // chemin qu'au démarrage, puis écrit DANS l'objet plan existant : runOneItem
  // en capture la référence à l'entrée, donc remplacer run.plan laisserait la
  // boucle sur l'ancien.
  registerRoute('POST', '/api/fm/retarget', async (body) => {
    const accountId = Number(body && body.accountId);
    if (!Number.isFinite(accountId)) throw new Error('accountId requis');
    const run = runs.get(accountId);
    if (!run) return { ok: false, reason: 'aucun run' };
    // 'blocked' est accepté : c'est le seul état qui veut dire « je voulais
    // continuer mais je ne peux pas », donc celui qu'un réglage peut débloquer.
    const live = run.status === 'running' || run.status === 'starting' || run.status === 'waiting-item';
    if (!live && run.status !== 'blocked') return { ok: false, reason: `run ${run.status}` };

    const settings = {
      targets: body.targets || {},
      thresholds: body.thresholds || {},
      phases: body.phases || {},
      // Champ absent → on garde la valeur courante, comme `delay` juste en
      // dessous. Un appelant postant un corps partiel ne doit pas désactiver
      // l'orbe sans le vouloir.
      orbe: (body && body.orbe !== undefined) ? !!body.orbe : run.config.orbe,
      delay: Array.isArray(body.delay) ? body.delay : run.config.delay,
    };

    if (data.setLang) data.setLang(uiLang());
    const item = await data.getItem(run.plan.itemId);
    const tables = await data.getTables();
    // Le run a pu être remplacé par un /api/fm/start entre-temps (fenêtre
    // async des deux await ci-dessus). Inatteignable aujourd'hui, mais
    // gratuit à verrouiller : on refuse plutôt que d'appliquer un plan à un
    // run qui n'est plus celui qu'on a validé plus haut.
    if (runs.get(accountId) !== run) return { ok: false, reason: 'run remplacé' };
    // Un plan sans cible ferait passer le run pour terminé. On refuse et on
    // garde le plan précédent plutôt que d'appliquer quelque chose à moitié.
    // engine.buildPlan lève plutôt que de renvoyer une liste vide : on
    // convertit cette levée en refus, comme le ferait un `targets.length`.
    let next;
    try {
      next = engine.buildPlan(item, tables, {
        targets: settings.targets, thresholds: settings.thresholds,
        phases: settings.phases, weights,
      });
    } catch (e) {
      // Le message réel part dans la réponse et dans le journal du run : sans
      // ça, une régression future se présenterait toujours sous « aucune
      // cible », sans indice, sur une machine à laquelle personne n'a accès.
      pushLog(run, 'warn', `retarget refusé (plan invalide) : ${e.message}`);
      return { ok: false, reason: `aucune cible : ${e.message}` };
    }
    if (!next.targets.length) return { ok: false, reason: 'aucune cible' };

    const sig = planSignature(next.targets);
    const changed = sig !== run.lastRetargetSig;
    run.lastRetargetSig = sig;

    Object.assign(run.plan, next);
    run.config.delay = settings.delay;
    run.config.orbe = settings.orbe;

    // La boucle ne relit pas le stock entre deux jets réussis (elle garde
    // run.state.stock) : sans ce rafraîchissement, un palier ajouté par ce
    // retarget resterait invisible jusqu'au prochain blocage. Le plan est
    // déjà appliqué à ce stade — un échec de lecture ne doit jamais faire
    // échouer la route.
    if (run.state) {
      try { run.state.stock = await run.transport.readStock(); }
      catch (e) { pushLog(run, 'warn', `stock non rafraîchi après retarget : ${e.message}`); }
    }

    // Ce readStock() est un troisième await : il rouvre la même fenêtre que
    // celle refermée plus haut. Un /api/fm/start concurrent (autorisé tant
    // que le run n'est pas 'running') a pu remplacer l'entrée pendant cette
    // lecture. Sans cette seconde vérification, runLoop(resume:true) ci-
    // dessous relancerait une boucle sur ce `run` désormais orphelin — or
    // createLiveTransport renvoie le transport PARTAGÉ du compte (obs.live),
    // pas un transport par run : deux boucles jetteraient des runes en
    // concurrence sur le même personnage en jeu. Ne pas retirer ni déplacer
    // cette garde sans revérifier tout le chemin d'await.
    if (runs.get(accountId) !== run) return { ok: false, reason: 'run remplacé' };

    // Reprise : uniquement si le run était bloqué faute de rune jouable — le
    // seul blocage qu'un réglage peut lever — ET que le plan a réellement
    // changé.
    if (run.status === 'blocked' && run.blockedReason === 'no-rune' && changed) {
      run.error = null;
      // totalThrown a déjà encaissé les jets de cet exemplaire quand la boucle
      // a rendu la main ; le += de fin d'item les rajouterait.
      run.totalThrown -= (run.state && run.state.thrown) || 0;
      runLoop(run, { resume: true }).catch(e => {
        run.status = 'error';
        run.error = e.message;
        pushLog(run, 'error', `boucle interrompue: ${e.message}`);
      });
      return { ok: true, resumed: true, run: publicRun(run) };
    }
    return { ok: true, resumed: false, run: publicRun(run) };
  });

  registerRoute('POST', '/api/fm/capture/start', (body) => {
    if (!tapInstalled) throw new Error(m('tapUnavailable'));
    const accountId = Number(body && body.accountId);
    if (!Number.isFinite(accountId)) throw new Error('accountId requis');
    return { ok: true, ...startCapture(accountId) };
  });

  registerRoute('POST', '/api/fm/capture/stop', (body) => {
    const accountId = Number(body && body.accountId);
    const r = stopCapture(accountId);
    return r ? { ok: true, ...r } : { ok: false, reason: 'aucune capture en cours' };
  });

  registerRoute('GET', '/api/fm/capture/status', (body, req) => {
    const accountId = Number(qs(req).accountId);
    const cap = captures.get(accountId);
    const file = cap ? cap.file : capturePath(accountId);
    let captured = 0;
    if (!cap) { try { captured = fs.statSync(file).size; } catch {} }
    const profile = storeFor(accountId).get();
    return {
      available: !!tapInstalled,
      analyzer: !!protocol,
      running: !!cap,
      count: cap ? cap.count : 0,
      file,
      captureBytes: cap ? null : captured,
      calibrated: !!profile,
      // 'builtin' = profil livré avec STAKK (rien à faire) ; 'learned' = issu
      // d'une calibration locale, qui prend le pas.
      profileSource: profile ? (profile.source === 'builtin' ? 'builtin' : 'learned') : null,
      profile: profileSummary(profile),
    };
  });

  // Analyse le dump et en déduit le profil rejouable. Séparé de la capture :
  // on peut relancer l'analyse sans refaire de jets, et l'échec est un
  // diagnostic lisible plutôt qu'une exception.
  registerRoute('POST', '/api/fm/calibrate', (body) => {
    if (!protocol) throw new Error(m('analyzerUnavailable'));
    const accountId = Number(body && body.accountId);
    if (!Number.isFinite(accountId)) throw new Error('accountId requis');
    if (captures.has(accountId)) throw new Error(m('stopCaptureFirst'));
    const file = capturePath(accountId);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch { throw new Error(m('noCapture')); }

    const r = protocol.buildProfile(text, { now: new Date().toISOString() });
    if (!r.ok) {
      log(`[fm] calibration ${accountId} KO (${r.reason}): ${r.detail}`);
      return { ok: false, reason: r.reason, detail: r.detail, stats: r.stats || null };
    }
    // Calibration = geste explicite de l'utilisateur : elle passe outre la
    // preuve comme outre l'équivalence, donc elle n'emprunte pas le store.
    saveProfileFile(accountId, r.profile);
    log(`[fm] calibration ${accountId} OK — move=${r.profile.move.msgId} ready=${r.profile.ready.msgId}`);
    return { ok: true, profile: profileSummary(r.profile), stats: r.stats };
  });

  registerRoute('POST', '/api/fm/live/arm', async (body) => {
    const accountId = Number(body && body.accountId);
    if (!Number.isFinite(accountId)) throw new Error('accountId requis');
    if (!body || body.itemId == null) throw new Error('itemId requis');
    return armLive(accountId, body.itemId);
  });

  // Apprentissage du reliquat par sa valeur affichée. Le chemin retenu est
  // rangé dans le profil du compte : c'est une caractéristique du build Dofus,
  // pas une préférence, donc il survit aux redémarrages.
  registerRoute('POST', '/api/fm/reliquat/learn', (body) => {
    const accountId = Number(body && body.accountId);
    if (!Number.isFinite(accountId)) throw new Error('accountId requis');
    const value = Number(body && body.value);
    if (!Number.isFinite(value) || value < 0) throw new Error(m('residueValueRequired'));
    const obs = observers.get(accountId);
    if (!obs) throw new Error(m('notArmedOpenWorkshop'));

    const r = obs.live.learnReliquat(value);
    if (!r.ok) return r;

    const profile = storeFor(accountId).get() || {};
    profile.reliquatPath = r.path;
    saveProfileFile(accountId, profile);
    log(`[fm] reliquat appris pour le compte ${accountId} : champ ${r.path} = ${value}`);
    return r;
  });

  // Diagnostic : contenu brut du dernier paquet d'atelier. Sert à repérer le
  // reliquat en comparant deux relevés — un champ protobuf à zéro est omis,
  // donc le reliquat n'existe dans le paquet que lorsqu'il est non nul.
  registerRoute('GET', '/api/fm/live/dump', (body, req) => {
    const accountId = Number(qs(req).accountId);
    if (!Number.isFinite(accountId)) throw new Error('accountId requis');
    const obs = observers.get(accountId);
    if (!obs) throw new Error(m('notArmedShort'));
    const q = qs(req);
    // ?throw=1 : tout ce que le serveur a envoyé pendant le dernier jet.
    // C'est là que se trouve le reliquat, pas dans la description de l'item.
    // ?throw=1 : la réponse au dernier jet (ou, à défaut, les derniers
    // paquets reçus — les jets faits à la main ne passent pas par STAKK).
    const dump = q.throw ? obs.live.dumpLastThrow(!!q.recent) : obs.live.dumpLastItemPacket();
    if (!dump) return { ok: false, reason: 'no-packet' };
    return { ok: true, ...dump };
  });

  registerRoute('POST', '/api/fm/reliquat/forget', (body) => {
    const accountId = Number(body && body.accountId);
    if (!Number.isFinite(accountId)) throw new Error('accountId requis');
    const learned = loadProfileFile(accountId);
    if (learned && learned.reliquatPath) {
      delete learned.reliquatPath;
      saveProfileFile(accountId, learned);
    }
    // L'observateur garde le chemin en mémoire : on le réarme pour repartir
    // d'une lecture propre.
    disarmLive(accountId);
    return { ok: true };
  });

  registerRoute('POST', '/api/fm/live/disarm', (body) => {
    const accountId = Number(body && body.accountId);
    return { ok: disarmLive(accountId) };
  });

  registerRoute('GET', '/api/fm/live/status', (body, req) => {
    const accountId = Number(qs(req).accountId);
    if (!Number.isFinite(accountId)) throw new Error('accountId requis');
    return liveStatus(accountId);
  });

  registerRoute('POST', '/api/fm/calibrate/reset', (body) => {
    const accountId = Number(body && body.accountId);
    if (!Number.isFinite(accountId)) throw new Error('accountId requis');
    // Le fichier emporte la preuve persistée, mais pas celle de session : si le
    // profil résolu après effacement porte le même gabarit — le cas normal
    // quand la preuve était posée sur l'intégré — elle tiendrait encore, les
    // jets muets resteraient lus comme des échecs de forgemagie ordinaires et
    // le run n'escaladerait jamais vers « protocole périmé ». C'est le bouton
    // de dernier recours : il doit tout rendre.
    forgetProfileProof(accountId);
    try { fs.unlinkSync(storeFor(accountId).path); } catch {}
    return { ok: true };
  });

  // Un compte qui se déconnecte ne peut plus recevoir de jets : on coupe.
  // La connexion du personnage est le seul moment où l'inventaire complet
  // passe sur le fil : on ouvre la fenêtre de veille dès le lancement.
  on('launch', ({ accountId }) => {
    if (!tapInstalled) return;
    startStockWatch(accountId);
    log(`[fm] veille inventaire ouverte pour le compte ${accountId}`);
  });

  on('detach', ({ accountId }) => {
    stockWatchers.delete(accountId);
    inbound.delete(accountId);
    const run = runs.get(accountId);
    if (run && (run.status === 'running' || run.status === 'starting' || run.status === 'waiting-item')) {
      run.status = 'stopped';
      run.error = m('accountDisconnected');
      pushLog(run, 'warn', m('accountDisconnectedRun'));
      try { run.abort.onAbort && run.abort.onAbort(); } catch {}
    }
    stopCapture(accountId);
    // Le canal du compte est mort : l'observateur pointerait sur un socket
    // fermé et enverrait dans le vide.
    disarmLive(accountId);
  });

  log('[fm] plugin chargé' + (tapInstalled ? ' (tap paquets actif)' : ''));

  return { _runs: runs, _publicRun: publicRun, _data: data, _engine: engine };
};
