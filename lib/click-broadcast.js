'use strict';

/**
 * click-broadcast.js — Plugin : replique un Ctrl+clic de la
 * fenêtre Dofus leader (foreground) vers toutes les autres fenêtres lancées.
 *
 * Flow :
 *   - Chaque Dofus reçoit un script Frida qui :
 *       * poll GetAsyncKeyState(VK_CONTROL, VK_LBUTTON) à 30ms
 *       * sur front montant de Ctrl+LMB, vérifie que SA fenêtre est celle au
 *         foreground (sinon ce n'est pas le leader → on laisse l'autre gérer)
 *       * calcule GetCursorPos + ScreenToClient + GetClientRect → (xPct, yPct)
 *         (coords relatives au client area, en fraction 0..1 — gère fenêtres
 *         de tailles/positions différentes)
 *       * émet { type:'click', xPct, yPct } via send()
 *       * expose replayClick(xPct, yPct) qui PostMessage WM_MOUSEMOVE +
 *         WM_LBUTTONDOWN + WM_LBUTTONUP sur son propre HWND, sans jamais
 *         prendre le foreground (pas de flash visuel)
 *   - Le plugin :
 *       * sur chaque click reporté, broadcast replayClick sur TOUTES les
 *         autres sessions (la leader a déjà reçu le clic réel de Windows)
 *   - Toggle global via /api/click-broadcast (GET status, POST { enabled })
 *
 * Hypothèses v1 :
 *   - Ctrl + LMB hardcodé (modifier configurable = v2)
 *   - Broadcast vers TOUTES les autres fenêtres Dofus (pas de notion "team")
 *   - PostMessage sans foreground cycle : fonctionne sur Unity (WM_MOUSE*)
 *     mais pas sur les jeux qui lisent raw input uniquement. Si Dofus ne
 *     réagit pas, fallback SendInput + focus cycle à prévoir.
 */

