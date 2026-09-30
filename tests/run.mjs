/**
 * Tests für die reine Logik (ohne GNOME). Ausführen mit:  node tests/run.mjs
 *
 * Prüft u. a. die mitgelieferte Zielarten-Datenbank – nach jeder Änderung an
 * linux/data/targets.json einmal laufen lassen.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as tt from '../linux/src/targetTypes.js';
import * as u from '../linux/src/monUtil.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let count = 0;
const test = (name, fn) => {
    try {
        fn();
        count++;
    } catch (e) {
        console.error(`FEHLER in „${name}“:\n${e.stack}`);
        process.exit(1);
    }
};

// ---------------------------------------------------------------------------
// Zielarten-Datenbank
// ---------------------------------------------------------------------------

const bundledRaw = JSON.parse(readFileSync(join(root, 'linux/data/targets.json'), 'utf-8'));
const metadata = JSON.parse(readFileSync(join(root, 'linux/metadata.json'), 'utf-8'));

test('mitgelieferte Datenbank ist vollständig gültig (nichts übersprungen)', () => {
    const r = tt.validateTargetDb(bundledRaw);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.skipped, 0, 'Die mitgelieferte Datenbank enthält ungültige Einträge');
    assert.equal(r.db.types.length, bundledRaw.types.length);
    assert.ok(r.db.version >= 1);
});

test('mitgelieferte Datenbank: Checkmk und Uptime Kuma mit Treiber und Status-Übersetzung', () => {
    tt.applyTargetTypes(tt.validateTargetDb(bundledRaw).db);
    assert.deepEqual(tt.typeIds(), ['checkmk', 'uptimekuma']);
    const cmk = tt.getType('checkmk');
    assert.equal(cmk.driver, 'checkmk-rest');
    assert.deepEqual(cmk.fields, ['url', 'site', 'username', 'secret']);
    assert.ok(tt.hasCapability(cmk, 'events'));
    assert.deepEqual(cmk.options.apiVersions, ['v1', '1.0']);
    assert.deepEqual(tt.mapState(cmk, 'service', 2), { severity: 'crit', label: 'CRIT' });
    assert.deepEqual(tt.mapState(cmk, 'event', 'warning'), { severity: 'warn', label: 'WARN' });
    assert.equal(tt.mapState(cmk, 'service', 7).severity, 'unknown');
    const kuma = tt.getType('uptimekuma');
    assert.equal(kuma.driver, 'prometheus-kuma');
    assert.ok(!tt.hasCapability(kuma, 'events'));
    assert.equal(tt.mapState(kuma, 'service', 0).severity, 'crit');
    assert.equal(tt.mapState(kuma, 'service', 3).severity, 'maintenance');
    for (const t of Object.values(tt.TYPES))
        assert.ok(!t.docsUrl || t.docsUrl.startsWith('https://'), t.id);
});

test('metadata.json: UUID und Schema stimmen', () => {
    assert.equal(metadata.uuid, 'monbar@johnlose.de');
    assert.equal(metadata['settings-schema'], 'org.gnome.shell.extensions.monbar');
    assert.ok(Number.isInteger(metadata.version));
});

const base = () => ({
    schema: 1, version: 5,
    types: [{ id: 'nagios', name: 'Nagios', driver: 'checkmk-rest' }],
});

test('Datenbank: zu neues Schema, fehlende Version und leere Liste werden abgelehnt', () => {
    assert.equal(tt.validateTargetDb({ ...base(), schema: 99 }).ok, false);
    assert.equal(tt.validateTargetDb({ ...base(), version: undefined }).ok, false);
    assert.equal(tt.validateTargetDb({ ...base(), types: [] }).ok, false);
    assert.equal(tt.validateTargetDb(null).ok, false);
});

test('Datenbank: unbekannter Treiber wird übersprungen, nicht übernommen', () => {
    const r = tt.validateTargetDb({ ...base(), types: [
        { id: 'nagios', name: 'Nagios', driver: 'nagios-cgi' },
        { id: 'icinga', name: 'Icinga', driver: 'checkmk-rest' },
    ] });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, 1);
    assert.deepEqual(r.db.types.map(t => t.id), ['icinga']);
});

test('Datenbank: Pflichtfelder des Treibers werden ergänzt, fremde Felder verworfen', () => {
    const r = tt.validateTargetDb({ ...base(), types: [
        { id: 'k2', name: 'Kuma 2', driver: 'prometheus-kuma', fields: ['site', 'username'] },
    ] });
    assert.deepEqual(r.db.types[0].fields, ['url', 'username', 'secret']);
});

test('Datenbank: nur https-Links, harmlose Optionen, gültige Schweregrade', () => {
    const r = tt.validateTargetDb({ ...base(), types: [{
        id: 'x1', name: 'X', driver: 'checkmk-rest',
        docsUrl: 'http://evil.example',
        options: { apiVersions: ['v1', '../../x', 'unstable'], endpoint: 'https://evil.example' },
        stateMap: { service: { 1: { severity: 'boom' }, 2: { severity: 'crit', label: 'CRIT' } } },
    }] });
    const t = r.db.types[0];
    assert.equal(t.docsUrl, '');
    assert.deepEqual(t.options, { apiVersions: ['v1', 'unstable'] });
    assert.deepEqual(Object.keys(t.stateMap.service), ['2']);
});

test('Datenbank: Standardintervall nie unter dem Minimum', () => {
    const r = tt.validateTargetDb({ ...base(), types: [
        { id: 'x1', name: 'X', driver: 'checkmk-rest', minInterval: 5, defaultInterval: 1 },
    ] });
    assert.equal(r.db.types[0].defaultInterval, 5);
});

test('unbekannte Zielart liefert Platzhalter ohne Treiber', () => {
    const t = tt.getType('gibtsnicht');
    assert.equal(t.known, false);
    assert.equal(t.driver, null);
});

// Ab hier mit der mitgelieferten Datenbank
tt.applyTargetTypes(tt.validateTargetDb(bundledRaw).db);

// ---------------------------------------------------------------------------
// Ziele
// ---------------------------------------------------------------------------

test('Ziele: gültige werden übernommen, kaputte verworfen, keine Secrets im JSON', () => {
    const t = u.makeTarget('checkmk', 'Zuhause');
    const json = JSON.stringify([
        t, { id: 'kaputt' }, 'x', { ...t, secret: 'geheim' },
        { id: 'tabcdefgh', type: 'uptimekuma', url: 'http://kuma:3001', interval: 0 },
    ]);
    const list = u.parseTargets(json);
    assert.equal(list.length, 2);
    assert.equal(list[0].name, 'Zuhause');
    assert.equal(list[1].name, 'Uptime Kuma');
    assert.equal(list[1].interval, null);
    assert.ok(!u.serializeTargets(list).includes('geheim'));
    assert.deepEqual(u.parseTargets('kein json'), []);
});

test('URL-Normierung', () => {
    assert.equal(u.normalizeUrl(' https://monitor.lan/ '), 'https://monitor.lan');
    assert.equal(u.normalizeUrl('http://192.168.1.10:3001'), 'http://192.168.1.10:3001');
    assert.equal(u.normalizeUrl('ftp://x'), null);
    assert.equal(u.normalizeUrl('https://a b'), null);
    assert.equal(u.normalizeUrl('https://user:pw@host'), null);
    assert.equal(u.normalizeUrl('https://host/?x=1'), null);
});

test('Ziel-Prüfung meldet fehlende Angaben', () => {
    const t = { ...u.makeTarget('checkmk'), url: 'https://m', site: 'mysite', username: 'monbar' };
    assert.equal(u.targetProblem(t), null);
    assert.match(u.targetProblem({ ...t, site: '' }), /Instanz/);
    assert.match(u.targetProblem({ ...t, username: '' }), /Automationsbenutzer/);
    assert.match(u.targetProblem({ ...t, url: 'x' }), /URL/);
    const k = { ...u.makeTarget('uptimekuma'), url: 'http://kuma:3001' };
    assert.equal(u.targetProblem(k), null);
    assert.match(u.targetProblem({ ...k, type: 'weg' }), /Zielarten-Datenbank/);
});

test('Intervall: eigene Wahl, Vorgabe der Zielart, Minimum', () => {
    const t = u.makeTarget('checkmk');
    assert.equal(u.effectiveInterval(t), 2);
    assert.equal(u.effectiveInterval({ ...t, interval: 10 }), 10);
    assert.equal(u.isDue({ lastAttemptAt: 0, intervalMin: 2, now: 1e12 }), true);
    assert.equal(u.isDue({ lastAttemptAt: 1e12 - 60000, intervalMin: 2, now: 1e12 }), false);
});

// ---------------------------------------------------------------------------
// Abos & Ignorieren
// ---------------------------------------------------------------------------

const T = 'tzielabc1';
const sub = (host, extra = {}) => ({ ...u.makeSubscription(T, host), ...extra });

test('Abos: je Ziel und Server nur eines, „Ausgewählte“ nicht für alle Server', () => {
    const list = u.parseSubscriptions(JSON.stringify([
        sub('*', { services: 'selected' }), sub('web01'), sub('web01'), { id: 'x' },
        sub('db01', { ignore: ['Log *', '', 42] }),
    ]));
    assert.deepEqual(list.map(s => s.host), ['*', 'web01', 'db01']);
    assert.equal(list[0].services, 'all');
    assert.deepEqual(list[2].ignore, ['Log *']);
});

test('Glob-Muster: *, ?, Maskierung, Groß-/Kleinschreibung, Sonderzeichen', () => {
    assert.ok(u.matchesAny(['Log *'], ['log /var/log/syslog']));
    assert.ok(u.matchesAny(['Interface ?'], ['Interface 2']));
    assert.ok(!u.matchesAny(['Interface ?'], ['Interface 12']));
    assert.ok(u.matchesAny(['Filesystem /boot'], ['Filesystem /boot']));
    assert.ok(!u.matchesAny(['Filesystem /boot'], ['Filesystem /boot/efi']));
    assert.ok(u.matchesAny(['a.b(c)'], ['a.b(c)']));
    assert.ok(!u.matchesAny(['a.b'], ['axb']));
    assert.ok(u.matchesAny([u.escapeGlob('Disk *C*')], ['Disk *C*']));
    assert.ok(!u.matchesAny([u.escapeGlob('Disk *C*')], ['Disk xCx']));
    // Viele * dürfen nicht hängen
    const t0 = Date.now();
    u.matchesAny(['*a*a*a*a*a*a*a*a*a*a*b'], ['a'.repeat(60)]);
    assert.ok(Date.now() - t0 < 1000);
});

const prob = (host, name, severity = 'crit', extra = {}) => {
    const p = { target: T, kind: 'service', host, name, severity, label: 'X', text: '', since: 0,
        acknowledged: false, downtime: false, ...extra };
    p.key = u.problemKey(p);
    return p;
};

test('Filter: ohne Abo nichts, „Alle Server“ zeigt alles außer OK', () => {
    const ps = [prob('a', 's1'), prob('b', 's2', 'warn'), prob('c', 's3', 'ok')];
    assert.equal(u.filterProblems(ps, [], T).length, 0);
    assert.equal(u.filterProblems(ps, [sub('*')], T).length, 2);
    assert.equal(u.filterProblems(ps, [sub('*')], 'tanderes1').length, 0);
});

test('Filter: einzelne Server, Dienst-Auswahl, nur Serverstatus', () => {
    const ps = [prob('a', 's1'), prob('a', 's2'), prob('b', 's3'),
        prob('a', '', 'crit', { kind: 'host' })];
    const subs = [sub('a', { services: 'selected', selected: ['s2'] })];
    assert.deepEqual(u.filterProblems(ps, subs, T).map(p => p.name).sort(), ['', 's2']);
    const none = [sub('a', { services: 'none' })];
    assert.deepEqual(u.filterProblems(ps, none, T).map(p => p.kind), ['host']);
});

test('Filter: Server-Abo hat Vorrang vor „Alle Server“, zielweite Ignorierliste gilt trotzdem', () => {
    const ps = [prob('a', 'Log syslog'), prob('a', 'CPU'), prob('b', 'Log x')];
    const subs = [sub('*', { ignore: ['Log *'] }), sub('a', { ignore: ['CPU'] })];
    assert.equal(u.filterProblems(ps, subs, T).length, 0);
});

test('Filter: Log-Meldungen (Event Console) an/aus und nach Text ignorieren', () => {
    const ev = prob('a', 'sshd', 'warn', { kind: 'event', text: 'Failed password for root', eventId: '7' });
    assert.equal(u.filterProblems([ev], [sub('a')], T).length, 1);
    assert.equal(u.filterProblems([ev], [sub('a', { events: false })], T).length, 0);
    assert.equal(u.filterProblems([ev], [sub('a', { ignore: ['Failed password*'] })], T).length, 0);
    assert.equal(u.filterProblems([ev], [sub('a', { ignore: ['sshd'] })], T).length, 0);
});

test('Filter: quittiert und Wartung standardmäßig ausgeblendet', () => {
    const ps = [prob('a', 's1', 'crit', { acknowledged: true }), prob('a', 's2', 'crit', { downtime: true }),
        prob('a', 's3', 'maintenance')];
    assert.equal(u.filterProblems(ps, [sub('*')], T).length, 0);
    assert.equal(u.filterProblems(ps, [sub('*')], T, { showAcknowledged: true }).length, 1);
    assert.equal(u.filterProblems(ps, [sub('*')], T, { showDowntime: true }).length, 2);
});

test('Ignorieren-Knopf: Muster ins Server-Abo, sonst ins Abo „Alle Server“', () => {
    const subs = [sub('*'), sub('a')];
    const r1 = u.addIgnoreForProblem(subs, prob('a', 'Disk *C*'));
    assert.equal(r1.subId, subs[1].id);
    assert.equal(u.filterProblems([prob('a', 'Disk *C*'), prob('a', 'Disk xCx')], r1.subs, T).length, 1);
    const r2 = u.addIgnoreForProblem(subs, prob('b', 'CPU'));
    assert.equal(r2.subId, subs[0].id);
    // Doppelt hinzufügen ändert nichts
    const r3 = u.addIgnoreForProblem(r2.subs, prob('b', 'CPU'));
    assert.deepEqual(r3.subs.find(s => s.host === '*').ignore, ['CPU']);
    assert.equal(u.addIgnoreForProblem(subs, prob('a', '', 'crit', { kind: 'host' })), null);
    const long = prob('a', 'x', 'warn', { kind: 'event', text: 'y'.repeat(300) });
    const p = u.ignorePatternFor(long);
    assert.ok(p.length <= 100 && p.endsWith('*'));
    assert.ok(u.matchesAny([p], u.ignoreTexts(long)));
});

test('Abfrageplan: alle, einzelne Server, nichts', () => {
    assert.deepEqual(u.queryPlan([sub('*')], T), { any: true, hosts: null, services: null, events: null });
    const plan = u.queryPlan([sub('a', { events: false }), sub('b', { services: 'none' })], T);
    assert.deepEqual(plan, { any: true, hosts: ['a', 'b'], services: ['a'], events: ['b'] });
    assert.deepEqual(u.queryPlan([], T), { any: false, hosts: false, services: false, events: false });
    const mixed = u.queryPlan([sub('*', { services: 'none', events: false }), sub('a')], T);
    assert.deepEqual(mixed, { any: true, hosts: null, services: ['a'], events: ['a'] });
});

test('Sortierung und Zählung: Störungen zuerst, Unbekannt zählt als Warnung', () => {
    const ps = [prob('a', 'w', 'warn'), prob('a', 'c', 'crit'), prob('a', 'u', 'unknown'),
        prob('a', '', 'crit', { kind: 'host' })];
    assert.deepEqual(u.sortProblems(ps).map(p => p.name), ['', 'c', 'u', 'w']);
    assert.deepEqual(u.summarize(ps), { crit: 2, warn: 2, total: 4 });
});

test('neue Meldungen nach Mindest-Schweregrad', () => {
    const ps = [prob('a', 'c'), prob('a', 'w', 'warn')];
    const seen = new Set([ps[0].key]);
    assert.equal(u.newProblems(seen, ps, 'crit').length, 0);
    assert.equal(u.newProblems(seen, ps, 'warn').length, 1);
    assert.equal(u.newProblems(new Set(), ps, 'crit').length, 1);
});

// ---------------------------------------------------------------------------
// Checkmk
// ---------------------------------------------------------------------------

const cmk = { ...u.makeTarget('checkmk'), id: T, url: 'https://monitor.lan/', site: 'mysite', username: 'monbar' };

test('Checkmk: API-Adresse, auch wenn die URL schon die Instanz enthält', () => {
    assert.equal(u.checkmkApiBase(cmk, 'v1'), 'https://monitor.lan/mysite/check_mk/api/v1');
    assert.equal(u.checkmkApiBase({ ...cmk, url: 'https://monitor.lan/mysite' }, '1.0'),
        'https://monitor.lan/mysite/check_mk/api/1.0');
});

test('Checkmk: Abfrage-Ausdrücke und Parameter', () => {
    assert.deepEqual(u.checkmkServiceQuery(null, false), { op: '!=', left: 'state', right: '0' });
    assert.deepEqual(u.checkmkServiceQuery(['a'], true), { op: 'and', expr: [
        { op: '!=', left: 'state', right: '0' },
        { op: '=', left: 'state_type', right: '1' },
        { op: '=', left: 'host_name', right: 'a' },
    ] });
    const hq = u.checkmkHostQuery(['a', 'b']);
    assert.equal(hq.expr[1].op, 'or');
    const qs = u.checkmkCollectionQuery(['name', 'state'], { op: '=', left: 'name', right: 'a&b' });
    assert.ok(qs.startsWith('columns=name&columns=state&query='));
    assert.equal(JSON.parse(decodeURIComponent(qs.split('query=')[1])).right, 'a&b');
});

test('Checkmk: Host- und Service-Antwort werden normiert', () => {
    const hosts = u.checkmkHostProblems(u.checkmkRows({ value: [
        { extensions: { name: 'nas', state: 1, acknowledged: 0, scheduled_downtime_depth: 0,
            plugin_output: 'CRIT - 10.0.0.2: rta nan', last_state_change: 1700000000 } },
    ] }), cmk);
    assert.equal(hosts[0].severity, 'crit');
    assert.equal(hosts[0].label, 'DOWN');
    assert.equal(hosts[0].since, 1700000000000);
    const svc = u.checkmkServiceProblems(u.checkmkRows({ value: [
        { extensions: { host_name: 'nas', description: 'Filesystem /', state: 1, state_type: 1,
            acknowledged: 1, scheduled_downtime_depth: 0, plugin_output: 'WARN  85%' } },
        { extensions: { host_name: 'nas', description: 'CPU', state: 2, state_type: 0 } },
        { extensions: { host_name: 'nas', description: 'Mem', state: 2, host_scheduled_downtime_depth: 1 } },
    ] }), cmk);
    assert.deepEqual(svc.map(p => p.name), ['Filesystem /', 'Mem']);   // weiche Zustände raus
    assert.equal(svc[0].acknowledged, true);
    assert.equal(svc[0].text, 'WARN 85%');
    assert.equal(svc[1].downtime, true);
    assert.equal(u.checkmkServiceProblems(u.checkmkRows({ value: [
        { extensions: { host_name: 'nas', description: 'CPU', state: 2, state_type: 0 } },
    ] }), cmk, { hardOnly: false }).length, 1);
    assert.deepEqual(u.checkmkRows({}), []);
});

test('Checkmk: Logwatch-Ausgabe wird in Anzahl und Meldung zerlegt', () => {
    const out = '1 CRIT messages (Last worst: "Sep 27 06:24:21 49158.25 volsnap Die Schattenkopien von Volume "V:" wurden gelöscht.")';
    assert.deepEqual(u.parseLogwatch(out), { count: 1, message: 'volsnap Die Schattenkopien von Volume "V:" wurden gelöscht.' });
    assert.equal(u.parseLogwatch('2 WARN, 3 CRIT messages (Last worst: "Sep 30 15:00:56 0.5038 Microsoft-Windows-Security-Auditing Codeintegrität")').count, 5);
    assert.equal(u.parseLogwatch('CRIT - 10.0.0.2: rta nan'), null);

    const [p] = u.checkmkServiceProblems(u.checkmkRows({ value: [
        { extensions: { host_name: 'hv02', description: 'Log Security', state: 2, state_type: 1,
            plugin_output: '19 CRIT messages (Last worst: "Sep 30 15:00:56 0.5038 Microsoft-Windows-Security-Auditing Die Codeintegrität hat festgestellt, dass der Abbildhash einer Datei nicht gültig ist.")' } },
    ] }), cmk);
    assert.equal(p.log, true);
    assert.equal(p.count, 19);
    assert.match(p.text, /^Microsoft-Windows-Security-Auditing Die Codeintegrität/);

    // Ignorieren-Knopf: nur diese Meldung, nicht das ganze Log
    const pattern = u.ignorePatternFor(p);
    assert.ok(pattern.startsWith('*') && pattern.endsWith('*') && pattern.length <= 100);
    const subs = u.addIgnoreForProblem([sub('*')], p).subs;
    const other = { ...p, text: 'Microsoft-Windows-Kernel-Power Das System wurde neu gestartet' };
    other.key = u.problemKey({ ...other, name: 'x' });
    assert.deepEqual(u.filterProblems([p, other], subs, T).map(x => x.text), [other.text]);
    // Ganzes Log über den Dienstnamen ignorieren geht weiterhin
    assert.equal(u.filterProblems([p, other], [sub('*', { ignore: ['Log Security'] })], T).length, 0);
    // Muster mit vielen Sonderzeichen bleibt innerhalb der Längengrenze
    const star = { ...p, text: '*?'.repeat(60) };
    assert.ok(u.ignorePatternFor(star).length <= 100);
    assert.ok(u.matchesAny([u.ignorePatternFor(star)], u.ignoreTexts(star)));
});

test('Checkmk: Event Console – offene Meldungen, Filter auf Server, Zahlen- und Textstatus', () => {
    const json = { value: [
        { id: '12', extensions: { host: 'nas', application: 'sshd', text: 'Failed password', state: 1,
            phase: 'open', last: '2026-09-30T10:00:00Z', count: 3 } },
        { id: '13', extensions: { host: 'nas', application: 'kernel', text: 'oops', state: 'critical', phase: 'ack' } },
        { id: '14', extensions: { host: 'nas', application: 'x', text: 'y', state: 2, phase: 'closed' } },
        { id: '15', extensions: { host: 'web', application: 'x', text: 'z', state: 2 } },
    ] };
    const ev = u.checkmkEventProblems(json, cmk, ['nas']);
    assert.deepEqual(ev.map(e => e.eventId), ['12', '13']);
    assert.equal(ev[0].severity, 'warn');
    assert.equal(ev[0].since, Date.parse('2026-09-30T10:00:00Z'));
    assert.equal(ev[1].severity, 'crit');
    assert.equal(ev[1].acknowledged, true);
    assert.notEqual(ev[0].key, ev[1].key);
    assert.equal(u.checkmkEventProblems(json, cmk).length, 3);
});

test('Checkmk: Links in die Oberfläche sind korrekt kodiert', () => {
    const p = prob('nas', 'Filesystem /');
    assert.equal(u.guiLink(cmk, p),
        'https://monitor.lan/mysite/check_mk/view.py?view_name=service&host=nas&service=Filesystem%20%2F');
    assert.match(u.guiLink(cmk, { ...p, kind: 'host' }), /view_name=host&host=nas$/);
});

// ---------------------------------------------------------------------------
// Uptime Kuma
// ---------------------------------------------------------------------------

const kuma = { ...u.makeTarget('uptimekuma'), id: T, url: 'http://kuma:3001' };
const METRICS = `
# HELP monitor_status Monitor Status (1 = UP, 0= DOWN, 2= PENDING, 3= MAINTENANCE)
# TYPE monitor_status gauge
monitor_status{monitor_name="Router",monitor_type="ping",monitor_url="https://",monitor_hostname="192.168.1.1",monitor_port="null"} 1
monitor_status{monitor_name="Nextcloud",monitor_type="http",monitor_url="https://cloud.example.de/status.php",monitor_hostname="null",monitor_port="null"} 0
monitor_status{monitor_name="Wiki \\"alt\\"",monitor_type="http",monitor_url="https://wiki.example.de",monitor_hostname="null",monitor_port="null"} 3
monitor_status{monitor_name="Gruppe",monitor_type="group",monitor_url="https://",monitor_hostname="null",monitor_port="null"} 0
monitor_status{monitor_name="DNS",monitor_type="dns",monitor_url="https://",monitor_hostname="pihole",monitor_port="53"} 2
monitor_cert_days_remaining{monitor_name="Blog",monitor_type="http",monitor_url="https://blog.example.de",monitor_hostname="null",monitor_port="null"} 5
monitor_status{monitor_name="Blog",monitor_type="http",monitor_url="https://blog.example.de",monitor_hostname="null",monitor_port="null"} 1
monitor_response_time{monitor_name="Blog",monitor_type="http",monitor_url="https://blog.example.de",monitor_hostname="null",monitor_port="null"} 120
process_cpu_user_seconds_total 1.5
kaputt{monitor_name="x 1
`;

test('Prometheus-Text wird zerlegt, auch mit maskierten Anführungszeichen', () => {
    const samples = u.parsePrometheus(METRICS);
    assert.equal(samples.length, 9);
    assert.equal(samples[2].labels.monitor_name, 'Wiki "alt"');
    assert.equal(samples[8].name, 'process_cpu_user_seconds_total');
});

test('Uptime Kuma: Monitore, Server-Zuordnung und Meldungen', () => {
    const monitors = u.kumaMonitors(u.parsePrometheus(METRICS));
    assert.equal(monitors.length, 6);
    const byName = Object.fromEntries(monitors.map(m => [m.name, m]));
    assert.equal(u.kumaHostOf(byName.Router), '192.168.1.1');
    assert.equal(u.kumaHostOf(byName.Nextcloud), 'cloud.example.de');
    assert.equal(u.kumaHostOf(byName.DNS), 'pihole');
    assert.equal(byName.Blog.certDays, 5);

    const inv = u.kumaInventory(monitors, u.getType('uptimekuma'));
    assert.ok(!['Gruppe'].some(n => [...inv.values()].flat().includes(n)));
    assert.deepEqual(inv.get('blog.example.de'), ['Blog']);

    const ps = u.kumaProblems(monitors, kuma);
    const got = Object.fromEntries(ps.map(p => [p.name, p]));
    assert.equal(got.Nextcloud.severity, 'crit');
    assert.equal(got.DNS.severity, 'warn');
    assert.equal(got['Wiki "alt"'].downtime, true);
    assert.equal(got.Blog.label, 'ZERTIFIKAT');
    assert.match(got.Blog.text, /in 5 Tagen/);
    assert.ok(!got.Gruppe && !got.Router);
    // Wartung wird standardmäßig ausgeblendet
    assert.equal(u.filterProblems(ps, [sub('*')], T).length, 3);
    assert.equal(u.guiLink(kuma, got.Nextcloud), 'http://kuma:3001/dashboard');
});

// ---------------------------------------------------------------------------
// Export / Import
// ---------------------------------------------------------------------------

test('Export: Ziele, Abos und Optionen, aber keine Secrets oder fremden Felder', () => {
    const t1 = { ...u.makeTarget('checkmk', 'Zuhause'), url: 'https://mon.lan', site: 'home', username: 'monbar', secret: 'GEHEIM' };
    const s1 = { ...u.makeSubscription(t1.id, '*'), ignore: ['Log *'] };
    const fremd = u.makeSubscription('tfremd0001', '*');
    const text = u.buildExport({
        targets: [t1], subs: [s1, fremd],
        options: { 'panel-position': 'left', 'show-downtime': true, 'git-update-url': 'https://evil', 'notify-min-severity': 'boom' },
        versionName: '0.3', now: new Date('2026-09-30T12:00:00Z'),
    });
    assert.ok(!text.includes('GEHEIM'));
    const data = JSON.parse(text);
    assert.equal(data.format, 'monbar-export');
    assert.equal(data.subscriptions.length, 1);
    assert.deepEqual(data.options, { 'panel-position': 'left', 'show-downtime': true });
    assert.equal(data.targets[0].username, 'monbar');
});

test('Import: Datei wird geprüft, kaputte Einträge verworfen', () => {
    assert.equal(u.parseImport('kein json').ok, false);
    assert.equal(u.parseImport('{"format":"etwas"}').ok, false);
    assert.match(u.parseImport('{"format":"monbar-export","version":99}').error, /neueren/);
    const t = u.makeTarget('uptimekuma');
    const r = u.parseImport(JSON.stringify({
        format: 'monbar-export', version: 1,
        targets: [t, { id: 'kaputt' }],
        subscriptions: [u.makeSubscription(t.id, '*'), u.makeSubscription('tunbekannt', '*')],
        options: { 'show-ok-icon': false, 'panel-position': 'oben' },
    }));
    assert.equal(r.ok, true);
    assert.equal(r.targets.length, 1);
    assert.equal(r.subs.length, 1);
    assert.deepEqual(r.options, { 'show-ok-icon': false });
});

test('Import: Zusammenführen über die Ziel-ID (Secrets bleiben, andere Ziele unberührt)', () => {
    const a = { ...u.makeTarget('checkmk', 'A'), url: 'https://a' };
    const b = { ...u.makeTarget('checkmk', 'B'), url: 'https://b' };
    const subsA = [u.makeSubscription(a.id, '*'), u.makeSubscription(a.id, 'alt')];
    const subsB = [u.makeSubscription(b.id, '*')];
    const c = u.makeTarget('uptimekuma', 'C');
    const imported = {
        targets: [{ ...a, name: 'A neu' }, c],
        subs: [u.makeSubscription(a.id, 'web'), u.makeSubscription(c.id, '*')],
    };
    const r = u.mergeImport([a, b], [...subsA, ...subsB], imported);
    assert.equal(r.added, 1);
    assert.equal(r.updated, 1);
    assert.deepEqual(r.targets.map(t => t.name), ['A neu', 'B', 'C']);
    assert.equal(r.targets[0].id, a.id);   // gleiche ID → gleiches Secret im Schlüsselbund
    assert.deepEqual(r.subs.filter(s => s.target === a.id).map(s => s.host), ['web']);
    assert.equal(r.subs.filter(s => s.target === b.id).length, 1);
    // Rundreise: Export → Import ergibt dieselben Daten
    const round = u.parseImport(u.buildExport({ targets: r.targets, subs: r.subs }));
    assert.deepEqual(round.targets, r.targets);
    assert.deepEqual(round.subs.map(s => s.id).sort(), r.subs.map(s => s.id).sort());
});

// ---------------------------------------------------------------------------
// Sonstiges
// ---------------------------------------------------------------------------

test('Zeitangaben', () => {
    assert.equal(u.toMillis(1700000000), 1700000000000);
    assert.equal(u.toMillis(1700000000000), 1700000000000);
    assert.equal(u.toMillis('1700000000'), 1700000000000);
    assert.equal(u.toMillis(''), null);
    const now = Date.parse('2026-09-30T12:00:00Z');
    assert.equal(u.formatSince(now - 30000, now), 'gerade eben');
    assert.equal(u.formatSince(now - 5 * 60000, now), 'seit 5 Min.');
    assert.equal(u.formatSince(now - 3 * 3600000, now), 'seit 3 Std.');
    assert.equal(u.formatSince(now - 86400000, now), 'seit 1 Tag');
    assert.equal(u.formatSince(null, now), '');
});

test('HTTP- und Netzwerkfehler werden eingeordnet', () => {
    assert.equal(u.httpErrorKind(401), 'auth');
    assert.equal(u.httpErrorKind(404), 'notfound');
    assert.equal(u.httpErrorKind(503), 'server');
    assert.equal(u.networkErrorKind('Unacceptable TLS certificate'), 'tls');
    assert.equal(u.networkErrorKind('Connection refused'), 'network');
});

console.log(`${count} Tests bestanden.`);
