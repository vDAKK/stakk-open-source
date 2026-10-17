'use strict';

/**
 * Le plugin de chasse observe, et rien d'autre.
 *
 * C'est LA propriété de ce module, et la raison pour laquelle la chasse
 * automatique a été retirée : traverser des dizaines de cartes en fabriquant
 * des paquets était le geste le plus exposé de tout STAKK.
 *
 * Le canal de jeu fourni ici échoue à la moindre écriture. Un test qui
 * vérifierait « le plugin n'appelle pas construireDrapeau » raterait une
 * émission passant par un autre chemin ; celui-ci ne peut pas la rater.
 *
 *   node test/chasse-plugin.test.js
 */

const assert = require('assert');
const createChasse = require('../lib/chasse');

// Le helper des autres suites est synchrone. Ici plusieurs cas attendent une
// résolution d'indice, et un `assert` qui échoue dans une fonction async part
// en rejet non capturé : le processus tombe bien, mais sur une trace de crash,
// et les cas suivants ne tournent pas. On les enchaîne donc à la file.
let passed = 0;
const file = [];
function test(name, fn) {
  file.push(async () => {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
  });
}

// Un canal qui refuse d'être écrit. Toute émission fait tomber le test.
function canalInviolable() {
  const interdire = () => { throw new Error('le plugin a EMIS un paquet'); };
  return { write: interdire, end: interdire, send: interdire };
}

const PROTOCOLE_MUET = {
  types: { etape: 'hhf' },
  lireEtape: () => null,
  lireCarteAnnoncee: () => null,
  acteursContiennent: () => false,
};

function monter(options) {
  options = options || {};
  const routes = {};
  let tap = null;
  const plugin = createChasse({
    log: () => {},
    registerRoute: (m, p, h) => { routes[`${m} ${p}`] = h; },
    setPacketHandler: (fn) => { tap = fn; return true; },
    getGameChannel: canalInviolable,
    createProtocolLearn: () => ({ typeNameOf: () => null }),
    createChasseProtocol: () => Object.assign({}, PROTOCOLE_MUET, options.protocole || {}),
    createChasseIndices: options.indices ? () => options.indices : undefined,
    monde: options.monde || null,
  });
  const etat = (id) => routes['GET /api/chasse/etat'](null, { url: `/api/chasse/etat?accountId=${id}` });
  return { plugin, routes, etat, tap: (...a) => tap && tap(...a) };
}

// ─── Ce que le plugin expose ───────────────────────────────────────────────

test('le plugin se charge et n expose que la lecture', () => {
  const { plugin, routes } = monter();
  assert.strictEqual(plugin.actif, true);
  assert.ok(routes['GET /api/chasse/etat'], 'la route de lecture manque');
  assert.strictEqual(routes['POST /api/chasse/auto'], undefined,
    'la route d automatisation est encore la');
});

test('aucune route n est enregistree en ecriture', () => {
  const { routes } = monter();
  for (const cle of Object.keys(routes)) {
    assert.ok(cle.startsWith('GET '), `route non-GET exposee : ${cle}`);
  }
});

test('sans protocole injecte, le plugin se desactive au lieu de planter', () => {
  const plugin = createChasse({ log: () => {}, registerRoute: () => {} });
  assert.strictEqual(plugin.actif, false);
});

// ─── L'absence d'émission ──────────────────────────────────────────────────

test('une session de chasse complete n emet rien', () => {
  const etapes = [
    { genre: 'aller', direction: 2, indice: 927 },
    { genre: 'aller', direction: 0, indice: 965 },
    { genre: 'fouille' },
  ];
  let i = 0;
  const { tap } = monter({
    protocole: {
      lireEtape: () => (i < etapes.length ? etapes[i++] : null),
      lireCarteAnnoncee: () => ({ mapId: 88081670 }),
    },
  });
  // Cinquante paquets entrants : c'est là que l'ancienne version décidait
  // d'agir. La moindre écriture ferait throw le canal.
  for (let n = 0; n < 50; n++) tap(1, 'in', 42, Buffer.from([n & 0xff]));
});

