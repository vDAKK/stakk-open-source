# STAKK — Checklist post-maintenance Dofus

Quand Dofus revient en ligne, lance d'abord :

```bash
node scripts/check-maintenance.js                 # checks sans compte
node scripts/check-maintenance.js --account 11111111   # checks avec un compte réel
```

Puis, pour chaque check qui passe en **FAIL** ou **WARN**, applique le fix ci-dessous.

---

## 1. `ZAAP_VERSION` désynchro

**Symptôme** : le check affiche `code=X.Y.Z ≠ local=A.B.C`, ou HAAPI renvoie 403.

**Fix** : [client/lib/haapi.js:19](client/lib/haapi.js#L19)

```js
const ZAAP_VERSION = '3.14.8'; // remplacer par la version courante
```

Source de vérité de la version courante :
- `%APPDATA%\zaap\application.log` (chercher `Zaap X.Y.Z`)
- ou relancer Zaap officiel, laisser auto-update, re-lire le log

Voir aussi [client/lib/sub-tracker.js:54](client/lib/sub-tracker.js#L54) (`Zaap 4.6.1` — mettre à jour si besoin).

---

## 2. HAAPI auth cassé

**Symptôme** : `HAAPI auth` en FAIL avec un compte dont la `key` était valide avant.

**Causes possibles** :
- key expirée → re-login depuis l'UI (trigger `refreshApiKey` puis `SignOnWithApiKey`)
- path HAAPI renommé → grep `/json/Ankama/v5/` dans lib/haapi.js et comparer aux calls de Zaap officiel (observer via Wireshark/Fiddler en lançant Zaap sur un compte test)
- headers requis ajoutés (ex: nouveau `X-Client-*`) → ajouter dans `request()` options.headers

Les 4 endpoints critiques utilisés par `preAuth` ([client/lib/haapi.js:316-349](client/lib/haapi.js#L316-L349)) :

| Endpoint | Méthode | Usage |
|----------|---------|-------|
| `/json/Ankama/v5/Account/SignOnWithApiKey` | POST | session sur serveur |
| `/json/Ankama/v5/Game/ListWithApiKey` | GET | liste subs |
| `/json/Ankama/v5/Api/RefreshApiKey` | POST | refresh key |
| `/json/Ankama/v5/Account/CreateToken` | GET | token de jeu |

---

## 3. OAuth form cassé (login avec mot de passe)

**Symptôme** : `OAuth form` en FAIL → les sélecteurs `input[name="login"]` / `input[name="password"]` / `button[type="submit"]` ne matchent plus.

**Fix** : [client/lib/haapi.js:206-209](client/lib/haapi.js#L206-L209)

```js
await page.waitForSelector('input[name="login"]', { timeout: 10000 });
await page.type('input[name="login"]', login, { delay: 30 });
await page.type('input[name="password"]', password, { delay: 30 });
await page.click('button[type="submit"]');
```

Pour trouver les nouveaux sélecteurs :
```bash
# Ouvrir le form HTML dans un navigateur
start "" "https://auth.ankama.com/login/ankama?code_challenge=x&redirect_uri=zaap://login&client_id=102&direct=true"
# F12 → inspecter le form → récupérer les attributs name/id
```

Fallback : le user peut toujours se connecter manuellement dans Brave (la flow CDP capture le `zaap://login?code=` quoi qu'il arrive).

---

## 4. Protobuf `IdentificationRequest` (device_id + jrz)

**Symptôme** : Dofus se connecte au proxy mais disconnect immédiat après auth ; pas de log `*** DEVICE_ID REMPLACE` ou `*** FINGERPRINT REMPLACE` dans le proxy.

### 4a. `device_identifier` (64 hex uppercase)

Pattern détecté dans [client/lib/game-proxy.js:362](client/lib/game-proxy.js#L362) :
```
0x0a 0x40 <64 bytes hex ASCII>
```
- `0x0a` = protobuf tag (field 1, wire type LEN)
- `0x40` = length 64
- Si Ankama passe à 32 bytes, 128, ou encode en raw bytes (non-hex), le check `isHex` échoue → patch silencieux.

**Fix** : dumper le premier paquet sortant sur port 5555 et relire les offsets. Ajouter un dump côté proxy :
```js
// dans le on('data') client→serveur, port 5555, premier paquet
fs.writeFileSync('firstpacket.hex', data.toString('hex'));
```

### 4b. Fingerprint `jrz`

Pattern : `type.ankama.com/jrz` + long nombre décimal ASCII ([client/lib/game-proxy.js:398](client/lib/game-proxy.js#L398)).

Si Ankama renomme le proto URL (`type.ankama.com/XXX`), la string disparaît → `idx === -1` → le fingerprint original passe en clair.

**Fix** : hex-dump le paquet, chercher le nouveau marker (souvent `type.ankama.com/...`), adapter `marker` dans `replaceFingerprint()`.

---

## 5. Frida hook `connect()` / `ConnectEx`

**Symptôme** : Dofus lancé mais aucun log `REDIRECT 127.0.0.1:xxxx → proxy:YYYY` ; le jeu tente de se connecter aux IPs Ankama réelles.

**Causes** :
- Frida binding cassé (migration Node majeure) → `npm rebuild frida` dans [client/](client/)
- Ankama utilise une nouvelle API socket (ex: `WSASend`/`WSAConnectByNameW`) → ajouter le hook dans [client/lib/frida-hook.js:84](client/lib/frida-hook.js#L84) sur le même modèle que `ConnectEx`

**Test rapide** : lancer un compte, regarder la console stakk. Si on voit `[hook] connect() → proxy:NNNN` mais pas de `REDIRECT` ensuite = jeu utilise une API non hookée.

---

## 6. Flash key / handshake jeu

Le `flashKey` (17 chars avec checksum hex final) est généré côté STAKK dans [client/lib/frida-hook.js:8-21](client/lib/frida-hook.js#L8-L21). Il sert d'input au `generateFakeFingerprint` côté proxy.

Si Ankama change la longueur attendue (≠ 18) ou l'algo du checksum, la connexion est rejetée au handshake serveur de jeu (port 5555). À re-dériver depuis les logs Zaap officiel après maintenance.

---

## 7. Forgemagie : le serveur ignore les runes posées

**Symptôme** : chaque jet remonte `Rune X sans réponse du jeu`, les piles sont
écartées une à une (`identifiant refusé 3 fois, retiré du stock`), et la forge
finit par s'arrêter sur `plus de rune jetable` alors que le sac est plein.

**Cause** : Ankama réobfusque les signatures de types protobuf à chaque build.
Le message de pose est passé de `type.ankama.com/kdr` à `.../kcj` en août 2026,
et le message de forge de `kqm` à `kqo` — l'enveloppe a changé aussi (champ 3
`{-1, Any}` → champ 2 `{Any, -1}`, uid déplacé du champ 2 au champ 1). Un paquet
émis avec un type qui n'existe plus est ignoré par le serveur, sans erreur.

**Fix : aucun.** Depuis août 2026, STAKK réapprend le format tout seul. Il suffit
que le joueur **pose une rune à la main** dans l'atelier : le paquet sortant
contient l'identifiant d'une de ses runes, identifiant que STAKK connaît déjà par
son miroir d'inventaire — donc ce paquet ne peut être qu'une pose. La commande de
jeu qui suit dans les 20 secondes devient le « forger ». Le profil appris est
écrit dans `~/.stakk/fm-protocol-<accountId>.json` avec `source: "auto"`.

Le journal l'annonce :
```
[fm] protocole réappris depuis le jeu : pose=kcj forge=kqo (uid sur 5 octet(s) à l'offset 29)
```

Une série de jets sans réponse coupe désormais le run au lieu de vider le stock :
```
[fm] aucun jet n'obtient de réponse — protocole probablement périmé.
     Pose une rune à la main dans l'atelier : STAKK réapprend le format tout seul.
```

**Si l'apprentissage ne se déclenche pas** : c'est que le miroir d'inventaire est
vide, donc qu'aucun identifiant n'est reconnaissable. Reconnecte le personnage —
le serveur ne renvoie l'inventaire complet qu'à la connexion. Vérifie ensuite
`~/.stakk/fm-inventory-<accountId>.json`.

La calibration manuelle (capture de deux jets puis analyse) reste disponible dans
**Réglages → Recalibrer** comme filet, mais elle n'est plus le chemin nominal.

Le gabarit intégré, lui, est verrouillé par un test sur des octets réels du
client : [client/test/fm-protocol.test.js](client/test/fm-protocol.test.js)
(`profil intégré : reproduit exactement les octets du vrai client`). Si Ankama
change encore le format, ce test ne casse pas — c'est normal, il décrit le build
d'août 2026. Ce sont les tests d'apprentissage voisins qui garantissent qu'une
nouvelle disposition sera rattrapée.

---

## 8. Shield « perdu » alors qu'il tient dans le launcher

**Symptôme** : `⚠ SHIELD DÉSYNCHRONISÉ` (anciennement `Clé API invalide`) au
lancement, quelques heures après un Shield pourtant réussi — pendant que le même
compte se connecte sans problème depuis le launcher Ankama.

**Cause, vérifiée sur le terrain** : le certificat Shield est **rattaché à la clé
API qui l'a demandé**. Preuve, même certificat et même compte :

| Clé utilisée | `SignOnWithApiKey` | `CreateToken` |
|---|---|---|
| celle qui a créé le certificat | OK | **OK** |
| une clé plus récente | OK | `Invalid security parameters` |

La clé n'est donc jamais en cause — le message historique était trompeur. Tout ce
qui **renouvelle** la clé détache le certificat, et `RefreshApiKey` en émet une
nouvelle à chaque appel.

Trois mécanismes le faisaient, tous corrigés en août 2026 :

1. `web-server.js` — l'auto-import du launcher au démarrage écrasait la clé
   porteuse du certificat par celle de Zaap. Les comptes `customShield`
   conservent désormais leur clé (bundlé : nécessite un rebuild d'exe).
2. `key-refresh.js` — le mode force passait sur tous les comptes après chaque
   import. Les comptes `customShield` sont maintenant épargnés tant que leur clé
   fonctionne.
3. `zaap-server.js` — un `RefreshApiKey` était émis à **chaque** demande de token
   de jeu. On utilise désormais la clé courante, et on ne la renouvelle qu'en
   dernier recours, si Ankama la refuse vraiment.

**Diagnostic à froid**, sans lancer le jeu :

```js
const acc = JSON.parse(fs.readFileSync('release/data/<accountId>', 'utf8'));
const haapi = require('./lib/haapi.js')({});
await haapi.createToken(acc.key, 1, null, acc.certificate, acc.hm1);
```

- token renvoyé → couple clé + certificat sain, chercher ailleurs
- `Invalid security parameters` → certificat détaché : refaire le Shield
- `Certificate control failed` → certificat révoqué côté Ankama : refaire le Shield

**Ne jamais « réparer » en réimportant depuis le launcher** : c'est ce qui casse
le Shield, pas ce qui le répare.

---

## Tests de non-régression

```bash
npm test                    # moteur, protocole, transport, plugins
npm run test:fm:ui          # parcours navigateur complet (Chrome requis)
```

---

## Ordre d'exécution recommandé

1. `node scripts/check-maintenance.js` → fixer tout ce qui n'est pas lié au live game
2. Bump `ZAAP_VERSION` si besoin (le moins cher, le plus probable)
3. Lancer **un** compte test, observer la console :
   - `[Proxy:NNNN] *** DEVICE_ID REMPLACE` et `*** FINGERPRINT REMPLACE` doivent apparaître
   - Si non → problème 4a/4b, dumper les paquets
4. Si le compte arrive en sélection perso → tout va bien, déployer
5. Tagger un release (`v1.3.x`) avec le fix, push l'update — les users en auto-update récupèrent
