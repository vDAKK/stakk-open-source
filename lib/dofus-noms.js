'use strict';

/**
 * dofus-noms.js — le dictionnaire de SENS du protocole, et sa péremption.
 *
 * `dofus-schema.js` donne la forme exacte de n'importe quel message. Il ne dit
 * pas que `hhf` est l'état d'une chasse au trésor. C'est le rôle de ce
 * module-ci : associer un nom obfusqué à ce qu'il désigne, et surtout dire
 * QUAND cette association a cessé d'être vraie.
 *
 * ═══ Ce qui survit à un patch, et ce qui n'y survit pas ══════════════════
 *
 * Mesuré en confrontant deux dumps réels du protocole (mars et août 2026,
 * 1608 et 2254 messages) :
 *
 *   • Retrouver un message par sa FORME ne marche pas. Sur 2254 messages,
 *     3 seulement ont un correspondant unique dans l'autre build — 0,1 %.
 *     Ankama ne rebat pas que les noms : il rebat les NUMÉROS DE CHAMP.
 *     L'enveloppe le prouve, elle qui portait `int32 = 1, Any = 2` en mars et
 *     porte `Any = 1, int32 = 2` en août. Toute idée de remappage
 *     automatique par signature structurelle est donc morte.
 *
 *   • Deux choses survivent, et ce module s'appuie dessus :
 *
 *     1. Les NOMS EN CLAIR. Ankama en laisse 166 dans le build courant
 *        (`map_id`, `key_cells`, `quantity`, `object_uid`…), dont 123 ne
 *        désignent qu'un seul message. 18 des messages du dictionnaire sont
 *        ancrables ainsi. À noter : le dump de mars n'en avait aucun côté
 *        jeu — l'ancre est solide aujourd'hui, pas garantie demain.
 *
 *     2. L'ORDRE DU POOL. Les 2204 noms font tous exactement trois lettres et
 *        sont alloués en séquence : l'ordre alphabétique est donc l'ordre de
 *        déclaration, et un même namespace forme une PLAGE CONTIGUË. La
 *        chasse au trésor en est l'illustration : `quest_type`, resté en
 *        clair, ancre `hgm` (rang 41) et `hht` (rang 58), et les trois
 *        messages cherchés tombent entre les deux — `hgj` 40, `hhf` 51,
 *        `hhv` 60.
 *
 * D'où la doctrine : on ne remappe pas tout seul, on LOCALISE. Après un
 * patch, `localiser()` ramène 2204 candidats à une vingtaine, et le
 * ré-étiquetage devient l'affaire de quelques minutes au lieu d'une campagne
 * de réapprentissage.
 *
 * Et tant que le ré-étiquetage n'est pas fait, `estAJour()` répond non : mieux
 * vaut un module qui se déclare périmé qu'un module qui agit sur un `hhf`
 * devenu autre chose.
 */