test('les paquets sortants ne sont meme pas regardes', () => {
  // La position vient de ce que le SERVEUR annonce : une demande du client
  // peut être refusée, une annonce jamais.
  let lus = 0;
  const { tap, etat } = monter({
    protocole: { lireCarteAnnoncee: () => { lus++; return { mapId: 7 }; } },
  });
  tap(1, 'out', 42, Buffer.from([1]));
  assert.strictEqual(lus, 0, 'un paquet sortant a ete decode');
  assert.strictEqual(etat(1).mapId, null);
});

test('un paquet illisible ne coupe pas le trafic', () => {
  const { tap } = monter({
    protocole: {
      lireEtape: () => { throw new Error('paquet corrompu'); },
      lireCarteAnnoncee: () => { throw new Error('idem'); },
      acteursContiennent: () => { throw new Error('idem'); },
    },
  });
  tap(1, 'in', 42, Buffer.from([1, 2, 3]));   // ne doit pas lever
});

// ─── Ce que l'overlay lit ──────────────────────────────────────────────────

test('la position vient du graphe, pas du paquet', () => {
  const { tap, etat } = monter({
    protocole: { lireCarteAnnoncee: () => ({ mapId: 88081670 }) },
    monde: { coords: () => ({ x: 3, y: 17, monde: 1 }), nomDirection: () => 'nord', itineraire: () => null },
  });
  tap(1, 'in', 42, Buffer.from([1]));
  const e = etat(1);
  assert.strictEqual(e.mapId, 88081670);
  assert.strictEqual(e.x, 3);
  assert.strictEqual(e.y, 17);
});

test('sans cible il n y a pas de commande a copier', () => {
  const e = monter().etat(1);
  assert.strictEqual(e.travel, null);
  assert.strictEqual(e.cible, null);
});

test('un accountId absent est refuse proprement', () => {
  const { routes } = monter();
  const r = routes['GET /api/chasse/etat'](null, { url: '/api/chasse/etat' });
  assert.ok(r.error, 'un appel sans accountId doit expliquer ce qui manque');
});

test('l etat dit ce qui manque plutot que de rester muet', () => {
  const e = monter().etat(1);
  assert.strictEqual(e.protocoleConnu, true);
  assert.strictEqual(e.resolveur, false, 'aucun resolveur injecte');
  assert.strictEqual(e.graphe, false, 'aucun graphe injecte');
  assert.strictEqual(e.tap, true);
});

// ─── Le phorreur ───────────────────────────────────────────────────────────

test('un phorreur n a pas de travel, seulement une direction', async () => {
  const { tap, etat } = monter({
    protocole: {
      lireEtape: () => ({
        drapeaux: [{ valide: true, mapId: 88081665 }],
        etapes: [{ genre: 'aller', direction: 6, indice: 2673 }],
        etapeNum: 0, etapesTotal: 5,
      }),
      lireCarteAnnoncee: () => ({ mapId: 88081670 }),
      acteursContiennent: () => false,
    },
    monde: { coords: () => ({ x: 3, y: 22 }), nomDirection: () => 'nord', itineraire: () => null },
    indices: {
      estPhorreur: async () => ({ nom: 'Phorreur méfiant' }),
      resoudre: async () => { throw new Error('un phorreur ne doit pas etre resolu en carte'); },
    },
  });
  tap(1, 'in', 42, Buffer.from([1]));
  await new Promise(r => setImmediate(r));
  const e = etat(1);
  assert.strictEqual(e.phorreur, 'Phorreur méfiant');
  assert.strictEqual(e.travel, null, 'aucune coordonnee ne designe un phorreur mobile');
  assert.strictEqual(e.directionNom, 'nord');
  assert.strictEqual(e.phorreurIci, false);
});

