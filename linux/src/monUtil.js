/**
 * monUtil.js - Reine Logik (ohne GNOME-Abhängigkeiten): Ziele, Abos,
 * Ignorierlisten, Normalisierung der Antworten von Checkmk und Uptime Kuma,
 * Filterung, Sortierung und Formatierung.
 */

import { getType, mapState, isText } from './targetTypes.js';

export {
    TYPES, typeIds, getType, fieldLabel, hasCapability, getIntervalChoices,
} from './targetTypes.js';

export const SEVERITY_LABELS = {
    crit: 'Störung',
    warn: 'Warnung',
    unknown: 'Unbekannt',
    ok: 'OK',
    maintenance: 'Wartung',
};

const SEVERITY_RANK = { crit: 0, unknown: 1, warn: 2, maintenance: 3, ok: 4 };

const TARGET_ID = /^t[a-z0-9]{6,16}$/;
const SUB_ID = /^s[a-z0-9]{6,16}$/;
const TYPE_ID = /^[a-z0-9-]{2,20}$/;
const SITE = /^[A-Za-z0-9_-]{1,40}$/;

export const ALL_HOSTS = '*';
export const SERVICE_MODES = ['all', 'selected', 'none'];

const MAX_TARGETS = 20;
const MAX_SUBS = 300;
const MAX_SELECTED = 500;
const MAX_PATTERNS = 100;
const MAX_PATTERN_LENGTH = 100;

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function randomId(prefix) {
    let s = '';
    while (s.length < 10)
        s += Math.random().toString(36).slice(2);
    return prefix + s.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Ziele (als JSON in GSettings, ohne Zugangsdaten)
// ---------------------------------------------------------------------------

export function makeTargetId() {
    return randomId('t');
}

export function makeSubId() {
    return randomId('s');
}

/** Name des Schlüsselbund-Eintrags für das Secret eines Ziels. */
export function secretName(targetId) {
    return `target-${targetId}`;
}

/**
 * Liest die Zielliste. Ungültige Einträge werden verworfen, das Ergebnis ist
 * immer ein Array. Unbekannte Zielarten bleiben erhalten (werden nur nicht abgefragt).
 * @returns {{id, type, name, url, site, username, insecure, enabled, interval}[]}
 */
export function parseTargets(json) {
    let data;
    try {
        data = JSON.parse(json || '[]');
    } catch (_e) {
        return [];
    }
    if (!Array.isArray(data))
        return [];

    const seen = new Set();
    const result = [];
    for (const item of data.slice(0, MAX_TARGETS)) {
        if (!isPlainObject(item) || !TARGET_ID.test(item.id ?? '') || !TYPE_ID.test(item.type ?? ''))
            continue;
        if (seen.has(item.id))
            continue;
        seen.add(item.id);
        result.push({
            id: item.id,
            type: item.type,
            name: isText(item.name, 40) ? item.name.trim() : getType(item.type).name,
            url: typeof item.url === 'string' ? item.url.trim().slice(0, 300) : '',
            site: typeof item.site === 'string' ? item.site.trim().slice(0, 40) : '',
            username: typeof item.username === 'string' ? item.username.trim().slice(0, 80) : '',
            insecure: item.insecure === true,
            enabled: item.enabled !== false,
            interval: Number.isInteger(item.interval) && item.interval >= 1 && item.interval <= 1440
                ? item.interval : null,
        });
    }
    return result;
}

export function serializeTargets(targets) {
    return JSON.stringify(targets.map(t => ({
        id: t.id,
        type: t.type,
        name: t.name,
        url: t.url,
        site: t.site,
        username: t.username,
        insecure: !!t.insecure,
        enabled: t.enabled !== false,
        interval: t.interval ?? null,
    })));
}

export function makeTarget(typeId, name = '') {
    const type = getType(typeId);
    return {
        id: makeTargetId(),
        type: typeId,
        name: isText(name?.trim(), 40) ? name.trim() : type.name,
        url: '',
        site: '',
        username: '',
        insecure: false,
        enabled: true,
        interval: null,
    };
}

/**
 * Prüft und normiert eine Server-URL: nur http(s), keine Leerzeichen, kein
 * Abfrageteil, ohne abschließenden Schrägstrich.
 * @returns {string|null}
 */
export function normalizeUrl(raw) {
    const url = String(raw ?? '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/i.test(url))
        return null;
    return url;
}

export function isValidSite(site) {
    return SITE.test(site ?? '');
}

/**
 * Was an einem Ziel noch fehlt, damit es abgefragt werden kann (ohne Secret).
 * @returns {string|null} Beschreibung oder null, wenn vollständig
 */
export function targetProblem(target) {
    const type = getType(target.type);
    if (!type.known || !type.driver)
        return 'Zielart ist nicht mehr in der Zielarten-Datenbank';
    if (!normalizeUrl(target.url))
        return 'Server-URL fehlt oder ist ungültig (http:// oder https://)';
    if (type.fields.includes('site') && !isValidSite(target.site))
        return 'Instanz (Site) fehlt oder ist ungültig';
    if (type.driver === 'checkmk-rest' && !target.username)
        return 'Automationsbenutzer fehlt';
    return null;
}

/** Abfrageintervall (Minuten) eines Ziels: eigene Einstellung oder Vorgabe der Zielart. */
export function effectiveInterval(target, type = getType(target.type)) {
    const wanted = target.interval ?? type.defaultInterval ?? 2;
    return Math.max(type.minInterval ?? 1, wanted);
}

/** Ist eine Abfrage fällig? */
export function isDue({ lastAttemptAt = 0, intervalMin, now = Date.now() }) {
    return now - lastAttemptAt >= intervalMin * 60 * 1000 - 5000;
}

// ---------------------------------------------------------------------------
// Abos
// ---------------------------------------------------------------------------

function cleanList(raw, max, maxLen) {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    const seen = new Set();
    for (const v of raw) {
        if (typeof v !== 'string')
            continue;
        const s = v.trim();
        if (!isText(s, maxLen) || seen.has(s))
            continue;
        seen.add(s);
        out.push(s);
        if (out.length >= max)
            break;
    }
    return out;
}

/**
 * Liest die Abo-Liste.
 * @returns {{id, target, host, services, selected, events, ignore}[]}
 *   host: '*' = alle Server des Ziels; services: 'all' | 'selected' | 'none'
 */
export function parseSubscriptions(json) {
    let data;
    try {
        data = JSON.parse(json || '[]');
    } catch (_e) {
        return [];
    }
    if (!Array.isArray(data))
        return [];

    const seen = new Set();
    const hostKeys = new Set();
    const result = [];
    for (const item of data.slice(0, MAX_SUBS)) {
        if (!isPlainObject(item) || !SUB_ID.test(item.id ?? '') || !TARGET_ID.test(item.target ?? ''))
            continue;
        const host = typeof item.host === 'string' ? item.host.trim() : '';
        if (!isText(host, 200))
            continue;
        // Je Ziel und Server nur ein Abo
        const hostKey = `${item.target}\u0000${host}`;
        if (seen.has(item.id) || hostKeys.has(hostKey))
            continue;
        seen.add(item.id);
        hostKeys.add(hostKey);
        let services = SERVICE_MODES.includes(item.services) ? item.services : 'all';
        if (host === ALL_HOSTS && services === 'selected')
            services = 'all';
        result.push({
            id: item.id,
            target: item.target,
            host,
            services,
            selected: cleanList(item.selected, MAX_SELECTED, 200),
            events: item.events !== false,
            ignore: cleanList(item.ignore, MAX_PATTERNS, MAX_PATTERN_LENGTH).filter(isValidPattern),
        });
    }
    return result;
}

export function serializeSubscriptions(subs) {
    return JSON.stringify(subs.map(s => ({
        id: s.id,
        target: s.target,
        host: s.host,
        services: s.services,
        selected: s.selected ?? [],
        events: s.events !== false,
        ignore: s.ignore ?? [],
    })));
}

export function makeSubscription(targetId, host = ALL_HOSTS) {
    return {
        id: makeSubId(),
        target: targetId,
        host,
        services: 'all',
        selected: [],
        events: true,
        ignore: [],
    };
}

// ---------------------------------------------------------------------------
// Ignorier-Muster: * = beliebig viele Zeichen, ? = genau ein Zeichen,
// \* und \? stehen für die Zeichen selbst. Groß-/Kleinschreibung egal.
// ---------------------------------------------------------------------------

export function isValidPattern(pattern) {
    return isText(pattern, MAX_PATTERN_LENGTH) && pattern.trim().length > 0;
}

const patternCache = new Map();

/**
 * Zerlegt ein Muster in Zeichen-Tokens: {any: true} für *, {one: true} für ?,
 * sonst {ch}. Bewusst kein RegExp: Muster wie *a*a*a*b würden dort exponentiell
 * zurückverfolgen und GNOME Shell einfrieren.
 */
function compileGlob(pattern) {
    if (patternCache.has(pattern))
        return patternCache.get(pattern);
    const tokens = [];
    const lower = pattern.toLowerCase();
    for (let i = 0; i < lower.length; i++) {
        const c = lower[i];
        if (c === '\\' && (lower[i + 1] === '*' || lower[i + 1] === '?' || lower[i + 1] === '\\'))
            tokens.push({ ch: lower[++i] });
        else if (c === '*') {
            if (!tokens.at(-1)?.any)
                tokens.push({ any: true });
        } else if (c === '?')
            tokens.push({ one: true });
        else
            tokens.push({ ch: c });
    }
    if (patternCache.size > 500)
        patternCache.clear();
    patternCache.set(pattern, tokens);
    return tokens;
}

/**
 * Glob-Vergleich in O(Länge Text × Länge Muster), ohne Rückverfolgung
 * (klassischer Zwei-Zeiger-Algorithmus mit Merkstelle für das letzte *).
 */
export function globMatch(pattern, text) {
    const p = compileGlob(pattern);
    const s = String(text).toLowerCase();
    let i = 0;
    let j = 0;
    let star = -1;
    let mark = 0;
    while (i < s.length) {
        const t = p[j];
        if (t && !t.any && (t.one || t.ch === s[i])) {
            i++;
            j++;
        } else if (t?.any) {
            star = j++;
            mark = i;
        } else if (star >= 0) {
            j = star + 1;
            i = ++mark;
        } else {
            return false;
        }
    }
    while (p[j]?.any)
        j++;
    return j === p.length;
}

/** Macht aus einem Text ein Muster, das genau diesen Text trifft. */
export function escapeGlob(text) {
    return String(text).replace(/[\\*?]/g, '\\$&');
}

export function matchesAny(patterns, texts) {
    for (const p of patterns) {
        for (const t of texts) {
            if (t && globMatch(p, t))
                return true;
        }
    }
    return false;
}

/** Texte, gegen die Ignorier-Muster einer Meldung geprüft werden. */
export function ignoreTexts(problem) {
    if (problem.kind === 'event')
        return [problem.name, problem.text, `${problem.name}: ${problem.text}`];
    if (problem.kind === 'host')
        return [problem.host];
    return [problem.name];
}

/**
 * Muster, mit dem der „Ignorieren“-Knopf im Popup genau diese Meldung ausblendet:
 * bei Diensten der Dienstname, bei Log-Meldungen der Meldungstext.
 */
export function ignorePatternFor(problem) {
    if (problem.kind === 'event') {
        const text = String(problem.text ?? '').trim();
        const base = text.length > 0 ? text : problem.name;
        const escaped = escapeGlob(base);
        return escaped.length <= MAX_PATTERN_LENGTH ? escaped : `${escapeGlob(base.slice(0, 80))}*`;
    }
    const escaped = escapeGlob(problem.name);
    return escaped.length <= MAX_PATTERN_LENGTH ? escaped : `${escapeGlob(problem.name.slice(0, 80))}*`;
}

/**
 * Fügt ein Ignorier-Muster für eine Meldung hinzu: im Abo des Servers, falls es
 * eins gibt, sonst im Abo „Alle Server“ (gilt dann zielweit).
 * @returns {{subs: object[], pattern: string, subId: string}|null}
 */
export function addIgnoreForProblem(subs, problem) {
    if (problem.kind === 'host')
        return null;
    const own = subs.filter(s => s.target === problem.target);
    const sub = own.find(s => s.host === problem.host) ?? own.find(s => s.host === ALL_HOSTS);
    if (!sub)
        return null;
    const pattern = ignorePatternFor(problem);
    const updated = subs.map(s => (s.id === sub.id && !s.ignore.includes(pattern)
        ? { ...s, ignore: [...s.ignore, pattern].slice(0, MAX_PATTERNS) }
        : s));
    return { subs: updated, pattern, subId: sub.id };
}

// ---------------------------------------------------------------------------
// Welche Daten ein Ziel liefern muss (für gezielte Abfragen)
// ---------------------------------------------------------------------------

/**
 * @returns {{any: boolean, hosts: string[]|null, services: string[]|null|false, events: string[]|null|false}}
 *   null = alle Server, false = gar nicht abfragen, Array = nur diese Server
 */
export function queryPlan(subs, targetId) {
    const own = subs.filter(s => s.target === targetId);
    const all = own.find(s => s.host === ALL_HOSTS);
    const specific = own.filter(s => s.host !== ALL_HOSTS);

    const pick = predicate => {
        if (all && predicate(all))
            return null;
        const hosts = specific.filter(predicate).map(s => s.host);
        return hosts.length > 0 ? hosts : false;
    };

    return {
        any: own.length > 0,
        hosts: all ? null : (specific.length > 0 ? specific.map(s => s.host) : false),
        services: pick(s => s.services !== 'none'),
        events: pick(s => s.events),
    };
}

// ---------------------------------------------------------------------------
// Filtern, Sortieren, Zählen
// ---------------------------------------------------------------------------

/**
 * Wendet Abos, Ignorierlisten und Anzeige-Optionen auf die Meldungen eines Ziels an.
 * @param {object[]} problems - normierte Meldungen eines Ziels
 * @param {object[]} subs - alle Abos
 * @param {string} targetId
 * @param {{showAcknowledged?: boolean, showDowntime?: boolean}} [opts]
 */
export function filterProblems(problems, subs, targetId, opts = {}) {
    const own = subs.filter(s => s.target === targetId);
    const all = own.find(s => s.host === ALL_HOSTS) ?? null;
    const byHost = new Map(own.filter(s => s.host !== ALL_HOSTS).map(s => [s.host, s]));
    const targetIgnore = all?.ignore ?? [];

    return problems.filter(p => {
        if (p.severity === 'ok')
            return false;
        if ((p.downtime || p.severity === 'maintenance') && !opts.showDowntime)
            return false;
        if (p.acknowledged && !opts.showAcknowledged)
            return false;

        const sub = byHost.get(p.host) ?? all;
        if (!sub)
            return false;

        if (p.kind === 'service') {
            if (sub.services === 'none')
                return false;
            if (sub.services === 'selected' && !sub.selected.includes(p.name))
                return false;
        } else if (p.kind === 'event') {
            if (!sub.events)
                return false;
        }

        const patterns = sub === all ? targetIgnore : [...sub.ignore, ...targetIgnore];
        return !matchesAny(patterns, ignoreTexts(p));
    });
}

export function sortProblems(problems) {
    const kindRank = { host: 0, service: 1, event: 2 };
    return [...problems].sort((a, b) =>
        (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9)
        || (kindRank[a.kind] ?? 9) - (kindRank[b.kind] ?? 9)
        || (b.since ?? 0) - (a.since ?? 0)
        || a.host.localeCompare(b.host)
        || a.name.localeCompare(b.name));
}

/** Zählt Störungen (crit) und Warnungen (warn + unknown). */
export function summarize(problems) {
    let crit = 0;
    let warn = 0;
    for (const p of problems) {
        if (p.severity === 'crit')
            crit++;
        else if (p.severity === 'warn' || p.severity === 'unknown')
            warn++;
    }
    return { crit, warn, total: crit + warn };
}

/**
 * Meldungen, die seit der letzten Abfrage neu hinzugekommen sind und
 * mindestens den gewünschten Schweregrad haben.
 */
export function newProblems(previousKeys, problems, minSeverity = 'crit') {
    const limit = SEVERITY_RANK[minSeverity] ?? 0;
    return problems.filter(p => !previousKeys.has(p.key) && (SEVERITY_RANK[p.severity] ?? 9) <= limit);
}

export function problemKey(p) {
    return [p.target, p.kind, p.host, p.name, p.eventId ?? ''].join('\u0001');
}

function finishProblem(p) {
    p.key = problemKey(p);
    return p;
}

// ---------------------------------------------------------------------------
// Zeit
// ---------------------------------------------------------------------------

/** Sekunden, Millisekunden oder ISO-Text → Millisekunden (oder null). */
export function toMillis(value) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0)
        return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
    if (typeof value === 'string' && value.trim()) {
        if (/^[0-9]+(\.[0-9]+)?$/.test(value.trim()))
            return toMillis(Number(value));
        const ms = Date.parse(value);
        return Number.isFinite(ms) ? ms : null;
    }
    return null;
}

