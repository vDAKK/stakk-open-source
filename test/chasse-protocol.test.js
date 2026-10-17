'use strict';

/**
 * Protocole de la chasse au trésor.
 *
 * Une chasse est une suite d'étapes : le joueur reçoit un indice (« va vers le
 * sud, cherche un panneau »), se déplace de carte en carte, pose un drapeau
 * quand il pense être au bon endroit, et creuse à la dernière étape.
 *
 * La version précédente de ces tests fixait un contrat en attendant une
 * capture : le module ne savait rien et refusait d'agir. Le schéma protobuf du
 * build a levé l'attente — les trois messages sont connus champ par champ — et
 * ces tests portent désormais sur le décodage réel.
 *
 * La construction, elle, a disparu : la chasse observe et conseille, elle ne
 * joue plus. Un test le verrouille — les trois constructeurs ne doivent plus
 * être exportés du tout.
 *
 * Ce qui NE change pas : sans dictionnaire à jour, aucun type par défaut,
 * donc aucune action. Un patch d'Ankama rend `hhf` faux, et agir dessus
 * enverrait n'importe quoi au serveur.
 *
 *   node test/chasse-protocol.test.js
 */

const assert = require('assert');
const learn = require('../lib/protocol-learn')();
const createDofusSchema = require('../lib/dofus-schema');
const createChasse = require('../lib/chasse-protocol');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

const proto = createChasse({ createProtocolLearn: () => learn });
const schema = createDofusSchema();

// Un événement de chasse plausible : deux drapeaux posés, trois étapes —
// aller au sud, aller à l'ouest jusqu'à un indice, creuser.
const EVENEMENT = {
  flws: [{ flwe: 1, flwf: 84279045 }, { flwe: 0, flwf: 84279046 }],
  flww: 2,
  flwx: [
    { flvv: { flux: 3, fluy: 2 } },
    { flvw: { flvc: 1, flvd: 4, flve: 317 } },
    { flvy: {} },
  ],
};
const PAQUET = schema.encoderAny('hhf', EVENEMENT);

// ─── Refus ─────────────────────────────────────────────────────────────────

test('un paquet vide ne rend aucune étape', () => {
  assert.strictEqual(proto.lireEtape(null), null);
  assert.strictEqual(proto.lireEtape(Buffer.alloc(0)), null);
});

test('un paquet sans rapport n\'est pas une étape de chasse', () => {
  // Une récolte porte la même enveloppe Any : sans discriminant sur le
  // type_url, un décodage trop permissif inventerait des étapes.
  const recolte = Buffer.from(
    '2d122b0a1e0a13747970652e616e6b616d612e636f6d2f69776f120708ff09108c9c1e10ffffffffffffffffff01', 'hex');
  assert.strictEqual(proto.lireEtape(recolte), null);
  assert.strictEqual(proto.estMessageChasse(recolte), false);
});

test('sans protocole utilisable, aucune étape n\'est lue', () => {
  // Le garde-fou de toute la démarche : plutôt se déclarer aveugle que lire
  // des champs justes rattachés au mauvais message.
  const aveugle = createChasse({ createProtocolLearn: () => learn, schema: null, noms: null });
  assert.strictEqual(aveugle.utilisable(), false);
  assert.strictEqual(aveugle.lireEtape(PAQUET), null);
});

test('le protocole ne sait fabriquer aucun paquet', () => {
  // La propriété centrale depuis que la chasse observe au lieu d'agir : ce
  // qu'on ne peut pas fabriquer, on ne peut pas l'envoyer par mégarde.
  for (const interdit of ['construireDrapeau', 'construireFouille', 'construireDemandeEtat']) {
    assert.strictEqual(proto[interdit], undefined,
      `${interdit} est encore exporté : l'overlay pourrait émettre un paquet`);
  }
});

test('un dictionnaire périmé ne fournit aucun type par défaut', () => {
  const perime = createChasse({
    createProtocolLearn: () => learn,
    noms: { estAJour: () => false, nom: () => 'hhf' },
  });
  assert.deepStrictEqual(perime.types, { drapeau: null, fouille: null, etape: null, demande: null });
  assert.strictEqual(perime.utilisable(), false);
});

