'use strict';

/**
 * game-proxy.js — Proxy TCP
 *
 * Un proxy par compte. Toutes les connexions sont redirigées ici par Frida.
 * Le proxy :
 *   - Reçoit "CONNECT host:port HTTP/1.0 " du hook Frida
 *   - Ouvre la connexion réelle vers le serveur
 *   - Intercepte le message protobuf jrz (fingerprint machine) et le remplace
 *   - Remape port 26116 → port du vrai zaap server
 */

module.exports = function createGameProxyModule(deps) {
  deps = deps || {};
  const net    = deps.net    || require('net');
  const crypto = deps.crypto || require('crypto');
  const fs     = deps.fs     || require('fs');
  const path   = deps.path   || require('path');

let nextPort = 8102;

// Callback optionnel pour notifier le web-server quand on détecte des infos perso.
// Défini par web-server via setCharacterUpdateHandler().
let onCharacterUpdate = null;
function setCharacterUpdateHandler(fn) { onCharacterUpdate = fn; }

// Callback pour notifier d'un changement de map (mapId). Reverse-engineering
// décodé depuis recon: chaque OUT contient un Any (type.ankama.com/<code>)
// dont le inner message porte un varint = target mapId. Voir extractTargetMapId
// pour le détail de la détection robuste aux re-obfuscations du code.
let onMapUpdate = null;
function setMapUpdateHandler(fn) { onMapUpdate = fn; }

// ─── Tap paquets (plugins) ──────────────────────────────────────────────────
//
// Un plugin (ex: fm.js) peut observer TOUS les paquets du canal jeu (port 5555)
// et en injecter. Le tap est passif par défaut : si aucun handler n'est posé,
// le coût est un test de nullité par paquet.
//
// Contrat du handler : (accountId, dir, msgId, buf, channel) où dir vaut 'in'
// (serveur→client) ou 'out' (client→serveur). Le handler NE DOIT PAS modifier
// `buf` — pour altérer le flux, injecte un nouveau paquet via `channel`. Toute
// exception est avalée : un plugin cassé ne doit jamais couper une connexion
// de jeu.
// Liste (et non handler unique) : plusieurs plugins peuvent vouloir écouter le
// canal sans se marcher dessus. Retourne un désabonnement.
const packetHandlers = [];
function setPacketHandler(fn) {
  if (typeof fn !== 'function') return () => {};
  packetHandlers.push(fn);
  return () => {
    const i = packetHandlers.indexOf(fn);
    if (i >= 0) packetHandlers.splice(i, 1);
  };
}

// accountId → channel du socket de jeu actif. Permet à un plugin d'émettre
// sans attendre de recevoir un paquet d'abord.
const gameChannels = new Map();
function getChannel(accountId) { return gameChannels.get(accountId) || null; }

/**
 * Génère un faux fingerprint (long nombre décimal) à partir du flashKey.
 * Doit être de la même longueur que l'original pour ne pas casser le protobuf.
 */
function generateFakeFingerprint(flashKey, originalLength) {
  // Générer un nombre pseudo-aléatoire déterministe à partir du flashKey
  let hash = crypto.createHash('sha512').update(flashKey).digest('hex');
  // Convertir en décimal et ajuster la longueur
  let result = '';
  while (result.length < originalLength) {
    for (let i = 0; i < hash.length && result.length < originalLength; i += 8) {
      const chunk = parseInt(hash.slice(i, i + 8), 16);
      result += chunk.toString();
    }
    hash = crypto.createHash('sha512').update(hash).digest('hex');
  }
  // Le premier chiffre ne doit pas être 0
  if (result[0] === '0') result = '1' + result.slice(1);
  return result.slice(0, originalLength);
}

// ─── Character extractor ────────────────────────────────────────────────────
//
// Approche: on scanne chaque paquet serveur→client pour trouver des string fields
// protobuf qui ressemblent à des noms de personnages, et des int fields proches
// qui pourraient être le niveau (1-200).
//
// Protobuf wire format:
//   - String field: tag = (field_num << 3) | 2, suivi d'un varint longueur, suivi des bytes
//   - VarInt field:  tag = (field_num << 3) | 0, suivi d'un varint
//
// Les tags de string sont: 0x0a (f1), 0x12 (f2), 0x1a (f3), 0x22 (f4), 0x2a (f5), etc.
// Les tags d'int sont:     0x08 (f1), 0x10 (f2), 0x18 (f3), 0x20 (f4), 0x28 (f5), etc.
//
// On cherche des strings de 3 à 20 caractères qui contiennent uniquement des caractères
// valides pour un nom Dofus (lettres, chiffres, tirets). Si plusieurs sont trouvées dans
// un même paquet, c'est probablement la CharactersListMessage ou un dump similaire.

// Table des classes Dofus 2/3 par classId (protobuf est 0-indexé — Feca=0,
// et en protobuf3 la valeur 0 est omise, d'où l'absence du champ pour les Fecas).
const CLASS_BY_ID = {
  0: 'Feca', 1: 'Osamodas', 2: 'Enutrof', 3: 'Sram', 4: 'Xelor',
  5: 'Ecaflip', 6: 'Eniripsa', 7: 'Iop', 8: 'Cra', 9: 'Sadida',
  10: 'Sacrieur', 11: 'Pandawa', 12: 'Roublard', 13: 'Zobal',
  14: 'Steamer', 15: 'Eliotrope', 16: 'Huppermage', 17: 'Ouginak',
  18: 'Forgelance',
};

function isValidCharName(s) {
  if (s.length < 3 || s.length > 20) return false;
  return /^[A-Za-z\u00C0-\u017F][A-Za-z0-9\u00C0-\u017F\- ]{2,19}$/.test(s);
}

// Décode un varint à partir de offset. Retourne { value, length } ou null.
function readVarInt(buf, offset) {
  let value = 0;
  let shift = 0;
  let length = 0;
  for (let i = offset; i < buf.length && i < offset + 10; i++) {
    const b = buf[i];
    value |= (b & 0x7f) << shift;
    length++;
    if ((b & 0x80) === 0) return { value, length };
    shift += 7;
  }
  return null;
}

// Extrait les vraies entries de personnages d'un buffer.
// Pattern strict décodé depuis le hex dump de msgId 16192:
//   0a <nameLen> <name>       // field 1 LEN = nom
//   [10 <classId>]             // field 2 varint = classe (optionnel, omis si default)
//   [18 <sex>]                 // field 3 varint = sexe
//   20 <level>                 // field 4 varint = niveau TOTAL (main + omega)
//   2a 1d <29 date bytes>      // field 5 LEN 29 = dernier jeu ISO
//
// Un candidat n'est valide que si level ET date sont trouvés juste après le nom.
// Ça élimine les faux positifs comme les nicknames de compte ou les noms de guilde.
function extractCharacterEntries(buf) {
  const results = [];
  for (let i = 0; i < buf.length - 40; i++) {
    if (buf[i] !== 0x0a) continue;
    const nameLen = buf[i + 1];
    if (nameLen < 3 || nameLen > 20) continue;
    const nameStart = i + 2;
    const nameEnd = nameStart + nameLen;
    if (nameEnd > buf.length) continue;

    // Valide l'ASCII/UTF-8 printable
    let valid = true;
    for (let j = nameStart; j < nameEnd; j++) {
      const b = buf[j];
      if (b < 0x20 || b === 0x7f) { valid = false; break; }
    }
    if (!valid) continue;

    const name = buf.toString('utf8', nameStart, nameEnd);
    if (!isValidCharName(name)) continue;

    // Décodage des champs après le nom
    let offset = nameEnd;
    let classId = null, sex = null, level = null, date = null;

    if (offset < buf.length && buf[offset] === 0x10) {
      const v = readVarInt(buf, offset + 1);
      if (v && v.value >= 0 && v.value <= 18) { classId = v.value; offset += 1 + v.length; }
    }
    // Si classId est absent du protobuf, c'est la valeur par défaut = 0 = Feca
    if (classId === null) classId = 0;
    if (offset < buf.length && buf[offset] === 0x18) {
      const v = readVarInt(buf, offset + 1);
      if (v && v.value >= 1 && v.value <= 2) { sex = v.value; offset += 1 + v.length; }
    }
    if (offset < buf.length && buf[offset] === 0x20) {
      const v = readVarInt(buf, offset + 1);
      if (v && v.value >= 1 && v.value <= 10000) { level = v.value; offset += 1 + v.length; }
    }
    if (offset + 31 <= buf.length && buf[offset] === 0x2a && buf[offset + 1] === 0x1d) {
      const dateStr = buf.toString('utf8', offset + 2, offset + 2 + 29);
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(dateStr)) {
        date = dateStr;
      }
    }

    // Strict: level ET date obligatoires → élimine les faux positifs
    if (level !== null && date !== null) {
      results.push({ name, classId, sex, level, date });
    }
  }
  return results;
}