export function formatSince(ms, now = Date.now()) {
    if (!Number.isFinite(ms))
        return '';
    const min = Math.max(0, Math.floor((now - ms) / 60000));
    if (min < 1)
        return 'gerade eben';
    if (min < 60)
        return `seit ${min} Min.`;
    const h = Math.floor(min / 60);
    if (h < 24)
        return `seit ${h} Std.`;
    const d = Math.floor(h / 24);
    if (d < 14)
        return `seit ${d} ${d === 1 ? 'Tag' : 'Tagen'}`;
    const date = new Date(ms);
    return `seit ${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}.${date.getFullYear()}`;
}

export function formatClock(date) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** Hängt einen Parameter an, der Zwischenspeicher (z. B. von GitHub raw) umgeht. */
export function withCacheBuster(url) {
    return `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`;
}

// ---------------------------------------------------------------------------
// HTTP-Fehler
// ---------------------------------------------------------------------------

export function httpErrorKind(status) {
    if (status === 401 || status === 403)
        return 'auth';
    if (status === 404)
        return 'notfound';
    if (status === 429)
        return 'ratelimit';
    if (status >= 500 && status < 600)
        return 'server';
    return 'http';
}

/** Ordnet eine Fehlermeldung der Netzwerk-Bibliothek ein (TLS oder Netzwerk). */
export function networkErrorKind(message) {
    return /certificate|zertifikat|tls|ssl/i.test(String(message ?? '')) ? 'tls' : 'network';
}

