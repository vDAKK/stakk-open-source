// keytap — capture clavier/souris globale pour macOS.
//
// Pourquoi ce binaire existe : sur macOS, le script Frida injecté dans Dofus
// ne peut PAS lire l'entrée physique. Dofus tourne en hardened runtime ; une
// fois du code non signé injecté, macOS cesse d'honorer ses autorisations TCC
// de lecture d'entrée (CGEventSourceKeyState renvoie toujours false, et un
// event tap ne reçoit rien). Poster des événements reste possible, lire non.
//
// STAKK n'est pas injecté : sa signature est intacte, il peut donc porter
// l'autorisation « Surveillance de l'entrée » et lire l'entrée. Ce helper fait
// cette lecture et écrit une ligne JSON par événement sur stdout ; les plugins
// décident et agissent via le RPC Frida côté jeu.
//
// Usage : keytap [--clicks] [<keycode>…]
//   <keycode>  virtual keycodes Carbon à surveiller (front montant)
//   --clicks   rapporte aussi les clics gauche, avec position écran
//
// Sortie (une ligne JSON par événement) :
//   {"ready":true}
//   {"kc":64,"ctrl":0,"alt":0,"shift":0}
//   {"click":1,"x":123.0,"y":456.0,"ctrl":1,"alt":0,"shift":0}

import Foundation
import CoreGraphics

var watched = Set<Int64>()
var wantClicks = false
for arg in CommandLine.arguments.dropFirst() {
    if arg == "--clicks" { wantClicks = true }
    else if let kc = Int64(arg) { watched.insert(kc) }
}
if watched.isEmpty && !wantClicks {
    FileHandle.standardError.write("usage: keytap [--clicks] <keycode>...\n".data(using: .utf8)!)
    exit(2)
}

// stdout depuis un callback de tap : une seule file série, pour ne pas
// entrelacer deux lignes JSON.
let outQueue = DispatchQueue(label: "keytap.out")
func emit(_ line: String) {
    outQueue.async { print(line); fflush(stdout) }
}

func mods(_ f: CGEventFlags) -> String {
    let c = f.contains(.maskControl) ? 1 : 0
    let a = f.contains(.maskAlternate) ? 1 : 0
    let s = f.contains(.maskShift) ? 1 : 0
    return "\"ctrl\":\(c),\"alt\":\(a),\"shift\":\(s)"
}

var tapRef: CFMachPort?

let callback: CGEventTapCallBack = { _, type, event, _ in
    // Un tap désactivé par le système (timeout / entrée utilisateur) doit être
    // réarmé, sinon il reste muet sans erreur.
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let t = tapRef { CGEvent.tapEnable(tap: t, enable: true) }
        return Unmanaged.passUnretained(event)
    }
    switch type {
    case .keyDown:
        let kc = event.getIntegerValueField(.keyboardEventKeycode)
        if watched.contains(kc) { emit("{\"kc\":\(kc),\(mods(event.flags))}") }
    case .leftMouseDown:
        if wantClicks {
            let p = event.location
            emit("{\"click\":1,\"x\":\(p.x),\"y\":\(p.y),\(mods(event.flags))}")
        }
    default:
        break
    }
    return Unmanaged.passUnretained(event)
}

var mask = CGEventMask(1 << CGEventType.keyDown.rawValue)
if wantClicks { mask |= CGEventMask(1 << CGEventType.leftMouseDown.rawValue) }

// listenOnly : on observe sans consommer, le jeu reçoit l'entrée normalement.
guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap,
                                  place: .headInsertEventTap,
                                  options: .listenOnly,
                                  eventsOfInterest: mask,
                                  callback: callback,
                                  userInfo: nil) else {
    FileHandle.standardError.write("tap-failed\n".data(using: .utf8)!)
    exit(1)
}
tapRef = tap
let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), src, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)
emit("{\"ready\":true}")
CFRunLoopRun()