// Préfixe STABLE du type_url Any : 0a 13 (field 1 LEN=19) + "type.ankama.com/".
// Les 3 derniers octets du type_url sont un code OBFUSQUÉ qu'Ankama rebats à
// CHAQUE build (recon mai 2026 = "isp", juin 2026 = "jrb", ...). On ne matche
// donc PLUS le code littéral — il casse à chaque maj. On matche le préfixe
// stable puis on valide la FORME du message pour isoler le ChangeMapRequest
// sans dépendre du code. Survit aux futures re-obfuscations, zéro recapture.
const TYPE_URL_PREFIX = Buffer.from('\x0a\x13type.ankama.com/', 'latin1');
const TYPE_URL_LEN = TYPE_URL_PREFIX.length + 3; // + code obfusqué 3 lettres = 21

// Largeur varint d'un mapId Dofus 3. Tous les mapId observés (8.4e7 → 2.06e8)
// tiennent sur EXACTEMENT 4 octets varint (plage 2 097 152 → 268 435 455).
// C'est le discriminant clé : les entity ids partagent la même enveloppe Any
// mais s'encodent sur 5 octets (~1e10), et readVarInt fait des OR bit-à-bit
// 32-bit qui WRAP au-delà de 4 octets → un simple test de plage sur leur
// valeur serait faussé. Filtrer sur length===4 les écarte proprement, ainsi
// que les petits flags (1-2 octets).
const MAP_ID_VARINT_LEN = 4;