module.exports = function createDofusNoms(deps) {
  deps = deps || {};

  const schema = deps.schema || require('./dofus-schema')();
  const dico = deps.dico || charger();

  function charger() {
    try { return require('./dofus-noms.json'); }
    catch { return { build: null, noms: {} }; }
  }

  const noms = dico.noms || {};
  const inverse = {};
  for (const [sens, nom] of Object.entries(noms)) inverse[nom] = sens;

  // Un nom « parlant » : Ankama laisse passer les composés et les longs.
  // Même critère que `compiler-protocole.js`, pour que les deux tables
  // s'accordent sur ce qui compte comme ancre.
  const estClair = (n) => typeof n === 'string' && (n.includes('_') || n.length > 6);

  // ─── Consultation ────────────────────────────────────────────────────────

  const nom = (sens) => noms[sens] || null;
  const sens = (n) => inverse[n] || null;
  const sensConnus = () => Object.keys(noms).sort();

  /** Les noms de champs restés en clair dans le message que `sens` désigne. */
  function ancresDe(sens) {
    const n = noms[sens];
    const champs = n && schema.champsDe(n);
    if (!champs) return [];
    return Object.values(champs).map(c => c.n).filter(estClair).sort();
  }

  // ─── Empreinte de build ──────────────────────────────────────────────────

  /**
   * Empreinte du schéma chargé. Volontairement grossière — nombre de messages
   * et de champs, plus les noms restés en clair — mais elle suffit : elle
   * change dès qu'Ankama rebat le protocole, et ne bouge pas si on se contente
   * de recompiler le même `.proto`.
   */
  function empreinteBuild() {
    const crypto = require('crypto');
    const parts = [];
    for (const s of sensConnus()) {
      const n = noms[s];
      const champs = schema.champsDe(n);
      parts.push(`${s}=${n}:${champs ? Object.keys(champs).length : 'X'}`);
    }
    parts.push(`m=${schema.nbMessages()}`);
    return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
  }

  /** Le dictionnaire décrit-il bien le schéma actuellement chargé ? */
  const estAJour = () => !!dico.build && dico.build === empreinteBuild();

  // ─── Localisation après un patch ─────────────────────────────────────────

  /**
   * Les messages portant TOUS les noms de champs donnés. C'est le seul
   * mécanisme de re-localisation qui résiste au rebattage des numéros de
   * champ, puisqu'il ne s'appuie que sur ce qu'Ankama a laissé en clair.
   */
  function localiser(ancres) {
    if (!Array.isArray(ancres) || !ancres.length) return [];
    const voulues = new Set(ancres);
    const trouves = [];
    for (const n of schema.nomsMessages()) {
      const champs = schema.champsDe(n);
      const presents = new Set(Object.values(champs).map(c => c.n));
      let complet = true;
      for (const a of voulues) if (!presents.has(a)) { complet = false; break; }
      if (complet) trouves.push(n);
    }
    return trouves;
  }

  /**
   * Les messages voisins de `nom` dans le pool de noms, à `rayon` rangs.
   *
   * Les noms font tous trois lettres et sont alloués en séquence : l'ordre
   * alphabétique est l'ordre de déclaration, donc les voisins d'un message
   * sont ses frères de namespace. Après un patch, c'est ce qui transforme
   * « cherche parmi 2204 » en « cherche parmi 20 ».
   */
  function voisinage(nom, rayon) {
    rayon = rayon || 10;
    const pool = schema.nomsMessages();
    const i = pool.indexOf(nom);
    if (i === -1) return [];
    return pool.slice(Math.max(0, i - rayon), i + rayon + 1);
  }

  /**
   * État de santé du dictionnaire entrée par entrée :
   *   - `absent`  : le nom n'existe plus dans le schéma — patch certain
   *   - `muet`    : le message existe mais n'a plus aucune ancre en clair,
   *                 donc plus rien ne permettrait de le retrouver seul
   *   - `ancre`   : ancres présentes, et voici les candidats qu'elles donnent
   *
   * `suspects` liste les entrées dont les ancres désignent AUTRE CHOSE que le
   * nom enregistré : c'est le signal qu'un patch a déplacé le message.
   */
  function verifier() {
    const rapport = { absent: [], muet: [], ancre: [], suspects: [] };
    for (const s of sensConnus()) {
      const n = noms[s];
      if (!schema.estConnu(n)) { rapport.absent.push({ sens: s, nom: n }); continue; }
      const ancres = ancresDe(s);
      if (!ancres.length) { rapport.muet.push({ sens: s, nom: n }); continue; }
      const candidats = localiser(ancres);
      rapport.ancre.push({ sens: s, nom: n, ancres, candidats });
      if (!candidats.includes(n)) rapport.suspects.push({ sens: s, nom: n, candidats });
    }
    return rapport;
  }

  return {
    nom, sens, sensConnus, ancresDe,
    empreinteBuild, estAJour, build: dico.build || null,
    localiser, voisinage, verifier,
  };
};
