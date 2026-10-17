'use strict';

/**
 * zaap-server.js — Simule le serveur Zaap Thrift (port 26116)
 *
 * Protocol: Thrift Binary strict mode, RAW (sans TFramedTransport).
 *
 * Exposé comme FACTORY : ses deps (net, uuid, haapi) sont injectées par
 * web-server.js au démarrage.
 */

module.exports = function createZaapServer(deps) {
  deps = deps || {};
  const net   = deps.net   || require('net');
  const uuidv4 = deps.uuidv4 || require('uuid').v4;
  const haapi = deps.haapi || require('./haapi');
  const fs    = deps.fs    || require('fs');
  const path  = deps.path  || require('path');

  // Répertoire des comptes. `dataDir` n'est pas encore fourni par les exe en
  // circulation : on le recalcule comme web-server le fait, pour que la
  // persistance de clé arrive en module hot sans attendre un nouveau build.
  const DATA_DIR = deps.dataDir || path.join(
    process.env.STAKK_APP_ROOT
      || (process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..')),
    'release', 'data');
  const DEBUG = deps.DEBUG !== undefined ? deps.DEBUG : true;

const pendingByHash = new Map();   // hash -> accountData
const sessionByKey  = new Map();   // gameSession -> accountData

function registerHash(hash, accountData) {
  pendingByHash.set(hash, accountData);
}

// Demande un token de jeu. La clé courante d'abord — c'est elle qui porte le
// certificat Shield. Si Ankama la rejette (révocation, expiration), on tente UN
// renouvellement, en sachant qu'il invalidera le certificat : le message qui
// suit dit alors clairement quoi faire.
async function createTokenWithRetry(account, gameParam) {
  try {
    return await haapi.createToken(
      account.key, gameParam, account.proxy, account.certificate || null, account.hm1 || null);
  } catch (first) {
    // « Invalid security parameters » = certificat refusé pour CETTE clé.
    // Renouveler n'y changerait rien (la nouvelle clé n'aura pas non plus le
    // certificat) : autant remonter le diagnostic utile tout de suite.
    if (/Invalid security/i.test(first.message)) throw first;

    // Un compte à certificat ne se répare pas par un renouvellement : la clé
    // neuve n'hérite pas du certificat, donc CreateToken échouerait de nouveau
    // — en « Invalid security parameters » cette fois, et la clé d'origine
    // serait morte pour de bon. On préfère échouer sans rien casser.
    if (account.certificate) {
      console.log(`[Zaap] clé refusée pour ${account.login} — renouvellement volontairement évité `
        + `(le compte porte un certificat : roter la clé le détacherait définitivement)`);
      throw first;
    }

    console.log(`[Zaap] clé refusée pour ${account.login} — tentative de renouvellement`);
    const freshKey = await haapi.refreshApiKey(account.key, account.refreshToken, account.proxy);
    persistRotatedKey(account, freshKey);
    return await haapi.createToken(
      freshKey, gameParam, account.proxy, account.certificate || null, account.hm1 || null);
  }
}

// Range la clé fraîche renvoyée par Ankama : sur disque (source de vérité au
// prochain lancement) ET dans les copies en mémoire de ce compte, pour que les
// sessions déjà ouvertes n'utilisent pas une clé périmée.
function persistRotatedKey(account, freshKey) {
  if (!freshKey || !account || freshKey === account.key) return;
  const previous = account.key;

  for (const held of [...pendingByHash.values(), ...sessionByKey.values()]) {
    if (held.accountId === account.accountId) held.key = freshKey;
  }
  account.key = freshKey;

  const file = path.join(DATA_DIR, String(account.accountId));
  try {
    // Relecture avant écriture : le fichier porte aussi les stats de lancement
    // et les persos, qu'une copie mémoire plus ancienne écraserait.
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    saved.key = freshKey;
    saved.refreshDate = Date.now();
    fs.writeFileSync(file, JSON.stringify(saved, null, 4));
    console.log(`[Zaap] clé rotée par Ankama pour ${account.login} : `
      + `${String(previous).slice(0, 8)}… → ${String(freshKey).slice(0, 8)}… (sauvegardée)`);
  } catch (e) {
    console.error(`[Zaap] ⚠ clé rotée pour ${account.login} mais NON sauvegardée (${e.message}) `
      + `— le prochain lancement risque de refuser la clé`);
  }
}

let _server = null;
let _textSocketServer = null;

// Port 26616 comme krm35 — le jeu est lancé avec --port=26116
// mais Frida redirige 26116 → proxy → 26616 (ici)
function startZaapServer(port = 26616) {
  if (_server) return Promise.resolve({ server: _server, port: _server.address().port });

  return new Promise((resolve, reject) => {
    const server = net.createServer(socket => handleClient(socket));
    server.on('error', err => {
      if (err.code === 'EADDRINUSE') {
        server.close();
        startZaapServer(port + 1).then(resolve).catch(reject);
      } else reject(err);
    });
    server.listen(port, '127.0.0.1', () => {
      _server = server;
      const p = server.address().port;
      console.log(`[Zaap] Serveur démarré sur port ${p}`);
      // TextSocketServer : le vrai Zaap tourne sur 26117 (Thrift=26116 +1),
      // mais on passe --port=26616 aux jeux, donc Retro pourrait chercher sur
      // 26617 (notre +1). On écoute sur les DEUX pour couvrir les deux
      // conventions.
      startTextSocketServer(26117);
      if (p + 1 !== 26117) startTextSocketServer(p + 1);
      resolve({ server, port: p });
    });
  });
}

// Serveur "TextSocket" : accepte les connexions UTF-8 et les garde ouvertes
// sans rien faire de plus (suffisant pour débloquer Retro). Si un jeu envoie
// des données, on les log en DEBUG.
const _textSocketServers = new Map();
function startTextSocketServer(port) {
  if (_textSocketServers.has(port)) return;
  const srv = net.createServer(socket => {
    socket.setEncoding('utf8');
    if (DEBUG) console.log(`[TextSocket:${port}] client connected (${socket.remoteAddress}:${socket.remotePort})`);
    socket.on('data', (data) => {
      if (DEBUG) console.log(`[TextSocket:${port}] <- ${String(data).slice(0, 200)}`);
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      if (DEBUG) console.log(`[TextSocket] client disconnected`);
    });
  });
  srv.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.log(`[TextSocket] port ${port} déjà utilisé — probablement un vrai Zaap tourne en parallèle (pas bloquant pour Dofus 3)`);
    } else {
      console.log(`[TextSocket] erreur: ${err.message}`);
    }
  });
  srv.listen(port, '127.0.0.1', () => {
    _textSocketServers.set(port, srv);
    console.log(`[TextSocket] Serveur démarré sur port ${port}`);
  });
}

