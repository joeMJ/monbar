/**
 * monUtil.js - Reine Logik (ohne GNOME-Abhängigkeiten): Ziele, Abos,
 * Ignorierlisten, Normalisierung der Antworten von Checkmk und Uptime Kuma,
 * Filterung, Sortierung und Formatierung.
 */

import { getType, mapState, isText, fieldLabel, DRIVERS } from './targetTypes.js';

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
            weburl: typeof item.weburl === 'string' ? item.weburl.trim().slice(0, 300) : '',
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
        weburl: t.weburl ?? '',
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
        weburl: '',
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
    const driver = DRIVERS[type.driver];
    if (!type.known || !driver)
        return 'Zielart ist nicht mehr in der Zielarten-Datenbank';
    if (!normalizeUrl(target.url))
        return `${fieldLabel(type, 'url')} fehlt oder ist ungültig (http:// oder https://)`;
    if (type.fields.includes('site') && !isValidSite(target.site))
        return `${fieldLabel(type, 'site')} fehlt oder ist ungültig`;
    // Pflichtfelder bestimmt der Treiber (im Code), nicht die Datenbank
    if (driver.required.includes('username') && !target.username)
        return `${fieldLabel(type, 'username')} fehlt`;
    if (type.fields.includes('weburl') && target.weburl && !normalizeUrl(target.weburl))
        return `${fieldLabel(type, 'weburl')}: Adresse ist ungültig`;
    return null;
}

/**
 * Was tun, wenn für ein Ziel kein Secret gelesen werden konnte?
 *
 * Direkt nach dem Anmelden (besonders per FIDO-Stick) ist der Secret Service oft noch
 * nicht bereit: Die Abfrage wirft, läuft in die Zeitüberschreitung oder findet noch
 * nichts. Das darf nicht als „kein Secret hinterlegt“ stehen bleiben, sondern muss von
 * selbst erneut versucht werden.
 *
 * @param {{locked?: boolean, error?: string|null, inGrace?: boolean}} r
 *   inGrace: noch in der Anlaufphase nach dem Anmelden
 * @returns {{kind: 'keyring'|'locked'|'nokey', message: string, retrySeconds: number|null}}
 */