// ---------------------------------------------------------------------------
// Checkmk (REST API)
// ---------------------------------------------------------------------------

/** Basisadresse der REST API: <url>/<site>/check_mk/api/<version> */
export function checkmkApiBase(target, version) {
    let url = normalizeUrl(target.url) ?? '';
    const site = target.site;
    // URL wurde mit Instanz angegeben (…/mysite) → nicht doppelt anhängen
    if (url.endsWith(`/${site}`))
        url = url.slice(0, -(site.length + 1));
    return `${url}/${encodeURIComponent(site)}/check_mk/api/${version}`;
}

/** Adresse der Checkmk-Oberfläche (für den Klick auf eine Meldung). */
export function checkmkGuiLink(target, problem) {
    let url = normalizeUrl(target.url);
    if (!url || !isValidSite(target.site))
        return null;
    if (url.endsWith(`/${target.site}`))
        url = url.slice(0, -(target.site.length + 1));
    const base = `${url}/${encodeURIComponent(target.site)}/check_mk/view.py`;
    const h = encodeURIComponent(problem.host);
    if (problem.kind === 'host')
        return `${base}?view_name=host&host=${h}`;
    if (problem.kind === 'service')
        return `${base}?view_name=service&host=${h}&service=${encodeURIComponent(problem.name)}`;
    return `${base}?view_name=ec_events_of_monhost&host=${h}`;
}