test('ICI ne s affiche que si le phorreur est vu dans les acteurs', async () => {
  let vu = false;
  const { tap, etat } = monter({
    protocole: {
      lireEtape: () => ({
        drapeaux: [{ valide: true, mapId: 88081665 }],
        etapes: [{ genre: 'aller', direction: 6, indice: 2673 }],
        etapeNum: 0, etapesTotal: 5,
      }),
      lireCarteAnnoncee: () => ({ mapId: 88081670 }),
      acteursContiennent: () => vu,
    },
    monde: { coords: () => ({ x: 3, y: 22 }), nomDirection: () => 'nord', itineraire: () => null },
    indices: { estPhorreur: async () => ({ nom: 'Phorreur rusé' }), resoudre: async () => null },
  });
  tap(1, 'in', 42, Buffer.from([1]));
  await new Promise(r => setImmediate(r));
  assert.strictEqual(etat(1).phorreurIci, false, 'annonce sans l avoir vu');
  vu = true;
  tap(1, 'in', 42, Buffer.from([2]));
  assert.strictEqual(etat(1).phorreurIci, true);
});

test('un indice ordinaire ne declenche jamais la recherche d acteurs', async () => {
  // Le garde-fou du faux positif : chercher un identifiant quelconque dans
  // l'arbre des acteurs ferait afficher « ICI » sur une coincidence.
  let cherche = 0;
  const { tap } = monter({
    protocole: {
      lireEtape: () => ({
        drapeaux: [{ valide: true, mapId: 88081665 }],
        etapes: [{ genre: 'aller', direction: 0, indice: 927 }],
        etapeNum: 0, etapesTotal: 5,
      }),
      lireCarteAnnoncee: () => ({ mapId: 88081670 }),
      acteursContiennent: () => { cherche++; return true; },
    },
    monde: { coords: () => ({ x: 2, y: 9 }), nomDirection: () => 'est', itineraire: () => null },
    indices: { estPhorreur: async () => null, resoudre: async () => null },
  });
  tap(1, 'in', 42, Buffer.from([1]));
  await new Promise(r => setImmediate(r));
  tap(1, 'in', 42, Buffer.from([2]));
  assert.strictEqual(cherche, 0, 'les acteurs ont ete fouilles pour un POI fixe');
});

// ─── La cible et la commande ───────────────────────────────────────────────

test('l etape courante est lue dans la liste, pas a la racine', async () => {
  // Le defaut mesure en jeu : 4 evenements lus, 0 etape affichee, parce que
  // `genre`/`direction`/`indice` etaient cherches a la racine de l'evenement.
  const { tap, etat } = monter({
    protocole: {
      lireEtape: () => ({
        depart: 88085249,
        drapeaux: [{ valide: true, mapId: 88081665 }],
        etapes: [
          { genre: 'aller', direction: 0, indice: 927 },
          { genre: 'aller', direction: 6, indice: 965 },
        ],
        etapeNum: 1, etapesTotal: 5,
      }),
      lireCarteAnnoncee: () => ({ mapId: 100 }),
      acteursContiennent: () => false,
    },
    monde: {
      coords: (m) => (m === 88081665 ? { x: 3, y: 22 } : { x: 5, y: 20 }),
      nomDirection: () => 'nord',
      itineraire: () => [{ map: 1 }, { map: 2 }],
    },
    indices: { estPhorreur: async () => null, resoudre: async () => null },
  });
  tap(1, 'in', 42, Buffer.from([1]));
  await new Promise(r => setImmediate(r));
  const e = etat(1);
  assert.strictEqual(e.indice, 965, 'le dernier indice revele n est pas retenu');
  assert.strictEqual(e.direction, 6);
  assert.strictEqual(e.etape, 'aller');
  assert.strictEqual(e.origine, 88081665, 'l origine n est pas le dernier drapeau');
  assert.strictEqual(e.etapesTotal, 5);
});

