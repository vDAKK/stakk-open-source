'use strict';

/**
 * organizer.js — Plugin : switch de fenêtre par raccourci clavier.
 *
 * Flow :
 *   - Chaque Dofus lancé via Frida reçoit un script injecté qui :
 *       * lit GetAsyncKeyState pour une liste de VK codes ciblés (les raccourcis
 *         actuellement configurés) à 30ms d'intervalle
 *       * sur front montant (keydown), envoie { type:'keydown', vk, mods } via
 *         send()
 *       * expose focus() qui trouve le HWND principal du process et le passe
 *         au foreground avec la ruse AttachThreadInput (sinon SetForegroundWindow
 *         est silencieusement ignoré quand STAKK n'est pas le processus
 *         foreground actuel)
 *   - Le plugin (côté STAKK) :
 *       * agrège les VK trackés depuis la config et les pousse à chaque session
 *       * sur chaque keydown reporté, dédupe cross-session (plusieurs Dofus
 *         voient le même keystroke global) et match contre les raccourcis
 *         (par compte, ou cycle next/prev)
 *       * sur match → focus de la bonne fenêtre Dofus via RPC
 *
 * Wakfu : pas de session Frida au lancement (spawn direct), donc pas de hotkey
 * pour l'instant. Dofus 3 + Retro sont supportés.
 */