// ─── Lecture ───────────────────────────────────────────────────────────────

test('les types viennent du dictionnaire du build', () => {
  assert.deepStrictEqual(proto.types, { drapeau: 'hhv', fouille: 'hgj', etape: 'hhf', demande: 'hhh' });
  assert.strictEqual(proto.utilisable(), true);
});

test('le type des messages reste injectable', () => {
  // De quoi corriger un nom sans republier le module, le temps que le
  // dictionnaire soit régénéré après un patch.
  const p = createChasse({ createProtocolLearn: () => learn, types: { etape: 'hhq' } });
  assert.strictEqual(p.types.etape, 'hhq');
  assert.strictEqual(p.types.drapeau, 'hhv');
});

test('l\'état d\'une chasse se lit intégralement', () => {
  const e = proto.lireEtape(PAQUET);
  assert.strictEqual(e.questType, 2);
  assert.strictEqual(e.drapeaux.length, 2);
  assert.strictEqual(e.etapes.length, 3);
});

test('un drapeau porte son état et la carte visée', () => {
  const [premier] = proto.lireEtape(PAQUET).drapeaux;
  assert.strictEqual(premier.etat, 1);
  assert.strictEqual(premier.mapId, 84279045);
});

test('une étape rend sa direction en clair', () => {
  const [pas] = proto.lireEtape(PAQUET).etapes;
  assert.strictEqual(pas.genre, 'indice');
  assert.strictEqual(pas.direction, 2);
  assert.strictEqual(pas.directionNom, 'sud');
});

test("le nombre d'une étape est un indice, jamais une distance", () => {
  // Vérifié sur une chasse réelle : l'étape marquée 965 correspond à un trajet
  // de CINQ cartes ([3,22] vers [3,17]). Le lire comme un compte envoyait le
  // moteur à 965 cartes de là, et il abandonnait aussitôt.
  const [, vers] = proto.lireEtape(PAQUET).etapes;
  assert.strictEqual(vers.genre, 'indice');
  assert.strictEqual(vers.directionNom, 'ouest');
  assert.strictEqual(vers.indice, 1);
  assert.ok(vers.parametres.includes(317));
});

test("la carte de départ de la chasse est exposée", () => {
  // Relevée à 88085249 en jeu, elle tombe en [10,22] : exactement le
  // « Départ [10,22] » que le panneau du jeu affiche.
  const avec = schema.encoderAny('hhf', Object.assign({ flwu: 88085249 }, EVENEMENT));
  assert.strictEqual(proto.lireEtape(avec).depart, 88085249);
});

test('la variante vide se lit comme une fouille', () => {
  const [, , fin] = proto.lireEtape(PAQUET).etapes;
  assert.strictEqual(fin.genre, 'fouille');
  assert.strictEqual(fin.direction, null);
});

test('l\'étiquette d\'une étape est révisable sans redécoder', () => {
  // `genre` est une lecture, pas une certitude. `variante` dit le champ réel,
  // pour corriger si l'une de ces lectures se révèle fausse.
  for (const e of proto.lireEtape(PAQUET).etapes) {
    assert.ok(e.variante, 'chaque étape doit exposer sa variante brute');
    assert.ok(e.brut !== undefined, 'chaque étape doit exposer son contenu brut');
  }
});

test('un événement de chasse est reconnu comme tel', () => {
  assert.strictEqual(proto.estMessageChasse(PAQUET), true);
});