// ─── Client handler ───────────────────────────────────────────────────────────

function handleClient(socket) {
  let buf = Buffer.alloc(0);
  let processing = false;
  let firstChunkLogged = false;

  if (DEBUG) console.log(`[Zaap] client connected (${socket.remoteAddress}:${socket.remotePort})`);

  socket.on('data', chunk => {
    if (DEBUG && !firstChunkLogged) {
      firstChunkLogged = true;
      // Dump les 64 premiers octets reçus pour diagnostic protocol
      console.log(`[Zaap] first chunk from :${socket.remotePort} (${chunk.length}): ${chunk.slice(0, 64).toString('hex')}`);
    }
    buf = Buffer.concat([buf, chunk]);
    if (!processing) drain();
  });

  async function drain() {
    processing = true;
    while (buf.length > 0) {
      const msg = tryParseMessage(buf);
      if (!msg) {
        // Deux cas : (a) buffer trop court → on attend le prochain chunk,
        // (b) magic invalide (pas du Thrift) → drop. On différencie via le
        // magic Thrift 0x80 0x01 qu'on peut checker dès 2 octets.
        const badMagic = buf.length >= 2 && (buf[0] !== 0x80 || buf[1] !== 0x01);
        if (badMagic) {
          if (DEBUG) console.log(`[Zaap] ⚠ bytes non Thrift (${buf.length}): ${buf.slice(0, 64).toString('hex')}`);
          buf = Buffer.alloc(0);
        }
        // Sinon : buf conservé, on reprend à la prochaine arrivée de data
        break;
      }
      buf = buf.subarray(msg.consumed);

      if (DEBUG) console.log(`[Zaap] <- ${msg.methodName}`);

      try {
        const w = new Writer();
        await buildBody(msg.methodName, msg.args, w);
        w.stop();
        const response = buildReply(msg.methodName, msg.seqId, w.toBuffer());
        if (!socket.destroyed) socket.write(response);
      } catch (e) {
        console.error('[Zaap] Erreur:', e.message);
      }
    }
    processing = false;
  }

  socket.on('error', () => {});
  socket.on('close', () => { if (DEBUG) console.log(`[Zaap] client disconnected`); });
}

