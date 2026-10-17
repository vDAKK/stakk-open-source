'use strict';

/**
 * Exemple de plugin STAKK.
 *
 * Copie ce fichier dans le dossier `plugins/` à côté de stakk.exe (ou à la
 * racine du dépôt en dev), puis relance STAKK. Il apparaît dans le panneau
 * « Modules » (clic sur le numéro de version, en haut à gauche).
 *
 * Il compte les lancements par compte et expose le résultat sur
 *   GET http://localhost:3000/api/launch-log
 *
 * Un plugin exporte une factory qui reçoit la « deps bag » de STAKK. Les plus
 * utiles :
 *   on(event, handler)        launch | detach | ready | accounts-imported
 *   registerRoute(m, p, fn)   route HTTP ; fn(body, req) → objet sérialisé en JSON
 *   log(msg)                  ligne dans l'onglet Logs
 *   loadAccounts()            comptes de release/data
 *   setPacketHandler(fn)      tap sur les paquets du jeu (Dofus 3)
 *   fs, path, os, crypto, net, http, https, spawn, frida
 * La liste complète est dans getPluginApi() (lib/web-server.js).
 *
 * Un plugin ne require() que des modules natifs de Node : tout le reste
 * arrive par la deps bag.
 */

module.exports = function createLaunchLog({ on, registerRoute, log, loadAccounts }) {
  const launches = {}; // accountId → nombre de lancements depuis le démarrage

  on('launch', ({ accountId, gameKey }) => {
    launches[accountId] = (launches[accountId] || 0) + 1;
    log(`[launch-log] ${accountId} → ${gameKey} (${launches[accountId]}e lancement)`);
  });

  registerRoute('GET', '/api/launch-log', () => {
    const logins = new Map(loadAccounts().map(a => [a.accountId, a.login]));
    return Object.entries(launches).map(([id, count]) => ({
      accountId: Number(id),
      login: logins.get(Number(id)) || null,
      count,
    }));
  });

  return {};
};