export function secretFailure({ locked = false, error = null, inGrace = false }) {
    const retry = inGrace ? 30 : 60;
    if (error)
        return { kind: 'keyring', message: error, retrySeconds: retry };
    if (locked)
        return { kind: 'locked', message: '', retrySeconds: retry };
    if (inGrace)
        return { kind: 'keyring', message: 'Schlüsselbund antwortet noch nicht', retrySeconds: retry };
    // Wirklich kein Secret: Neuer Versuch erst mit dem regulären Intervall bzw. nach dem Eintragen
    return { kind: 'nokey', message: '', retrySeconds: null };
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
// Export / Import der Konfiguration (ohne Secrets)
// ---------------------------------------------------------------------------

export const EXPORT_FORMAT = 'monbar-export';
export const EXPORT_VERSION = 1;

/**
 * Allgemeine Einstellungen, die mit exportiert werden: Schlüssel → Typ bzw. erlaubte Werte.
 * Zugangsdaten, Update-Adressen und interne Zähler gehören bewusst nicht dazu.
 */
export const EXPORT_OPTIONS = {
    'panel-position': ['left', 'center', 'right'],
    'show-ok-icon': 'boolean',
    'show-acknowledged': 'boolean',
    'show-downtime': 'boolean',
    'hard-states-only': 'boolean',
    'notify-enabled': 'boolean',
    'notify-min-severity': ['crit', 'warn'],
};

function validOption(key, value) {
    const rule = EXPORT_OPTIONS[key];
    if (rule === 'boolean')
        return typeof value === 'boolean';
    return Array.isArray(rule) && rule.includes(value);
}

/**
 * Baut die Export-Datei. Secrets liegen nur im Schlüsselbund und sind in den
 * Ziel-Daten gar nicht enthalten; serializeTargets() schreibt nur bekannte Felder.
 */
export function buildExport({ targets, subs, options = {}, versionName = '', now = new Date() }) {
    const cleanOptions = {};
    for (const [key, value] of Object.entries(options)) {
        if (validOption(key, value))
            cleanOptions[key] = value;
    }
    return JSON.stringify({
        format: EXPORT_FORMAT,
        version: EXPORT_VERSION,
        exported: now.toISOString(),
        monbar: versionName,
        note: 'Ziele und Abos ohne Zugangsdaten. Secrets nach dem Import auf einem anderen Rechner neu eintragen.',
        targets: JSON.parse(serializeTargets(targets)),
        subscriptions: JSON.parse(serializeSubscriptions(subs.filter(s => targets.some(t => t.id === s.target)))),
        options: cleanOptions,
    }, null, 2);
}

/**
 * Liest eine Export-Datei. Ungültige Einträge werden verworfen; Abos ohne
 * zugehöriges Ziel in der Datei ebenso.
 * @returns {{ok: true, targets, subs, options} | {ok: false, error: string}}
 */
export function parseImport(text) {
    let data;
    try {
        data = JSON.parse(text);
    } catch (_e) {
        return { ok: false, error: 'Die Datei ist kein gültiges JSON' };
    }
    if (!isPlainObject(data) || data.format !== EXPORT_FORMAT)
        return { ok: false, error: 'Keine monbar-Exportdatei' };
    if (!Number.isInteger(data.version) || data.version > EXPORT_VERSION)
        return { ok: false, error: `Die Datei stammt aus einer neueren monbar-Version (Format ${data.version})` };

    const targets = parseTargets(JSON.stringify(data.targets ?? []));
    const ids = new Set(targets.map(t => t.id));
    const subs = parseSubscriptions(JSON.stringify(data.subscriptions ?? [])).filter(s => ids.has(s.target));
    const options = {};
    if (isPlainObject(data.options)) {
        for (const [key, value] of Object.entries(data.options)) {
            if (validOption(key, value))
                options[key] = value;
        }
    }
    if (targets.length === 0 && Object.keys(options).length === 0)
        return { ok: false, error: 'Die Datei enthält keine Ziele' };
    return { ok: true, targets, subs, options };
}

/**
 * Führt importierte Ziele mit den vorhandenen zusammen, über die Ziel-ID:
 * gleiche ID → Ziel und seine Abos werden ersetzt (das Secret im Schlüsselbund
 * bleibt, es hängt an der ID), neue ID → hinzugefügt, alle anderen bleiben unverändert.
 * @returns {{targets, subs, added: number, updated: number}}
 */
export function mergeImport(existingTargets, existingSubs, imported) {
    const importedIds = new Set(imported.targets.map(t => t.id));
    let updated = 0;
    const targets = existingTargets.map(t => {
        if (!importedIds.has(t.id))
            return t;
        updated++;
        return imported.targets.find(x => x.id === t.id);
    });
    const existingIds = new Set(existingTargets.map(t => t.id));
    const fresh = imported.targets.filter(t => !existingIds.has(t.id));
    const mergedTargets = [...targets, ...fresh].slice(0, MAX_TARGETS);
    const kept = new Set(mergedTargets.map(t => t.id));
    const subs = [
        ...existingSubs.filter(s => !importedIds.has(s.target)),
        ...imported.subs,
    ].filter(s => kept.has(s.target)).slice(0, MAX_SUBS);
    return { targets: mergedTargets, subs, added: fresh.length, updated };
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
    // Log-Dienste (Logwatch): Dienstname oder die gemeldete Log-Zeile
    if (problem.log)
        return [problem.name, problem.text];
    return [problem.name];
}

function containsPattern(text) {
    let core = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60).trim();
    // Maskierte Sonderzeichen verlängern das Muster – nie über die erlaubte Länge
    while (core && escapeGlob(core).length + 2 > MAX_PATTERN_LENGTH)
        core = core.slice(0, -1).trim();
    return core ? `*${escapeGlob(core)}*` : null;
}

/**
 * Muster, mit dem der „Ignorieren“-Knopf im Popup genau diese Meldung ausblendet:
 * bei Diensten der Dienstname, bei Log-Meldungen (Event Console oder Logwatch-Dienst)
 * der Anfang der Log-Zeile – damit nur diese Meldung verschwindet, nicht das ganze Log.
 */
