'use strict';

/**
 * Tests du cycle de vie d'un profil protocole. I/O réelles, dans un dossier
 * temporaire : c'est la persistance elle-même qu'on vérifie.
 *   node test/protocol-store.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const learn = require('../lib/protocol-learn')();

let passed = 0;
function test(name, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stakk-store-'));
  try { fn(dir); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const BUILTIN = { version: 2, source: 'builtin', codes: { move: 'kcj', ready: 'kqo' },
  move: { template: 'aa', uidOffset: 1, uidLength: 1 }, ready: { packet: 'bb' } };
const LEARNED = { version: 2, source: 'auto', codes: { move: 'zzz', ready: 'yyy' },
  move: { template: 'cc', uidOffset: 1, uidLength: 5 }, ready: { packet: 'dd' } };

function store(dir, over) {
  return learn.createProfileStore(Object.assign({
    fs, path, dir, feature: 'fm', accountId: 42,
    builtin: () => BUILTIN,
    isEquivalent: (a, b) => !!a && !!b && a.move.template === b.move.template,
    log: () => {},
  }, over || {}));
}

test('sans profil sur disque, rend le gabarit intégré', dir => {
  assert.strictEqual(store(dir).get().source, 'builtin');
});

test('un profil appris a le dernier mot', dir => {
  const s = store(dir);
  assert.deepStrictEqual(s.learn(LEARNED), { saved: true });
  assert.strictEqual(store(dir).get().codes.move, 'zzz', 'profil non relu depuis le disque');
});

test('nomme le fichier comme la forgemagie le fait déjà', dir => {
  store(dir).learn(LEARNED);
  assert.ok(fs.existsSync(path.join(dir, 'fm-protocol-42.json')),
    'le nom de fichier a changé — les profils déjà appris seraient perdus');
});

test('ne réécrit pas un candidat équivalent', dir => {
  const s = store(dir);
  s.learn(LEARNED);
  const before = fs.statSync(path.join(dir, 'fm-protocol-42.json')).mtimeMs;
  assert.deepStrictEqual(s.learn({ ...LEARNED, createdAt: 'plus tard' }), { skipped: 'equivalent' });
  assert.strictEqual(fs.statSync(path.join(dir, 'fm-protocol-42.json')).mtimeMs, before);
});

test('refuse d\'écraser un profil prouvé', dir => {
  const s = store(dir);
  s.learn(LEARNED);
  s.markProven();
  assert.deepStrictEqual(s.learn({ ...LEARNED, move: { ...LEARNED.move, template: 'ee' } }),
    { skipped: 'proven' });
  assert.strictEqual(s.get().move.template, 'cc', 'un profil prouvé a été écrasé');
});

test('la preuve survit au redémarrage', dir => {
  const s1 = store(dir);
  s1.learn(LEARNED);
  s1.markProven();
  // Nouveau processus : nouvelle instance, aucun état en mémoire.
  const s2 = store(dir);
  assert.strictEqual(s2.isProven(), true, 'la preuve n\'a pas été persistée');
  assert.deepStrictEqual(s2.learn({ ...LEARNED, move: { ...LEARNED.move, template: 'ee' } }),
    { skipped: 'proven' });
});

test('la preuve ne se transmet pas à un autre gabarit', dir => {
  const s = store(dir);
  s.learn(LEARNED);
  s.markProven();
  s.dropLearned();                       // retour à l'intégré
  assert.strictEqual(s.isProven(), false,
    'l\'intégré a hérité de la preuve du profil appris');
});

test('dropLearned jette l\'appris et revient à l\'intégré', dir => {
  const s = store(dir);
  s.learn(LEARNED);
  assert.strictEqual(s.dropLearned(), true);
  assert.strictEqual(s.get().source, 'builtin');
  assert.strictEqual(s.dropLearned(), false, 'second appel : plus rien à jeter');
});

test('dropLearned garde un profil appris qui vaut déjà l\'intégré', dir => {
  // Même template que l'intégré : le jeter annoncerait un repli qui ne change
  // pas un octet, et le consommateur redépenserait toute une série de jets
  // muets avant de poser le vrai diagnostic. Le problème est ailleurs.
  const s = store(dir);
  // Écrit directement : learn() refuserait ce candidat comme équivalent. Sur
  // disque il y arrive par un autre chemin — une calibration, ou un intégré
  // qui a rattrapé le profil appris à la mise à jour suivante de STAKK.
  const jumeau = { ...LEARNED, move: { ...LEARNED.move, template: BUILTIN.move.template } };
  fs.writeFileSync(path.join(dir, 'fm-protocol-42.json'), JSON.stringify(jumeau));
  let relearns = 0;
  s.onRelearn(() => { relearns++; });
  assert.strictEqual(s.dropLearned(), false, 'un profil équivalent à l\'intégré a été jeté');
  assert.ok(fs.existsSync(path.join(dir, 'fm-protocol-42.json')), 'le fichier a été supprimé');
  assert.strictEqual(relearns, 0, 'un abandon sans effet a été annoncé');
});

test('dropLearned ne jette rien s\'il n\'y a aucun gabarit intégré', dir => {
  // Sans repli, supprimer l'appris laisserait le consommateur sans profil du
  // tout — il relit `get()` à chaque jet et n'aurait plus rien à envoyer.
  const s = store(dir, { builtin: () => null });
  s.learn(LEARNED);
  assert.strictEqual(s.dropLearned(), false, 'l\'appris a été jeté sans repli possible');
  assert.strictEqual(s.get().codes.move, 'zzz', 'le consommateur s\'est retrouvé sans profil');
});

test('forgetProof retire la preuve sans déclarer le protocole périmé', dir => {
  // Le consommateur escalade en deux temps : la preuve tombe d'abord, le
  // verdict « périmé » ne vient qu'après. Les deux ne doivent pas être liés.
  const s = store(dir);
  s.learn(LEARNED);
  s.markProven();
  assert.strictEqual(s.isProven(), true, 'préalable : profil prouvé');

  s.forgetProof();
  assert.strictEqual(s.isProven(), false, 'la preuve a survécu à son oubli');
  assert.strictEqual(s.isStale(), false, 'oublier la preuve a déclaré le protocole périmé');
  assert.strictEqual(s.get().codes.move, 'zzz', 'le profil lui-même a été jeté');

  // L'oubli est sur disque, pas seulement en mémoire : c'est justement le
  // redémarrage qui ne débloque plus rien depuis que la preuve est persistée.
  assert.strictEqual(store(dir).isProven(), false,
    'la preuve est revenue après relecture depuis le disque');
  assert.deepStrictEqual(s.learn({ ...LEARNED, move: { ...LEARNED.move, template: 'ee' } }),
    { saved: true }, 'l\'apprentissage est resté verrouillé après l\'oubli');
});

test('reposer la preuve ne perd pas les annotations du fichier', dir => {
  // Le fichier ne porte pas que le gabarit : le consommateur y range aussi le
  // chemin du reliquat, par un tout autre chemin que le cycle de vie et y
  // compris quand le gabarit en place est l'intégré. Oublier puis reposer la
  // preuve — ce que fait une série muette suivie d'un jet qui répond — ne doit
  // rien en emporter.
  const file = path.join(dir, 'fm-protocol-42.json');
  const lire = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const s = store(dir);

  s.markProven();
  // Annotation posée par le consommateur, à côté de la preuve.
  fs.writeFileSync(file, JSON.stringify({ ...lire(), reliquatPath: '1.4.2' }));

  s.forgetProof();
  assert.strictEqual(s.isProven(), false, 'préalable : preuve oubliée');
  assert.strictEqual(lire().reliquatPath, '1.4.2',
    'forgetProof a effacé le chemin du reliquat');

  s.markProven();
  assert.strictEqual(s.isProven(), true, "la preuve n'a pas été reposée");
  assert.strictEqual(lire().reliquatPath, '1.4.2',
    'le chemin du reliquat a été perdu en reposant la preuve');
});

test('forgetProof sur un profil sans preuve ne touche pas au fichier', dir => {
  const s = store(dir);
  s.learn(LEARNED);
  const before = fs.statSync(path.join(dir, 'fm-protocol-42.json')).mtimeMs;
  s.forgetProof();
  assert.strictEqual(fs.statSync(path.join(dir, 'fm-protocol-42.json')).mtimeMs, before);
  assert.strictEqual(s.get().codes.move, 'zzz');
});

test('onRelearn prévient après un apprentissage et après un abandon', dir => {
  const s = store(dir);
  let n = 0;
  s.onRelearn(() => { n++; });
  s.learn(LEARNED);
  assert.strictEqual(n, 1, 'pas prévenu après apprentissage');
  s.dropLearned();
  assert.strictEqual(n, 2, 'pas prévenu après abandon');
});

test('un fichier corrompu ne fait pas tomber le store', dir => {
  fs.writeFileSync(path.join(dir, 'fm-protocol-42.json'), '{ ceci n\'est pas du json');
  assert.strictEqual(store(dir).get().source, 'builtin');
});

test('un profil "builtin" sur disque ne masque pas l\'intégré courant', dir => {
  // Photo d'un gabarit intégré d'une version passée : Dofus ne le comprend
  // peut-être plus. Seuls les profils réellement appris ont le dernier mot.
  fs.writeFileSync(path.join(dir, 'fm-protocol-42.json'),
    JSON.stringify({ ...BUILTIN, move: { template: 'périmé', uidOffset: 1, uidLength: 1 } }));
  assert.strictEqual(store(dir).get().move.template, 'aa');
});

test('flagStale ne se déclenche qu\'une fois', dir => {
  const s = store(dir);
  assert.strictEqual(s.isStale(), false);
  assert.strictEqual(s.flagStale(), true, 'premier appel');
  assert.strictEqual(s.flagStale(), false, 'déclenché deux fois');
  assert.strictEqual(s.isStale(), true);
});

test('flagStale efface la preuve : les faits la démentent', dir => {
  // Sans cet effacement, une preuve accordée à tort verrouillerait
  // l'apprentissage pour toujours — la persistance a supprimé la soupape
  // qu'était le redémarrage.
  const s = store(dir);
  s.learn(LEARNED);
  s.markProven();
  assert.strictEqual(s.isProven(), true, 'préalable : profil prouvé');

  s.flagStale();
  assert.strictEqual(s.isProven(), false, 'la preuve a survécu à la péremption');

  // Nouvelle instance sur le même répertoire : l'effacement doit être sur
  // disque, pas seulement dans l'état en mémoire de `s`.
  const s2 = store(dir);
  assert.strictEqual(s2.isProven(), false,
    'la preuve a survécu à la péremption après relecture depuis le disque');

  const autre = { ...LEARNED, codes: { move: 'www', ready: 'xxx' },
    move: { ...LEARNED.move, template: 'ee' } };
  assert.deepStrictEqual(s.learn(autre), { saved: true },
    'l\'apprentissage est resté verrouillé après péremption');
});

test('markProven sur le gabarit intégré nu : rien à jeter, l\'intégré reste', dir => {
  // Cas protégé par « un profil builtin sur disque ne masque pas l'intégré » :
  // ici il n'y a même pas de profil appris, la preuve se pose donc sur une
  // copie de l'intégré courant. Rien de tout ça n'était exercé jusqu'ici.
  const s = store(dir);
  s.markProven();
  assert.strictEqual(s.isProven(), true, 'la preuve sur l\'intégré n\'a pas pris');
  assert.strictEqual(s.get().source, 'builtin',
    'la preuve posée sur l\'intégré a masqué l\'intégré courant');
  assert.strictEqual(s.dropLearned(), false, 'rien n\'a jamais été appris, il n\'y a rien à jeter');

  // Nouvelle instance sur le même répertoire : la preuve doit tenir sur
  // disque, pas seulement dans l'état en mémoire de `s`.
  const s2 = store(dir);
  assert.strictEqual(s2.get().source, 'builtin',
    'la preuve posée sur l\'intégré a fini par masquer l\'intégré courant');
});

test('learn() refuse un candidat nul ou sans move, sans rien écrire', dir => {
  const s = store(dir);
  assert.deepStrictEqual(s.learn(null), { error: 'candidat incomplet' });
  assert.deepStrictEqual(s.learn({}), { error: 'candidat incomplet' });
  assert.ok(!fs.existsSync(path.join(dir, 'fm-protocol-42.json')),
    'un candidat invalide a quand même écrit un fichier');
});

test('learn() ignore un provenTemplate glissé dans le candidat : la preuve se mérite, ne se dicte pas', dir => {
  const s = store(dir);
  // provenTemplate bidon qui correspond déjà au template du candidat : le cas
  // le plus piégeux, celui où l'injection réussirait immédiatement si le
  // champ n'était pas retiré avant écriture.
  const truque = { ...LEARNED, provenTemplate: LEARNED.move.template };
  const avant = JSON.stringify(truque);
  assert.deepStrictEqual(s.learn(truque), { saved: true });
  assert.strictEqual(s.isProven(), false,
    'un provenTemplate fourni par l\'appelant a été pris comme une preuve méritée');
  // Le retrait doit se faire sur une COPIE : l'objet de l'appelant ne doit
  // jamais être muté par learn(), sinon un futur remplacement du
  // destructuring par un `delete candidat.provenTemplate` passerait ce test
  // tout en cassant silencieusement l'appelant.
  assert.strictEqual(JSON.stringify(truque), avant,
    'le candidat de l\'appelant a été muté par learn()');
  assert.strictEqual(truque.provenTemplate, LEARNED.move.template,
    'provenTemplate a disparu de l\'objet de l\'appelant');
});

console.log(`\n${passed} test(s) OK`);