test("le compteur d'étapes est celui de la CHASSE, pas des indices", () => {
  // Confondre les deux affichait « Étape 5/5 » sur une chasse qui n'en était
  // qu'à sa deuxième : la liste d'indices décrit la seule étape en cours.
  //
  // Deux relevés réels. Au premier, le champ d'index est absent — proto3
  // n'émet pas un zéro — et le jeu affichait « ÉTAPE 1/5 » ; se fier aux seuls
  // champs présents faisait alors élire « essais restants » à sa place.
  const releve1 = schema.encoderAny('hhf', { flwr: 5, flwt: 4, flwv: 5, flww: 2, flws: [], flwx: [] });
  const releve2 = schema.encoderAny('hhf', { flwo: 1, flwr: 5, flwt: 3, flwv: 5, flww: 2, flws: [], flwx: [] });
  const a = proto.lireEtape(releve1), b = proto.lireEtape(releve2);
  assert.strictEqual(a.etapeNum, 0);
  assert.strictEqual(a.etapesTotal, 5);
  assert.strictEqual(a.derniereEtape, false);
  assert.strictEqual(b.etapeNum, 1);
  assert.strictEqual(b.etapesTotal, 5);
});

test('la dernière étape se signale comme telle', () => {
  const fin = schema.encoderAny('hhf', { flwo: 4, flwr: 5, flwt: 1, flwv: 5, flww: 2, flws: [], flwx: [] });
  assert.strictEqual(proto.lireEtape(fin).derniereEtape, true);
});

test("un drapeau posé se distingue d'un drapeau validé", () => {
  // Cocher sur la simple présence faisait valider l'indice au premier pas.
  const p2 = schema.encoderAny('hhf', {
    flww: 2, flws: [{ flwe: 1, flwf: 88081665 }, { flwf: 88081670 }], flwx: [],
  });
  const d = proto.lireEtape(p2).drapeaux;
  assert.strictEqual(d[0].valide, true);
  assert.strictEqual(d[1].valide, false);
});


// ─── Le phorreur sur la carte ──────────────────────────────────────────────

test('le phorreur est vu aussi a l arrivee sur la carte', () => {
  // Deux messages portent la liste d'acteurs, et il faut les deux : `jsn`
  // annonce ceux qui ARRIVENT pendant qu'on est là, `jss` ceux qui sont DÉJÀ
  // là quand c'est nous qui arrivons. Le second est le cas courant.
  //
  // Le faux schéma évite de fabriquer un vrai paquet d'acteurs : ce qui est
  // vérifié ici est le CHOIX des messages acceptés, pas le décodage protobuf,
  // déjà couvert par dofus-schema.test.js.
  const fauxSchema = {
    extraireAny: (buf) => ({ nom: buf.toString(), contenu: { a: 2673 } }),
    champsDe: () => null,
    estConnu: () => true,
  };
  const fauxNoms = {
    estAJour: () => true,
    nom: (sens) => ({
      GameRolePlayShowActorsEvent: 'jsn',
      MapComplementaryInformationEvent: 'jss',
      TreasureHuntEvent: 'hhf',
      TreasureHuntFlagRequest: 'hhv',
      TreasureHuntDigRequest: 'hgj',
      TreasureHuntStateRequest: 'hhh',
    })[sens] || null,
    voisinage: () => [],
  };
  const p = createChasse({ createProtocolLearn: () => learn, schema: fauxSchema, noms: fauxNoms });

  assert.strictEqual(p.acteursContiennent(Buffer.from('jsn'), 2673), true, 'acteurs apparus');
  assert.strictEqual(p.acteursContiennent(Buffer.from('jss'), 2673), true, 'acteurs a l arrivee');
  assert.strictEqual(p.acteursContiennent(Buffer.from('hhf'), 2673), false,
    'un message de chasse n est pas une liste d acteurs');
  assert.strictEqual(p.acteursContiennent(Buffer.from('jss'), 999), false,
    'un PNJ absent ne doit pas etre annonce present');
});

test('un dictionnaire perime ne fait voir aucun phorreur', () => {
  // Après un patch d'Ankama, `jss` désigne autre chose : y chercher un
  // identifiant ferait afficher « ICI » au hasard.
  const p = createChasse({
    createProtocolLearn: () => learn,
    schema: { extraireAny: () => ({ nom: 'jss', contenu: { a: 2673 } }), champsDe: () => null, estConnu: () => true },
    noms: { estAJour: () => false, nom: () => 'jss', voisinage: () => [] },
  });
  assert.strictEqual(p.acteursContiennent(Buffer.from('jss'), 2673), false);
});

console.log(`\n${passed} test(s) OK`);