// Scanne un buffer client→serveur pour un changement de map. Retourne le
// nouveau mapId si trouvé, sinon null. Robuste à la fragmentation TCP, aux
// paquets multi-sub-messages, ET aux re-obfuscations du code type_url.
//
// Forme ChangeMapRequest observée (recon) :
//   0a 13 "type.ankama.com/<xyz>" 12 05 <tag-varint> <mapId sur 4 octets>
// Le numéro de field interne varie selon le build (field 1/2/3 → tag 0x08/
// 0x10/0x18) donc on accepte tout tag varint (wire type 0), puis on exige la
// largeur 4 octets pour confirmer que c'est bien un mapId et pas autre chose.
function extractTargetMapId(buf) {
  let idx = 0;
  while ((idx = buf.indexOf(TYPE_URL_PREFIX, idx)) !== -1) {
    // Saute le préfixe + les 3 octets de code obfusqué → on pointe Any.value.
    let p = idx + TYPE_URL_LEN;
    // Any.value = field 2 LEN (tag 0x12), suivi de <varint length> <inner>.
    if (p < buf.length && buf[p] === 0x12) {
      p++;
      const lenInfo = readVarInt(buf, p);
      if (lenInfo) {
        p += lenInfo.length;
        // Inner : 1er champ = mapId en varint (wire type 0, tag & 0x07 === 0).
        if (p < buf.length && (buf[p] & 0x07) === 0) {
          const v = readVarInt(buf, p + 1);
          if (v && v.length === MAP_ID_VARINT_LEN) return v.value;
        }
      }
    }
    idx += TYPE_URL_LEN;
  }
  return null;
}

