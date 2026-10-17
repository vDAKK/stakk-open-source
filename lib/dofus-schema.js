'use strict';

/**
 * dofus-schema.js — décodage de paquets Dofus 3 GUIDÉ PAR LE SCHÉMA.
 *
 * `protocol-learn.js` lit un protobuf sans rien savoir de lui : il devine la
 * forme, met des hypothèses en concurrence, et s'ancre sur une valeur déjà
 * connue pour retrouver un champ. C'est ce qui a permis à STAKK de marcher
 * sans schéma — au prix de déductions, dont certaines fausses.
 *
 * Ce module fait l'inverse. Il part du schéma compilé par
 * `scripts/compiler-schema.js` et décode exactement, sans deviner.
 *
 * ═══ Pourquoi on peut se passer d'apprendre ══════════════════════════════
 *
 * Un message de jeu voyage dans un `google.protobuf.Any` :
 *
 *     hea { oneof { hdx request = 1; hdy response = 2; hdw event = 3 } }
 *     hdw { google.protobuf.Any content = 1; int32 uid = 2; }
 *     Any { string type_url = 1; bytes value = 2; }
 *
 * et `type_url` vaut `type.ankama.com/<nom>`. LE NOM DU MESSAGE EST SUR LE
 * FIL. Il suffit de le lire, de chercher le message dans le schéma, et tout
 * le paquet se décode — y compris les messages dont Ankama a obfusqué jusqu'au
 * dernier nom de champ.
 *
 * Ce que le schéma NE dit pas, c'est le sens : il donne `hhf { hgi flww = 9 }`
 * sans dire que c'est `TreasureHuntEvent.questType`. Ce dictionnaire-là vit
 * dans les modules métier.
 *
 * ═══ Durée de vie ════════════════════════════════════════════════════════
 *
 * Le schéma décrit UN build. Ankama rebat les noms à chaque patch : `hhf`
 * désignera autre chose, et le décodage rendra des champs justes rattachés au
 * mauvais message. D'où `estConnu()` et `nomsInconnus()` — de quoi détecter la
 * péremption plutôt que de la subir — et le maintien de l'apprentissage en
 * secours.
 *
 * Aucune I/O hors du chargement du schéma : Buffer in → objet out.
 */

const PREFIXE_TYPE_URL = 'type.ankama.com/';