function hostFilter(hosts, column) {
    if (!hosts || hosts.length === 0)
        return null;
    if (hosts.length === 1)
        return { op: '=', left: column, right: hosts[0] };
    return { op: 'or', expr: hosts.map(h => ({ op: '=', left: column, right: h })) };
}

function andAll(exprs) {
    const list = exprs.filter(Boolean);
    return list.length === 1 ? list[0] : { op: 'and', expr: list };
}

export const CHECKMK_HOST_COLUMNS = [
    'name', 'state', 'acknowledged', 'scheduled_downtime_depth', 'plugin_output', 'last_state_change',
];
export const CHECKMK_SERVICE_COLUMNS = [
    'host_name', 'description', 'state', 'state_type', 'acknowledged', 'scheduled_downtime_depth',
    'host_scheduled_downtime_depth', 'plugin_output', 'last_state_change',
];

/** Livestatus-Ausdruck: Hosts, die nicht UP sind (optional nur bestimmte). */
export function checkmkHostQuery(hosts) {
    return andAll([{ op: '!=', left: 'state', right: '0' }, hostFilter(hosts, 'name')]);
}

/** Livestatus-Ausdruck: Services, die nicht OK sind (optional nur harte Zustände, nur bestimmte Hosts). */
export function checkmkServiceQuery(hosts, hardOnly) {
    return andAll([
        { op: '!=', left: 'state', right: '0' },
        hardOnly ? { op: '=', left: 'state_type', right: '1' } : null,
        hostFilter(hosts, 'host_name'),
    ]);
}