function createGameProxy(opts = {}) {
  const localPort = nextPort++;
  const { flashKey, localAddress, proxyUri, zaapPort, accountId, dataDir, reconDir } = opts;

  // État d'extraction pour ce proxy (= pour ce compte)
  // On garde la meilleure date vue pour ne pas écraser avec des données plus anciennes.
  const charState = {
    bestDate: null,        // date ISO du perso actif connu, pour comparer
    lastPersistedName: null,
    dumpWritten: false,
    lastMapId: null,       // dernier mapId broadcast pour éviter les doublons
  };

  // ─── Health-check auto de la détection de map ────────────────────────────
  // Objectif : ne JAMAIS rester silencieusement cassé après une maj Ankama qui
  // changerait la STRUCTURE du ChangeMapRequest (le cas rare que le fix
  // structurel ne couvre pas). Au lieu de demander à l'user de refaire un recon
  // manuel, STAKK détecte la panne et dump automatiquement le contexte.
  //
  // Principe : l'inbound sert d'ORACLE "le joueur charge des maps" (peu importe
  // qu'il soit bruité — cf. faux positif msgId 11265 observé en recon). Si
  // l'inbound voit de l'activité map MAIS l'outbound n'extrait AUCUN mapId, c'est
  // que l'encodage outbound a changé → on flush un recon auto + warning. Le bruit
  // inbound ne peut pas déclencher de fausse alerte : la condition exige
  // outboundMapHits===0, qui n'arrive qu'en panne réelle.
  const health = {
    outHits: 0,            // mapId extraits côté outbound (= ça marche)
    inHits: 0,             // activité map vue côté inbound (oracle)
    flagged: false,        // alerte déjà émise (latch, évite le spam)
    recentOut: [],         // ring buffer des derniers paquets OUT (pour le dump)
  };
  const HEALTH_RING_MAX = 80;       // paquets OUT gardés pour le dump auto
  const HEALTH_IN_TRIGGER = 3;      // activité map inbound mini avant de juger

  // Une fois l'outbound prouvé fonctionnel (1er hit), on coupe l'oracle inbound
  // pour zéro coût en régime établi.
  function healthOracleActive() {
    return !health.flagged && health.outHits === 0;
  }

  function pushRecentOut(buf, msgId) {
    const ts = new Date().toISOString().slice(11, 23);
    const hex = buf.subarray(0, 256).toString('hex');
    health.recentOut.push(`${ts} OUT msgId=${msgId} len=${buf.length} hex=${hex}`);
    if (health.recentOut.length > HEALTH_RING_MAX) health.recentOut.shift();
  }

  function flagMapDetectionBroken() {
    if (health.flagged) return;
    health.flagged = true;
    const banner =
      `[Proxy:${localPort}] *** DÉTECTION MAP CASSÉE — le joueur charge des maps ` +
      `(inbound) mais aucun mapId outbound extrait. La structure du ChangeMapRequest ` +
      `a probablement changé suite à une maj Dofus.`;
    console.log(banner);
    if (!dataDir) return;
    try {
      const dir = path.join(dataDir, 'recon');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `auto-broken-${accountId}-${localPort}.log`);
      const head =
        `# STAKK AUTO-RECON — détection map cassée\n` +
        `# account=${accountId} port=${localPort} at=${new Date().toISOString()}\n` +
        `# inHits=${health.inHits} outHits=${health.outHits}\n` +
        `# Derniers ${health.recentOut.length} paquets OUT (cherche le ChangeMapRequest):\n#\n`;
      fs.writeFileSync(file, head + health.recentOut.join('\n') + '\n');
      console.log(`[Proxy:${localPort}] Auto-recon écrit → ${file} (envoie ce fichier pour le fix)`);
    } catch (e) {
      console.log(`[Proxy:${localPort}] auto-recon écriture KO: ${e.message}`);
    }
  }

  // ─── Recon mode ──────────────────────────────────────────────────────────
  // Quand reconDir est fourni, on log chaque paquet port 5555 (in + out) vers
  // un fichier texte lisible — timestamp, direction, msgId, longueur, hex dump.
  // Usage: reverse engineer msgIds inconnus (ex: changement de map, inventaire).
  let reconStream = null;
  if (reconDir && accountId) {
    try {
      if (!fs.existsSync(reconDir)) fs.mkdirSync(reconDir, { recursive: true });
      const reconFile = path.join(reconDir, `recon-${accountId}-${localPort}.log`);
      reconStream = fs.createWriteStream(reconFile, { flags: 'w' });
      reconStream.write(`# STAKK map recon — account=${accountId} port=${localPort} started=${new Date().toISOString()}\n`);
      reconStream.write(`# Format: HH:MM:SS.mmm DIR msgId=NNN len=LLL hex=<first 128 bytes>\n#\n`);
      console.log(`[Proxy:${localPort}] RECON mode ON → ${reconFile}`);
    } catch (e) {
      console.log(`[Proxy:${localPort}] RECON init KO: ${e.message}`);
      reconStream = null;
    }
  }
  function logRecon(dir, msgId, buf) {
    if (!reconStream) return;
    const now = new Date();
    const ts = now.toISOString().slice(11, 23); // HH:MM:SS.mmm
    const hex = buf.subarray(0, 128).toString('hex').match(/.{1,2}/g).join(' ');
    reconStream.write(`${ts} ${dir} msgId=${msgId} len=${buf.length} hex=${hex}\n`);
  }
  function logReconMarker(label) {
    if (!reconStream) return;
    const ts = new Date().toISOString().slice(11, 23);
    reconStream.write(`\n# === ${ts} MARKER: ${label} ===\n\n`);
  }

  function persistCharacters(entries, msgId) {
    if (!accountId || !dataDir) return;
    if (entries.length === 0) return;
    // Trier par date décroissante — le plus récent = le perso actif
    const sorted = [...entries].sort((a, b) => b.date.localeCompare(a.date));
    const current = sorted[0];
    // Si on a déjà persisté un perso avec une date égale ou plus récente → skip (évite de flood les écritures)
    if (charState.bestDate && current.date <= charState.bestDate && current.name === charState.lastPersistedName) return;
    const file = path.join(dataDir, String(accountId));
    try {
      const acc = JSON.parse(fs.readFileSync(file, 'utf8'));
      acc.characterName = current.name;
      acc.characterLevel = current.level;
      acc.characterClass = current.classId ? (CLASS_BY_ID[current.classId] || null) : (acc.characterClass || null);
      acc.characters = sorted.map(e => ({
        name: e.name,
        level: e.level,
        class: e.classId ? (CLASS_BY_ID[e.classId] || null) : null,
        lastPlayed: e.date,
      }));
      fs.writeFileSync(file, JSON.stringify(acc, null, 4));
      charState.bestDate = current.date;
      charState.lastPersistedName = current.name;
      console.log(`[Proxy:${localPort}] *** LISTE PERSOS (${entries.length}) msgId=${msgId}: ` +
        sorted.map(e => `${e.name} lvl${e.level}${e.classId?' '+CLASS_BY_ID[e.classId]:''}`).join(', '));
      console.log(`[Proxy:${localPort}] *** PERSO ACTIF: ${current.name} lvl ${current.level}${current.classId?' ('+CLASS_BY_ID[current.classId]+')':''}`);
      if (onCharacterUpdate) {
        onCharacterUpdate(accountId, {
          characterName: current.name,
          characterLevel: current.level,
          characterClass: current.classId ? CLASS_BY_ID[current.classId] : null,
          characters: acc.characters,
        });
      }
    } catch (e) {
      console.log(`[Proxy:${localPort}] persistCharacters KO: ${e.message}`);
    }
  }

  function dumpPacket(d, msgId) {
    if (!accountId || !dataDir || charState.dumpWritten) return;
    try {
      const file = path.join(dataDir, String(accountId) + '.chars.hex');
      const header = `msgId=${msgId} len=${d.length} at=${new Date().toISOString()}\n`;
      const hex = d.toString('hex').match(/.{1,32}/g).join('\n');
      fs.writeFileSync(file, header + hex);
      charState.dumpWritten = true;
      console.log(`[Proxy:${localPort}] Hex dump -> ${file}`);
    } catch {}
  }

  function tryExtract(d, msgId) {
    if (!accountId) return;
    const entries = extractCharacterEntries(d);
    if (entries.length === 0) return;
    // Ignore les paquets trop gros (> 20 entries matchantes = probable noise)
    if (entries.length > 20) return;
    dumpPacket(d, msgId);
    persistCharacters(entries, msgId);
  }

  return new Promise((resolve, reject) => {
    const tunnels = new Set();
    // Handler de connexion partagé entre listeners IPv4 et IPv6 (Mac).
    // Sur macOS, IPV6_V6ONLY=1 par défaut → un socket Frida IPv6 (Dofus
    // utilise AF_INET6 family=30 pour le game server) ne route PAS vers
    // notre listener IPv4 127.0.0.1. On bind donc aussi un listener ::1
    // et le hook Frida écrit ::1 (au lieu de ::ffff:127.0.0.1) sur Mac.
    function handleConnection(socket) {
      let host, port;
      if (!socket._queue) socket._queue = [];
      tunnels.add(socket);
      // Buffer sliding pour retrouver MAP_CHANGE_MARKER même quand il est
      // fragmenté entre 2 chunks TCP. On garde les 200 derniers bytes de la
      // concat prev+new pour la prochaine passe. 200 > marker(21) + inner
      // msg(~40) donc couvre les fragmentations plausibles.
      let mapIdTail = Buffer.alloc(0);

      // Canal d'injection exposé aux plugins pour CE tunnel. Créé seulement
      // pour le canal jeu (port 5555), enregistré tant que le socket vit.
      let channel = null;
      function makeChannel() {
        return {
          accountId,
          port: localPort,
          // client → serveur : passe par la file d'attente tant que l'upstream
          // n'est pas connecté, exactement comme le trafic normal.
          sendToServer(buf) {
            if (!Buffer.isBuffer(buf) || !buf.length) return false;
            if (socket._remote?._connected) { socket._remote.write(buf); return true; }
            socket._queue.push(buf);
            return true;
          },
          // serveur → client : sert à simuler une réponse côté jeu.
          sendToClient(buf) {
            if (!Buffer.isBuffer(buf) || !buf.length) return false;
            socket.write(buf);
            return true;
          },
        };
      }
      function tap(dir, msgId, buf) {
        if (!packetHandlers.length || !accountId) return;
        for (const fn of packetHandlers) {
          try { fn(accountId, dir, msgId, buf, channel); }
          catch (e) { console.log(`[Proxy:${localPort}] tap ${dir} err: ${e.message}`); }
        }
      }

      socket.on('data', async data => {
        try {
          const s = data.toString('utf8', 0, Math.min(data.length, 60));
          if (s.startsWith('CONNECT')) {
            const connectEnd = data.indexOf(Buffer.from('HTTP/1.0 '));
            const connectLen = connectEnd >= 0 ? connectEnd + 9 : data.length;
            const connectStr = data.toString('utf8', 0, connectLen);
            const remaining = connectEnd >= 0 && connectLen < data.length ? data.subarray(connectLen) : null;

            const split = connectStr.split(' ')[1].split(':');
            host = split[0];
            if (host === '0.0.0.0') host = '127.0.0.1';
            port = parseInt(split[1]);

            if (port === 26116 && zaapPort) port = zaapPort;
            if (port === 26117) port = zaapPort ? zaapPort + 1 : 26617;

            console.log(`[Proxy:${localPort}] CONNECT → ${host}:${port}${remaining ? ' +' + remaining.length + 'B' : ''}`);

            if (remaining && remaining.length > 0) {
              socket._queue.push(remaining);
            }

            socket._remote = new net.Socket();

            // Canal jeu : un seul par compte à la fois. Si un ancien tunnel
            // traîne (reconnexion), il est remplacé — le teardown ne supprime
            // l'entrée que si elle lui appartient encore.
            if (port === 5555 && accountId) {
              channel = makeChannel();
              gameChannels.set(accountId, channel);
            }

            const connectOpts = { host, port };
            if (localAddress && host !== '127.0.0.1') connectOpts.localAddress = localAddress;

            socket._remote.connect(connectOpts);

            socket._remote.on('connect', () => {
              socket._remote._connected = true;
              if (socket._queue.length > 0) {
                console.log(`[Proxy:${localPort}] Connected, flushing ${socket._queue.length} queued`);
              }
              socket._queue.forEach(pkt => socket._remote.write(pkt));
              socket._queue.length = 0;
            });

            socket._remote.on('data', d => {
              if (port === 5555 && d.length >= 2) {
                const msgId = d.readUInt16BE(0) >> 2;
                logRecon('IN ', msgId, d);
                // Scanner pour infos perso
                try { tryExtract(d, msgId); } catch (e) { console.log(`[Proxy:${localPort}] extract err: ${e.message}`); }
                // Oracle health-check : l'inbound confirme que le joueur charge
                // des maps. Actif seulement tant que l'outbound n'a rien prouvé
                // (zéro coût en régime établi). Si activité inbound MAIS outbound
                // muet → encodage outbound cassé → dump auto.
                if (healthOracleActive() && accountId) {
                  try {
                    if (extractTargetMapId(d) !== null) {
                      health.inHits++;
                      if (health.inHits >= HEALTH_IN_TRIGGER && health.outHits === 0) {
                        flagMapDetectionBroken();
                      }
                    }
                  } catch {}
                }
                tap('in', msgId, d);
              }
              socket.write(d);
            });

            socket._remote.on('close', () => socket.destroy());
            socket._remote.on('error', e => {
              console.log(`[Proxy:${localPort}] remote error: ${e.message}`);
              socket.destroy();
            });
          } else {
            // Données jeu → serveur
            if (port === 5555 && data.length >= 2) {
              const msgId = data.readUInt16BE(0) >> 2;
              logRecon('OUT', msgId, data);

              // Détecter changement de map dans toute requête sortante.
              // On scan prev-tail + data pour retrouver le marker même s'il
              // est coupé entre 2 chunks TCP (cause la plus fréquente de
              // "MAP CHANGE raté"). La queue (200B) est assez grande pour
              // couvrir marker (21B) + inner message complet.
              try {
                // Tant que la détection n'a rien sorti, on garde les paquets OUT
                // en ring buffer pour pouvoir dump le contexte si on flag une panne.
                if (healthOracleActive()) pushRecentOut(data, msgId);
                const scanBuf = mapIdTail.length > 0
                  ? Buffer.concat([mapIdTail, data])
                  : data;
                const newMapId = extractTargetMapId(scanBuf);
                if (newMapId !== null) {
                  health.outHits++;
                  if (newMapId !== charState.lastMapId) {
                    charState.lastMapId = newMapId;
                    console.log(`[Proxy:${localPort}] *** MAP CHANGE → ${newMapId}`);
                    if (accountId && onMapUpdate) {
                      try { onMapUpdate(accountId, newMapId); }
                      catch (e) { console.log(`[Proxy:${localPort}] onMapUpdate err: ${e.message}`); }
                    }
                  }
                }
                mapIdTail = scanBuf.length > 200
                  ? scanBuf.subarray(scanBuf.length - 200)
                  : scanBuf;
              } catch (e) { console.log(`[Proxy:${localPort}] mapId extract err: ${e.message}`); }

              // Intercepter le device_identifier dans IdentificationRequest
              // et le fingerprint jrz
              if (flashKey) {
                data = replaceDeviceIdentifier(data, flashKey, localPort);
                data = replaceFingerprint(data, flashKey, localPort);
              }

              // Tap APRÈS réécriture : les plugins voient l'octet exact qui
              // part sur le réseau, donc rejouable tel quel.
              tap('out', msgId, data);
            }

            if (socket._remote?._connected) {
              socket._remote.write(data);
            } else {
              socket._queue.push(data);
            }
          }
        } catch (e) {
          console.error(`[Proxy:${localPort}] erreur:`, e.message);
        }
      });

      // Détruire l'upstream dès que le client se ferme (FIN, RST, ou kill).
      // 'close' est le seul event garanti de se déclencher dans tous les cas ;
      // sans ça, si Dofus est tué par SIGKILL le socket upstream reste ouvert
      // et le serveur Ankama garde le perso connecté jusqu'à son idle timeout.
      const teardown = () => {
        tunnels.delete(socket);
        if (channel && accountId && gameChannels.get(accountId) === channel) {
          gameChannels.delete(accountId);
        }
        try { socket._remote?.destroy(); } catch {}
      };
      socket.on('close', teardown);
      socket.on('error', () => {});
    }

    const server = net.createServer(handleConnection);
    // Listener secondaire IPv6 sur ::1 pour Mac où Frida redirige les
    // connect AF_INET6 vers ::1 (cf frida-hook.js). Sur Windows c'est
    // créé aussi mais Frida y redirige tout en IPv4 ::ffff: → routé via
    // dual-stack auto, listener IPv6 inutilisé. Coût zéro.
    const server6 = net.createServer(handleConnection);

    // On attend que les 2 listeners se soient settled (success OU error)
    // avant de résoudre. Sinon race : v4 résout immédiatement avec [v4 only]
    // alors que v6 finit par bind 1ms plus tard mais le state est déjà figé.
    let v4Settled = false, v6Settled = false;
    let listenedV4 = false, listenedV6 = false;
    let resolved = false;
    function maybeResolve() {
      if (resolved || !v4Settled || !v6Settled) return;
      if (!listenedV4) return reject(new Error('v4 listen failed'));
      resolved = true;
      console.log(`[Proxy] Port ${localPort} (flashKey=${flashKey || 'none'})${listenedV6 ? ' [v4+v6]' : ' [v4 only]'}`);
      resolve({
        port: localPort,
        reconMarker: logReconMarker,
        close: () => new Promise(r => {
          for (const s of tunnels) {
            try { s._remote?.destroy(); } catch {}
            try { s.destroy(); } catch {}
          }
          tunnels.clear();
          try { reconStream?.end(); } catch {}
          let pending = 1 + (listenedV6 ? 1 : 0);
          const done = () => { if (--pending === 0) { console.log(`[Proxy:${localPort}] ferme`); r(); } };
          try { server.close(done); } catch { done(); }
          if (listenedV6) { try { server6.close(done); } catch { done(); } }
        }),
      });
    }

    server.listen(localPort, '127.0.0.1', () => { listenedV4 = true; v4Settled = true; maybeResolve(); });
    server.on('error', e => { v4Settled = true; if (!resolved) reject(e); });
    server6.listen(localPort, '::1', () => {
      listenedV6 = true; v6Settled = true;
      console.log(`[Proxy:${localPort}] v6 listener bind OK on ::1`);
      maybeResolve();
    });
    // Si v6 fail (ex: pas d'IPv6 stack ou port pris), on continue en v4-only.
    server6.on('error', e => {
      console.log(`[Proxy:${localPort}] v6 listen KO (${e.code} ${e.message}), continue en v4-only`);
      v6Settled = true;
      maybeResolve();
    });
  });
}

