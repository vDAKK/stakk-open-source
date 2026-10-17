# STAKK pour macOS

## Installation utilisateur

1. Télécharge l'archive depuis les releases :
   - **Apple Silicon (M1/M2/M3)** : `stakk-macos-arm64-vX.Y.Z.zip`
   - **Intel** : `stakk-macos-x64-vX.Y.Z.zip`
2. Extrais le zip — tu obtiens `STAKK.app` et `install.sh`.
3. Ouvre un Terminal dans ce dossier et lance :
   ```bash
   ./install.sh
   ```
   (permissions + signature ad-hoc + clear quarantine + rappel SIP)
4. Désactive SIP (voir plus bas — obligatoire pour Frida).
5. **Double-clic sur `STAKK.app`** dans Finder. L'app lance stakk comme
   n'importe quelle app Mac native.

## Build (cross-compile depuis Windows)

```bash
cd client
npm install
# Les deux archs d'un coup
node build-mac-cross.js both
# Ou une seule
node build-mac-cross.js arm64
```

Prérequis (à mettre en place une fois) :

- `mac-prebuilds/<arch>/build/frida_binding.node` — prebuild natif Frida,
  depuis https://github.com/frida/frida/releases/tag/17.9.1
  (`frida-v17.9.1-napi-v8-darwin-<arch>.tar.gz`)
- `mac-frida/node_modules/frida` — install isolée de frida 17 (ESM). Le client
  principal reste sur frida 15 CJS pour Windows/pkg.
- `mac-prebuilds/node/` — se remplit tout seul au premier build (download du
  binaire Node darwin officiel).

Sortie : `dist-mac-<arch>/{STAKK.app,install.sh}` plus l'archive de release
`macos-<arch>-v<version>.zip` prête à uploader, à la racine de `client/`.

Le build combine `pkg` (binaire unique Node+JS embed) ET un wrapper
`STAKK.app` natif Mac :

```
dist-mac-<arch>/
  STAKK.app/
    Contents/
      Info.plist                        metadata app
      MacOS/
        STAKK                           launcher shell (entry point)
      Resources/
        stakk-bin                       binaire pkg (Node + JS)
        build/Release/frida_binding.node  natif Frida arch-specific
        node_modules/frida/             wrapper JS
        node_modules/bindings/ + file-uri-to-path
        release/data/                   persistance runtime
        version.txt
  install.sh                            codesign + xattr + SIP reminder
```

Double-clic sur STAKK.app → Finder exécute `Contents/MacOS/STAKK`
(shell launcher) → `exec stakk-bin` depuis Resources/.

## Désactivation de SIP (obligatoire)

Frida a besoin d'injecter du code dans Dofus.exe, ce qui est bloqué par **System Integrity Protection** par défaut.

### 1. Redémarre en mode Recovery

**Intel Mac :**
- Redémarre et maintiens `Cmd + R` jusqu'au logo Apple

**Apple Silicon (M1/M2/M3) :**
- Éteins le Mac
- Maintiens le bouton d'alimentation jusqu'à "Options de démarrage"
- Clique "Options" → "Continuer"

### 2. Ouvre Terminal

Menu `Utilities` → `Terminal`

### 3. Désactive SIP

```bash
csrutil disable
```

### 4. Redémarre normalement

```bash
reboot
```

### Vérifier

Après redémarrage, dans un terminal :
```bash
csrutil status
```

Devrait afficher : `System Integrity Protection status: disabled`

## Lancement

Double-clic sur `STAKK.app` dans Finder. L'app démarre comme n'importe
quelle app Mac.

Pour debug, depuis le Terminal :
```bash
./STAKK.app/Contents/MacOS/STAKK
```
Ça exécute le launcher directement et affiche les logs en console.

## Diagnostic

Le build Mac est cross-compilé depuis Windows et le launcher se ré-exécute en
root via `osascript`. Beaucoup de choses peuvent diverger silencieusement entre
ces deux environnements. Le mode diag dump tout en une passe, sans prompt
d'élévation :

```bash
# 1. En tant qu'utilisateur
STAKK_DIAG=1 ./STAKK.app/Contents/MacOS/STAKK

# 2. Dans l'environnement root, celui où STAKK tourne réellement
sudo STAKK_DIAG=1 ./STAKK.app/Contents/MacOS/STAKK
```

Comparer les deux sorties : les lignes `MISMATCH` montrent ce que l'élévation
casse (identité utilisateur, `$HOME`). Le rapport couvre aussi l'intégrité du
bundle, le chargement de Frida et `task_for_pid`, la résolution des dossiers
de jeu, et la variante de dérivation de clé qui déchiffre le keydata du
launcher Ankama.

Aucune donnée sensible n'est imprimée : uniquement des booléens, des
compteurs et des noms de champs.

## Réactiver SIP

Pour réactiver SIP après utilisation :
1. Redémarre en mode Recovery
2. `csrutil enable`
3. Redémarre

⚠️ **Attention** : STAKK ne fonctionnera plus une fois SIP réactivé.

## Références

- [Apple Documentation — Disabling SIP](https://developer.apple.com/documentation/security/disabling-and-enabling-system-integrity-protection)