/**
 * Setzt die Abfrage-Parameter einer Collection zusammen:
 * columns=a&columns=b&query=<JSON>
 */
export function checkmkCollectionQuery(columns, query) {
    const parts = columns.map(c => `columns=${encodeURIComponent(c)}`);
    if (query)
        parts.push(`query=${encodeURIComponent(JSON.stringify(query))}`);
    return parts.join('&');
}

/** Zeilen einer Collection-Antwort (die Spalten stehen in `extensions`). */
export function checkmkRows(json) {
    if (!isPlainObject(json) || !Array.isArray(json.value))
        return [];
    return json.value
        .map(v => (isPlainObject(v?.extensions) ? v.extensions : isPlainObject(v?.members) ? v.members : null))
        .filter(Boolean);
}

function truthy(v) {
    return v === true || v === 1 || v === '1';
}

function trimText(value, max = 500) {
    const s = String(value ?? '').replace(/\s+/g, ' ').trim();
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function checkmkHostProblems(rows, target, type = getType(target.type)) {
    return rows.filter(r => typeof r.name === 'string' && r.name).map(r => {
        const { severity, label } = mapState(type, 'host', r.state);
        return finishProblem({
            target: target.id,
            kind: 'host',
            host: r.name,
            name: '',
            severity,
            label,
            text: trimText(r.plugin_output),
            since: toMillis(r.last_state_change),
            acknowledged: truthy(r.acknowledged),
            downtime: Number(r.scheduled_downtime_depth) > 0,
        });
    });
}

export function checkmkServiceProblems(rows, target, { hardOnly = true } = {}, type = getType(target.type)) {
    return rows
        .filter(r => typeof r.host_name === 'string' && typeof r.description === 'string')
        // Falls der Server den Filter auf state_type nicht kennt, hier nachfiltern
        .filter(r => !hardOnly || r.state_type === undefined || Number(r.state_type) === 1)
        .map(r => {
            const { severity, label } = mapState(type, 'service', r.state);
            return finishProblem({
                target: target.id,
                kind: 'service',
                host: r.host_name,
                name: r.description,
                severity,
                label,
                text: trimText(r.plugin_output),
                since: toMillis(r.last_state_change),
                acknowledged: truthy(r.acknowledged),
                downtime: Number(r.scheduled_downtime_depth) > 0 || Number(r.host_scheduled_downtime_depth) > 0,
            });
        });
}

/**
 * Meldungen der Event Console. Die Antwort ist eine Collection; die Felder
 * stehen je nach Version in `extensions` – beides wird akzeptiert.
 */
export function checkmkEventProblems(json, target, hosts = null, type = getType(target.type)) {
    if (!isPlainObject(json) || !Array.isArray(json.value))
        return [];
    const wanted = hosts ? new Set(hosts) : null;
    const out = [];
    for (const v of json.value) {
        const e = isPlainObject(v?.extensions) ? v.extensions : v;
        if (!isPlainObject(e))
            continue;
        const phase = String(e.phase ?? 'open');
        if (phase === 'closed' || phase === 'archived')
            continue;
        const host = String(e.host ?? '').trim();
        if (!host || (wanted && !wanted.has(host)))
            continue;
        const { severity, label } = mapState(type, 'event', e.state);
        out.push(finishProblem({
            target: target.id,
            kind: 'event',
            host,
            name: String(e.application ?? '').trim() || 'Event Console',
            eventId: String(v?.id ?? e.event_id ?? e.id ?? ''),
            severity,
            label,
            text: trimText(e.text),
            since: toMillis(e.last ?? e.first),
            count: Number.isInteger(e.count) ? e.count : null,
            acknowledged: phase === 'ack',
            downtime: false,
        }));
    }
    return out;
}

// ---------------------------------------------------------------------------
// Uptime Kuma (Prometheus-Textformat von /metrics)
// ---------------------------------------------------------------------------

/**
 * Zerlegt das Prometheus-Textformat.
 * @returns {{name: string, labels: object, value: number}[]}
 */
export function parsePrometheus(text) {
    const out = [];
    for (const rawLine of String(text ?? '').split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#'))
            continue;
        const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)/.exec(line);
        if (!m)
            continue;
        const name = m[1];
        let i = name.length;
        const labels = {};
        if (line[i] === '{') {
            i++;
            let ok = false;
            while (i < line.length) {
                while (line[i] === ' ' || line[i] === ',')
                    i++;
                if (line[i] === '}') {
                    i++;
                    ok = true;
                    break;
                }
                const lm = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(line.slice(i));
                if (!lm)
                    break;
                i += lm[0].length;
                if (line[i] !== '=' || line[i + 1] !== '"')
                    break;
                i += 2;
                let value = '';
                let closed = false;
                while (i < line.length) {
                    const c = line[i];
                    if (c === '\\') {
                        const n = line[i + 1];
                        value += n === 'n' ? '\n' : n ?? '';
                        i += 2;
                    } else if (c === '"') {
                        i++;
                        closed = true;
                        break;
                    } else {
                        value += c;
                        i++;
                    }
                }
                if (!closed)
                    break;
                labels[lm[0]] = value;
            }
            if (!ok)
                continue;
        }
        const rest = line.slice(i).trim().split(/\s+/);
        const value = Number(rest[0]);
        if (!Number.isFinite(value))
            continue;
        out.push({ name, labels, value });
    }
    return out;
}

