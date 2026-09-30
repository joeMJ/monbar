/**
 * Tests der Treiber (Checkmk, Uptime Kuma) mit einer HTTP-Attrappe statt echter
 * Server. Ausführen mit:  node --import ./tests/mock/register.mjs tests/drivers.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as tt from '../linux/src/targetTypes.js';
import * as u from '../linux/src/monUtil.js';
import { CheckmkClient } from '../linux/src/checkmkClient.js';
import { KumaClient } from '../linux/src/kumaClient.js';
import { setRoutes, calls } from './mock/http.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
tt.applyTargetTypes(tt.validateTargetDb(JSON.parse(readFileSync(join(root, 'linux/data/targets.json'), 'utf-8'))).db);

let count = 0;
const test = async (name, fn) => {
    try {
        await fn();
        count++;
    } catch (e) {
        console.error(`FEHLER in „${name}“:\n${e.stack}`);
        process.exit(1);
    }
};

const cmk = { ...u.makeTarget('checkmk'), id: 'tcmk00001', url: 'https://mon.lan', site: 'home', username: 'monbar' };
const all = { any: true, hosts: null, services: null, events: null };
const has = s => url => url.includes(s);
const query = url => JSON.parse(decodeURIComponent(url.split('query=')[1]));

const hostRows = { value: [{ extensions: { name: 'nas', state: 1, plugin_output: 'PING timeout' } }] };
const svcRows = { value: [{ extensions: { host_name: 'web', description: 'HTTPS', state: 2, state_type: 1, plugin_output: 'down' } }] };
const events = { value: [{ id: '5', extensions: { host: 'web', application: 'nginx', text: 'upstream timed out', state: 1, phase: 'open' } }] };

await test('Checkmk: Version v1 wird erkannt, Anmeldung per Bearer, alle drei Abfragen', async () => {
    setRoutes([
        { match: has('/api/v1/version'), json: { versions: { checkmk: '2.5.0p3' }, edition: 'cre' } },
        { match: has('/api/v1/domain-types/host/'), json: hostRows },
        { match: has('/api/v1/domain-types/service/'), json: svcRows },
        { match: has('/api/v1/domain-types/event_console/'), json: events },
    ]);
    const c = new CheckmkClient();
    const r = await c.fetchProblems(cmk, 's3cret', all, { hardOnly: true });
    assert.equal(r.ok, true);
    assert.deepEqual(r.problems.map(p => p.kind), ['host', 'service', 'event']);
    assert.equal(calls[0].headers.Authorization, 'Bearer monbar s3cret');
    assert.ok(calls[0].url.startsWith('https://mon.lan/home/check_mk/api/v1/'));
    const svcCall = calls.find(x => x.url.includes('/service/'));
    assert.deepEqual(query(svcCall.url).expr[1], { op: '=', left: 'state_type', right: '1' });
    // Version wird gemerkt
    await c.fetchProblems(cmk, 's3cret', all);
    assert.equal(calls.filter(x => x.url.endsWith('/version')).length, 1);
});

await test('Checkmk: ältere Version (1.0) wird automatisch genutzt', async () => {
    setRoutes([
        { match: has('/api/1.0/version'), json: { versions: { checkmk: '2.3.0p10' } } },
        { match: has('/api/1.0/domain-types/host/'), json: { value: [] } },
        { match: has('/api/1.0/domain-types/service/'), json: svcRows },
        { match: has('/api/1.0/domain-types/event_console/'), json: { value: [] } },
    ]);
    const c = new CheckmkClient();
    const t = await c.test(cmk, 'x');
    assert.equal(t.ok, true);
    assert.match(t.message, /2\.3\.0p10.*REST API 1\.0/);
    const r = await c.fetchProblems(cmk, 'x', all);
    assert.equal(r.problems.length, 1);
});

await test('Checkmk: falsches Secret → auth, falsche Instanz → notfound mit Hinweis', async () => {
    setRoutes([{ match: has('/version'), status: 401 }]);
    assert.equal((await new CheckmkClient().fetchProblems(cmk, 'x', all)).error, 'auth');
    setRoutes([]);
    const r = await new CheckmkClient().fetchProblems(cmk, 'x', all);
    assert.equal(r.error, 'notfound');
    assert.match(r.message, /Instanz/);
});

await test('Checkmk: Server lehnt state_type ab → ohne Filter erneut, nachgefiltert', async () => {
    setRoutes([
        { match: has('/version'), json: {} },
        { match: has('/domain-types/host/'), json: { value: [] } },
        { match: url => url.includes('/service/') && url.includes('state_type'), status: 400 },
        { match: has('/domain-types/service/'), json: { value: [
            { extensions: { host_name: 'a', description: 'weich', state: 2 } },
        ] } },
        { match: has('/event_console/'), json: { value: [] } },
    ]);
    const c = new CheckmkClient();
    const r = await c.fetchProblems(cmk, 'x', all, { hardOnly: true });
    assert.equal(r.ok, true);
    assert.equal(r.problems.length, 1);   // ohne state_type-Spalte bleibt die Meldung erhalten
    const svcCalls = calls.filter(x => x.url.includes('/service/'));
    assert.equal(svcCalls.length, 2);
    assert.ok(!svcCalls[1].url.includes('state_type'));
});

await test('Checkmk: ohne Event Console → Hinweis, danach nicht mehr abgefragt', async () => {
    setRoutes([
        { match: has('/version'), json: {} },
        { match: has('/domain-types/host/'), json: { value: [] } },
        { match: has('/domain-types/service/'), json: svcRows },
    ]);
    const c = new CheckmkClient();
    const r1 = await c.fetchProblems(cmk, 'x', all);
    assert.deepEqual(r1.notes, ['events-unsupported']);
    assert.equal(r1.problems.length, 1);
    const before = calls.length;
    await c.fetchProblems(cmk, 'x', all);
    assert.ok(!calls.slice(before).some(x => x.url.includes('event_console')));
});

await test('Checkmk: gezielte Abfrage nur abonnierter Server, Events eines Servers per ?host=', async () => {
    setRoutes([
        { match: has('/version'), json: {} },
        { match: has('/domain-types/'), json: { value: [] } },
    ]);
    const c = new CheckmkClient();
    await c.fetchProblems(cmk, 'x', { any: true, hosts: ['web', 'db'], services: ['web'], events: ['db'] });
    const h = calls.find(x => x.url.includes('/host/'));
    assert.equal(query(h.url).expr[1].op, 'or');
    const s = calls.find(x => x.url.includes('/service/'));
    assert.deepEqual(query(s.url).expr.at(-1), { op: '=', left: 'host_name', right: 'web' });
    assert.ok(calls.find(x => x.url.includes('event_console')).url.endsWith('?host=db'));
    // Nichts abonniert, was Dienste braucht → keine Dienst-Abfrage
    setRoutes([{ match: has('/version'), json: {} }, { match: has('/domain-types/'), json: { value: [] } }]);
    await c.fetchProblems(cmk, 'x', { any: true, hosts: ['web'], services: false, events: false });
    assert.deepEqual(calls.map(x => x.url.split('/domain-types/')[1]?.split('/')[0]).filter(Boolean), ['host']);
});

await test('Checkmk: Server- und Dienstliste für die Einstellungen', async () => {
    setRoutes([
        { match: has('/version'), json: {} },
        { match: has('/domain-types/host/'), json: { value: [
            { extensions: { name: 'web', alias: 'Web' } }, { extensions: { name: 'db' } },
        ] } },
        { match: has('/domain-types/service/'), json: { value: [
            { extensions: { host_name: 'web', description: 'HTTPS' } }, { extensions: { host_name: 'web', description: 'CPU load' } },
        ] } },
    ]);
    const c = new CheckmkClient();
    assert.deepEqual((await c.listHosts(cmk, 'x')).items, ['db', 'web']);
    assert.deepEqual((await c.listServices(cmk, 'x', 'web')).items, ['CPU load', 'HTTPS']);
    assert.deepEqual(query(calls.at(-1).url), { op: '=', left: 'host_name', right: 'web' });
});

await test('Checkmk: selbst signiertes Zertifikat wird nur auf Wunsch akzeptiert', async () => {
    setRoutes([{ match: has('/version'), json: {} }]);
    await new CheckmkClient().test({ ...cmk, insecure: true }, 'x');
    assert.equal(calls[0].insecure, true);
    setRoutes([{ match: has('/version'), json: {} }]);
    await new CheckmkClient().test(cmk, 'x');
    assert.equal(calls[0].insecure, false);
});

const kuma = { ...u.makeTarget('uptimekuma'), id: 'tkuma0001', url: 'http://kuma:3001' };
const METRICS = [
    '# HELP monitor_status Monitor Status',
    'monitor_status{monitor_name="NAS",monitor_type="ping",monitor_url="https://",monitor_hostname="nas.lan",monitor_port="null"} 0',
    'monitor_status{monitor_name="Web",monitor_type="http",monitor_url="https://web.lan",monitor_hostname="null",monitor_port="null"} 1',
].join('\n');

await test('Uptime Kuma: API-Key als Basic-Auth-Passwort, Meldungen und Inventar', async () => {
    setRoutes([{ match: has('/metrics'), text: METRICS }]);
    const c = new KumaClient();
    const r = await c.fetchProblems({ ...kuma, username: '' }, 'uk1_abc');
    assert.equal(r.ok, true);
    assert.deepEqual(r.problems.map(p => [p.host, p.name, p.severity]), [['nas.lan', 'NAS', 'crit']]);
    assert.equal(calls[0].url, 'http://kuma:3001/metrics');
    assert.equal(Buffer.from(calls[0].headers.Authorization.slice(6), 'base64').toString(), ':uk1_abc');
    assert.deepEqual((await c.listHosts(kuma, 'k')).items, ['nas.lan', 'web.lan']);
    assert.deepEqual((await c.listServices(kuma, 'k', 'web.lan')).items, ['Web']);
    assert.match((await c.test(kuma, 'k')).message, /2 Monitore/);
});

await test('Uptime Kuma: Anmeldeseite statt Metriken wird erkannt', async () => {
    setRoutes([{ match: has('/metrics'), text: '<html><body>Login</body></html>' }]);
    const r = await new KumaClient().fetchProblems(kuma, 'k');
    assert.equal(r.error, 'format');
    setRoutes([{ match: has('/metrics'), status: 401 }]);
    assert.equal((await new KumaClient().fetchProblems(kuma, 'k')).error, 'auth');
});

console.log(`${count} Treiber-Tests bestanden.`);
