#!/usr/bin/env node
'use strict';

/**
 * recalibrer-inventaire.js — état et remise à zéro des numéros de champs
 * d'inventaire appris par la forgemagie.
 *
 * ── À quoi ça sert ────────────────────────────────────────────────────────
 * STAKK ne dispose d'aucun schéma protobuf : il lit les paquets d'inventaire
 * en s'ancrant sur les gid Dofus qu'il connaît, ce qui lui donne les NUMÉROS
 * DE CHAMPS du gid, de l'identifiant de pile et de la quantité. Ce mapping est
 * appris tout seul, rangé dans ~/.stakk/fm-fields-<compte>.json, et invalidé
 * automatiquement dès qu'il cesse de concorder avec le trafic.
 *
 * Ce script n'est donc PAS un passage obligé. Il sert à regarder ce que STAKK
 * a retenu, et à forcer un réapprentissage quand un patch Dofus a tout rebattu
 * et qu'on ne veut pas attendre l'invalidation automatique.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────
 *   node recalibrer-inventaire.js                 état de tous les comptes
 *   node recalibrer-inventaire.js 42              état du compte 42
 *   node recalibrer-inventaire.js --reset         remet tous les comptes à zéro
 *   node recalibrer-inventaire.js --reset 42      remet le compte 42 à zéro
 *   node recalibrer-inventaire.js --aide          ce texte
 *
 * ── Lancement pendant que STAKK tourne ────────────────────────────────────
 * Sans danger : la lecture ne touche à rien, et STAKK écrit ses fichiers par
 * renommage atomique (jamais de JSON tronqué sous les yeux du script).
 *
 * En revanche `--reset` efface le fichier, pas la mémoire du processus en
 * cours : STAKK garde le mapping qu'il a déjà en tête jusqu'à ce qu'il le
 * recharge, c'est-à-dire au prochain démarrage de STAKK (ou, si le compte
 * n'était pas encore observé, au prochain armement de l'atelier). Pour un
 * réapprentissage immédiat : lancer --reset puis redémarrer STAKK.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const STAKK_DIR = path.join(os.homedir(), '.stakk');
const FILE_RE = /^fm-fields-(.+)\.json$/;

// Le décodeur est le même que celui de STAKK : la concordance vérifiée ici est
// exactement celle que le transport applique.
let protocol = null;
try { protocol = require('./lib/fm-protocol')(); }
catch (e) { console.error(`fm-protocol illisible (${e.message}) — vérification impossible`); }

// L'aide est le commentaire de tête : une seule source, jamais désynchronisée.
function usage() {
  const src = fs.readFileSync(__filename, 'utf8');
  const block = src.slice(src.indexOf('/**') + 3, src.indexOf('*/'));
  console.log(block.split(/\r?\n/).map(l => l.replace(/^\s*\* ?/, '')).join('\n').trim());
}

function listAccounts() {
  let names = [];
  try { names = fs.readdirSync(STAKK_DIR); } catch { return []; }
  return names
    .map(n => FILE_RE.exec(n))
    .filter(Boolean)
    .map(m => m[1])
    .sort();
}