export function ignorePatternFor(problem) {
    if (problem.kind === 'event' || problem.log) {
        const pattern = containsPattern(problem.text);
        if (pattern)
            return pattern;
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
            const log = parseLogwatch(r.plugin_output);
            return finishProblem({
                target: target.id,
                kind: 'service',
                host: r.host_name,
                name: r.description,
                severity,
                label,
                text: trimText(log ? log.message : r.plugin_output),
                log: !!log,
                count: log?.count ?? null,
                since: toMillis(r.last_state_change),
                acknowledged: truthy(r.acknowledged),
                downtime: Number(r.scheduled_downtime_depth) > 0 || Number(r.host_scheduled_downtime_depth) > 0,
            });
        });
}

/**
 * Zerlegt die Ausgabe eines Checkmk-Logwatch-Dienstes (Syslog, Windows-Ereignisprotokoll …):
 *   '1 CRIT messages (Last worst: "Sep 27 06:24:21 49158.25 volsnap Die Schattenkopien …")'
 *   '2 WARN, 1 CRIT messages (Last worst: "…")'
 * @returns {{count: number, message: string}|null} null, wenn es keine Logwatch-Ausgabe ist
 */
export function parseLogwatch(output) {
    const s = String(output ?? '').trim();
    const m = /^((?:[0-9]+\s+(?:CRIT|WARN|OK|IGN)\s*,?\s*)+)messages?\s*\(Last worst:\s*"?([\s\S]*?)"?\s*\)\s*$/i.exec(s);
    if (!m)
        return null;
    const count = [...m[1].matchAll(/[0-9]+/g)].reduce((sum, x) => sum + Number(x[0]), 0);
    return { count, message: stripLogPrefix(m[2]) };
}

