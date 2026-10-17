'use strict';

/**
 * compiler-noms.js — fige le dictionnaire de sens et l'empreinte du build.
 *
 * Les paires sens → nom obfusqué viennent de `krm35/dofus-multi`, où elles
 * sont écrites en dur dans le pool de constantes V8 de son `index.jsc` : son
 * code appelle `send("TreasureHuntFlagRequest", {flyz, flza})`, et une table
 * interne rattache ce libellé au message `hhv`. 41 paires en sont sorties, et
 * chacune a été confrontée au schéma avant d'être retenue.
 *
 * Trois d'entre elles ne viennent pas de cette table mais des sites d'appel,
 * où le libellé et les champs se lisent côte à côte : la chasse au trésor.
 * Les champs concordent exactement avec `hhf`, `hhv` et `hgj`.
 *
 * Recoupement indépendant : `jrw` et `jqi` étaient déjà connus de STAKK, non
 * par ce binaire mais par apprentissage en jeu. Les deux sources disent la
 * même chose.
 *
 * L'empreinte enregistrée sert de date de péremption. Elle change dès
 * qu'Ankama rebat le protocole, et `dofus-noms.js` refuse alors de répondre —
 * voir la mesure qui y est consignée : le remappage automatique par forme ne
 * marche pas, il faut ré-étiqueter.
 *
 *   node scripts/compiler-noms.js
 */

const fs = require('fs');
const path = require('path');

const RACINE = path.join(__dirname, '..');
const ENTREE = path.join(RACINE, 'cache', 'dofus-message-names.json');
const SORTIE = path.join(RACINE, 'lib', 'dofus-noms.json');

// Relevées sur les sites d'appel de dofus-multi, pas dans sa table : le
// libellé y voisine les champs, qui concordent avec le schéma.
//   send("TreasureHuntFlagRequest", { flyz, flza })  →  hhv { hgi, int32 }
//   send("TreasureHuntDigRequest",  { fluj })        →  hgj { hgi }
//   on lit TreasureHuntEvent via flww/flwu/flws/flwx →  hhf
const RELEVEES = {
  TreasureHuntEvent: 'hhf',
  TreasureHuntFlagRequest: 'hhv',
  TreasureHuntDigRequest: 'hgj',

  // Celui-ci ne vient pas de dofus-multi mais du schéma lui-même : Ankama a
  // laissé ses deux champs en clair, et ils ne laissent aucun doute.
  //
  //     message jgs {
  //       repeated int32 challengers_positions = 1;
  //       defenders_positions = 2;
  //     }
  //
  // `challengers_positions` n'apparaît nulle part ailleurs dans les 2254
  // messages. C'est le placement de début de combat — le PREMIER signal qu'un
  // combat commence, bien avant le premier tour. C'est ce qu'il faut pour
  // arrêter une récolte automatique dès l'agression, plutôt qu'une fois le
  // personnage déjà en train de jouer son tour.
  FightPlacementPossiblePositionsEvent: 'jgs',

  // Les réponses du serveur aux actions de chasse. Identifiées par leur forme
  // ET par la cardinalité de leur enum, qui recoupe celle documentée du
  // protocole Dofus 2 :
  //
  //   hhq { result(7 valeurs), int32, questType }   → drapeau
  //        TreasureHuntFlagRequestEnum a 7 valeurs (OK, WRONG, TOO_MANY,
  //        WRONG_INDEX, SAME_MAP, IMPOSSIBLE, RIGHT_HIDDEN)
  //   hhk { questType, result(6 valeurs) }          → fouille
  //        TreasureHuntDigRequestEnum en a 6 (OK, WRONG, WRONG_AND_YOU_KNOW_IT,
  //        TOO_MANY, FINISHED, NEW_HINT)
  //
  // Un troisième voisin, `hht`, porte lui aussi un `result` et pourrait être
  // l'un des deux. Le moteur ne s'y fie pas : il traite N'IMPORTE laquelle de
  // ces réponses comme « le serveur a parlé » et regarde ensuite si l'étape a
  // avancé. Une confusion entre les trois ne change donc rien à son
  // comportement — elle changerait seulement ce que dit le journal.
  TreasureHuntFlagAnswerEvent: 'hhq',
  TreasureHuntDigAnswerEvent: 'hhk',

  // OBSERVÉ, pas déduit : à l'ouverture du panneau de chasse, le client émet
  // `hhh` en ne renseignant que son champ « type de quête », et le serveur
  // répond 34 ms plus tard par l'état complet de la chasse.
  //
  //     OUT 12:28:12.068  hhh  { flxh: 2 }
  //     IN  12:28:12.102  hhf  { … étape 2/5, indices, drapeaux … }
  //
  // C'est ce qui permet de RETROUVER une chasse déjà en cours : sans cette
  // requête, STAKK restait aveugle jusqu'à ce que le joueur agisse, puisque le
  // serveur ne pousse rien à la connexion — vérifié sur une capture qui
  // commence au lancement du jeu.
  TreasureHuntStateRequest: 'hhh',
};

if (require.main === module) {
  const schema = require(path.join(RACINE, 'lib', 'dofus-schema'))();

  let base = {};
  if (fs.existsSync(ENTREE)) base = JSON.parse(fs.readFileSync(ENTREE, 'utf8'));
  else console.warn(`[noms] ${path.relative(process.cwd(), ENTREE)} absent, on ne prend que les paires relevées`);

  const candidats = { ...base, ...RELEVEES };
  const noms = {};
  const rejetes = [];
  for (const [sens, nom] of Object.entries(candidats)) {
    // Une paire qui ne retombe pas sur le schéma est fausse ou périmée :
    // l'inscrire ferait agir STAKK sur un message qui n'existe pas.
    if (schema.estConnu(nom)) noms[sens] = nom;
    else rejetes.push(`${sens} -> ${nom}`);
  }

  // On écrit d'abord sans empreinte, puis on la calcule sur le dictionnaire
  // effectivement retenu — sinon elle décrirait autre chose que le fichier.
  const dico = { build: null, noms };
  const createDofusNoms = require(path.join(RACINE, 'lib', 'dofus-noms'));
  dico.build = createDofusNoms({ schema, dico }).empreinteBuild();

  fs.writeFileSync(SORTIE, JSON.stringify(dico, null, 1));

  const outil = createDofusNoms({ schema, dico });
  const rapport = outil.verifier();
  console.log(`${Object.keys(noms).length} paires retenues, ${rejetes.length} rejetées`);
  if (rejetes.length) console.log('  rejetées :', rejetes.join(', '));
  console.log(`empreinte du build : ${dico.build}`);
  console.log(`ancrables sur un nom en clair : ${rapport.ancre.length}`);
  console.log(`muets (aucune ancre, introuvables seuls après un patch) : ${rapport.muet.length}`);
  if (rapport.suspects.length) console.log('  SUSPECTS :', JSON.stringify(rapport.suspects));
  console.log(`-> ${path.relative(process.cwd(), SORTIE)}`);
}

module.exports = { RELEVEES };