function readState(accountId) {
  const file = path.join(STAKK_DIR, `fm-fields-${accountId}.json`);
  try { return { file, state: JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch (e) { return { file, error: e.message }; }
}

/**
 * Le mapping colle-t-il encore ?
 *
 * On rejoue le repérage des triplets sur le dernier message concordant que
 * STAKK a conservé, avec les gid qui avaient servi à l'apprentissage. Si tous
 * les objets qu'on y retrouve désignent bien le gid et l'identifiant aux
 * numéros retenus, le mapping tient. Sinon, il faut le réapprendre.
 */
function checkConcordance(state) {
  if (!protocol || typeof protocol.scanFieldCandidates !== 'function') return { verdict: 'inconnu', why: 'décodeur indisponible' };
  const map = protocol.normalizeFieldMap(state.map);
  if (!map) return { verdict: 'aucun', why: 'aucun mapping retenu' };
  if (!state.sample) return { verdict: 'inconnu', why: 'aucun message de référence conservé' };
  if (!state.gids || !state.gids.length) return { verdict: 'inconnu', why: 'aucun gid de référence conservé' };

  let buf;
  try { buf = Buffer.from(state.sample, 'hex'); }
  catch { return { verdict: 'inconnu', why: 'message de référence illisible' }; }

  const found = protocol.scanFieldCandidates(buf, state.gids);
  if (!found.length) return { verdict: 'non', why: 'plus aucun objet reconnaissable dans le message de référence' };

  const ok = found.filter(c => c.gidField === map.gid && c.uidField === map.uid).length;
  if (ok === found.length) return { verdict: 'oui', why: `${ok} objet(s) relu(s) aux mêmes numéros` };
  if (ok === 0) return { verdict: 'non', why: `${found.length} objet(s) relu(s) à d'autres numéros` };
  return { verdict: 'partiel', why: `${ok}/${found.length} objet(s) concordants` };
}

function show(accountId) {
  const { file, state, error } = readState(accountId);
  console.log(`\ncompte ${accountId}`);
  console.log(`  fichier      ${file}`);
  if (error) { console.log(`  état         illisible (${error})`); return; }

  const map = protocol && protocol.normalizeFieldMap
    ? protocol.normalizeFieldMap(state.map)
    : state.map;
  if (!map) {
    console.log('  mapping      aucun — STAKK lit encore à l\'heuristique (comportement de repli)');
  } else {
    console.log(`  mapping      gid=champ ${map.gid}, identifiant=champ ${map.uid}, `
      + `quantité=${map.qty == null ? 'indéterminée (repli heuristique)' : `champ ${map.qty}`}`);
  }
  console.log(`  appris sur   ${state.objects || 0} objet(s), ${state.packets || 0} message(s)`);
  if (state.savedAt) console.log(`  enregistré   ${state.savedAt}`);
  const c = checkConcordance(state);
  console.log(`  concordance  ${c.verdict} — ${c.why}`);
  if (c.verdict === 'non') {
    console.log('  → un patch Dofus a probablement rebattu les champs. '
      + `Relance : node recalibrer-inventaire.js --reset ${accountId}`);
  }
}

function reset(accountId) {
  const file = path.join(STAKK_DIR, `fm-fields-${accountId}.json`);
  try {
    fs.unlinkSync(file);
    console.log(`compte ${accountId} : mapping effacé (${file})`);
  } catch (e) {
    if (e.code === 'ENOENT') console.log(`compte ${accountId} : aucun mapping à effacer`);
    else console.error(`compte ${accountId} : effacement KO (${e.message})`);
  }
}

function main(argv) {
  if (argv.includes('--aide') || argv.includes('--help') || argv.includes('-h')) { usage(); return; }
  const doReset = argv.includes('--reset');
  const wanted = argv.filter(a => !a.startsWith('-'));
  const accounts = wanted.length ? wanted : listAccounts();

  if (!accounts.length) {
    console.log('aucun mapping de champs d\'inventaire enregistré '
      + `(rien qui corresponde à ${path.join(STAKK_DIR, 'fm-fields-*.json')}).`);
    console.log('C\'est normal avant la première session de forgemagie : '
      + 'STAKK apprend les numéros de champs tout seul en observant le trafic.');
    return;
  }

  if (doReset) {
    for (const a of accounts) reset(a);
    console.log('\nRedémarre STAKK pour que le réapprentissage reparte de zéro : '
      + 'un processus déjà lancé garde en mémoire le mapping qu\'il avait chargé.');
    return;
  }

  for (const a of accounts) show(a);
  console.log('\nPour forcer un réapprentissage : node recalibrer-inventaire.js --reset [compte]');
}

main(process.argv.slice(2));