/** Entfernt Zeitstempel und Kennnummer am Anfang einer Log-Zeile („Sep 27 06:24:21 49158.25 “). */
export function stripLogPrefix(line) {
    return String(line ?? '')
        .replace(/^[A-Z][a-z]{2}\s+[0-9]{1,2}\s+[0-9]{2}:[0-9]{2}:[0-9]{2}\s+/, '')
        .replace(/^[0-9]+(\.[0-9]+)?\s+/, '')
        .trim();
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

// ---------------------------------------------------------------------------
// Gemeinsam für Icinga 2 und Nagios
// ---------------------------------------------------------------------------

/** Hart bestätigter Zustand? Akzeptiert 1/0, "1"/"0", "hard"/"soft"; unbekannt = hart. */
export function isHardState(value) {
    if (value === undefined || value === null || value === '')
        return true;
    if (typeof value === 'string' && /^(hard|soft)$/i.test(value))
        return value.toLowerCase() === 'hard';
    return Number(value) === 1;
}

/** Rohstatus als Schlüssel für die Status-Übersetzung: 2.0 → "2", "Critical" → "critical". */
function stateKey(value) {
    if (typeof value === 'number')
        return String(Math.round(value));
    const s = String(value ?? '').trim();
    return /^[0-9]+(\.0+)?$/.test(s) ? String(Math.round(Number(s))) : s.toLowerCase();
}

function positive(value) {
    return value === true || Number(value) > 0;
}

// ---------------------------------------------------------------------------
// Icinga 2 (REST API /v1/objects)
// ---------------------------------------------------------------------------

/** Basisadresse der API; eine angegebene Adresse mit /v1 wird nicht doppelt ergänzt. */
export function icingaApiBase(target) {
    const url = (normalizeUrl(target.url) ?? '').replace(/\/v1$/, '');
    return `${url}/v1`;
}

/** Zeichenkette für Icinga-Filterausdrücke (doppelte Anführungszeichen, maskiert). */
function icingaString(s) {
    return JSON.stringify(String(s));
}

/**
 * Filterausdruck: nur Probleme, optional nur harte Zustände und nur bestimmte Hosts.
 * @param {'host'|'service'} kind
 */
export function icingaFilter(kind, hosts, hardOnly) {
    const parts = [`${kind}.state!=0`];
    if (hardOnly)
        parts.push(`${kind}.state_type==1`);
    const column = kind === 'host' ? 'host.name' : 'service.host_name';
    if (hosts?.length === 1)
        parts.push(`${column}==${icingaString(hosts[0])}`);
    else if (hosts?.length > 1)
        parts.push(`${column} in [${hosts.map(icingaString).join(',')}]`);
    return parts.join(' && ');
}

export const ICINGA_HOST_ATTRS = [
    'name', 'display_name', 'state', 'state_type', 'acknowledgement', 'downtime_depth',
    'last_check_result', 'last_state_change',
];
export const ICINGA_SERVICE_ATTRS = [
    'name', 'display_name', 'host_name', 'state', 'state_type', 'acknowledgement', 'downtime_depth',
    'last_check_result', 'last_state_change',
];

/** Abfrage-Parameter: attrs=a&attrs=b&joins=host.downtime_depth&filter=… */
export function icingaQuery(attrs, { filter = null, joins = [] } = {}) {
    const parts = attrs.map(a => `attrs=${encodeURIComponent(a)}`);
    for (const j of joins)
        parts.push(`joins=${encodeURIComponent(j)}`);
    if (filter)
        parts.push(`filter=${encodeURIComponent(filter)}`);
    return parts.join('&');
}

function icingaResults(json) {
    return isPlainObject(json) && Array.isArray(json.results)
        ? json.results.filter(r => isPlainObject(r?.attrs)) : [];
}

export function icingaHostProblems(json, target, { hardOnly = true } = {}, type = getType(target.type)) {
    const out = [];
    for (const r of icingaResults(json)) {
        const a = r.attrs;
        const host = String(a.name ?? r.name ?? '').trim();
        if (!host || (hardOnly && !isHardState(a.state_type)))
            continue;
        const { severity, label } = mapState(type, 'host', stateKey(a.state));
        out.push(finishProblem({
            target: target.id,
            kind: 'host',
            host,
            name: '',
            severity,
            label,
            text: trimText(a.last_check_result?.output),
            since: toMillis(a.last_state_change),
            acknowledged: positive(a.acknowledgement),
            downtime: positive(a.downtime_depth),
        }));
    }
    return out;
}

export function icingaServiceProblems(json, target, { hardOnly = true } = {}, type = getType(target.type)) {
    const out = [];
    for (const r of icingaResults(json)) {
        const a = r.attrs;
        // Objektname ist „host!dienst“; host_name und name stehen auch einzeln in attrs
        const [fullHost, fullName] = String(r.name ?? '').split('!');
        const host = String(a.host_name ?? fullHost ?? '').trim();
        const name = String(a.display_name || a.name || fullName || '').trim();
        if (!host || !name || (hardOnly && !isHardState(a.state_type)))
            continue;
        const { severity, label } = mapState(type, 'service', stateKey(a.state));
        const log = parseLogwatch(a.last_check_result?.output);
        out.push(finishProblem({
            target: target.id,
            kind: 'service',
            host,
            name,
            severity,
            label,
            text: trimText(log ? log.message : a.last_check_result?.output),
            log: !!log,
            count: log?.count ?? null,
            since: toMillis(a.last_state_change),
            acknowledged: positive(a.acknowledgement),
            downtime: positive(a.downtime_depth) || positive(r.joins?.host?.downtime_depth),
        }));
    }
    return out;
}

/** Namen aus einer Objekt-Abfrage (für die Auswahl in den Einstellungen). */
export function icingaNames(json, { service = false } = {}) {
    const names = icingaResults(json)
        .map(r => String((service ? r.attrs.display_name || r.attrs.name : r.attrs.name) ?? '').trim())
        .filter(Boolean);
    return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

/**
 * Link in Icinga Web (Modul Icinga DB Web). Ohne eingetragene Weboberfläche kein Link,
 * denn die API-Adresse (Port 5665) ist keine Oberfläche.
 */
export function icingaGuiLink(target, problem) {
    const web = normalizeUrl(target.weburl);
    if (!web)
        return null;
    if (problem.kind === 'host')
        return `${web}/icingadb/host?name=${encodeURIComponent(problem.host)}`;
    return `${web}/icingadb/service?name=${encodeURIComponent(problem.name)}&host.name=${encodeURIComponent(problem.host)}`;
}

// ---------------------------------------------------------------------------
// Nagios Core (JSON-CGI statusjson.cgi, ab 4.0.7)
// ---------------------------------------------------------------------------

/** Basisadresse der Weboberfläche, z. B. https://server/nagios (ohne /cgi-bin). */
export function nagiosBase(target) {
    return (normalizeUrl(target.url) ?? '').replace(/\/cgi-bin(\/[^/]*)?$/, '');
}

/**
 * Adresse einer statusjson-Abfrage. `formatoptions=enumerate` liefert Status als Text
 * („critical“) statt als Bitwert; die Status-Übersetzung kennt vorsichtshalber beides.
 */
export function nagiosQueryUrl(target, query, params = {}) {
    const parts = [`query=${query}`];
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '')
            parts.push(`${key}=${key === 'servicestatus' || key === 'hoststatus' ? value : encodeURIComponent(value)}`);
    }
    return `${nagiosBase(target)}/cgi-bin/statusjson.cgi?${parts.join('&')}`;
}