test('l indice est resolu depuis l origine, pas depuis le joueur', async () => {
  // Le joueur est en [5,20] ; l'etape part du drapeau, en [3,22]. Resoudre
  // depuis sa position chercherait l'indice au mauvais endroit.
  const vus = [];
  const { tap } = monter({
    protocole: {
      lireEtape: () => ({
        depart: 88085249,
        drapeaux: [{ valide: true, mapId: 88081665 }],
        etapes: [{ genre: 'aller', direction: 6, indice: 965 }],
        etapeNum: 0, etapesTotal: 5,
      }),
      lireCarteAnnoncee: () => ({ mapId: 100 }),
      acteursContiennent: () => false,
    },
    monde: {
      coords: (m) => (m === 88081665 ? { x: 3, y: 22 } : { x: 5, y: 20 }),
      nomDirection: () => 'nord',
      itineraire: () => null,
    },
    indices: {
      estPhorreur: async () => null,
      resoudre: async (x, y) => { vus.push(`${x},${y}`); return null; },
    },
  });
  tap(1, 'in', 42, Buffer.from([1]));
  await new Promise(r => setImmediate(r));
  assert.ok(vus.includes('3,22'), `resolu depuis ${vus.join(' / ')} au lieu de l origine 3,22`);
  assert.ok(!vus.includes('5,20'), 'resolu depuis la position du joueur');
});

test('une cible resolue donne le travel et le compte de cartes', async () => {
  const { tap, etat } = monter({
    protocole: {
      lireEtape: () => ({
        drapeaux: [{ valide: true, mapId: 88081665 }],
        etapes: [{ genre: 'aller', direction: 0, indice: 927 }],
        etapeNum: 0, etapesTotal: 5,
      }),
      lireCarteAnnoncee: () => ({ mapId: 100 }),
      acteursContiennent: () => false,
    },
    monde: {
      coords: () => ({ x: 2, y: 9 }),
      nomDirection: () => 'est',
      itineraire: () => [{ map: 101 }, { map: 102 }, { map: 103 }, { map: 104 }, { map: 200 }],
    },
    indices: {
      estPhorreur: async () => null,
      resoudre: async () => ({ map: 200, x: 7, y: 9, nom: 'Panneau' }),
    },
  });
  tap(1, 'in', 42, Buffer.from([1]));
  await new Promise(r => setImmediate(r));
  const e = etat(1);
  assert.strictEqual(e.travel, '/travel 7,9');
  assert.strictEqual(e.cartes, 5, 'le compte vient du graphe, pas des coordonnees');
  assert.strictEqual(e.cible.nom, 'Panneau');
});

test('une etape relue ne relance pas la resolution', async () => {
  // Le serveur renvoie l'état complet à chaque drapeau : sans ce garde, chaque
  // renvoi coûterait un appel réseau et ferait clignoter l'overlay.
  let appels = 0;
  const { tap } = monter({
    protocole: {
      lireEtape: () => ({
        drapeaux: [{ valide: true, mapId: 88081665 }],
        etapes: [{ genre: 'aller', direction: 0, indice: 927 }],
        etapeNum: 0, etapesTotal: 5,
      }),
      lireCarteAnnoncee: () => ({ mapId: 100 }),
      acteursContiennent: () => false,
    },
    monde: { coords: () => ({ x: 2, y: 9 }), nomDirection: () => 'est', itineraire: () => null },
    indices: {
      estPhorreur: async () => { appels++; return null; },
      resoudre: async () => null,
    },
  });
  tap(1, 'in', 42, Buffer.from([1]));
  await new Promise(r => setImmediate(r));
  const apresPremier = appels;
  assert.strictEqual(apresPremier, 1, 'la premiere etape doit etre resolue une fois');

  for (let n = 0; n < 5; n++) tap(1, 'in', 42, Buffer.from([n]));
  await new Promise(r => setImmediate(r));
  assert.strictEqual(appels, apresPremier, `${appels - apresPremier} resolutions de trop`);
});

(async () => {
  for (const cas of file) await cas();
  console.log(`\n${passed} test(s) OK`);
})();
