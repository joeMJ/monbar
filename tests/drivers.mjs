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
import { IcingaClient } from '../linux/src/icingaClient.js';
import { NagiosClient } from '../linux/src/nagiosClient.js';
import { NagiosXiClient } from '../linux/src/nagiosXiClient.js';
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

const auth = h => Buffer.from(h.Authorization.slice(6), 'base64').toString();
const param = (url, key) => new URL(url).searchParams.get(key);

// ---------------------------------------------------------------------------
// Icinga 2
// ---------------------------------------------------------------------------

const ici = { ...u.makeTarget('icinga2'), id: 'tici00001', url: 'https://icinga.lan:5665', username: 'monbar' };

await test('Icinga 2: Basic Auth, gefilterte Abfragen, Host-Wartung per joins', async () => {
    setRoutes([
        { match: has('/v1/objects/hosts'), json: { results: [
            { name: 'nas', attrs: { name: 'nas', state: 1.0, state_type: 1.0, acknowledgement: 0, downtime_depth: 0 } }] } },
        { match: has('/v1/objects/services'), json: { results: [
            { name: 'web!http', attrs: { name: 'http', host_name: 'web', state: 2.0, state_type: 1.0 }, joins: { host: {} } }] } },
    ]);
    const r = await new IcingaClient().fetchProblems(ici, 'pw', { any: true, hosts: null, services: ['web'], events: false });
    assert.equal(r.ok, true);
    assert.deepEqual(r.problems.map(p => p.kind), ['host', 'service']);
    assert.equal(auth(calls[0].headers), 'monbar:pw');
    assert.equal(param(calls[0].url, 'filter'), 'host.state!=0 && host.state_type==1');
    assert.equal(param(calls[1].url, 'filter'), 'service.state!=0 && service.state_type==1 && service.host_name=="web"');
    assert.equal(param(calls[1].url, 'joins'), 'host.downtime_depth');
});

await test('Icinga 2: Filter abgelehnt → einmal ohne Filter, danach dauerhaft ohne', async () => {
    setRoutes([
        { match: url => url.includes('filter='), status: 403 },
        { match: has('/v1/objects/'), json: { results: [
            { name: 'a!x', attrs: { name: 'x', host_name: 'a', state: 2, state_type: 1 } },
            { name: 'b!y', attrs: { name: 'y', host_name: 'b', state: 0, state_type: 1 } }] } },
    ]);
    const c = new IcingaClient();
    const r = await c.fetchProblems(ici, 'pw', { any: true, hosts: false, services: null, events: false });
    assert.equal(r.ok, true);
    assert.equal(u.filterProblems(r.problems, [u.makeSubscription(ici.id, '*')], ici.id).length, 1);
    assert.equal(calls.length, 2);
    await c.fetchProblems(ici, 'pw', { any: true, hosts: false, services: null, events: false });
    assert.ok(!calls.at(-1).url.includes('filter='));
    // Dienstliste für die Einstellungen wird trotzdem auf den Host eingegrenzt
    assert.deepEqual((await c.listServices(ici, 'pw', 'a')).items, ['x']);
});

await test('Icinga 2: Test, Hostliste, falsches Passwort', async () => {
    setRoutes([{ match: has('/v1/objects/hosts'), json: { results: [{ attrs: { name: 'b' } }, { attrs: { name: 'a' } }] } }]);
    const c = new IcingaClient();
    assert.match((await c.test(ici, 'pw')).message, /2 Hosts/);
    assert.deepEqual((await c.listHosts(ici, 'pw')).items, ['a', 'b']);
    setRoutes([{ match: has('/v1/'), status: 401 }]);
    assert.equal((await new IcingaClient().fetchProblems(ici, 'x', { any: true, hosts: null, services: null })).error, 'auth');
});

// ---------------------------------------------------------------------------
// Nagios Core
// ---------------------------------------------------------------------------

const nag = { ...u.makeTarget('nagios'), id: 'tnag00001', url: 'https://srv.lan/nagios', username: 'nagiosadmin' };
const ok = data => ({ result: { type_code: 0, type_text: 'Success' }, data });