/**
 * Remplace le device_identifier dans le protobuf IdentificationRequest.
 * Format: le premier message vers le serveur de connexion (port 5555) contient
 * un champ protobuf string (tag 0a, field 1) de 64 bytes hex = device_identifier.
 * On le remplace par un hash dérivé du flashKey (même longueur).
 */
function replaceDeviceIdentifier(data, flashKey, port) {
  // Chercher le pattern protobuf: 0a 40 (field 1, length 64) suivi de 64 chars hex uppercase
  for (let i = 0; i < data.length - 66; i++) {
    if (data[i] === 0x0a && data[i + 1] === 0x40) {
      // Vérifier que les 64 bytes suivants sont des caractères hex (0-9, A-F)
      let isHex = true;
      for (let j = 0; j < 64; j++) {
        const b = data[i + 2 + j];
        if (!((b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66))) {
          isHex = false;
          break;
        }
      }
      if (!isHex) continue;

      const origId = data.toString('utf8', i + 2, i + 2 + 64);
      // Générer un fake device_identifier de 64 chars hex à partir du flashKey
      const fakeId = crypto.createHash('sha256').update('device-' + flashKey).digest('hex').toUpperCase()
                   + crypto.createHash('sha256').update('device2-' + flashKey).digest('hex').toUpperCase();
      const fakeId64 = fakeId.slice(0, 64);

      console.log(`[Proxy:${port}] *** DEVICE_ID ORIGINAL: ${origId}`);
      console.log(`[Proxy:${port}] *** DEVICE_ID REMPLACE: ${fakeId64}`);

      const result = Buffer.from(data);
      result.write(fakeId64, i + 2, 64, 'utf8');
      return result;
    }
  }
  return data;
}