// ─── Parseur Thrift brut ──────────────────────────────────────────────────────

function tryParseMessage(buf) {
  if (buf.length < 8) return null;
  if (buf.readUInt8(0) !== 0x80 || buf.readUInt8(1) !== 0x01) return null;

  const nameLen = buf.readInt32BE(4);
  if (nameLen < 0 || nameLen > 200) return null;

  const bodyStart = 8 + nameLen + 4;
  if (buf.length < bodyStart) return null;

  const methodName = buf.subarray(8, 8 + nameLen).toString('utf8');
  const seqId      = buf.readInt32BE(8 + nameLen);

  const parsed = tryReadStruct(buf, bodyStart);
  if (!parsed) return null;

  return { methodName, seqId, args: parsed.args, consumed: parsed.endPos };
}

function tryReadStruct(buf, pos) {
  const args = {};
  while (pos < buf.length) {
    const ftype = buf.readUInt8(pos); pos++;
    if (ftype === 0) return { args, endPos: pos };

    if (pos + 2 > buf.length) return null;
    const fid = buf.readInt16BE(pos); pos += 2;

    if (ftype === 11) { // STRING
      if (pos + 4 > buf.length) return null;
      const len = buf.readInt32BE(pos); pos += 4;
      if (len < 0 || pos + len > buf.length) return null;
      const val = buf.subarray(pos, pos + len).toString('utf8');
      pos += len;
      args['s' + fid] = val;
      if (fid === 1) args.arg1 = val;
      else if (fid === 2) args.arg2 = val;
      else if (fid === 4) args.hash = val;
    } else if (ftype === 8) { // I32
      if (pos + 4 > buf.length) return null;
      const iv = buf.readInt32BE(pos);
      args['i' + fid] = iv;
      if (fid === 3) args.instanceId = iv;
      pos += 4;
    } else if (ftype === 2 || ftype === 3) { pos += 1; if (pos > buf.length) return null; }
    else if (ftype === 6) { pos += 2; if (pos > buf.length) return null; }
    else if (ftype === 10 || ftype === 4) { pos += 8; if (pos > buf.length) return null; }
    else if (ftype === 12) {
      const inner = tryReadStruct(buf, pos);
      if (!inner) return null;
      pos = inner.endPos;
    } else return null;
  }
  return null;
}

// ─── Construction réponses ────────────────────────────────────────────────────

function buildReply(methodName, seqId, body) {
  const nameBytes = Buffer.from(methodName, 'utf8');
  const header = Buffer.allocUnsafe(4 + 4 + nameBytes.length + 4);
  let h = 0;
  header[h++] = 0x80; header[h++] = 0x01;
  header[h++] = 0x00; header[h++] = 0x02; // REPLY
  header.writeInt32BE(nameBytes.length, h); h += 4;
  nameBytes.copy(header, h); h += nameBytes.length;
  header.writeInt32BE(seqId, h);
  return Buffer.concat([header, body]);
}