function clean(v) {
    const s = String(v ?? '').trim();
    return s && s !== 'null' && s !== 'undefined' ? s : '';
}

function monitorIdentity(labels) {
    if (clean(labels.monitor_id))
        return `id:${labels.monitor_id}`;
    return ['monitor_name', 'monitor_type', 'monitor_url', 'monitor_hostname', 'monitor_port']
        .map(k => labels[k] ?? '').join('\u0001');
}

/**
 * Fasst die Metriken zu Monitoren zusammen.
 * @returns {{name, type, url, hostname, port, status, certDays, certValid, responseMs}[]}
 */
export function kumaMonitors(samples) {
    const map = new Map();
    for (const s of samples) {
        if (!s.name.startsWith('monitor_') || !clean(s.labels.monitor_name))
            continue;
        const id = monitorIdentity(s.labels);
        if (!map.has(id)) {
            map.set(id, {
                name: s.labels.monitor_name,
                type: clean(s.labels.monitor_type),
                url: clean(s.labels.monitor_url),
                hostname: clean(s.labels.monitor_hostname),
                port: clean(s.labels.monitor_port),
                status: null,
                certDays: null,
                certValid: null,
                responseMs: null,
            });
        }
        const m = map.get(id);
        if (s.name === 'monitor_status')
            m.status = s.value;
        else if (s.name === 'monitor_cert_days_remaining')
            m.certDays = s.value;
        else if (s.name === 'monitor_cert_is_valid')
            m.certValid = s.value;
        else if (s.name === 'monitor_response_time')
            m.responseMs = s.value;
    }
    return [...map.values()].filter(m => m.status !== null);
}

