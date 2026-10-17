'use strict';

/**
 * compiler-schema.js — compile le schéma protobuf COMPLET de Dofus 3.
 *
 * `compiler-protocole.js` produit une table des champs PARLANTS : elle dit ce
 * qu'un champ signifie, et ne garde que les messages où Ankama a laissé des
 * noms lisibles. C'est un dictionnaire de sens, et il reste 1958 messages
 * dehors.
 *
 * Celui-ci répond à l'autre moitié du problème : la FORME. Il garde tout —
 * chaque message, chaque numéro de champ, son type, sa répétition — y compris
 * les messages entièrement obfusqués. Le sens y est absent ; la structure y
 * est exacte.
 *
 * Pourquoi c'est suffisant pour ne plus apprendre : sur le fil, un message de
 * jeu voyage dans un `google.protobuf.Any` dont le `type_url` vaut
 * `type.ankama.com/<nom>`. Le NOM DU MESSAGE EST DONC SUR LE FIL. Avec le
 * schéma en main, n'importe quel paquet se décode intégralement sans avoir
 * rien observé : plus de champ deviné, plus de gabarit ancré sur une valeur
 * connue. Ce qui reste à établir — et c'est un autre travail, celui de
 * `protocole-champs.json` — c'est à quoi `hhf` correspond.
 *
 * Le schéma vient du `dofus.proto` embarqué par `krm35/dofus-multi`, extrait
 * du pool de constantes V8 de son `index.jsc` (228 ko, 2708 déclarations).
 *
 * Les noms sont uniques dans tout le fichier, y compris pour les messages
 * imbriqués : on aplatit donc par nom simple, et une référence qualifiée
 * (`hrz.hrx`) se résout sur son dernier segment.
 *
 * ATTENTION, même mise en garde que pour la table des champs : ceci décrit UN
 * build. Un patch d'Ankama rebat les noms et périme le fichier — il faut le
 * recompiler, pas l'espérer stable.
 *
 *   node scripts/compiler-schema.js [chemin/dofus.proto]
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const RACINE = path.join(__dirname, '..');
const ENTREE_DEFAUT = path.join(RACINE, 'cache', 'dofus.proto');
const SORTIE = path.join(RACINE, 'lib', 'dofus-schema.json.gz');

// Les scalaires protobuf, avec le type de fil que chacun emprunte. Tout ce qui
// n'est pas là-dedans est un message ou un enum : un enum voyage en varint,
// un message en bloc préfixé de sa longueur.
const SCALAIRES = {
  double: 'f64', float: 'f32',
  int32: 'varint', int64: 'varint', uint32: 'varint', uint64: 'varint',
  sint32: 'zigzag', sint64: 'zigzag',
  fixed32: 'f32', fixed64: 'f64', sfixed32: 'f32', sfixed64: 'f64',
  bool: 'bool', string: 'string', bytes: 'bytes',
};

function compiler(source) {
  const lignes = source.split('\n');
  const messages = {};
  const enums = new Set();
  const pile = [];

  for (const ligne of lignes) {
    const ouverture = /^\s*(message|enum) (\w+) \{/.exec(ligne);
    if (ouverture) {
      const [, genre, nom] = ouverture;
      if (genre === 'enum') enums.add(nom);
      else messages[nom] = {};
      pile.push(nom);
      // Une déclaration tenant sur une seule ligne (`message x {}`) se referme
      // aussitôt : sans ça la pile dériverait et tous les champs suivants
      // atterriraient dans le mauvais message.
      if (/\}\s*$/.test(ligne)) pile.pop();
      continue;
    }
    if (/^\s*\}/.test(ligne)) { pile.pop(); continue; }

    const champ = /^\s*(optional |repeated )?([\w.]+) (\w+) = (\d+);/.exec(ligne);
    if (!champ || !pile.length) continue;
    const courant = pile[pile.length - 1];
    if (!messages[courant]) continue; // un champ ne vit pas dans un enum

    const [, repetition, type, nom, numero] = champ;
    messages[courant][numero] = {
      n: nom,
      t: type.split('.').pop(),
      ...(repetition === 'repeated ' ? { r: 1 } : {}),
    };
  }

  return { messages, enums: [...enums].sort() };
}

if (require.main === module) {
  const src = process.argv[2] || ENTREE_DEFAUT;
  if (!fs.existsSync(src)) {
    console.error(`Introuvable : ${src}`);
    console.error('Usage : node scripts/compiler-schema.js [chemin/dofus.proto]');
    process.exit(1);
  }

  const { messages, enums } = compiler(fs.readFileSync(src, 'utf8'));
  const table = { messages, enums, scalaires: SCALAIRES };
  const brut = Buffer.from(JSON.stringify(table), 'utf8');
  // Le schéma pèse quelques centaines de ko en clair pour beaucoup de noms
  // courts très répétés : gzip le divise par cinq, et zlib est dans Node.
  fs.writeFileSync(SORTIE, zlib.gzipSync(brut, { level: 9 }));

  const nbChamps = Object.values(messages).reduce((n, m) => n + Object.keys(m).length, 0);
  console.log(`${Object.keys(messages).length} messages, ${enums.length} enums, ${nbChamps} champs`);
  console.log(`-> ${path.relative(process.cwd(), SORTIE)} ` +
    `(${Math.round(fs.statSync(SORTIE).size / 1024)} ko gzip, ${Math.round(brut.length / 1024)} ko en clair)`);
}

module.exports = { compiler, SCALAIRES };