module.exports = function createClickBroadcast(deps) {
  const { on, registerRoute, log, runKey, loadConfig, saveConfig,
          // macOS : lancement du helper de capture (clavier/souris). Absents
          // d'une version d'hôte plus ancienne → le mac se désactive
          // proprement au lieu de planter le plugin.
          spawn, fs, path, APP_ROOT } = deps;

  // Script Frida injecté dans chaque Dofus. Même structure que organizer.js :
  // cache du HWND principal + callback EnumWindows pour le retrouver.
  const FRIDA_SCRIPT = `
(function() {
  var NULL = ptr(0);
  var GetAsyncKeyState = new NativeFunction(Module.getExportByName('user32.dll','GetAsyncKeyState'),'int16',['int']);
  var GetCursorPos = new NativeFunction(Module.getExportByName('user32.dll','GetCursorPos'),'int',['pointer']);
  var SetCursorPos = new NativeFunction(Module.getExportByName('user32.dll','SetCursorPos'),'int',['int','int']);
  var GetClientRect = new NativeFunction(Module.getExportByName('user32.dll','GetClientRect'),'int',['pointer','pointer']);
  var ScreenToClient = new NativeFunction(Module.getExportByName('user32.dll','ScreenToClient'),'int',['pointer','pointer']);
  var ClientToScreen = new NativeFunction(Module.getExportByName('user32.dll','ClientToScreen'),'int',['pointer','pointer']);
  var GetForegroundWindow = new NativeFunction(Module.getExportByName('user32.dll','GetForegroundWindow'),'pointer',[]);
  var SetForegroundWindow = new NativeFunction(Module.getExportByName('user32.dll','SetForegroundWindow'),'int',['pointer']);
  var BringWindowToTop = new NativeFunction(Module.getExportByName('user32.dll','BringWindowToTop'),'int',['pointer']);
  var GetWindowThreadProcessId = new NativeFunction(Module.getExportByName('user32.dll','GetWindowThreadProcessId'),'uint32',['pointer','pointer']);
  var AttachThreadInput = new NativeFunction(Module.getExportByName('user32.dll','AttachThreadInput'),'int',['uint32','uint32','int']);
  var mouse_event = new NativeFunction(Module.getExportByName('user32.dll','mouse_event'),'void',['uint32','uint32','uint32','uint32','pointer']);
  var Sleep = new NativeFunction(Module.getExportByName('kernel32.dll','Sleep'),'void',['uint32']);
  var EnumWindows = new NativeFunction(Module.getExportByName('user32.dll','EnumWindows'),'int',['pointer','pointer']);
  var IsWindowVisible = new NativeFunction(Module.getExportByName('user32.dll','IsWindowVisible'),'int',['pointer']);
  var GetWindow = new NativeFunction(Module.getExportByName('user32.dll','GetWindow'),'pointer',['pointer','uint32']);
  var GetWindowTextLengthW = new NativeFunction(Module.getExportByName('user32.dll','GetWindowTextLengthW'),'int',['pointer']);
  var GetCurrentProcessId = new NativeFunction(Module.getExportByName('kernel32.dll','GetCurrentProcessId'),'uint32',[]);
  var GetCurrentThreadId = new NativeFunction(Module.getExportByName('kernel32.dll','GetCurrentThreadId'),'uint32',[]);

  var myPid = GetCurrentProcessId();
  var mainHwnd = NULL;

  function findMainHwnd() {
    if (!mainHwnd.isNull()) {
      if (IsWindowVisible(mainHwnd)) return mainHwnd;
      mainHwnd = NULL;
    }
    var found = NULL;
    var pidBuf = Memory.alloc(4);
    var cb = new NativeCallback(function(hwnd, lparam) {
      if (!IsWindowVisible(hwnd)) return 1;
      if (!GetWindow(hwnd, 4).isNull()) return 1; // GW_OWNER → skip dialogs
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

  function foregroundIsMine() {
    var fg = GetForegroundWindow();
    if (fg.isNull()) return false;
    var pidBuf = Memory.alloc(4);
    GetWindowThreadProcessId(fg, pidBuf);
    return pidBuf.readU32() === myPid;
  }

  var VK_LBUTTON = 0x01, VK_CONTROL = 0x11, VK_MENU = 0x12, VK_SHIFT = 0x10;
  var MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;

  var enabled = false;
  // Modificateur requis — on matche EXACTEMENT (ctrl seul ≠ ctrl+shift, pour
  // éviter qu'un Shift+clic accidentel pendant un "drag-select Ctrl+clic"
  // fasse broadcast).
  var needCtrl = true, needAlt = false, needShift = false;
  var pollTimer = null;
  var lastTriggered = false; // rising-edge tracking du combo modifier+LMB
  var POLL_MS = 30;
  // Cooldown anti-boucle : après un replay, on ignore les ticks pendant 200ms
  // pour laisser Windows stabiliser l'état LMB suite au mouse_event synthétique
  // (sinon GetAsyncKeyState pourrait re-déclencher un emit en cascade).
  var suppressUntil = 0;

  function readRelClick() {
    var hwnd = findMainHwnd();
    if (hwnd.isNull()) return null;
    var pt = Memory.alloc(8);
    if (!GetCursorPos(pt)) return null;
    ScreenToClient(hwnd, pt);
    var cx = pt.readS32();
    var cy = pt.add(4).readS32();
    var rect = Memory.alloc(16);
    GetClientRect(hwnd, rect);
    var w = rect.add(8).readS32();
    var h = rect.add(12).readS32();
    if (w <= 0 || h <= 0) return null;
    // Clamp au client area — si le clic est dans la title bar / borders,
    // on rejette (pas un clic gameplay).
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) return null;
    return { xPct: cx / w, yPct: cy / h };
  }

  function tick() {
    // Pendant la fenêtre de suppression post-replay, on ne lit même pas l'état :
    // on force lastTriggered=true pour bloquer tout nouveau front montant tant
    // que l'utilisateur n'aura pas relâché + re-pressé physiquement.
    if (Date.now() < suppressUntil) { lastTriggered = true; return; }
    var ctrl  = (GetAsyncKeyState(VK_CONTROL) & 0x8000) !== 0;
    var alt   = (GetAsyncKeyState(VK_MENU)    & 0x8000) !== 0;
    var shift = (GetAsyncKeyState(VK_SHIFT)   & 0x8000) !== 0;
    var lmb   = (GetAsyncKeyState(VK_LBUTTON) & 0x8000) !== 0;
    var modsMatch = (ctrl === needCtrl) && (alt === needAlt) && (shift === needShift);
    var armed = modsMatch && lmb;
    if (armed && !lastTriggered) {
      // Front montant : on n'émet que depuis la fenêtre foreground, sinon
      // tous les followers émettraient aussi (GetAsyncKeyState est global).
      if (foregroundIsMine()) {
        var c = readRelClick();
        if (c) send({ type: 'click', xPct: c.xPct, yPct: c.yPct, t: Date.now() });
      }
    }
    lastTriggered = armed;
  }

  rpc.exports = {
    setConfig: function(cfg) {
      cfg = cfg || {};
      enabled = !!cfg.enabled;
      if (cfg.modifier && typeof cfg.modifier === 'object') {
        // Refuse "aucun modificateur" : ça broadcasterait TOUT clic, danger.
        var anyMod = !!cfg.modifier.ctrl || !!cfg.modifier.alt || !!cfg.modifier.shift;
        if (anyMod) {
          needCtrl  = !!cfg.modifier.ctrl;
          needAlt   = !!cfg.modifier.alt;
          needShift = !!cfg.modifier.shift;
        }
      }
      lastTriggered = false;
      // Pas de poll ici : sur mac la détection du clic vient du helper natif
      // (cf. commentaire en tête du script). setConfig ne fait que mémoriser
      // l'état pour que screenToPct/isFrontmost répondent en cohérence.
      return { enabled: enabled, modifier: { ctrl: needCtrl, alt: needAlt, shift: needShift } };
    },
    replayClick: function(xPct, yPct) {
      // Unity ignore PostMessage(WM_LBUTTONDOWN) en background — il lit
      // l'input global via GetAsyncKeyState + GetCursorPos. Donc seule
      // méthode qui marche : focus cycle + SetCursorPos + mouse_event
      // synthétique. Cost : la fenêtre flashe au premier plan quelques ms,
      // et le curseur saute à la position cible puis revient.
      var hwnd = findMainHwnd();
      if (hwnd.isNull()) return false;
      var rect = Memory.alloc(16);
      GetClientRect(hwnd, rect);
      var w = rect.add(8).readS32();
      var h = rect.add(12).readS32();
      if (w <= 0 || h <= 0) return false;
      var cx = Math.max(0, Math.min(w - 1, Math.round(xPct * w)));
      var cy = Math.max(0, Math.min(h - 1, Math.round(yPct * h)));

      // Client → screen coords (mouse_event + SetCursorPos travaillent en
      // coordonnées écran absolues).
      var pt = Memory.alloc(8);
      pt.writeS32(cx); pt.add(4).writeS32(cy);
      ClientToScreen(hwnd, pt);
      var sx = pt.readS32(), sy = pt.add(4).readS32();

      // Sauvegarde curseur + foreground pour restaurer après.
      var saved = Memory.alloc(8);
      GetCursorPos(saved);
      var prevFg = GetForegroundWindow();
      var myTid = GetCurrentThreadId();

      // AttachThreadInput à la fenêtre actuellement au premier plan : sinon
      // SetForegroundWindow est silencieusement ignoré par Windows quand
      // l'appelant n'a pas déjà le focus (anti-focus-stealing d'Explorer).
      var fgTid = 0;
      if (!prevFg.isNull()) {
        var fgPidBuf = Memory.alloc(4);
        fgTid = GetWindowThreadProcessId(prevFg, fgPidBuf);
        if (fgTid && fgTid !== myTid) AttachThreadInput(myTid, fgTid, 1);
      }
      SetForegroundWindow(hwnd);
      BringWindowToTop(hwnd);
      if (fgTid && fgTid !== myTid) AttachThreadInput(myTid, fgTid, 0);

      // Bloque l'émetteur pendant la durée du clic synthétique — empêche un
      // re-déclenchement en cascade via GetAsyncKeyState global.
      suppressUntil = Date.now() + 400;

      // Laisse Unity traiter WM_ACTIVATE et démarrer son input polling dans
      // le bon état. Sans ça, le clic arrive avant que le jeu ne se considère
      // focus et est ignoré (cause la plus fréquente de "flash sans effet").
      Sleep(60);

      // Cursor → position cible. Petit délai pour qu'Unity voit la nouvelle
      // position avant le click (lit GetCursorPos à chaque frame).
      SetCursorPos(sx, sy);
      Sleep(20);

      // LEFTDOWN → Unity doit détecter GetAsyncKeyState(VK_LBUTTON) = down
      // sur une frame. On laisse 30ms (~2 frames à 60fps) avant le UP pour
      // que le down soit bien capté comme un press complet (pas un flicker).
      mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, NULL);
      Sleep(30);
      mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, NULL);
      Sleep(30);

      // Restaure curseur à sa position d'origine.
      SetCursorPos(saved.readS32(), saved.add(4).readS32());

      // Rend le focus à la fenêtre leader (ce qui était foreground avant).
      if (!prevFg.isNull()) {
        var prevPidBuf = Memory.alloc(4);
        var prevTid = GetWindowThreadProcessId(prevFg, prevPidBuf);
        if (prevTid && prevTid !== myTid) AttachThreadInput(myTid, prevTid, 1);
        SetForegroundWindow(prevFg);
        BringWindowToTop(prevFg);
        if (prevTid && prevTid !== myTid) AttachThreadInput(myTid, prevTid, 0);
      }
      send({ type: 'debug', msg: 'replay done at screen=' + sx + ',' + sy + ' client=' + cx + ',' + cy + ' (' + w + 'x' + h + ')' });
      return true;
    }
  };

  send({ type: 'ready', pid: myPid });
})();
`;

  // Équivalent macOS. Même contrat : rpc.exports { setConfig, replayClick },
  // payload send({type:'click', xPct, yPct}) en fraction du content area —
  // onClick() et les routes HTTP sont donc identiques sur les deux plateformes.
  //
  // Différences imposées par macOS :
  //   - Lecture clavier/souris via CGEventSourceKeyState (pas de focus requis,
  //     mais autorisation Accessibilité obligatoire). Le bouton gauche se lit
  //     avec CGEventSourceButtonState.
  //   - Position curseur : CGEventCreate(NULL) + CGEventGetLocation, qui rend
  //     un CGPoint en coordonnées écran (origine haut-gauche sur l'écran
  //     principal, comme Windows).
  //   - Géométrie fenêtre via NSWindow (ObjC) au lieu de GetClientRect.
  //   - Rejeu du clic : CGEventCreateMouseEvent + CGEventPost. Pas besoin du
  //     focus cycle Windows — CGEventPost livre l'événement au HID system,
  //     donc la fenêtre cible n'a pas à passer au premier plan. Le curseur
  //     bouge quand même, on le restaure comme sur Windows.
  const FRIDA_SCRIPT_MAC = `
(function() {
  var CGEventSourceKeyState = new NativeFunction(
    Module.getGlobalExportByName('CGEventSourceKeyState'), 'bool', ['int32', 'uint16']);
  var CGEventSourceButtonState = new NativeFunction(
    Module.getGlobalExportByName('CGEventSourceButtonState'), 'bool', ['int32', 'uint32']);
  var CGEventCreate = new NativeFunction(
    Module.getGlobalExportByName('CGEventCreate'), 'pointer', ['pointer']);
  var CGEventGetLocation = new NativeFunction(
    Module.getGlobalExportByName('CGEventGetLocation'), 'void', ['pointer', 'pointer']);
  var CGEventCreateMouseEvent = new NativeFunction(
    Module.getGlobalExportByName('CGEventCreateMouseEvent'),
    'pointer', ['pointer', 'uint32', 'double', 'double', 'uint32']);
  var CGEventPost = new NativeFunction(
    Module.getGlobalExportByName('CGEventPost'), 'void', ['uint32', 'pointer']);
  var CGWarpMouseCursorPosition = new NativeFunction(
    Module.getGlobalExportByName('CGWarpMouseCursorPosition'), 'int32', ['double', 'double']);
  var CFRelease = new NativeFunction(
    Module.getGlobalExportByName('CFRelease'), 'void', ['pointer']);

  // Runtime Objective-C via son API C : Frida 17 n'injecte plus le pont ObjC
  // dans un script nu (le global ObjC est undefined).
  var objc_getClass = new NativeFunction(Module.getGlobalExportByName('objc_getClass'), 'pointer', ['pointer']);
  var sel_registerName = new NativeFunction(Module.getGlobalExportByName('sel_registerName'), 'pointer', ['pointer']);
  var msgSendPtr = Module.getGlobalExportByName('objc_msgSend');
  var CGMainDisplayID = new NativeFunction(Module.getGlobalExportByName('CGMainDisplayID'), 'uint32', []);
  var CGDisplayPixelsHigh = new NativeFunction(Module.getGlobalExportByName('CGDisplayPixelsHigh'), 'size_t', ['uint32']);

  function _s(str) { return Memory.allocUtf8String(str); }
  function _cls(name) { return objc_getClass(_s(name)); }
  function _sel(name) { return sel_registerName(_s(name)); }
  // objc_msgSend est variadique : une NativeFunction par signature.
  function _msgPtr(recv, name) {
    return new NativeFunction(msgSendPtr, 'pointer', ['pointer', 'pointer'])(recv, _sel(name));
  }
  function _msgBool(recv, name) {
    return new NativeFunction(msgSendPtr, 'bool', ['pointer', 'pointer'])(recv, _sel(name));
  }
  function _msgLong(recv, name) {
    return new NativeFunction(msgSendPtr, 'int64', ['pointer', 'pointer'])(recv, _sel(name));
  }
  function _msgPtrWithLong(recv, name, arg) {
    return new NativeFunction(msgSendPtr, 'pointer', ['pointer', 'pointer', 'int64'])(recv, _sel(name), arg);
  }
  // NSRect = 4 doubles renvoyés par valeur : sur arm64 c'est objc_msgSend
  // standard (pas _stret), la struct partant dans les registres flottants.
  function _msgRect(recv, name) {
    var f = new NativeFunction(msgSendPtr,
      ['double', 'double', 'double', 'double'], ['pointer', 'pointer']);
    return f(recv, _sel(name));
  }

  var kCombined = 1;            // kCGEventSourceStateCombinedSessionState
  var kLeftButton = 0;          // kCGMouseButtonLeft
  var kMouseMoved = 5, kLeftDown = 1, kLeftUp = 2;
  var kHIDEventTap = 0;         // kCGHIDEventTap
  var MAC_SHIFT = [56, 60], MAC_CTRL = [59, 62], MAC_ALT = [58, 61];

  function anyDown(codes) {
    for (var i = 0; i < codes.length; i++) {
      if (CGEventSourceKeyState(kCombined, codes[i])) return true;
    }
    return false;
  }

  // CGPoint = deux doubles. Frida n'a pas de retour struct-par-valeur ici,
  // d'où la variante à pointeur de sortie.
  function cursorPos() {
    var ev = CGEventCreate(ptr(0));
    if (ev.isNull()) return null;
    var pt = Memory.alloc(16);
    CGEventGetLocation(ev, pt);
    var x = pt.readDouble(), y = pt.add(8).readDouble();
    CFRelease(ev);
    return { x: x, y: y };
  }

  // Fenêtre principale du process : première NSWindow visible avec un titre.
  // Équivalent du findMainHwnd() Windows (EnumWindows + filtre pid/titre).
  function mainWindow() {
    try {
      var cls = _cls('NSApplication');
      if (cls.isNull()) return null;
      var app = _msgPtr(cls, 'sharedApplication');
      if (app.isNull()) return null;
      var wins = _msgPtr(app, 'windows');
      if (wins.isNull()) return null;
      var count = _msgLong(wins, 'count');
      for (var i = 0; i < count; i++) {
        var w = _msgPtrWithLong(wins, 'objectAtIndex:', i);
        if (w.isNull()) continue;
        if (!_msgBool(w, 'isVisible')) continue;
        var title = _msgPtr(w, 'title');
        if (title.isNull() || _msgLong(title, 'length') < 1) continue;
        return w;
      }
      return null;
    } catch (e) { return null; }
  }

  // Rect du content area en coordonnées écran, converti en repère
  // haut-gauche : Cocoa a l'origine en BAS-gauche, CGEvent en HAUT-gauche.
  // La hauteur de référence vient de CGDisplayPixelsHigh(CGMainDisplayID())
  // plutôt que de NSScreen — un appel C direct, pas de struct par valeur.
  function contentRectTopLeft() {
    try {
      var w = mainWindow();
      if (!w) return null;
      var f = _msgRect(w, 'frame'); // [x, y, w, h]
      var ox = f[0], oy = f[1], fw = f[2], fh = f[3];
      if (!(fw > 0 && fh > 0)) return null;
      var primaryH = CGDisplayPixelsHigh(CGMainDisplayID());
      return { x: ox, y: primaryH - (oy + fh), w: fw, h: fh };
    } catch (e) { return null; }
  }

  function frontmostIsMine() {
    try {
      var cls = _cls('NSRunningApplication');
      if (cls.isNull()) return false;
      var app = _msgPtr(cls, 'currentApplication');
      if (app.isNull()) return false;
      return !!_msgBool(app, 'isActive');
    } catch (e) { return false; }
  }

  var enabled = false;
  var needCtrl = true, needAlt = false, needShift = false;
  var pollTimer = null;
  var lastTriggered = false;
  var POLL_MS = 30;
  var suppressUntil = 0;

  function readRelClick() {
    var r = contentRectTopLeft();
    if (!r || r.w <= 0 || r.h <= 0) return null;
    var p = cursorPos();
    if (!p) return null;
    var cx = p.x - r.x, cy = p.y - r.y;
    if (cx < 0 || cy < 0 || cx >= r.w || cy >= r.h) return null;
    return { xPct: cx / r.w, yPct: cy / r.h };
  }

  function postMouse(type, x, y) {
    var ev = CGEventCreateMouseEvent(ptr(0), type, x, y, kLeftButton);
    if (ev.isNull()) return;
    CGEventPost(kHIDEventTap, ev);
    CFRelease(ev);
  }

  rpc.exports = {
    setConfig: function(cfg) {
      cfg = cfg || {};
      enabled = !!cfg.enabled;
      if (cfg.modifier && typeof cfg.modifier === 'object') {
        var anyMod = !!cfg.modifier.ctrl || !!cfg.modifier.alt || !!cfg.modifier.shift;
        if (anyMod) {
          needCtrl  = !!cfg.modifier.ctrl;
          needAlt   = !!cfg.modifier.alt;
          needShift = !!cfg.modifier.shift;
        }
      }
      lastTriggered = false;
      if (enabled && !pollTimer) pollTimer = setInterval(tick, POLL_MS);
      else if (!enabled && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      return { enabled: enabled, modifier: { ctrl: needCtrl, alt: needAlt, shift: needShift } };
    },
    // Convertit un clic en coordonnées écran (venu du helper) en fraction du
    // content area de CETTE fenêtre. Renvoie null si le clic est hors fenêtre :
    // c'est ce qui identifie la fenêtre leader côté hôte.
    screenToPct: function(sx, sy) {
      if (!enabled) return null;
      var r = contentRectTopLeft();
      if (!r || r.w <= 0 || r.h <= 0) return null;
      var cx = sx - r.x, cy = sy - r.y;
      if (cx < 0 || cy < 0 || cx >= r.w || cy >= r.h) return null;
      return { xPct: cx / r.w, yPct: cy / r.h };
    },
    isFrontmost: function() { return frontmostIsMine(); },
    replayClick: function(xPct, yPct) {
      var r = contentRectTopLeft();
      if (!r || r.w <= 0 || r.h <= 0) return false;
      var cx = Math.max(0, Math.min(r.w - 1, Math.round(xPct * r.w)));
      var cy = Math.max(0, Math.min(r.h - 1, Math.round(yPct * r.h)));
      var sx = r.x + cx, sy = r.y + cy;

      var saved = cursorPos();
      suppressUntil = Date.now() + 400;

      // move → down → up. Le move préalable évite que l'app voie un clic
      // surgir à une position qu'elle n'a jamais vu le curseur atteindre.
      postMouse(kMouseMoved, sx, sy);
      postMouse(kLeftDown, sx, sy);
      postMouse(kLeftUp, sx, sy);

      // Restaure le curseur. CGWarp plutôt qu'un event : pas de clic parasite.
      if (saved) CGWarpMouseCursorPosition(saved.x, saved.y);
      send({ type: 'debug', msg: 'replay done at screen=' + sx + ',' + sy + ' client=' + cx + ',' + cy + ' (' + r.w + 'x' + r.h + ')' });
      return true;
    }
  };

  send({ type: 'ready', pid: Process.id });
})();
`;

  // Windows garde EXACTEMENT le script d'origine ; darwin est additif.
  const SCRIPT = process.platform === 'darwin' ? FRIDA_SCRIPT_MAC : FRIDA_SCRIPT;

  // sessions[rk] = { script, rpc }
  const sessions = {};

  function loadState() {
    const cfg = loadConfig() || {};
    const st = cfg.clickBroadcast || {};
    const mod = st.modifier || {};
    // Défaut: activé, Ctrl seul. Si l'utilisateur a tout décoché côté UI,
    // on ré-applique Ctrl pour éviter un état "broadcast tout clic".
    const anyMod = !!mod.ctrl || !!mod.alt || !!mod.shift;
    return {
      enabled: st.enabled !== false,
      modifier: anyMod
        ? { ctrl: !!mod.ctrl, alt: !!mod.alt, shift: !!mod.shift }
        : { ctrl: true, alt: false, shift: false },
    };
  }
  function saveState(st) {
    const cfg = loadConfig() || {};
    cfg.clickBroadcast = st;
    saveConfig(cfg);
  }

  // ── Capture du clic macOS ────────────────────────────────────────────────
  // Même contrainte que pour organizer : le script injecté ne peut pas lire
  // l'entrée physique dans un process en hardened runtime. STAKK lance donc
  // mac-helper/keytap --clicks, qui rapporte chaque clic gauche en coordonnées
  // écran ; on demande ensuite à chaque session laquelle contient ce point
  // (screenToPct), ce qui désigne la fenêtre leader sans avoir à lire le
  // clavier depuis le jeu.
  const IS_MAC = process.platform === 'darwin';
  const KEYTAP_BIN = IS_MAC && path && APP_ROOT
    ? path.join(APP_ROOT, 'mac-helper', 'keytap')
    : null;
  let keytap = null;
  let keytapWarned = false;
  // Anti-boucle : après un broadcast, les replays synthétiques repassent par
  // le tap. On ignore les clics pendant cette fenêtre, comme le suppressUntil
  // du script Windows.
  let suppressUntil = 0;

  function stopKeytap() {
    if (!keytap) return;
    try { keytap.kill(); } catch {}
    keytap = null;
  }

  function restartKeytap() {
    if (!IS_MAC) return;
    stopKeytap();
    const st = loadState();
    if (!st.enabled) return;
    if (!Object.keys(sessions).length) return;
    if (!spawn || !fs || !KEYTAP_BIN || !fs.existsSync(KEYTAP_BIN)) {
      if (!keytapWarned) {
        keytapWarned = true;
        log(`[click-broadcast] helper absent (${KEYTAP_BIN}) — broadcast inactif sur macOS`);
      }
      return;
    }
    try {
      keytap = spawn(KEYTAP_BIN, ['--clicks'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      log(`[click-broadcast] helper non lancé: ${e.message}`);
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
        if (msg.ready) { log('[click-broadcast] helper prêt (clics)'); continue; }
        if (!msg.click) continue;
        onMacClick(msg).catch(e => log(`[click-broadcast] onMacClick: ${e.message}`));
      }
    });
    keytap.stderr.on('data', d => {
      const s2 = String(d).trim();
      if (!s2) return;
      if (s2.includes('tap-failed')) {
        log('[click-broadcast] helper refusé par macOS — accorde « Surveillance de l\'entrée » à STAKK dans Réglages → Confidentialité et sécurité, puis relance');
      } else {
        log(`[click-broadcast] helper: ${s2}`);
      }
    });
    keytap.on('exit', (code, sig) => {
      if (keytap) log(`[click-broadcast] helper arrêté (code=${code} sig=${sig})`);
      keytap = null;
    });
  }

  // Un clic physique rapporté par le helper : on vérifie le modificateur, puis
  // on cherche la fenêtre qui contient le point. Celle-là est la leader.
  async function onMacClick(msg) {
    if (Date.now() < suppressUntil) return;
    const st = loadState();
    if (!st.enabled) return;
    const m = st.modifier;
    // Match EXACT du modificateur, comme le script Windows.
    if (!!m.ctrl !== !!msg.ctrl || !!m.alt !== !!msg.alt || !!m.shift !== !!msg.shift) return;

    for (const [rk, s] of Object.entries(sessions)) {
      let pct = null;
      try { pct = await s.rpc.screenToPct(msg.x, msg.y); }
      catch (e) { continue; }
      if (!pct) continue;
      // Le replay se fait sur les AUTRES fenêtres ; la leader a déjà reçu le
      // clic réel. On bloque le tap le temps des replays synthétiques.
      suppressUntil = Date.now() + 600;
      await onClick(rk, pct);
      return;
    }
  }

  async function pushConfigToAll() {
    const st = loadState();
    for (const [rk, s] of Object.entries(sessions)) {
      try { await s.rpc.setConfig(st); }
      catch (e) { log(`[click-broadcast] setConfig ${rk}: ${e.message}`); }
    }
    // Sur mac c'est le helper qui détecte réellement le clic.
    restartKeytap();
  }

  async function onClick(leaderRk, payload) {
    const { xPct, yPct } = payload;
    if (typeof xPct !== 'number' || typeof yPct !== 'number') return;
    if (!(xPct >= 0 && xPct <= 1 && yPct >= 0 && yPct <= 1)) return;
    // Broadcast SÉQUENTIEL à toutes les autres sessions. Chaque replayClick
    // fait un focus cycle (SetForegroundWindow + mouse_event) — en parallèle
    // les cycles se racent et Windows livre le focus à un seul gagnant. En
    // séquence chaque fenêtre passe au premier plan, reçoit son clic, rend
    // le focus au leader, puis la suivante prend le relais.
    const targets = Object.entries(sessions).filter(([rk]) => rk !== leaderRk);
    log(`[click-broadcast] clic ${leaderRk} (${xPct.toFixed(3)},${yPct.toFixed(3)}) → broadcast vers ${targets.length} sess.`);
    if (targets.length === 0) return;
    for (const [rk, s] of targets) {
      try {
        const ok = await s.rpc.replayClick(xPct, yPct);
        log(`[click-broadcast] replay → ${rk}: ${ok ? 'OK' : 'KO (hwnd/rect)'}`);
      }
      catch (e) { log(`[click-broadcast] replay ${rk} ERR: ${e.message}`); }
    }
  }

  on('launch', async ({ accountId, gameKey, fridaHandle }) => {
    if (!fridaHandle || !fridaHandle.session) return; // Wakfu : pas de Frida
    const rk = runKey(accountId, gameKey);
    try {
      const script = await fridaHandle.session.createScript(SCRIPT);
      script.message.connect((msg) => {
        if (msg.type !== 'send') return;
        const payload = msg.payload;
        if (!payload || typeof payload !== 'object') return;
        if (payload.type === 'click') {
          onClick(rk, payload).catch(e => log(`[click-broadcast] onClick: ${e.message}`));
        } else if (payload.type === 'debug') {
          log(`[click-broadcast] dbg ${rk}: ${payload.msg}`);
        }
      });
      await script.load();
      sessions[rk] = { script, rpc: script.exports };
      const st = loadState();
      try { await script.exports.setConfig(st); }
      catch (e) { log(`[click-broadcast] setConfig initial ${rk}: ${e.message}`); }
      // macOS : démarre le helper dès qu'une session existe.
      if (!keytap) restartKeytap();
      const mods = Object.entries(st.modifier).filter(([,v])=>v).map(([k])=>k).join('+') || 'aucun';
      log(`[click-broadcast] session prête ${rk} (enabled=${st.enabled} mods=${mods})`);
    } catch (e) {
      log(`[click-broadcast] createScript KO ${rk}: ${e.message}`);
    }
  });

  on('detach', ({ accountId, gameKey }) => {
    const rk = runKey(accountId, gameKey);
    const s = sessions[rk];
    if (!s) return;
    try { s.script.unload().catch(() => {}); } catch {}
    delete sessions[rk];
    // Plus aucun jeu lancé → on rend l'accès à l'entrée.
    if (!Object.keys(sessions).length) stopKeytap();
  });

  registerRoute('GET', '/api/click-broadcast', () => loadState());
  registerRoute('POST', '/api/click-broadcast', async (body) => {
    body = body || {};
    const cur = loadState();
    const st = {
      enabled: body.enabled == null ? cur.enabled : !!body.enabled,
      modifier: body.modifier && typeof body.modifier === 'object'
        ? {
            ctrl:  !!body.modifier.ctrl,
            alt:   !!body.modifier.alt,
            shift: !!body.modifier.shift,
          }
        : cur.modifier,
    };
    // Empêche "aucun modificateur" : fallback sur Ctrl.
    if (!st.modifier.ctrl && !st.modifier.alt && !st.modifier.shift) {
      st.modifier = { ctrl: true, alt: false, shift: false };
    }
    saveState(st);
    await pushConfigToAll();
    return { ok: true, ...st };
  });

  log('[click-broadcast] plugin chargé');
  return {};
};
