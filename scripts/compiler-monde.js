'use strict';

/**
 * compiler-monde.js — compile le graphe du monde en table de déplacement.
 *
 * Se déplacer de carte en carte est le prérequis de la chasse au trésor : un
 * indice dit « va vers le sud », et il faut savoir quelle carte est au sud, et
 * par quelle case on y sort.
 *
 * Ces deux réponses, Ankama les publie lui-même. Le client Unity embarque un
 * `world-graph` — sommets, arêtes, transitions — que `krm35/dofus-multi`
 * extrait tel quel dans son cache. On ne devine donc rien : chaque arête donne
 * la carte de départ, la carte d'arrivée, la direction, et la CASE par
 * laquelle sortir.
 *
 *     m_direction  0=est 1=sud-est 2=sud 3=sud-ouest
 *                  4=ouest 5=nord-ouest 6=nord 7=nord-est   (255 = sans direction)
 *     m_cellId     la case à atteindre pour déclencher le changement
 *     m_criterion  une condition à remplir (quête, objet…) — souvent vide
 *
 * Deux sources sont fusionnées :
 *   `world-graph.json`  56 Mo, 10901 sommets, 10829 groupes d'arêtes
 *   `maps.json`         15223 cartes → [x, y, sousZone, zone, ?, monde]
 *
 * ═══ Une approximation, et pourquoi elle est acceptable ══════════════════
 *
 * Les sommets portent une `zoneId` : une même carte peut être découpée en
 * zones qui ne communiquent pas entre elles, et une transition partant d'une
 * zone où l'on ne se trouve pas est inatteignable. On agrège malgré tout par
 * carte, en gardant TOUTES les cases de sortie plutôt qu'une seule : le moteur
 * essaiera la plus proche, et une case inatteignable se solde par un
 * déplacement qui n'aboutit pas — détectable, et sans conséquence. Distinguer
 * les zones demanderait de savoir dans laquelle on est, ce que le serveur ne
 * dit pas directement.
 *
 * Les transitions conditionnelles sont conservées avec leur critère, à charge
 * du moteur de les éviter tant qu'il ne sait pas les évaluer.
 *
 *   node scripts/compiler-monde.js [world-graph.json] [maps.json]
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const RACINE = path.join(__dirname, '..');
const CACHE = path.join(RACINE, 'cache');
const SORTIE = path.join(RACINE, 'lib', 'monde.json.gz');

const SANS_DIRECTION = 255;

function compiler(graphe, cartes) {
  // mapId -> { d: { direction: [ [mapCible, cellule, critère?] ] } }
  const sorties = {};
  const aretes = graphe.m_edges && graphe.m_edges.m_values && graphe.m_edges.m_values.Array;
  if (!aretes) throw new Error('world-graph : m_edges introuvable');

  let nbTransitions = 0, nbConditionnelles = 0, nbSansDirection = 0;

  for (const groupe of aretes) {
    const liste = (groupe.m_values && groupe.m_values.Array) || [];
    for (const arete of liste) {
      const depuis = arete.m_from && arete.m_from.m_mapId;
      const vers = arete.m_to && arete.m_to.m_mapId;
      if (!Number.isInteger(depuis) || !Number.isInteger(vers)) continue;

      for (const t of (arete.m_transitions && arete.m_transitions.Array) || []) {
        const dir = t.m_direction;
        if (dir === SANS_DIRECTION || !Number.isInteger(dir) || dir < 0 || dir > 7) {
          nbSansDirection++;
          continue; // zaaps, portes, téléporteurs : hors du champ d'une chasse
        }
        const critere = typeof t.m_criterion === 'string' ? t.m_criterion.trim() : '';
        const cell = Number.isInteger(t.m_cellId) ? t.m_cellId : -1;
        if (cell < 0) continue;

        const parMap = sorties[depuis] || (sorties[depuis] = {});
        const parDir = parMap[dir] || (parMap[dir] = []);
        // Une même sortie revient d'une zone à l'autre : on ne la garde
        // qu'une fois, sinon le moteur essaierait deux fois la même case.
        if (parDir.some(e => e[0] === vers && e[1] === cell)) continue;
        parDir.push(critere ? [vers, cell, critere] : [vers, cell]);
        nbTransitions++;
        if (critere) nbConditionnelles++;
      }
    }
  }

  // mapId -> [x, y, monde] ; le reste de maps.json (sous-zone, zone) ne sert
  // pas à la navigation et pèserait pour rien.
  const coords = {};
  for (const [id, v] of Object.entries(cartes || {})) {
    if (!Array.isArray(v) || v.length < 6) continue;
    coords[id] = [v[0], v[1], v[5]];
  }

  return {
    table: { sorties, coords },
    stats: { nbTransitions, nbConditionnelles, nbSansDirection,
      cartesAvecSortie: Object.keys(sorties).length, cartesSituees: Object.keys(coords).length },
  };
}

if (require.main === module) {
  const cheminGraphe = process.argv[2] || path.join(CACHE, 'world-graph.json');
  const cheminCartes = process.argv[3] || path.join(CACHE, 'maps.json');
  for (const f of [cheminGraphe, cheminCartes]) {
    if (!fs.existsSync(f)) {
      console.error(`Introuvable : ${f}`);
      console.error('Usage : node scripts/compiler-monde.js [world-graph.json] [maps.json]');
      process.exit(1);
    }
  }

  const { table, stats } = compiler(
    JSON.parse(fs.readFileSync(cheminGraphe, 'utf8')),
    JSON.parse(fs.readFileSync(cheminCartes, 'utf8')));

  const brut = Buffer.from(JSON.stringify(table), 'utf8');
  fs.writeFileSync(SORTIE, zlib.gzipSync(brut, { level: 9 }));

  console.log(`${stats.cartesAvecSortie} cartes avec au moins une sortie, ` +
    `${stats.nbTransitions} transitions directionnelles`);
  console.log(`  dont ${stats.nbConditionnelles} conditionnelles`);
  console.log(`  ${stats.nbSansDirection} transitions sans direction écartées (zaaps, portes)`);
  console.log(`${stats.cartesSituees} cartes situées en coordonnées`);
  console.log(`-> ${path.relative(process.cwd(), SORTIE)} ` +
    `(${Math.round(fs.statSync(SORTIE).size / 1024)} ko gzip, ${Math.round(brut.length / 1024)} ko en clair)`);
}

module.exports = { compiler, SANS_DIRECTION };