/** Fehlermeldung der CGI (result.type_code ≠ 0) oder null. */
export function nagiosResultError(json) {
    if (!isPlainObject(json) || !isPlainObject(json.data))
        return 'Antwort ohne Daten – ist die Adresse die Nagios-Weboberfläche?';
    const code = json.result?.type_code;
    if (code !== undefined && Number(code) !== 0)
        return String(json.result?.message || json.result?.type_text || `Fehler ${code}`);
    return null;
}

function nagiosDetail(value) {
    return isPlainObject(value) ? value : { status: value };
}

function nagiosProblem(target, type, kind, host, name, d, hardOnly) {
    if (hardOnly && !isHardState(d.state_type))
        return null;
    const { severity, label } = mapState(type, kind, stateKey(d.status));
    const output = d.plugin_output ?? d.output;
    const log = kind === 'service' ? parseLogwatch(output) : null;
    return finishProblem({
        target: target.id,
        kind,
        host,
        name,
        severity,
        label,
        text: trimText(log ? log.message : output),
        log: !!log,
        count: log?.count ?? null,
        since: toMillis(d.last_state_change),
        acknowledged: positive(d.problem_has_been_acknowledged),
        downtime: positive(d.scheduled_downtime_depth),
    });
}

export function nagiosHostProblems(json, target, { hardOnly = true } = {}, type = getType(target.type)) {
    const list = json?.data?.hostlist;
    if (!isPlainObject(list))
        return [];
    return Object.entries(list)
        .map(([host, v]) => nagiosProblem(target, type, 'host', host, '', nagiosDetail(v), hardOnly))
        .filter(Boolean);
}

export function nagiosServiceProblems(json, target, { hardOnly = true } = {}, type = getType(target.type)) {
    const list = json?.data?.servicelist;
    if (!isPlainObject(list))
        return [];
    const out = [];
    for (const [host, services] of Object.entries(list)) {
        if (!isPlainObject(services))
            continue;
        for (const [name, v] of Object.entries(services)) {
            const p = nagiosProblem(target, type, 'service', host, name, nagiosDetail(v), hardOnly);
            if (p)
                out.push(p);
        }
    }
    return out;
}

/** Hostnamen (hostlist) bzw. Dienste eines Hosts (servicelist). */
export function nagiosNames(json, host = null) {
    const data = json?.data ?? {};
    const names = host
        ? Object.keys(isPlainObject(data.servicelist?.[host]) ? data.servicelist[host] : {})
        : Object.keys(isPlainObject(data.hostlist) ? data.hostlist : {});
    return names.sort((a, b) => a.localeCompare(b));
}

export function nagiosGuiLink(target, problem) {
    const base = nagiosBase(target);
    if (!base)
        return null;
    const h = encodeURIComponent(problem.host);
    if (problem.kind === 'host')
        return `${base}/cgi-bin/extinfo.cgi?type=1&host=${h}`;
    return `${base}/cgi-bin/extinfo.cgi?type=2&host=${h}&service=${encodeURIComponent(problem.name)}`;
}