// ─── Handlers métier ─────────────────────────────────────────────────────────

async function buildBody(methodName, args, w) {
  switch (methodName) {

    case 'connect': {
      const accountData = args.hash && pendingByHash.get(args.hash);
      if (!accountData) {
        w.writeStruct(1, sw => sw.writeI32(1, 3));
        break;
      }
      // NE PAS delete le hash — Wakfu ouvre plusieurs connexions Thrift
      // parallèles avec le même hash, et rejeter les suivantes fait échouer
      // son "Connexion avec l'Ankama Launcher". On accepte le reuse du
      // hash, avec une même session UUID pour éviter la prolifération.
      let gameSession = accountData._sessionKey;
      if (!gameSession) {
        gameSession = uuidv4();
        accountData._sessionKey = gameSession;
        sessionByKey.set(gameSession, accountData);
        console.log(`[Zaap] -> session pour ${accountData.login}`);
      } else if (DEBUG) {
        console.log(`[Zaap] -> session (reuse) pour ${accountData.login}`);
      }
      w.writeString(0, gameSession);
      break;
    }

    case 'auth_getGameToken':
    case 'auth_getGameTokenWithWindowId': {
      const account = args.arg1 && sessionByKey.get(args.arg1);
      if (!account) { w.writeStruct(1, sw => sw.writeI32(1, 2001)); break; }
      if (DEBUG) console.log(`[Zaap] auth args: ${JSON.stringify(args)}`);
      // Pour Retro uniquement, l'i2 envoyé par le client (101) est le bon
      // game_id HAAPI — hardcodé à 1 ne marche pas (confirmé empiriquement).
      // Pour Dofus 3 / Wakfu / etc., on revient au comportement historique :
      // account.gameId (venant de GAME_IDS côté launch) est la vérité, pour
      // ne pas casser les lancements qui marchaient avant l'adaptation Retro.
      const gameParam = account.gameKey === 'retro'
        ? ((typeof args.i2 === 'number' && args.i2 > 0) ? args.i2 : 101)
        : (account.gameId || 1);
      try {
        // Le certificat Shield est RATTACHÉ à la clé API qui l'a demandé :
        // vérifié à la main, la même requête CreateToken passe avec la clé
        // d'origine et échoue avec une clé plus récente, certificat identique.
        //
        // Or RefreshApiKey ROTATE la clé. L'appeler à chaque token, comme on le
        // faisait, cassait donc le Shield à chaque lancement — d'où « le Shield
        // ne tient pas dans STAKK alors qu'il tient dans le launcher », qui lui
        // garde sa clé. On utilise donc la clé telle quelle, et on ne la
        // renouvelle qu'en dernier recours, si Ankama la refuse vraiment.
        const token = await createTokenWithRetry(account, gameParam);
        console.log(`[Zaap] -> token pour ${account.login} (game=${gameParam}, len=${token.length})`);
        w.writeString(0, token);
      } catch (e) {
        if (e.message.includes('Invalid security')) {
          // Ce n'est PAS une clé invalide : SignOnWithApiKey passe très bien
          // dans ce cas. C'est le certificat Shield qui ne correspond plus à la
          // clé courante — typiquement après un import qui a remplacé la clé.
          console.error(`[Zaap] ⚠ SHIELD DÉSYNCHRONISÉ pour ${account.login}: le certificat ne correspond pas à la clé API courante.`);
          console.error(`[Zaap]   → Refais le Shield sur ce compte (le certificat sera rattaché à la clé actuelle).`);
        } else if (e.message.includes('Unauthorized service')) {
          // 403 sur \Ankama\Api ou \Ankama\Account = clé HAAPI révoquée par
          // Ankama (login ailleurs, rotation auto, MFA forcé, ou clé importée
          // d'une autre machine). Aucun proxy / réseau ne débloque ça —
          // seul un fresh OAuth login régénère une clé valide.
          console.error(`[Zaap] ⚠ CLÉ HAAPI MORTE pour ${account.login}: Ankama a révoqué cette clé (${e.message.match(/Unauthorized service '[^']+'/)?.[0] || '403'}).`);
          console.error(`[Zaap]   → Solution : login ce compte dans le launcher Ankama puis redémarre STAKK (auto-import), OU utilise "Ajouter un compte" dans STAKK pour un fresh OAuth.`);
        } else {
          console.error(`[Zaap] createToken échoué pour ${account.login}: ${e.message}`);
        }
        w.writeStruct(1, sw => sw.writeI32(1, 2001));
      }
      break;
    }

    case 'settings_get': {
      const SETTINGS = { autoConnectType: '"2"', language: '"fr"', connectionPort: '"5555"' };
      const val = SETTINGS[args.arg2];
      if (val) w.writeString(0, val);
      else w.writeStruct(1, sw => sw.writeI32(1, 4001));
      break;
    }

    case 'userInfo_get': {
      const account = args.arg1 && sessionByKey.get(args.arg1);
      if (account) {
        // gameList doit déclarer TOUS les jeux Ankama auxquels le compte
        // est censé être abonné. Si on ne déclare que id:1 (Dofus), Wakfu
        // (id:3) refuse de démarrer avec "Connexion avec Ankama Launcher
        // impossible". On déclare donc Dofus + Wakfu + Krosmaga + Retro
        // pour être permissifs — le client filtre selon son propre id.
        w.writeString(0, JSON.stringify({
          id: account.accountId, type: 'ANKAMA',
          login: account.login, nickname: account.login,
          nicknameWithTag: account.login + '#0000', tag: '0000',
          security: [], locked: '0', isMain: true, active: true,
          acceptedTermsVersion: 8,
          gameList: [
            { isFreeToPlay: false, isSubscribed: true, id: 1 },   // Dofus 2/3
            { isFreeToPlay: false, isSubscribed: true, id: 3 },   // Wakfu
            { isFreeToPlay: false, isSubscribed: true, id: 17 },  // Krosmaga
            { isFreeToPlay: false, isSubscribed: true, id: 101 }, // Retro
          ],
        }));
      } else w.writeStruct(1, sw => sw.writeI32(1, 5001));
      break;
    }

    case 'zaapMustUpdate_get':
    case 'updater_isUpdateAvailable':
      w.writeBool(0, false);
      break;

    case 'zaapVersion_get':
      w.writeString(0, '50.0.0');
      break;

    default:
      // Méthode non gérée — on log pour savoir quoi implémenter. Retourner
      // un struct vide plutôt qu'aucune réponse pour ne pas bloquer le client.
      console.log(`[Zaap] ⚠ méthode non implémentée: ${methodName} args=${JSON.stringify(args).slice(0, 200)}`);
      break;
  }
}

// ─── Encodeur Thrift Binary ───────────────────────────────────────────────────

class Writer {
  constructor() { this._b = []; }
  _hdr(type, fid) { this._b.push(type, (fid >> 8) & 0xff, fid & 0xff); }
  _i32(val) { this._b.push((val >>> 24) & 0xff, (val >>> 16) & 0xff, (val >>> 8) & 0xff, val & 0xff); }
  writeString(fid, str) {
    this._hdr(11, fid);
    const b = Buffer.from(str, 'utf8');
    this._i32(b.length);
    Array.prototype.push.apply(this._b, b);
  }
  writeBool(fid, val) { this._hdr(2, fid); this._b.push(val ? 1 : 0); }
  writeI32(fid, val) { this._hdr(8, fid); this._i32(val); }
  writeStruct(fid, fn) {
    this._hdr(12, fid);
    const inner = new Writer();
    fn(inner);
    inner.stop();
    Array.prototype.push.apply(this._b, inner._b);
  }
  stop() { this._b.push(0); }
  toBuffer() { return Buffer.from(this._b); }
}

  return { startZaapServer, registerHash, _persistRotatedKey: persistRotatedKey };
};