await test('Nagios Core: statusjson-Abfragen mit Klartext-Status und Basic Auth', async () => {
    setRoutes([
        { match: url => param(url, 'query') === 'hostlist', json: ok({ hostlist: { nas: { status: 'down', state_type: 'hard' } } }) },
        { match: url => param(url, 'query') === 'servicelist', json: ok({ servicelist: { web: { HTTP: { status: 'critical', state_type: 'hard' } } } }) },
    ]);
    const r = await new NagiosClient().fetchProblems(nag, 'pw', { any: true, hosts: null, services: ['web'], events: false });
    assert.equal(r.ok, true);
    assert.deepEqual(r.problems.map(p => [p.kind, p.host, p.severity]), [['host', 'nas', 'crit'], ['service', 'web', 'crit']]);
    assert.equal(auth(calls[0].headers), 'nagiosadmin:pw');
    assert.ok(calls[0].url.startsWith('https://srv.lan/nagios/cgi-bin/statusjson.cgi?query=hostlist&details=true&hoststatus=down+unreachable'));
    assert.equal(param(calls[1].url, 'formatoptions'), 'enumerate');
    assert.equal(param(calls[1].url, 'hostname'), 'web');
});

await test('Nagios Core: CGI-Fehler, falscher Pfad, Version im Test', async () => {
    setRoutes([{ match: has('statusjson.cgi'), json: { result: { type_code: 1, message: 'Invalid query' }, data: {} } }]);
    const r = await new NagiosClient().fetchProblems(nag, 'pw', { any: true, hosts: null, services: null });
    assert.deepEqual([r.ok, r.error, r.message], [false, 'format', 'Invalid query']);
    setRoutes([]);
    assert.match((await new NagiosClient().test(nag, 'pw')).message, /nicht gefunden/);
    setRoutes([{ match: has('programstatus'), json: ok({ programstatus: { version: '4.5.3' } }) }]);
    assert.match((await new NagiosClient().test(nag, 'pw')).message, /Nagios Core 4\.5\.3/);
});

// ---------------------------------------------------------------------------
// Nagios XI
// ---------------------------------------------------------------------------

const xi = { ...u.makeTarget('nagiosxi'), id: 'txi000001', url: 'https://xi.lan' };

await test('Nagios XI: API-Key als Parameter, Filter ne:0, Ergebnis doppelt gefiltert', async () => {
    setRoutes([
        { match: has('/objects/hoststatus'), json: { recordcount: 0, hoststatus: [] } },
        // älteres XI ignoriert den Filter und liefert auch OK
        { match: has('/objects/servicestatus'), json: { recordcount: 2, servicestatus: [
            { host_name: 'web', name: 'HTTP', current_state: '2', state_type: '1' },
            { host_name: 'web', name: 'Ping', current_state: '0', state_type: '1' }] } },
    ]);
    const r = await new NagiosXiClient().fetchProblems(xi, 'KEY&1', { any: true, hosts: null, services: null });
    assert.equal(r.ok, true);
    assert.equal(u.filterProblems(r.problems, [u.makeSubscription(xi.id, '*')], xi.id).length, 1);
    assert.ok(calls[0].url.startsWith('https://xi.lan/nagiosxi/api/v1/objects/hoststatus?'));
    assert.equal(param(calls[0].url, 'apikey'), 'KEY&1');
    assert.equal(param(calls[1].url, 'current_state'), 'ne:0');
    assert.equal(calls[0].headers.Authorization, undefined);
});

await test('Nagios XI: falscher Key (HTTP 200 mit error) wird als Anmeldefehler erkannt', async () => {
    setRoutes([{ match: has('/objects/'), json: { error: 'Invalid API Key' } }]);
    const r = await new NagiosXiClient().test(xi, 'falsch');
    assert.deepEqual([r.ok, r.error], [false, 'auth']);
    setRoutes([{ match: has('/objects/hoststatus'), json: { recordcount: '12', hoststatus: [{ host_name: 'a' }] } }]);
    assert.match((await new NagiosXiClient().test(xi, 'k')).message, /12 Hosts/);
});

console.log(`${count} Treiber-Tests bestanden.`);