/**
 * Cherche la string "jrz" dans le buffer protobuf.
 * Si trouvée, le long nombre décimal qui suit est le fingerprint machine.
 * On le remplace par un nombre différent, de MÊME longueur, dérivé du flashKey.
 */
function replaceFingerprint(data, flashKey, port) {
  // Chercher "type.ankama.com/jrz" dans le buffer
  const marker = Buffer.from('type.ankama.com/jrz');
  const idx = data.indexOf(marker);
  if (idx === -1) return data;

  // Après le marker, on cherche le nombre décimal (séquence de digits ASCII)
  let numStart = -1;
  let numEnd = -1;
  for (let i = idx + marker.length; i < data.length; i++) {
    const b = data[i];
    if (b >= 0x30 && b <= 0x39) { // '0'-'9'
      if (numStart === -1) numStart = i;
      numEnd = i + 1;
    } else if (numStart !== -1) {
      break;
    }
  }

  if (numStart === -1) return data;

  const origFingerprint = data.toString('utf8', numStart, numEnd);
  const fakeFingerprint = generateFakeFingerprint(flashKey, origFingerprint.length);

  console.log(`[Proxy:${port}] *** FINGERPRINT ORIGINAL: ${origFingerprint.slice(0, 30)}... (${origFingerprint.length} chars)`);
  console.log(`[Proxy:${port}] *** FINGERPRINT REMPLACE: ${fakeFingerprint.slice(0, 30)}... (${fakeFingerprint.length} chars)`);

  // Remplacer in-place (même longueur = pas besoin de toucher aux headers protobuf)
  const result = Buffer.from(data);
  result.write(fakeFingerprint, numStart, fakeFingerprint.length, 'utf8');
  return result;
}

  return {
    createGameProxy, setCharacterUpdateHandler, setMapUpdateHandler,
    setPacketHandler, getChannel,
  };
};
