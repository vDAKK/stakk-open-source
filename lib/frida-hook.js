'use strict';

module.exports = function createFridaHook(deps) {
  deps = deps || {};
  const frida  = deps.frida  || require('frida');
  const crypto = deps.crypto || require('crypto');

function generateFlashKey() {
  const hex = '0123456789ABCDEF';
  let key = '';
  for (let i = 0; i < 17; i++) {
    const n = Math.ceil(Math.random() * 100);
    if (n <= 40) key += String.fromCharCode(Math.floor(Math.random() * 26) + 65);
    else if (n <= 80) key += String.fromCharCode(Math.floor(Math.random() * 26) + 97);
    else key += String.fromCharCode(Math.floor(Math.random() * 10) + 48);
  }
  let r = 0;
  for (let i = 0; i < key.length; i++) r += key.charCodeAt(i) % 16;
  key += hex[r % 16];
  return key;
}

function generateFakeIdentity(account) {
  if (!account.flashKey) {
    account.flashKey = generateFlashKey();
  }
  return {
    hostname: 'DESKTOP-' + (account.refreshToken || '').split('-')[0].slice(0, 7).toUpperCase(),
    flashKey: account.flashKey,
    shouldSpoof: !!account.customShield,
  };
}

async function launchWithFrida(exePath, args, opts, fakeId, proxyPort) {
  // Stratégie spawn :
  // - Windows : frida.spawn (mode suspend) → script chargé AVANT le main()
  //   du target, on capture tous les connect() depuis le tout début.
  // - Mac : on tente frida.spawn d'abord, mais sur Tahoe (macOS 26) AMFI
  //   bloque posix_spawn-with-suspend même en root. Fallback : child_process
  //   .spawn standard puis frida.attach(pid) — task_for_pid sur process en
  //   cours marche dans des conditions plus larges. Coût : on rate les ~100ms
  //   premiers connect() (avant que le script ne soit attaché), mais Dofus
  //   met >500ms entre process start et premier connect au Zaap, donc OK.
  let pid;
  let needResume = false;
  try {
    pid = await frida.spawn([exePath, ...args], {
      cwd: opts.cwd,
      env: opts.env || {},
    });
    needResume = true;
  } catch (e) {
    if (process.platform !== 'darwin') throw e;
    console.log(`[Frida] spawn KO (${e.message}) — fallback child_process+attach (Mac)`);
    const { spawn: cpSpawn } = require('child_process');
    const child = cpSpawn(exePath, args, {
      cwd: opts.cwd,
      env: opts.env || process.env,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    pid = child.pid;
    if (!pid) throw new Error('child_process.spawn(Dofus) n\'a pas retourné de PID');
  }

  // Sur le path attach (Mac fallback), Dofus est déjà en train de booter.
  // Petite boucle de retry car frida.attach peut rater si le process n'a pas
  // encore eu le temps de charger ses libs assez pour que task_for_pid passe.
  let session;
  let lastErr;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      session = await frida.attach(pid);
      break;
    } catch (e) {
      lastErr = e;
      if (attempt === 9) throw new Error(`frida.attach(${pid}) après 10 tentatives: ${e.message}`);
      await new Promise(r => setTimeout(r, 50));
    }
  }

  const script = await session.createScript(getSource(fakeId, proxyPort || 0));
  script.message.connect(msg => {
    if (msg.type === 'send') console.log('[Frida]', msg.payload);
  });
  await script.load();
  if (needResume) await frida.resume(pid);

  // Handler pour detecter la mort du process cible (Dofus ferme)
  // On expose detachHandler pour que le caller puisse brancher son cleanup.
  const detachHandlers = [];
  session.detached.connect((reason) => {
    console.log(`[Frida] session PID ${pid} detachee (${reason})`);
    for (const h of detachHandlers) { try { h(reason); } catch {} }
  });

  console.log(`[Frida] PID ${pid} — spoof=${fakeId.shouldSpoof} proxy=${proxyPort || 'none'}`);
  return {
    pid,
    session,
    script,
    onDetach(fn) { detachHandlers.push(fn); },
    async cleanup() {
      try { await script.unload(); } catch {}
      try { await session.detach(); } catch {}
    },
  };
}

function getSource(fakeId, proxyPort) {
  const spoof = fakeId.shouldSpoof;
  return `
try {

  ${proxyPort > 0 ? `
  var PROXY_PORT = ${proxyPort};
  var DO_SPOOF = ${spoof};
  var FAKE_HOST = "${fakeId.hostname}";

  // ═══ CONNECT REDIRECT ═══
  // SEULEMENT port 26116 (zaap) et 5555 (serveur de jeu)
  // CDN (443) passe directement — pas besoin de proxy pour le CDN
  var REDIRECT_PORTS = {26116: true, 5555: true};

  // Compat Frida 15 (Windows bundle) ↔ Frida 17 (Mac bundle).
  // Frida 17 a déprécié Module.getExportByName(null, name) et l'a remplacé
  // par Module.getGlobalExportByName(name) — sans cette compat, le script
  // throw "TypeError: not a function" sur Mac car getExportByName ne prend
  // plus null comme premier arg.
  function findExp(name) {
    if (typeof Module.getGlobalExportByName === 'function') {
      return Module.getGlobalExportByName(name);
    }
    return Module.getExportByName(null, name);
  }

  var connect_p = findExp('connect');
  var send_p = findExp('send');
  var socket_send = new NativeFunction(send_p, 'int', ['int', 'pointer', 'int', 'int']);

  // Layout sockaddr selon plateforme :
  //   Windows : sa_family est uint16 à offset 0
  //   macOS/BSD : { sa_len:u8 @ 0, sa_family:u8 @ 1, ... } — readU16(0) donne
  //              (sa_family << 8) | sa_len qui est inutilisable. On lit
  //              directement le byte à offset 1 sur Darwin.
  //   Linux : sa_family est uint16 à offset 0 (comme Windows)
  var IS_MAC = (Process.platform === 'darwin');
  var IS_WIN = (Process.platform === 'windows');
  function readFamily(sa) {
    return IS_MAC ? sa.add(1).readU8() : sa.readU16();
  }

  // ═══ « en cours » n'est pas « échoué » ═══
  //
  // Un connect() non bloquant rend -1 dans le cas NORMAL : la connexion se
  // poursuit en arrière-plan. Seul le code d'erreur distingue ce cas d'un vrai
  // échec, et ni le mécanisme ni les valeurs ne sont les mêmes partout.
  //
  // Windows ne passe pas par errno : les erreurs de socket se lisent avec
  // WSAGetLastError(), et __errno_location — le symbole glibc qu'on
  // interrogeait — n'y existe même pas.
  function codesToleres(plateforme) {
    if (plateforme === 'windows') {
      // WSAEWOULDBLOCK · WSAEINPROGRESS · WSAEALREADY · WSAEINTR
      return [10035, 10036, 10037, 10004];
    }
    if (plateforme === 'darwin') return [36, 35, 4];   // EINPROGRESS · EAGAIN · EINTR
    return [115, 11, 4];                               // idem sous Linux
  }

  /**
   * Ce retour de connect() est-il un échec RÉEL ?
   *
   * Trois cas ne prouvent PAS un échec, et les confondre avec un échec a cassé
   * Windows : le garde y refusait tous les connect, donc le CONNECT ne partait
   * jamais vers le proxy et aucun compte n'entrait en jeu.
   *
   *   rv === 0     la connexion est établie, il n'y a rien à discuter.
   *   code null    on n'a pas su lire l'erreur. Avant ce garde le CONNECT
   *                partait toujours et Windows fonctionnait : ne pas savoir
   *                doit laisser passer.
   *   code 0       « aucune erreur ». Relevé en jeu sous Windows :
   *                  REDIRECT FAIL 108.128.247.72:5555 rv=-1 err=0 (windows)
   *                WSAGetLastError() est écrasé avant que onLeave ne tourne —
   *                le trampoline de Frida s'intercale entre l'appel et nous.
   *                Un zéro est donc l'absence d'information, pas un verdict,
   *                et c'est ce qui restait à corriger après le premier essai.
   *
   * Conséquence assumée : sous Windows le garde ne se déclenche quasiment
   * jamais. C'est exactement le comportement d'avant le correctif macOS, celui
   * qui marchait ; et le garde garde tout son sens là où l'errno est lisible.
   */
  function estUnEchec(rv, code, toleres) {
    if (rv === 0) return false;
    if (code === null || code === undefined || code === 0) return false;
    return toleres.indexOf(code) === -1;
  }

  var TOLERES = codesToleres(Process.platform);

  /** Le code d'erreur du dernier appel socket, ou null si on ne sait pas. */
  function dernierCodeSocket() {
    try {
      if (IS_WIN) {
        var wp = findExp('WSAGetLastError');
        if (!wp) return null;
        return new NativeFunction(wp, 'int', [])();
      }
      var errp = findExp(IS_MAC ? '__error' : '__errno_location');
      if (!errp) return null;
      return new NativeFunction(errp, 'pointer', [])().readS32();
    } catch (e) { return null; }
  }

  Interceptor.attach(connect_p, {
    onEnter: function(args) {
      this.sockfd = args[0];
      this.shouldSend = false;
      var sa = args[1];
      var family = readFamily(sa);
      var port, addr;
      // Adresse IPv6 de la forme ::ffff:a.b.c.d — renseigné par la branche
      // AF_INET6, relu par la réécriture pour rester dans le même plan.
      var mapped = false;

      // AF_INET6 a une valeur différente selon la plateforme :
      //   Windows : 23  ·  macOS Darwin : 30  ·  Linux : 10
      var IS_AF_INET6 = (family === 23 || family === 30 || family === 10);

      if (family === 2) {
        // AF_INET — sin_port à offset 2-3, sin_addr à offset 4-7 (identique
        // Win/Mac/Linux car ces offsets viennent après le family qui fait 2
        // bytes dans tous les cas).
        port = 256 * sa.add(2).readU8() + sa.add(3).readU8();
        addr = '';
        for (var i = 0; i < 4; i++) { addr += sa.add(4+i).readU8(); if(i<3) addr += '.'; }
      } else if (IS_AF_INET6) {
        // AF_INET6 : sin6_port @2-3, sin6_addr (16 octets) @8-23.
        // Les 4 derniers octets ne sont l'adresse IPv4 que pour une adresse
        // IPv4-mapped (::ffff:a.b.c.d). Pour une vraie IPv6 les lire donne un
        // quadruplet inventé — d'où des lignes comme « 34.247.205.111 » qui
        // ressemblent à de l'IPv4 sans en être. On teste le préfixe mapped.
        port = 256 * sa.add(2).readU8() + sa.add(3).readU8();
        mapped = true;
        for (var i = 0; i < 10; i++) { if (sa.add(8+i).readU8() !== 0) { mapped = false; break; } }
        if (mapped && (sa.add(18).readU8() !== 0xff || sa.add(19).readU8() !== 0xff)) mapped = false;
        addr = '';
        if (mapped) {
          for (var i = 0; i < 4; i++) { addr += sa.add(20+i).readU8(); if(i<3) addr += '.'; }
        } else {
          for (var i = 0; i < 16; i += 2) {
            addr += ('0' + sa.add(8+i).readU8().toString(16)).slice(-2)
                 +  ('0' + sa.add(9+i).readU8().toString(16)).slice(-2);
            if (i < 14) addr += ':';
          }
        }
      } else if (family === 1) {
        // AF_UNIX — log diagnostic, pas d'interception
        var p = '';
        try { p = sa.add(IS_MAC ? 2 : 2).readUtf8String(104); } catch(e) {}
        send('[connect-debug] AF_UNIX → ' + p);
        return;
      } else {
        send('[connect-debug] family=' + family + ' (skip)');
        return;
      }

      this.port = port;
      this.addr = addr;

      // Loggue tous les connect TCP/IP, ciblés ou non — diagnostic
      send('[connect-debug] ' + addr + ':' + port + ' (af=' + family + ')');

      // Seulement rediriger les ports ciblés
      if (!REDIRECT_PORTS[port]) return;

      // Ignorer si c'est déjà vers le proxy (éviter boucle)
      if ((addr === '127.0.0.1' || addr === '0.0.0.1' || addr === '0.0.0.0') && port === PROXY_PORT) return;

      send('REDIRECT ' + addr + ':' + port + ' → proxy:' + PROXY_PORT + ' (af=' + family + ')');

      if (family === 2) {
        // AF_INET: écrire 127.0.0.1:proxy
        sa.add(2).writeByteArray([Math.floor(PROXY_PORT / 256), PROXY_PORT % 256]);
        sa.add(4).writeByteArray([127, 0, 0, 1]);
      } else {
        // AF_INET6 : sur Windows on écrivait ::ffff:127.0.0.1 (IPv4-mapped) qui
        // marchait grâce au routage dual-stack auto. Sur macOS, IPV6_V6ONLY=1
        // par défaut → un socket IPv6 ne route PAS vers un listener IPv4. Donc
        // sur Mac on cible directement ::1 (IPv6 loopback) et le proxy ajoute
        // un 2nd listener IPv6. Sur Windows on garde l'ancien comportement.
        sa.add(2).writeByteArray([Math.floor(PROXY_PORT / 256), PROXY_PORT % 256]);
        sa.add(4).writeByteArray([0, 0, 0, 0]);
        // On garde la MÊME forme d'adresse que celle visée à l'origine. Un
        // socket qui vise ::ffff:a.b.c.d est dual-stack (V6ONLY=0) et parle en
        // fait IPv4 : lui donner un ::1 pur le fait échouer, car le listener
        // ::1 du proxy est un autre socket que son listener 127.0.0.1. À
        // l'inverse un socket en IPv6 pur ne peut pas viser une adresse
        // mapped. Dofus 3 utilise la forme mapped pour le port 5555.
        if (mapped) {
          // ::ffff:127.0.0.1 — reste dans le plan IPv4, atteint le listener v4.
          sa.add(8).writeByteArray([0,0,0,0, 0,0,0,0, 0,0,0xff,0xff, 127,0,0,1]);
        } else {
          // ::1 — IPv6 pur, atteint le listener v6 que le proxy bind sur Mac.
          sa.add(8).writeByteArray([0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,1]);
        }
        sa.add(24).writeByteArray([0, 0, 0, 0]);
      }
      this.shouldSend = true;
    },
    onLeave: function(retval) {
      if (!this.shouldSend) return;
      // connect() non bloquant renvoie -1 « en cours » : c'est le cas NORMAL et
      // il ne faut surtout pas le traiter comme un échec. Un vrai -1 veut dire
      // que le socket n'ira nulle part ; envoyer le CONNECT dessus le ferait
      // échouer en silence, sans rien dans les logs du proxy.
      var rv = retval.toInt32();
      if (rv !== 0) {
        var err = dernierCodeSocket();
        if (estUnEchec(rv, err, TOLERES)) {
          send('REDIRECT FAIL ' + this.addr + ':' + this.port
            + ' rv=' + rv + ' err=' + err + ' (' + Process.platform + ')');
          return;
        }
      }
      var connect_request = 'CONNECT ' + this.addr + ':' + this.port + ' HTTP/1.0 ';
      var buf_send = Memory.allocUtf8String(connect_request);
      socket_send(this.sockfd.toInt32(), buf_send, connect_request.length, 0);
    }
  });
  send('[hook] connect() → proxy:' + PROXY_PORT + ' (ports 26116+5555 only)');

  // ═══ CONNECTEX HOOK (async I/O — Dofus 3 utilise ça pour port 5555) ═══
  // Winsock only : sur Mac l'I/O async passe par kqueue, pas par ConnectEx, et
  // le hook connect() ci-dessus suffit. Sans ce garde, Module.getExportByName
  // sur ws2_32.dll lève et pollue les logs d'un « WSAIoctl err » trompeur.
  var connectExHooked = false;
  try {
    if (IS_MAC) throw new Error('skip');
    var WSAIoctl_p = Module.getExportByName('ws2_32.dll', 'WSAIoctl');
    Interceptor.attach(WSAIoctl_p, {
      onEnter: function(args) {
        this.code = args[1].toInt32() >>> 0;
        // SIO_GET_EXTENSION_FUNCTION_POINTER = 0xC8000006
        if (this.code === 0xC8000006) {
          this.outBuf = args[4];
        }
      },
      onLeave: function(retval) {
        if (this.code !== 0xC8000006 || !this.outBuf || retval.toInt32() !== 0 || connectExHooked) return;
        try {
          var fPtr = this.outBuf.readPointer();
          send('[hook] ConnectEx at ' + fPtr);
          Interceptor.attach(fPtr, {
            onEnter: function(args) {
              this.shouldSend = false;
              var sa = args[1];
              var family = sa.readU16();
              var port, addr;

              if (family === 2) {
                port = 256 * sa.add(2).readU8() + sa.add(3).readU8();
                addr = '';
                for (var i = 0; i < 4; i++) { addr += sa.add(4+i).readU8(); if(i<3) addr += '.'; }
              } else if (family === 23) {
                port = 256 * sa.add(2).readU8() + sa.add(3).readU8();
                addr = '';
                for (var i = 0; i < 4; i++) { addr += sa.add(20+i).readU8(); if(i<3) addr += '.'; }
              } else return;

              if (!REDIRECT_PORTS[port]) return;
              if ((addr === '127.0.0.1' || addr === '0.0.0.1' || addr === '0.0.0.0') && port === PROXY_PORT) return;

              send('ConnectEx REDIRECT ' + addr + ':' + port + ' → proxy:' + PROXY_PORT);

              if (family === 2) {
                sa.add(2).writeByteArray([Math.floor(PROXY_PORT / 256), PROXY_PORT % 256]);
                sa.add(4).writeByteArray([127, 0, 0, 1]);
              } else {
                sa.add(2).writeByteArray([Math.floor(PROXY_PORT / 256), PROXY_PORT % 256]);
                sa.add(4).writeByteArray([0, 0, 0, 0]);
                sa.add(8).writeByteArray([0,0,0,0, 0,0,0,0, 0,0,0xff,0xff, 127,0,0,1]);
                sa.add(24).writeByteArray([0, 0, 0, 0]);
              }
              this.shouldSend = true;
              this.addr = addr;
              this.port = port;
              this.sockfd = args[0];
            },
            onLeave: function(retval) {
              if (!this.shouldSend) return;
              // ConnectEx est async — envoyer CONNECT après un délai
              var a = this.addr, p = this.port, fd = this.sockfd.toInt32();
              setTimeout(function() {
                var req = 'CONNECT ' + a + ':' + p + ' HTTP/1.0 ';
                var buf = Memory.allocUtf8String(req);
                socket_send(fd, buf, req.length, 0);
                send('ConnectEx CONNECT sent: ' + a + ':' + p);
              }, 200);
            }
          });
          connectExHooked = true;
          send('[hook] ConnectEx hooked');
        } catch(e) { send('ConnectEx err: ' + e); }
      }
    });
  } catch(e) { if (!IS_MAC) send('WSAIoctl err: ' + e); }

  send('[info] hostname spoofing OFF');

  // ═══ CreateProcessW (Windows-only, le findExp trouve l'export selon API) ═══
  try {
    Interceptor.attach(findExp('CreateProcessW'), {
      onEnter: function(args) {
        var command = null, type = null;
        try { command = Memory.readUtf16String(args[0]); } catch(e) {}
        try { type = Memory.readUtf16String(args[1]); } catch(e) {}
        if (!command && type) {
          if (type.indexOf('network') !== -1 || type.indexOf('plugins') !== -1) {
            this.pid = args[9];
          }
        }
      },
      onLeave: function() {
        if (this.pid) {
          send(parseInt(this.pid.add(Process.pointerSize * 2).readInt()));
          delete this.pid;
        }
      }
    });
  } catch(e) {}

  send('[Frida] OK' + (DO_SPOOF ? ' spoof=' + FAKE_HOST : ''));

  ` : `
  send('[Frida] Aucun proxy');
  `}

} catch(e) {
  send('[Frida] ERREUR: ' + e);
}
`;
}

  return { launchWithFrida, generateFakeIdentity };
};