module.exports = function createOrganizer(deps) {
  const { frida, on, registerRoute, log,
          runningPids, runKey,
          loadConfig, saveConfig,
          // macOS : lancement du helper de capture clavier. Absents d'une
          // version d'hôte plus ancienne → restartKeytap() se désactive
          // proprement au lieu de planter le plugin.
          spawn, fs, path, APP_ROOT } = deps;

  // Script Frida injecté dans chaque Dofus. NULL → ptr(0) par sécurité.
  // Le poll à 30ms d'une poignée de VKs = < 0.1% CPU, négligeable.
  const FRIDA_SCRIPT = `
(function() {
  var NULL = ptr(0);
  var GetAsyncKeyState = new NativeFunction(Module.getExportByName('user32.dll','GetAsyncKeyState'),'int16',['int']);
  var SetForegroundWindow = new NativeFunction(Module.getExportByName('user32.dll','SetForegroundWindow'),'int',['pointer']);
  var ShowWindow = new NativeFunction(Module.getExportByName('user32.dll','ShowWindow'),'int',['pointer','int']);
  var IsIconic = new NativeFunction(Module.getExportByName('user32.dll','IsIconic'),'int',['pointer']);
  var EnumWindows = new NativeFunction(Module.getExportByName('user32.dll','EnumWindows'),'int',['pointer','pointer']);
  var GetWindowThreadProcessId = new NativeFunction(Module.getExportByName('user32.dll','GetWindowThreadProcessId'),'uint32',['pointer','pointer']);
  var IsWindowVisible = new NativeFunction(Module.getExportByName('user32.dll','IsWindowVisible'),'int',['pointer']);
  var GetWindow = new NativeFunction(Module.getExportByName('user32.dll','GetWindow'),'pointer',['pointer','uint32']);
  var GetWindowTextLengthW = new NativeFunction(Module.getExportByName('user32.dll','GetWindowTextLengthW'),'int',['pointer']);
  var GetCurrentProcessId = new NativeFunction(Module.getExportByName('kernel32.dll','GetCurrentProcessId'),'uint32',[]);
  var GetCurrentThreadId = new NativeFunction(Module.getExportByName('kernel32.dll','GetCurrentThreadId'),'uint32',[]);
  var GetForegroundWindow = new NativeFunction(Module.getExportByName('user32.dll','GetForegroundWindow'),'pointer',[]);
  var AttachThreadInput = new NativeFunction(Module.getExportByName('user32.dll','AttachThreadInput'),'int',['uint32','uint32','int']);
  var BringWindowToTop = new NativeFunction(Module.getExportByName('user32.dll','BringWindowToTop'),'int',['pointer']);
  var SetFocus = new NativeFunction(Module.getExportByName('user32.dll','SetFocus'),'pointer',['pointer']);
  var SetActiveWindow = new NativeFunction(Module.getExportByName('user32.dll','SetActiveWindow'),'pointer',['pointer']);
  var keybd_event = new NativeFunction(Module.getExportByName('user32.dll','keybd_event'),'void',['uint8','uint8','uint32','pointer']);

  var myPid = GetCurrentProcessId();
  var mainHwnd = NULL;

  function findMainHwnd() {
    // Cache : si la fenêtre principale existe déjà, on la renvoie direct.
    if (!mainHwnd.isNull()) {
      if (IsWindowVisible(mainHwnd)) return mainHwnd;
      mainHwnd = NULL;
    }
    var found = NULL;
    var pidBuf = Memory.alloc(4);
    var cb = new NativeCallback(function(hwnd, lparam) {
      if (!IsWindowVisible(hwnd)) return 1;
      if (!GetWindow(hwnd, 4).isNull()) return 1; // GW_OWNER = 4 → skip dialogs owned by autre fenêtre
      if (GetWindowTextLengthW(hwnd) < 1) return 1;
      pidBuf.writeU32(0);
      GetWindowThreadProcessId(hwnd, pidBuf);
      if (pidBuf.readU32() === myPid) { found = hwnd; return 0; }
      return 1;
    }, 'int', ['pointer','pointer']);
    EnumWindows(cb, NULL);
    mainHwnd = found;
    return found;
  }

  var VK_SHIFT = 0x10, VK_CONTROL = 0x11, VK_MENU = 0x12;
  function readMods() {
    return {
      ctrl:  (GetAsyncKeyState(VK_CONTROL) & 0x8000) !== 0 ? 1 : 0,
      alt:   (GetAsyncKeyState(VK_MENU)    & 0x8000) !== 0 ? 1 : 0,
      shift: (GetAsyncKeyState(VK_SHIFT)   & 0x8000) !== 0 ? 1 : 0
    };
  }

  var tracked = [];
  var lastDown = {};
  var pollTimer = null;
  var POLL_MS = 30;

  function tick() {
    for (var i = 0; i < tracked.length; i++) {
      var vk = tracked[i];
      var down = (GetAsyncKeyState(vk) & 0x8000) !== 0;
      if (down && !lastDown[vk]) {
        send({ type: 'keydown', vk: vk, mods: readMods(), t: Date.now() });
      }
      lastDown[vk] = down;
    }
  }

  rpc.exports = {
    setTracked: function(vkCodes) {
      tracked = vkCodes || [];
      lastDown = {};
      if (pollTimer && tracked.length === 0) {
        clearInterval(pollTimer);
        pollTimer = null;
      } else if (!pollTimer && tracked.length > 0) {
        pollTimer = setInterval(tick, POLL_MS);
      }
      return tracked.length;
    },
    focus: function() {
      var hwnd = findMainHwnd();
      if (hwnd.isNull()) return false;
      // Windows 10+ : SetForegroundWindow est silencieusement ignoré quand
      // un autre process a le foreground. Triple trick pour contourner :
      //   1. Simuler un keypress (Alt) — release le foreground-lock de Windows.
      //   2. AttachThreadInput du thread foreground → thread courant (Frida),
      //      ce qui partage l'input state et autorise SetForegroundWindow.
      //   3. BringWindowToTop + SetForegroundWindow + SetFocus + SetActiveWindow
      //      pour ancrer à la fois l'ordre Z ET le focus clavier (sinon la
      //      fenêtre s'affiche mais ne reçoit pas les frappes).
      var pidBuf = Memory.alloc(4);
      var fg = GetForegroundWindow();
      var fgThread = 0;
      if (!fg.isNull()) fgThread = GetWindowThreadProcessId(fg, pidBuf) >>> 0;
      var curThread = GetCurrentThreadId();
      // Alt down/up — hack classique pour release le foreground lock
      keybd_event(0x12, 0, 0, NULL);
      keybd_event(0x12, 0, 2, NULL);
      if (fgThread && fgThread !== curThread) AttachThreadInput(fgThread, curThread, 1);
      if (IsIconic(hwnd)) ShowWindow(hwnd, 9); // SW_RESTORE
      BringWindowToTop(hwnd);
      var ok = SetForegroundWindow(hwnd) !== 0;
      SetActiveWindow(hwnd);
      SetFocus(hwnd);
      if (fgThread && fgThread !== curThread) AttachThreadInput(fgThread, curThread, 0);
      return ok;
    }
  };

  send({ type: 'ready', pid: myPid });
})();
`;

  // Équivalent macOS du script injecté. Il ne garde QUE l'action : focus().
  //
  // La lecture du clavier ne peut pas se faire ici. Dofus tourne en hardened
  // runtime ; dès que Frida y injecte du code non signé, macOS cesse d'honorer
  // ses autorisations TCC d'entrée — CGEventSourceKeyState renvoie toujours
  // false et un event tap ne reçoit rien, alors que poster des événements
  // continue de marcher. Vérifié sur macOS 26 : droits Accessibilité ET
  // Surveillance de l'entrée accordés à Dofus, AXIsProcessTrusted() = 1,
  // balayage des 128 keycodes = 0 touche physique captée.
  //
  // La capture est donc déléguée au helper natif mac-helper/keytap, lancé par
  // STAKK lui-même (process non injecté, signature intacte, qui peut porter
  // l'autorisation). Le helper écrit une ligne JSON par front montant, le
  // plugin traduit en payload keydown identique à Windows et appelle focus()
  // par RPC. Le contrat vu par onKeydown()/matchShortcut() est inchangé.
  const FRIDA_SCRIPT_MAC = `
(function() {
  // Frida 17 : Module.getExportByName(null, …) et le global ObjC ont disparu.
  // Les symboles globaux passent par Module.getGlobalExportByName(), et le
  // pont ObjC n'est pas injecté dans un script nu — on parle donc directement
  // au runtime Objective-C via objc_getClass / sel_registerName / objc_msgSend.
  var objc_getClass  = new NativeFunction(Module.getGlobalExportByName('objc_getClass'), 'pointer', ['pointer']);
  var sel_registerName = new NativeFunction(Module.getGlobalExportByName('sel_registerName'), 'pointer', ['pointer']);
  var msgSendPtr = Module.getGlobalExportByName('objc_msgSend');

  function _s(str) { return Memory.allocUtf8String(str); }
  function _cls(name) { return objc_getClass(_s(name)); }
  function _sel(name) { return sel_registerName(_s(name)); }
  // objc_msgSend est variadique : il faut une NativeFunction par signature.
  function _msgPtr(recv, name) {
    return new NativeFunction(msgSendPtr, 'pointer', ['pointer', 'pointer'])(recv, _sel(name));
  }
  function _msgBoolWithUInt64(recv, name, arg) {
    return new NativeFunction(msgSendPtr, 'bool', ['pointer', 'pointer', 'uint64'])(recv, _sel(name), arg);
  }

  rpc.exports = {
    // Conservé pour garder la même surface RPC que le script Windows : le
    // plugin appelle setTracked() sur toutes les sessions sans distinction.
    // Sur mac le suivi se fait dans le helper, donc c'est un no-op.
    setTracked: function(vkCodes) {
      return (vkCodes || []).length;
    },
    focus: function() {
      // [[NSRunningApplication currentApplication] activateWithOptions:
      //   NSApplicationActivateIgnoringOtherApps (1 << 1)]
      // Équivalent macOS du trio BringWindowToTop/SetForegroundWindow/SetFocus.
      try {
        var cls = _cls('NSRunningApplication');
        if (cls.isNull()) return false;
        var app = _msgPtr(cls, 'currentApplication');
        if (app.isNull()) return false;
        return !!_msgBoolWithUInt64(app, 'activateWithOptions:', 1 << 1);
      } catch (e) {
        return false;
      }
    }
  };

  send({ type: 'ready', pid: Process.id });
})();
`;

  // VK Windows → virtual keycode Carbon, côté hôte : c'est lui qui pilote
  // désormais le helper. Les keycodes Carbon sont matériels (indépendants de
  // la disposition AZERTY/QWERTY). Un VK absent est loggué, pas silencieux.
  const VK_TO_MAC = {
    0x70: 122, 0x71: 120, 0x72: 99,  0x73: 118, // F1..F4
    0x74: 96,  0x75: 97,  0x76: 98,  0x77: 100, // F5..F8
    0x78: 101, 0x79: 109, 0x7A: 103, 0x7B: 111, // F9..F12
    0x7C: 105, 0x7D: 107, 0x7E: 113, 0x7F: 106, // F13..F16
    0x80: 64,  0x81: 79,  0x82: 80,  0x83: 90,  // F17..F20
    0x30: 29, 0x31: 18, 0x32: 19, 0x33: 20, 0x34: 21, // 0..4
    0x35: 23, 0x36: 22, 0x37: 26, 0x38: 28, 0x39: 25, // 5..9
    0x60: 82, 0x61: 83, 0x62: 84, 0x63: 85, 0x64: 86, // Numpad0..4
    0x65: 87, 0x66: 88, 0x67: 89, 0x68: 91, 0x69: 92, // Numpad5..9
    0x20: 49, 0x09: 48, 0x0D: 36, 0x1B: 53            // Space, Tab, Enter, Esc
  };
  const MAC_TO_VK = {};
  for (const [vk, kc] of Object.entries(VK_TO_MAC)) MAC_TO_VK[kc] = Number(vk);

  // Sélection du script selon la plateforme. Windows garde EXACTEMENT le
  // script d'origine — le chemin darwin est purement additif.
  const SCRIPT = process.platform === 'darwin' ? FRIDA_SCRIPT_MAC : FRIDA_SCRIPT;

  // sessions[rk] = { script, rpc }
  const sessions = {};
  // Dédupe cross-session : chaque Dofus voit le même keystroke global,
  // on ne déclenche qu'une fois dans une fenêtre de COOLDOWN_MS.
  const cooldown = {};
  const COOLDOWN_MS = 120;
  let lastFocused = null;

  function loadShortcuts() {
    const cfg = loadConfig() || {};
    return cfg.organizer || { accounts: {}, cycle: { next: null, prev: null } };
  }
  function saveShortcuts(sc) {
    const cfg = loadConfig() || {};
    cfg.organizer = sc;
    saveConfig(cfg);
  }

  function allTrackedVKs() {
    const sc = loadShortcuts();
    const set = new Set();
    for (const combo of Object.values(sc.accounts || {})) {
      if (combo && typeof combo.vk === 'number') set.add(combo.vk);
    }
    if (sc.cycle?.next?.vk != null) set.add(sc.cycle.next.vk);
    if (sc.cycle?.prev?.vk != null) set.add(sc.cycle.prev.vk);
    return Array.from(set);
  }

  // ── Capture clavier macOS ────────────────────────────────────────────────
  // Sur mac, le script injecté ne peut pas lire l'entrée physique (cf. le
  // commentaire de FRIDA_SCRIPT_MAC). STAKK lance donc le helper natif
  // mac-helper/keytap, qui porte l'autorisation « Surveillance de l'entrée »
  // et écrit une ligne JSON par front montant.
  const IS_MAC = process.platform === 'darwin';
  const KEYTAP_BIN = IS_MAC && path && APP_ROOT
    ? path.join(APP_ROOT, 'mac-helper', 'keytap')
    : null;
  let keytap = null;
  let keytapWarned = false;

  function stopKeytap() {
    if (!keytap) return;
    try { keytap.kill(); } catch {}
    keytap = null;
  }

  // Relance le helper sur la liste courante de keycodes. Appelé à chaque
  // changement de raccourci : le tap ne suit qu'un jeu fixe de touches.
  function restartKeytap() {
    if (!IS_MAC) return;
    stopKeytap();
    const vks = allTrackedVKs();
    if (!vks.length) return;
    if (!spawn || !fs || !KEYTAP_BIN || !fs.existsSync(KEYTAP_BIN)) {
      if (!keytapWarned) {
        keytapWarned = true;
        log(`[organizer] helper clavier absent (${KEYTAP_BIN}) — raccourcis inactifs sur macOS`);
      }
      return;
    }
    const codes = [];
    for (const vk of vks) {
      const kc = VK_TO_MAC[vk];
      if (kc === undefined) log(`[organizer] VK ${vk} sans équivalent macOS — raccourci ignoré`);
      else codes.push(kc);
    }
    if (!codes.length) return;

    try {
      keytap = spawn(KEYTAP_BIN, codes.map(String), { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      log(`[organizer] helper clavier non lancé: ${e.message}`);
      return;
    }

    let buf = '';
    keytap.stdout.on('data', chunk => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.ready) { log(`[organizer] helper clavier prêt (${codes.length} touche(s))`); continue; }
        const vk = MAC_TO_VK[msg.kc];
        if (vk === undefined) continue;
        // Même payload que le script Windows → onKeydown() est partagé. rk
        // est nominal ici : le helper est global, pas lié à une session.
        onKeydown('mac-keytap', {
          vk,
          mods: { ctrl: msg.ctrl, alt: msg.alt, shift: msg.shift },
          t: Date.now(),
        }).catch(e => log(`[organizer] onKeydown: ${e.message}`));
      }
    });
    keytap.stderr.on('data', d => {
      const s = String(d).trim();
      if (!s) return;
      // tap-failed = autorisation « Surveillance de l'entrée » manquante pour
      // le process qui a lancé STAKK. C'est la panne la plus probable, donc on
      // la nomme au lieu de relayer le mot brut du helper.
      if (s.includes('tap-failed')) {
        log('[organizer] helper clavier refusé par macOS — accorde « Surveillance de l\'entrée » à STAKK dans Réglages → Confidentialité et sécurité, puis relance');
      } else {
        log(`[organizer] helper clavier: ${s}`);
      }
    });
    keytap.on('exit', (code, sig) => {
      if (keytap) log(`[organizer] helper clavier arrêté (code=${code} sig=${sig})`);
      keytap = null;
    });
  }

  async function pushTrackedToAll() {
    const vks = allTrackedVKs();
    for (const [rk, s] of Object.entries(sessions)) {
      try { await s.rpc.setTracked(vks); }
      catch (e) { log(`[organizer] setTracked ${rk}: ${e.message}`); }
    }
    // Sur mac c'est le helper qui suit réellement les touches.
    restartKeytap();
  }

  function comboMatches(a, vk, mods) {
    if (!a || a.vk !== vk) return false;
    return !!a.ctrl === !!mods.ctrl && !!a.alt === !!mods.alt && !!a.shift === !!mods.shift;
  }

  function matchShortcut(vk, mods) {
    const sc = loadShortcuts();
    for (const [accId, combo] of Object.entries(sc.accounts || {})) {
      if (comboMatches(combo, vk, mods)) return { kind: 'account', accountId: parseInt(accId, 10) };
    }
    const c = sc.cycle || {};
    if (comboMatches(c.next, vk, mods)) return { kind: 'next' };
    if (comboMatches(c.prev, vk, mods)) return { kind: 'prev' };
    return null;
  }

  function orderedRunning() {
    return Object.keys(runningPids).map(rk => {
      const i = rk.indexOf(':');
      return { rk, accountId: parseInt(rk.slice(0, i), 10), gameKey: rk.slice(i + 1) };
    });
  }

  async function focusRk(rk) {
    const s = sessions[rk];
    if (!s) { log(`[organizer] pas de session pour ${rk}`); return false; }
    try {
      const ok = await s.rpc.focus();
      if (ok) lastFocused = rk;
      return ok;
    } catch (e) {
      log(`[organizer] focus ${rk}: ${e.message}`);
      return false;
    }
  }
  async function focusAccount(accountId) {
    const entry = orderedRunning().find(e => e.accountId === accountId && sessions[e.rk]);
    if (!entry) { log(`[organizer] focus: compte ${accountId} pas lancé`); return false; }
    return focusRk(entry.rk);
  }
  async function focusCycle(direction) {
    const list = orderedRunning().filter(e => sessions[e.rk]);
    if (!list.length) return false;
    const curIdx = list.findIndex(e => e.rk === lastFocused);
    const nextIdx = curIdx === -1
      ? 0
      : direction === 'next'
        ? (curIdx + 1) % list.length
        : (curIdx - 1 + list.length) % list.length;
    return focusRk(list[nextIdx].rk);
  }

  async function onKeydown(rk, payload) {
    const { vk, mods } = payload;
    const key = `${vk}|${mods.ctrl}|${mods.alt}|${mods.shift}`;
    const now = Date.now();
    if (cooldown[key] && now - cooldown[key] < COOLDOWN_MS) return;
    cooldown[key] = now;
    const m = matchShortcut(vk, mods);
    if (!m) return;
    if (m.kind === 'account') await focusAccount(m.accountId);
    else if (m.kind === 'next') await focusCycle('next');
    else if (m.kind === 'prev') await focusCycle('prev');
  }

  on('launch', async ({ accountId, gameKey, fridaHandle }) => {
    if (!fridaHandle || !fridaHandle.session) return; // Wakfu: spawn sans Frida
    const rk = runKey(accountId, gameKey);
    try {
      const script = await fridaHandle.session.createScript(SCRIPT);
      script.message.connect((msg) => {
        if (msg.type !== 'send') return;
        const payload = msg.payload;
        if (!payload || typeof payload !== 'object') return;
        if (payload.type === 'keydown') {
          onKeydown(rk, payload).catch(e => log(`[organizer] onKeydown: ${e.message}`));
        } else if (payload.type === 'unsupported') {
          // Émis par le script macOS uniquement : VK sans équivalent Carbon.
          log(`[organizer] ${rk}: raccourci(s) non supporté(s) sur macOS — VK ${payload.vks.join(', ')}`);
        }
      });
      await script.load();
      sessions[rk] = { script, rpc: script.exports };
      try { await script.exports.setTracked(allTrackedVKs()); }
      catch (e) { log(`[organizer] setTracked initial ${rk}: ${e.message}`); }
      // macOS : démarre (ou redémarre) le helper dès qu'une session existe.
      // Sans session lancée il n'y a rien à focus, donc rien à capturer.
      if (!keytap) restartKeytap();
      log(`[organizer] session prête ${rk}`);
    } catch (e) {
      log(`[organizer] createScript KO ${rk}: ${e.message}`);
    }
  });

  on('detach', ({ accountId, gameKey }) => {
    const rk = runKey(accountId, gameKey);
    const s = sessions[rk];
    if (!s) return;
    try { s.script.unload().catch(() => {}); } catch {}
    delete sessions[rk];
    if (lastFocused === rk) lastFocused = null;
    // Plus aucun jeu lancé → plus rien à focus : on rend l'accès clavier.
    if (!Object.keys(sessions).length) stopKeytap();
  });

  // ─── Routes API ────────────────────────────────────────────────────────
  registerRoute('GET', '/api/organizer/shortcuts', () => loadShortcuts());

  registerRoute('POST', '/api/organizer/shortcut', async (body) => {
    const { accountId, vk, ctrl, alt, shift, cycle } = body || {};
    const sc = loadShortcuts();
    sc.accounts = sc.accounts || {};
    sc.cycle = sc.cycle || { next: null, prev: null };
    if (cycle === 'next' || cycle === 'prev') {
      sc.cycle[cycle] = (vk == null)
        ? null
        : { vk, ctrl: !!ctrl, alt: !!alt, shift: !!shift };
    } else if (accountId != null) {
      const k = String(accountId);
      if (vk == null) delete sc.accounts[k];
      else sc.accounts[k] = { vk, ctrl: !!ctrl, alt: !!alt, shift: !!shift };
    } else {
      throw new Error('accountId ou cycle requis');
    }
    saveShortcuts(sc);
    await pushTrackedToAll();
    return { ok: true, shortcuts: sc };
  });

  registerRoute('POST', '/api/organizer/focus', async (body) => {
    const { accountId, gameKey, direction } = body || {};
    if (direction === 'next' || direction === 'prev') {
      return { ok: await focusCycle(direction) };
    }
    if (accountId == null) throw new Error('accountId ou direction requis');
    if (gameKey) return { ok: await focusRk(runKey(accountId, gameKey)) };
    return { ok: await focusAccount(parseInt(accountId, 10)) };
  });

  registerRoute('GET', '/api/organizer/sessions', () => {
    // Pour l'UI : liste des rk qui ont une session organizer prête
    return { sessions: Object.keys(sessions), lastFocused };
  });

  log('[organizer] plugin chargé');
  return {};
};