// ---------------------------------------------------------------------------
// Nagios XI (REST API /nagiosxi/api/v1/objects)
// ---------------------------------------------------------------------------

/** Basisadresse der API; eine URL mit oder ohne /nagiosxi wird akzeptiert. */
export function nagiosXiApiBase(target) {
    const url = (normalizeUrl(target.url) ?? '').replace(/\/nagiosxi(\/.*)?$/, '');
    return `${url}/nagiosxi/api/v1`;
}

/** Datensätze einer Antwort – neue Form {servicestatus: [...]}, alte {servicestatuslist: {servicestatus: ...}}. */
export function nagiosXiRecords(json, key) {
    if (!isPlainObject(json))
        return [];
    const value = json[key] ?? json[`${key}list`]?.[key];
    if (Array.isArray(value))
        return value.filter(isPlainObject);
    return isPlainObject(value) ? [value] : [];
}

/** XI liefert Zeiten meist als „2026-09-30 10:00:00“ (Ortszeit des Servers). */
export function nagiosXiTime(value) {
    if (typeof value === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}(:[0-9]{2})?$/.test(value.trim())) {
        const ms = Date.parse(value.trim().replace(' ', 'T'));
        return Number.isFinite(ms) && ms > 0 ? ms : null;
    }
    return toMillis(value);
}

function nagiosXiProblem(target, type, kind, r, hardOnly) {
    const host = String(r.host_name ?? (kind === 'host' ? r.name : '') ?? '').trim();
    const name = kind === 'host' ? '' : String(r.name ?? r.service_description ?? r.display_name ?? '').trim();
    if (!host || (kind === 'service' && !name) || (hardOnly && !isHardState(r.state_type)))
        return null;
    const { severity, label } = mapState(type, kind, stateKey(r.current_state));
    const log = kind === 'service' ? parseLogwatch(r.output) : null;
    return finishProblem({
        target: target.id,
        kind,
        host,
        name,
        severity,
        label,
        text: trimText(log ? log.message : r.output),
        log: !!log,
        count: log?.count ?? null,
        since: nagiosXiTime(r.last_state_change),
        acknowledged: positive(r.problem_has_been_acknowledged),
        downtime: positive(r.scheduled_downtime_depth),
    });
}

export function nagiosXiHostProblems(json, target, { hardOnly = true } = {}, type = getType(target.type)) {
    return nagiosXiRecords(json, 'hoststatus').map(r => nagiosXiProblem(target, type, 'host', r, hardOnly)).filter(Boolean);
}

export function nagiosXiServiceProblems(json, target, { hardOnly = true } = {}, type = getType(target.type)) {
    return nagiosXiRecords(json, 'servicestatus').map(r => nagiosXiProblem(target, type, 'service', r, hardOnly)).filter(Boolean);
}

export function nagiosXiNames(json, key) {
    const names = nagiosXiRecords(json, key)
        .map(r => String(key === 'hoststatus' ? r.host_name ?? r.name ?? '' : r.name ?? r.service_description ?? '').trim())
        .filter(Boolean);
    return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

export function nagiosXiGuiLink(target) {
    const url = normalizeUrl(target.url);
    return url ? `${url.replace(/\/nagiosxi(\/.*)?$/, '')}/nagiosxi/` : null;
}

/** Link zur Oberfläche des Monitoring-Systems für eine Meldung. */
export function guiLink(target, problem) {
    const type = getType(target.type);
    if (type.driver === 'checkmk-rest')
        return checkmkGuiLink(target, problem);
    if (type.driver === 'prometheus-kuma')
        return kumaGuiLink(target);
    if (type.driver === 'icinga2-rest')
        return icingaGuiLink(target, problem);
    if (type.driver === 'nagios-statusjson')
        return nagiosGuiLink(target, problem);
    if (type.driver === 'nagiosxi-rest')
        return nagiosXiGuiLink(target, problem);
    return null;
}