module.exports = function createDofusSchema(deps) {
  deps = deps || {};

  const table = deps.table || chargerTable();
  const messages = table.messages || {};
  const enums = new Set(table.enums || []);
  const scalaires = table.scalaires || {};

  function chargerTable() {
    const zlib = require('zlib');
    const fs = require('fs');
    const path = require('path');
    const fichier = path.join(__dirname, 'dofus-schema.json.gz');
    return JSON.parse(zlib.gunzipSync(fs.readFileSync(fichier)).toString('utf8'));
  }

  // ─── Lecture bas niveau ──────────────────────────────────────────────────

  // Accumulation en flottant plutôt qu'en OR bit-à-bit : les identifiants
  // Dofus dépassent 2^32 (un uid d'entité tourne autour de 1e10) et un OR
  // 32 bits les corromprait en silence. Même parti pris que protocol-learn.
  function lireVarInt(buf, pos) {
    let valeur = 0, facteur = 1;
    for (let i = pos; i < buf.length && i - pos < 10; i++) {
      const octet = buf[i];
      valeur += (octet & 0x7f) * facteur;
      if ((octet & 0x80) === 0) return { valeur, taille: i - pos + 1 };
      facteur *= 128;
    }
    return null;
  }

  function typeDeFil(type, repete) {
    if (scalaires[type]) {
      const fil = scalaires[type];
      if (fil === 'string' || fil === 'bytes') return 'bloc';
      // Un scalaire numérique répété s'encode en paquet : un seul champ de
      // type 2 contenant la suite des valeurs, pas un champ par valeur.
      return repete ? 'paquetable' : 'simple';
    }
    return enums.has(type) ? (repete ? 'paquetable' : 'simple') : 'message';
  }

  function decoderScalaire(type, brut) {
    switch (scalaires[type]) {
      case 'bool': return brut !== 0;
      case 'zigzag': return (brut % 2 === 0) ? brut / 2 : -(brut + 1) / 2;
      default: return brut;
    }
  }

  // ─── Décodage guidé ──────────────────────────────────────────────────────

  /**
   * Décode `buf` comme une instance de `nom`.
   *
   * Un champ absent du schéma n'est pas une erreur : Ankama en ajoute d'un
   * build à l'autre. Il est rendu sous la clé `?<numéro>` avec sa valeur
   * brute, ce qui rend la dérive visible au lieu de la perdre.
   *
   * Renvoie null si le message est inconnu ou le tampon illisible.
   */
  function decoder(nom, buf, profondeur) {
    profondeur = profondeur || 0;
    const schema = messages[nom];
    if (!schema || !Buffer.isBuffer(buf)) return null;
    // Garde-fou : un champ mal typé peut faire lire un bloc comme un message
    // et repartir en descente. 32 niveaux dépassent de loin le protocole réel.
    if (profondeur > 32) return null;

    const sortie = {};
    let pos = 0;

    while (pos < buf.length) {
      const tag = lireVarInt(buf, pos);
      if (!tag) return null;
      pos += tag.taille;

      const numero = Math.floor(tag.valeur / 8);
      const fil = tag.valeur % 8;
      if (numero === 0) return null;

      const champ = schema[numero];
      const cle = champ ? champ.n : `?${numero}`;
      const repete = !!(champ && champ.r);

      let valeur = null;
      if (fil === 0) {
        const v = lireVarInt(buf, pos);
        if (!v) return null;
        pos += v.taille;
        valeur = champ ? decoderScalaire(champ.t, v.valeur) : v.valeur;
      } else if (fil === 2) {
        const len = lireVarInt(buf, pos);
        if (!len) return null;
        pos += len.taille;
        const fin = pos + len.valeur;
        if (fin > buf.length) return null;
        const bloc = buf.subarray(pos, fin);
        pos = fin;

        if (!champ) {
          valeur = bloc;
        } else if (scalaires[champ.t] === 'string') {
          valeur = bloc.toString('utf8');
        } else if (scalaires[champ.t] === 'bytes') {
          valeur = bloc;
        } else if (typeDeFil(champ.t, repete) === 'paquetable') {
          // Suite de varints collés : on la déplie en tableau.
          const liste = [];
          let p = 0;
          while (p < bloc.length) {
            const v = lireVarInt(bloc, p);
            if (!v) return null;
            p += v.taille;
            liste.push(decoderScalaire(champ.t, v.valeur));
          }
          sortie[cle] = (sortie[cle] || []).concat(liste);
          continue;
        } else {
          valeur = decoder(champ.t, bloc, profondeur + 1);
          // Un sous-message illisible ne condamne pas le paquet : on garde les
          // octets, le reste du message est souvent ce qui nous intéresse.
          if (valeur === null) valeur = bloc;
        }
      } else if (fil === 5) {
        if (pos + 4 > buf.length) return null;
        valeur = buf.readUInt32LE(pos); pos += 4;
      } else if (fil === 1) {
        if (pos + 8 > buf.length) return null;
        valeur = Number(buf.readBigUInt64LE(pos)); pos += 8;
      } else {
        return null; // types de fil 3 et 4 (groupes) : abandonnés par proto3
      }

      if (repete) (sortie[cle] = sortie[cle] || []).push(valeur);
      else sortie[cle] = valeur;
    }

    return sortie;
  }

  // ─── Encodage guidé ──────────────────────────────────────────────────────

  function ecrireVarInt(valeur) {
    const out = [];
    let v = Math.floor(valeur);
    do { const b = v % 128; v = Math.floor(v / 128); out.push(v ? b | 0x80 : b); } while (v);
    return Buffer.from(out);
  }

  function encoderScalaire(type, valeur) {
    switch (scalaires[type]) {
      case 'bool': return ecrireVarInt(valeur ? 1 : 0);
      case 'zigzag': return ecrireVarInt(valeur >= 0 ? valeur * 2 : -valeur * 2 - 1);
      default: return ecrireVarInt(valeur);
    }
  }

  /**
   * Encode `objet` comme une instance de `nom`, en suivant le schéma.
   *
   * Les clés sont les noms de champs du schéma ; ce qui n'y figure pas est
   * ignoré. Les champs absents de l'objet ne sont pas émis — proto3 les traite
   * comme valant leur défaut, ce qui est bien ce qu'on veut.
   *
   * Émettre dans l'ordre croissant des numéros n'est pas exigé par protobuf,
   * mais c'est ce que fait le client officiel : un paquet fabriqué reste ainsi
   * indiscernable d'un paquet légitime.
   */
  function encoder(nom, objet, profondeur) {
    profondeur = profondeur || 0;
    const schema = messages[nom];
    if (!schema || !objet || typeof objet !== 'object') return null;
    if (profondeur > 32) return null;

    const morceaux = [];
    for (const numero of Object.keys(schema).map(Number).sort((a, b) => a - b)) {
      const champ = schema[numero];
      const valeur = objet[champ.n];
      if (valeur === undefined || valeur === null) continue;
      const repete = !!champ.r;
      const genre = typeDeFil(champ.t, repete);

      if (genre === 'paquetable') {
        const liste = Array.isArray(valeur) ? valeur : [valeur];
        if (!liste.length) continue;
        const corps = Buffer.concat(liste.map(v => encoderScalaire(champ.t, v)));
        morceaux.push(ecrireVarInt(numero * 8 + 2), ecrireVarInt(corps.length), corps);
        continue;
      }

      const liste = repete ? (Array.isArray(valeur) ? valeur : [valeur]) : [valeur];
      for (const v of liste) {
        if (genre === 'simple') {
          morceaux.push(ecrireVarInt(numero * 8), encoderScalaire(champ.t, v));
        } else {
          let bloc;
          if (scalaires[champ.t] === 'string') bloc = Buffer.from(String(v), 'utf8');
          else if (scalaires[champ.t] === 'bytes') bloc = Buffer.isBuffer(v) ? v : Buffer.from(v);
          else if (Buffer.isBuffer(v)) bloc = v; // sous-message déjà encodé
          else bloc = encoder(champ.t, v, profondeur + 1);
          if (bloc === null) return null;
          morceaux.push(ecrireVarInt(numero * 8 + 2), ecrireVarInt(bloc.length), bloc);
        }
      }
    }
    return Buffer.concat(morceaux);
  }

  /** Emballe un message dans son `Any`, type_url compris. */
  function encoderAny(nom, objet) {
    const corps = Buffer.isBuffer(objet) ? objet : encoder(nom, objet);
    if (corps === null) return null;
    const url = Buffer.from(PREFIXE_TYPE_URL + nom, 'utf8');
    return Buffer.concat([
      ecrireVarInt(1 * 8 + 2), ecrireVarInt(url.length), url,
      ecrireVarInt(2 * 8 + 2), ecrireVarInt(corps.length), corps,
    ]);
  }

  // ─── Enveloppe Any ───────────────────────────────────────────────────────

  /** `type.ankama.com/hhf` → `hhf`. Tolère un type_url déjà nu. */
  function nomDepuisTypeUrl(url) {
    if (typeof url !== 'string' || !url) return null;
    const i = url.lastIndexOf('/');
    return i === -1 ? url : url.slice(i + 1);
  }

  /**
   * Décode un `google.protobuf.Any` : { nom, contenu, brut }.
   *
   * `contenu` est null si le message n'est pas au schéma — cas nominal après
   * un patch Ankama. `brut` reste disponible pour l'apprentissage de secours.
   */
  function decoderAny(buf) {
    let pos = 0, url = null, valeur = null;
    while (pos < buf.length) {
      const tag = lireVarInt(buf, pos);
      if (!tag) return null;
      pos += tag.taille;
      if (tag.valeur % 8 !== 2) return null;
      const len = lireVarInt(buf, pos);
      if (!len) return null;
      pos += len.taille;
      const fin = pos + len.valeur;
      if (fin > buf.length) return null;
      const bloc = buf.subarray(pos, fin);
      pos = fin;
      if (Math.floor(tag.valeur / 8) === 1) url = bloc.toString('utf8');
      else if (Math.floor(tag.valeur / 8) === 2) valeur = bloc;
    }
    if (url === null) return null;
    const nom = nomDepuisTypeUrl(url);
    return {
      nom,
      brut: valeur || Buffer.alloc(0),
      contenu: valeur ? decoder(nom, valeur) : null,
    };
  }

  const MARQUEUR = Buffer.from(PREFIXE_TYPE_URL, 'latin1');

  /**
   * Extrait le premier `Any` d'un paquet TEL QU'IL ARRIVE, cadre compris.
   *
   * `decoderAny` suppose un `Any` nu ; sur le fil il est enveloppé dans une
   * trame (longueur, identifiant de message, enveloppe Event/Request). Le
   * décoder à plat rendait n'importe quoi : le type_url se retrouvait lu comme
   * le premier champ du message, et le paquet d'une récolte passait pour un
   * événement de chasse. On repère donc le marqueur, on remonte au tag qui le
   * précède pour valider le cadrage, puis on lit la charge utile.
   *
   * Rend null s'il n'y a pas d'`Any` lisible — un refus franc, pas une lecture
   * approximative.
   */
  function extraireAny(buf) {
    if (!Buffer.isBuffer(buf)) return null;
    const at = buf.indexOf(MARQUEUR);
    if (at === -1) return null;

    // La longueur du type_url précède le marqueur, et le tag `0a` (champ 1,
    // bytes) précède la longueur. Elle tient sur un à trois octets.
    for (let tete = at - 1; tete >= at - 3 && tete >= 0; tete--) {
      const taille = lireVarInt(buf, tete);
      if (!taille || tete + taille.taille !== at) continue;
      if (taille.valeur < MARQUEUR.length) continue;
      if (tete === 0 || buf[tete - 1] !== 0x0a) continue;
      const finUrl = at + taille.valeur;
      if (finUrl > buf.length) continue;

      const nom = buf.toString('latin1', at + MARQUEUR.length, finUrl);
      // Champ 2 de l'Any : la charge utile. Absente sur un message vide.
      if (buf[finUrl] !== 0x12) return { nom, brut: Buffer.alloc(0), contenu: null };
      const len = lireVarInt(buf, finUrl + 1);
      if (!len) return null;
      const debut = finUrl + 1 + len.taille;
      const fin = debut + len.valeur;
      if (fin > buf.length) return null;
      const brut = buf.subarray(debut, fin);
      return { nom, brut, contenu: decoder(nom, brut) };
    }
    return null;
  }

  // ─── Introspection ───────────────────────────────────────────────────────

  const estConnu = (nom) => Object.prototype.hasOwnProperty.call(messages, nom);
  const estEnum = (nom) => enums.has(nom);
  const champsDe = (nom) => messages[nom] || null;
  const nbMessages = () => Object.keys(messages).length;

  // Les noms obfusqués font tous exactement trois lettres et sont alloués en
  // séquence par Ankama : l'ordre alphabétique est donc l'ordre de déclaration.
  // C'est ce qui rend le voisinage exploitable pour retrouver un message après
  // un patch — cf. dofus-noms.js. Trié une fois, la liste est réutilisée.
  let poolTrie = null;
  function nomsMessages() {
    if (!poolTrie) poolTrie = Object.keys(messages).sort();
    return poolTrie;
  }

  /**
   * Cherche les messages dont la forme colle à `attendu`, une description
   * { numéro: type }. Sert à retrouver un message après un patch : les noms
   * changent, la structure beaucoup moins. Renvoie les noms candidats.
   */
  function messagesDeForme(attendu) {
    const numeros = Object.keys(attendu);
    const trouves = [];
    for (const [nom, champs] of Object.entries(messages)) {
      if (Object.keys(champs).length !== numeros.length) continue;
      if (numeros.every(n => champs[n] && champs[n].t === attendu[n])) trouves.push(nom);
    }
    return trouves;
  }

  return {
    PREFIXE_TYPE_URL,
    decoder, decoderAny, extraireAny, nomDepuisTypeUrl,
    encoder, encoderAny,
    estConnu, estEnum, champsDe, nbMessages, nomsMessages, messagesDeForme,
  };
};