/** „Server“ eines Monitors: Hostname, sonst Host der URL, sonst der Monitorname. */
export function kumaHostOf(monitor) {
    if (monitor.hostname)
        return monitor.hostname;
    const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^/:?#]+)/i.exec(monitor.url ?? '');
    if (m)
        return m[1].toLowerCase();
    return monitor.name;
}

function kumaVisible(monitor, type) {
    return !(type.options?.skipMonitorTypes ?? []).includes(monitor.type);
}

/** Server und Monitore für die Auswahl in den Einstellungen. */
export function kumaInventory(monitors, type) {
    const hosts = new Map();
    for (const m of monitors.filter(x => kumaVisible(x, type))) {
        const host = kumaHostOf(m);
        if (!hosts.has(host))
            hosts.set(host, new Set());
        hosts.get(host).add(m.name);
    }
    return new Map([...hosts.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([h, names]) => [h, [...names].sort((a, b) => a.localeCompare(b))]));
}

export function kumaProblems(monitors, target, type = getType(target.type)) {
    const certWarnDays = type.options?.certWarnDays ?? 0;
    const out = [];
    for (const m of monitors) {
        if (!kumaVisible(m, type))
            continue;
        const { severity, label } = mapState(type, 'service', m.status);
        const where = m.url || [m.hostname, m.port].filter(Boolean).join(':');
        const base = {
            target: target.id,
            kind: 'service',
            host: kumaHostOf(m),
            name: m.name,
            since: null,
            acknowledged: false,
            downtime: severity === 'maintenance',
        };
        if (severity !== 'ok') {
            out.push(finishProblem({
                ...base, severity, label,
                text: trimText(`${label}${where ? ` – ${where}` : ''}`),
            }));
        } else if (certWarnDays > 0 && Number.isFinite(m.certDays) && m.certDays <= certWarnDays) {
            const days = Math.floor(m.certDays);
            out.push(finishProblem({
                ...base,
                severity: days < 0 ? 'crit' : 'warn',
                label: 'ZERTIFIKAT',
                text: days < 0 ? 'Zertifikat ist abgelaufen'
                    : `Zertifikat läuft ${days === 0 ? 'heute' : `in ${days} ${days === 1 ? 'Tag' : 'Tagen'}`} ab`,
            }));
        }
    }
    return out;
}

export function kumaGuiLink(target) {
    const url = normalizeUrl(target.url);
    return url ? `${url}/dashboard` : null;
}

/** Link zur Oberfläche des Monitoring-Systems für eine Meldung. */
export function guiLink(target, problem) {
    const type = getType(target.type);
    if (type.driver === 'checkmk-rest')
        return checkmkGuiLink(target, problem);
    if (type.driver === 'prometheus-kuma')
        return kumaGuiLink(target);
    return null;
}
