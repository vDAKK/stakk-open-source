'use strict';
/**
 * Chargeur local des plugins (lib/plugins.js) : sélection via plugins.json,
 * plugins utilisateur déposés dans plugins/, isolation des erreurs.
 *
 *   node test/plugins-loader.test.js
 *
 * Les plugins intégrés sont tous désactivés dans ces scénarios : les charger
 * pour de vrai démarrerait leurs timers et leurs process annexes.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;
const pending = [];
function test(name, fn) {
  pending.push(Promise.resolve().then(fn).then(
    () => { passed++; console.log(`  ok  ${name}`); },
    e => { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }));
}

// Chaque scénario a son propre module frais : l'état exposé par getStatus()
// est global au module.
function freshLoader() {
  delete require.cache[require.resolve('../lib/plugins')];
  return require('../lib/plugins');
}

function makeRoot({ selection, userPlugins = {} }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stakk-plugins-'));
  if (selection) fs.writeFileSync(path.join(root, 'plugins.json'), JSON.stringify(selection));
  if (Object.keys(userPlugins).length) {
    fs.mkdirSync(path.join(root, 'plugins'));
    for (const [name, src] of Object.entries(userPlugins)) {
      fs.writeFileSync(path.join(root, 'plugins', name + '.js'), src);
    }
  }
  return root;
}

const silent = () => {};

console.log('chargeur de plugins');

test('un plugin utilisateur reçoit la deps bag et ses routes sont enregistrées', async () => {
  const loader = freshLoader();
  const root = makeRoot({
    selection: { disabled: Object.keys(loader.BUILTIN) },
    userPlugins: {
      hello: `module.exports = (deps) => { deps.registerRoute('GET', '/api/hello', () => ({ hi: 1 })); return { ok: true }; };`,
    },
  });
  const routes = {};
  const deps = { registerRoute: (m, p, h) => { routes[`${m} ${p}`] = h; } };
  const results = await loader.loadPlugins(deps, { appRoot: root, log: silent });
  const hello = results.find(r => r.name === 'hello');
  assert.deepStrictEqual(hello.result, { ok: true });
  assert.deepStrictEqual(routes['GET /api/hello'](), { hi: 1 });
  assert.deepStrictEqual(loader.getStatus().plugins.hello, { source: 'user', status: 'loaded' });
});

test('les plugins désactivés ne sont pas chargés', async () => {
  const loader = freshLoader();
  const root = makeRoot({
    selection: { disabled: [...Object.keys(loader.BUILTIN), 'hello'] },
    userPlugins: { hello: `throw new Error('ne doit pas être évalué');` },
  });
  const results = await loader.loadPlugins({}, { appRoot: root, log: silent });
  assert.strictEqual(results.length, 0);
  const st = loader.getStatus().plugins;
  assert.strictEqual(st.hello.status, 'disabled');
  assert.strictEqual(st.fm.status, 'disabled');
});

test('un plugin en échec n\'empêche pas les suivants de charger', async () => {
  const loader = freshLoader();
  const root = makeRoot({
    selection: { disabled: Object.keys(loader.BUILTIN) },
    userPlugins: {
      a_casse: `module.exports = () => { throw new Error('boum'); };`,
      b_pas_factory: `module.exports = { pas: 'une fonction' };`,
      c_ok: `module.exports = () => 42;`,
    },
  });
  const results = await loader.loadPlugins({}, { appRoot: root, log: silent });
  const st = loader.getStatus().plugins;
  assert.strictEqual(st.a_casse.status, 'error');
  assert.match(st.a_casse.error, /boum/);
  assert.strictEqual(st.b_pas_factory.status, 'error');
  assert.strictEqual(st.c_ok.status, 'loaded');
  assert.strictEqual(results.find(r => r.name === 'c_ok').result, 42);
});

test('un plugin utilisateur remplace le plugin intégré du même nom', async () => {
  const loader = freshLoader();
  const root = makeRoot({
    selection: { disabled: Object.keys(loader.BUILTIN).filter(n => n !== 'organizer') },
    userPlugins: { organizer: `module.exports = () => 'perso';` },
  });
  const results = await loader.loadPlugins({}, { appRoot: root, log: silent });
  assert.strictEqual(results.find(r => r.name === 'organizer').result, 'perso');
  assert.strictEqual(loader.getStatus().plugins.organizer.source, 'user');
});

test('un plugins.json illisible retombe sur la sélection par défaut', async () => {
  const loader = freshLoader();
  const root = makeRoot({});
  fs.writeFileSync(path.join(root, 'plugins.json'), '{ pas du json');
  fs.mkdirSync(path.join(root, 'plugins'));
  fs.writeFileSync(path.join(root, 'plugins', 'seul.js'), `module.exports = () => 'ok';`);
  // On ne lance pas les intégrés : on vérifie seulement que le parse raté ne
  // fait pas tomber le chargement, via un plugin utilisateur isolé.
  const real = loader.BUILTIN;
  for (const k of Object.keys(real)) real[k] = () => () => null;
  const results = await loader.loadPlugins({}, { appRoot: root, log: silent });
  assert.strictEqual(results.find(r => r.name === 'seul').result, 'ok');
  assert.strictEqual(loader.getStatus().plugins.fm.status, 'loaded');
});

Promise.all(pending).then(() => {
  console.log(`\n${passed}/${pending.length} tests OK`);
});
