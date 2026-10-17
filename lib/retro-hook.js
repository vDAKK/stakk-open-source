'use strict';

/**
 * retro-hook.js — lance Dofus Retro via Frida + patch Win32 à la volée pour
 * forcer l'affichage de la BrowserWindow que Retro crée hidden quand on
 * n'est pas le "vrai" Ankama Launcher.
 *
 * Factory : frida est injecté depuis le bundle stakk (binding
 * natif, non téléchargeable), la logique Frida script + orchestration peut
 * être patchée à chaud.
 */

module.exports = function createRetroHook(deps) {
  deps = deps || {};
  const frida = deps.frida || require('frida');

// Script Frida injecté dans Dofus Retro.exe
const RETRO_HOOK_SCRIPT = `
const WS_VISIBLE = 0x10000000;
const SW_HIDE = 0;
const SW_SHOW = 5;

function readStr(ptrVal, isUnicode) {
  try {
    if (ptrVal.isNull()) return null;
    // Les atoms de classe Windows sont des entiers < 0xFFFF, pas des
    // pointeurs. On filtre pour éviter de déréférencer une adresse invalide.
    const low = ptrVal.toInt32() >>> 0;
    if (low < 0x10000) return null;
    return isUnicode ? ptrVal.readUtf16String(200) : ptrVal.readAnsiString(200);
  } catch { return null; }
}

function isMainAppWindow(className, windowName) {
  // Chrome_WidgetWin_1 = classe des BrowserWindow principaux d'Electron.
  // Chrome_WidgetWin_0 = idem sur certaines versions.
  // Les classes Chrome_* pour message pump / IME ne matchent pas.
  if (className === 'Chrome_WidgetWin_1' || className === 'Chrome_WidgetWin_0') return true;
  if (windowName && windowName.indexOf('Dofus Retro') >= 0) return true;
  return false;
}

function hookCreateWindow(name) {
  const isUnicode = name.endsWith('W');
  const fn = Module.findExportByName('user32.dll', name);
  if (!fn) { send({ type: 'warn', msg: name + ' not found' }); return; }
  Interceptor.attach(fn, {
    onEnter(args) {
      // CreateWindowExA/W signature (x64) :
      //   args[0]=dwExStyle, args[1]=lpClassName, args[2]=lpWindowName,
      //   args[3]=dwStyle, args[4..]=x,y,w,h,hWndParent,...
      const className = readStr(args[1], isUnicode);
      const windowName = readStr(args[2], isUnicode);
      if (!isMainAppWindow(className, windowName)) return;
      const dwStyle = args[3].toInt32();
      if (!(dwStyle & WS_VISIBLE)) {
        args[3] = ptr(dwStyle | WS_VISIBLE);
        this.patched = true;
        this.meta = { cls: className, title: windowName || '' };
      }
    },
    onLeave(retval) {
      if (this.patched) send({ type: 'visible', hwnd: retval.toString(), cls: this.meta.cls, title: this.meta.title });
    },
  });
  send({ type: 'hooked', fn: name });
}

// Pour ShowWindow on a besoin de lire le titre de la fenêtre. On déclare
// GetWindowTextW comme NativeFunction.
const GetWindowTextW = new NativeFunction(
  Module.findExportByName('user32.dll', 'GetWindowTextW'),
  'int', ['pointer', 'pointer', 'int']
);
const GetClassNameW = new NativeFunction(
  Module.findExportByName('user32.dll', 'GetClassNameW'),
  'int', ['pointer', 'pointer', 'int']
);

function readWindowTitle(hwnd) {
  const buf = Memory.alloc(512);
  const n = GetWindowTextW(hwnd, buf, 200);
  return n > 0 ? buf.readUtf16String(n) : '';
}
function readWindowClass(hwnd) {
  const buf = Memory.alloc(512);
  const n = GetClassNameW(hwnd, buf, 200);
  return n > 0 ? buf.readUtf16String(n) : '';
}

function hookShowWindow() {
  const fn = Module.findExportByName('user32.dll', 'ShowWindow');
  if (!fn) { send({ type: 'warn', msg: 'ShowWindow not found' }); return; }
  Interceptor.attach(fn, {
    onEnter(args) {
      const cmd = args[1].toInt32();
      if (cmd !== SW_HIDE) return;
      const hwnd = args[0];
      const title = readWindowTitle(hwnd);
      const cls = readWindowClass(hwnd);
      if (!isMainAppWindow(cls, title)) return;
      args[1] = ptr(SW_SHOW);
      send({ type: 'unhide', hwnd: hwnd.toString(), cls, title });
    },
  });
  send({ type: 'hooked', fn: 'ShowWindow' });
}

try {
  hookCreateWindow('CreateWindowExW');
  hookCreateWindow('CreateWindowExA');
  hookShowWindow();
  send({ type: 'ready' });
} catch (e) {
  send({ type: 'error', msg: String(e) });
}
`;

async function launchRetroWithFrida(exePath, exeArgs, opts, onLog) {
  const pid = await frida.spawn([exePath, ...exeArgs], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: 'inherit',
  });
  if (onLog) onLog(`[Retro:Frida] spawned PID=${pid}`);

  const session = await frida.attach(pid);
  const script = await session.createScript(RETRO_HOOK_SCRIPT);
  script.message.connect((msg) => {
    if (onLog) onLog(`[Retro:Frida] ${JSON.stringify(msg).slice(0, 200)}`);
  });
  await script.load();
  await frida.resume(pid);

  const detachHandlers = [];
  session.detached.connect((reason) => {
    if (onLog) onLog(`[Retro:Frida] session detached: ${reason}`);
    for (const h of detachHandlers) { try { h(reason); } catch {} }
  });

  return {
    pid,
    session,
    script,
    onDetach(cb) { detachHandlers.push(cb); },
    async cleanup() {
      try { await script.unload(); } catch {}
      try { await session.detach(); } catch {}
    },
  };
}

  return { launchRetroWithFrida };
};
