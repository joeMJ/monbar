/**
 * targetTypes.js - Zielarten-Datenbank (reine Logik, ohne GNOME-Abhängigkeiten)
 *
 * Die Datenbank ist eine JSON-Datei (linux/data/targets.json) mit den Zielarten,
 * die monbar kennt: Name, Treiber, benötigte Felder, Fähigkeiten, Übersetzung der
 * Status-Werte und Abfrageintervalle.
 *
 * SICHERHEIT: Die Datenbank enthält ausschließlich Daten. Der Programmcode, der
 * ein Ziel abfragt (der Treiber), ist fest in monbar hinterlegt; `driver` verweist
 * nur darauf. Adressen und Zugangsdaten stammen immer aus deiner eigenen
 * Konfiguration, nie aus der Datenbank. Eine manipulierte Datenbank kann daher
 * keine Secrets an fremde Server umleiten.
 *
 * Neue Zielarten, die einen vorhandenen Treiber nutzen, kommen per Datenbank-Update.
 * Eine Zielart mit neuem Protokoll (z. B. Nagios) braucht einen neuen Treiber im Code.
 */

/** Höchstes Datenbank-Schema, das diese Version der Extension versteht. */
export const SCHEMA_VERSION = 1;

/** Felder, die ein Ziel haben kann (Eingabezeilen in den Einstellungen). */
export const FIELDS = ['url', 'site', 'username', 'secret'];

/** Normierte Schweregrade, auf die alle Status-Werte abgebildet werden. */
export const SEVERITIES = ['ok', 'warn', 'crit', 'unknown', 'maintenance'];

/** Arten von Meldungen. */
export const KINDS = ['host', 'service', 'event'];

/**
 * Treiber, die der Code mitbringt, mit den Feldern und Fähigkeiten, die sie
 * unterstützen. `required` muss jede Zielart mit diesem Treiber anbieten.
 */
export const DRIVERS = {
    'checkmk-rest': {
        fields: ['url', 'site', 'username', 'secret'],
        required: ['url', 'site', 'username', 'secret'],
        capabilities: ['services', 'events'],
        kinds: ['host', 'service', 'event'],
    },
    'prometheus-kuma': {
        fields: ['url', 'username', 'secret'],
        required: ['url', 'secret'],
        capabilities: ['services'],
        kinds: ['service'],
    },
};

const ID_PATTERN = /^[a-z0-9-]{2,20}$/;
const MAX_TYPES = 30;
const MIN_INTERVAL = 1;
const MAX_INTERVAL = 1440;

const DEFAULT_INTERVAL_CHOICES = [1, 2, 5, 10, 15, 30, 60];

const FIELD_LABELS = {
    url: 'Server-URL',
    site: 'Instanz',
    username: 'Benutzer',
    secret: 'Secret',
};

/**
 * Laufende Registry der Zielarten. Wird von applyTargetTypes() in-place
 * aktualisiert, damit alle Module, die sie importieren, sofort den neuen Stand sehen.
 */
export const TYPES = {};

let activeVersion = 0;
let activeUpdated = '';
let activeIntervalChoices = [...DEFAULT_INTERVAL_CHOICES];

/** Notfall-Datenbank, falls weder die mitgelieferte noch eine geladene Datei lesbar ist. */
const FALLBACK_DB = {
    schema: SCHEMA_VERSION,
    version: 0,
    types: [
        {
            id: 'checkmk',
            name: 'Checkmk',
            driver: 'checkmk-rest',
            fields: ['url', 'site', 'username', 'secret'],
            capabilities: ['services', 'events'],
            stateMap: {
                host: {
                    0: { severity: 'ok', label: 'UP' },
                    1: { severity: 'crit', label: 'DOWN' },
                    2: { severity: 'crit', label: 'UNREACH' },
                },
                service: {
                    0: { severity: 'ok', label: 'OK' },
                    1: { severity: 'warn', label: 'WARN' },
                    2: { severity: 'crit', label: 'CRIT' },
                    3: { severity: 'unknown', label: 'UNKNOWN' },
                },
            },
        },
        {
            id: 'uptimekuma',
            name: 'Uptime Kuma',
            driver: 'prometheus-kuma',
            fields: ['url', 'username', 'secret'],
            capabilities: ['services'],
            stateMap: {
                service: {
                    0: { severity: 'crit', label: 'DOWN' },
                    1: { severity: 'ok', label: 'UP' },
                    2: { severity: 'warn', label: 'PENDING' },
                    3: { severity: 'maintenance', label: 'WARTUNG' },
                },
            },
        },
    ],
};

export function isText(value, max) {
    return typeof value === 'string' && value.length >= 1 && value.length <= max
        && !/[\u0000-\u001f\u007f]/.test(value);
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validInterval(value) {
    return Number.isInteger(value) && value >= MIN_INTERVAL && value <= MAX_INTERVAL ? value : null;
}

function validateIntervalChoices(raw) {
    if (!Array.isArray(raw))
        return null;
    const choices = [...new Set(raw.map(validInterval).filter(v => v !== null))].sort((a, b) => a - b);
    return choices.length > 0 && choices.length <= 12 ? choices : null;
}

/**
 * Status-Übersetzung: je Art (host, service, event) eine Tabelle
 * Rohwert → {severity, label}. Rohwerte sind Zahlen oder kurze Namen.
 */
function validateStateMap(raw, kinds) {
    const out = {};
    if (!isPlainObject(raw))
        return out;
    for (const kind of kinds) {
        const map = raw[kind];
        if (!isPlainObject(map))
            continue;
        const clean = {};
        for (const [key, entry] of Object.entries(map).slice(0, 40)) {
            if (!/^[A-Za-z0-9_-]{1,20}$/.test(key) || !isPlainObject(entry))
                continue;
            if (!SEVERITIES.includes(entry.severity))
                continue;
            const value = { severity: entry.severity };
            if (isText(entry.label, 20))
                value.label = entry.label.trim();
            clean[key] = value;
        }
        if (Object.keys(clean).length > 0)
            out[kind] = clean;
    }
    return out;
}

/** Treiber-spezifische Optionen. Nur bekannte Schlüssel, nur harmlose Werte. */
function validateOptions(driver, raw) {
    const out = {};
    if (!isPlainObject(raw))
        return out;
    if (driver === 'checkmk-rest') {
        if (Array.isArray(raw.apiVersions)) {
            const versions = raw.apiVersions
                .filter(v => typeof v === 'string' && /^(v[0-9]{1,2}|[0-9]{1,2}\.[0-9]{1,2}|unstable)$/.test(v))
                .slice(0, 4);
            if (versions.length > 0)
                out.apiVersions = [...new Set(versions)];
        }
    }
    if (driver === 'prometheus-kuma') {
        if (Number.isInteger(raw.certWarnDays) && raw.certWarnDays >= 0 && raw.certWarnDays <= 365)
            out.certWarnDays = raw.certWarnDays;
        if (Array.isArray(raw.skipMonitorTypes)) {
            out.skipMonitorTypes = raw.skipMonitorTypes
                .filter(v => typeof v === 'string' && /^[a-z0-9-]{1,20}$/.test(v))
                .slice(0, 20);
        }
    }
    return out;
}

function validateTextMap(raw, keys, max) {
    const out = {};
    if (!isPlainObject(raw))
        return out;
    for (const key of keys) {
        if (isText(raw[key], max))
            out[key] = raw[key].trim();
    }
    return out;
}

function validateType(item) {
    if (!isPlainObject(item))
        return null;
    if (typeof item.id !== 'string' || !ID_PATTERN.test(item.id))
        return null;
    if (!isText(item.name, 30))
        return null;
    const driver = DRIVERS[item.driver];
    if (!driver)
        return null;     // unbekannter Treiber (z. B. aus einem neueren monbar) → Zielart überspringen

    const fields = Array.isArray(item.fields)
        ? FIELDS.filter(f => item.fields.includes(f) && driver.fields.includes(f))
        : [...driver.fields];
    for (const f of driver.required) {
        if (!fields.includes(f))
            fields.push(f);
    }
    // Reihenfolge wie in FIELDS
    fields.sort((a, b) => FIELDS.indexOf(a) - FIELDS.indexOf(b));

    const capabilities = Array.isArray(item.capabilities)
        ? driver.capabilities.filter(c => item.capabilities.includes(c))
        : [...driver.capabilities];

    const docsUrl = isText(item.docsUrl, 300) && item.docsUrl.startsWith('https://') && !/\s/.test(item.docsUrl)
        ? item.docsUrl : '';

    const minInterval = validInterval(item.minInterval);
    let defaultInterval = validInterval(item.defaultInterval);
    if (defaultInterval && minInterval && defaultInterval < minInterval)
        defaultInterval = minInterval;

    return {
        id: item.id,
        name: item.name.trim(),
        driver: item.driver,
        description: isText(item.description, 400) ? item.description.trim() : '',
        docsUrl,
        fields,
        labels: validateTextMap(item.labels, FIELDS, 40),
        hints: validateTextMap(item.hints, FIELDS, 300),
        capabilities,
        minInterval,
        defaultInterval,
        options: validateOptions(item.driver, item.options),
        stateMap: validateStateMap(item.stateMap, driver.kinds),
    };
}

/**
 * Prüft eine geladene Datenbank und gibt eine bereinigte Kopie zurück.
 * Einzelne ungültige Einträge werden übersprungen (`skipped`), die Datenbank
 * als Ganzes wird nur bei Strukturfehlern oder zu neuem Schema abgelehnt.
 *
 * @param {any} data
 * @returns {{ok: true, db: object, skipped: number} | {ok: false, error: string}}
 */
export function validateTargetDb(data) {
    if (!isPlainObject(data))
        return { ok: false, error: 'Keine gültige Zielarten-Datenbank' };
    if (!Number.isInteger(data.schema) || data.schema < 1)
        return { ok: false, error: 'Schema-Version fehlt' };
    if (data.schema > SCHEMA_VERSION)
        return { ok: false, error: `Die Datenbank benötigt eine neuere monbar-Version (Schema ${data.schema})` };
    if (!Number.isInteger(data.version) || data.version < 0)
        return { ok: false, error: 'Versionsnummer fehlt' };
    if (!Array.isArray(data.types) || data.types.length === 0 || data.types.length > MAX_TYPES)
        return { ok: false, error: 'Liste der Zielarten fehlt oder ist zu groß' };

    const seen = new Set();
    const types = [];
    let skipped = 0;
    for (const item of data.types) {
        const type = validateType(item);
        if (!type || seen.has(type.id)) {
            skipped++;
            continue;
        }
        seen.add(type.id);
        types.push(type);
    }
    if (types.length === 0)
        return { ok: false, error: 'Keine gültige Zielart in der Datenbank' };

    return {
        ok: true,
        skipped,
        db: {
            schema: data.schema,
            version: data.version,
            updated: isText(data.updated, 20) ? data.updated : '',
            intervals: validateIntervalChoices(data.intervals),
            types,
        },
    };
}

/** Macht die (bereits validierte) Datenbank zur aktiven Registry. */
export function applyTargetTypes(db) {
    for (const id of Object.keys(TYPES))
        delete TYPES[id];
    for (const t of db.types)
        TYPES[t.id] = { ...t, known: true };
    activeIntervalChoices = db.intervals ?? [...DEFAULT_INTERVAL_CHOICES];
    activeVersion = db.version;
    activeUpdated = db.updated ?? '';
}

/** Liste der Zielarten-IDs in Reihenfolge der Datenbank. */
export function typeIds() {
    return Object.keys(TYPES);
}

/**
 * Zielart zu einer ID. Für unbekannte IDs (z. B. aus der Datenbank entfernt) gibt es
 * einen Platzhalter, damit eingetragene Ziele nicht verloren gehen – sie werden
 * dann nur nicht abgefragt.
 */
export function getType(id) {
    return TYPES[id] ?? {
        id,
        name: id,
        driver: null,
        description: '',
        docsUrl: '',
        fields: ['url', 'secret'],
        labels: {},
        hints: {},
        capabilities: [],
        minInterval: null,
        defaultInterval: null,
        options: {},
        stateMap: {},
        known: false,
    };
}

/** Bezeichnung eines Feldes für eine Zielart (aus der Datenbank oder eingebaut). */
export function fieldLabel(type, field) {
    return type?.labels?.[field] ?? FIELD_LABELS[field] ?? field;
}

/** true, wenn die Zielart die Fähigkeit hat (z. B. 'events'). */
export function hasCapability(type, capability) {
    return !!type?.capabilities?.includes(capability);
}

/**
 * Übersetzung eines Rohwerts (Zahl oder Name) in Schweregrad und Anzeigetext.
 * @returns {{severity: string, label: string}}
 */
export function mapState(type, kind, raw) {
    const map = type?.stateMap?.[kind];
    const key = String(raw);
    if (map && Object.hasOwn(map, key))
        return { severity: map[key].severity, label: map[key].label ?? key };
    return { severity: 'unknown', label: key.toUpperCase() };
}

/** Auswahl für das Abfrageintervall (Minuten), aus der Datenbank oder eingebaut. */
export function getIntervalChoices() {
    return [...activeIntervalChoices];
}

export function activeTypesVersion() {
    return activeVersion;
}

export function activeTypesUpdated() {
    return activeUpdated;
}

/** true, wenn die Datenbank `candidate` neuer ist als `current`. */
export function isNewerVersion(candidate, current) {
    return Number.isInteger(candidate) && candidate > current;
}

// Beim Laden des Moduls ist die Registry nie leer.
applyTargetTypes(validateTargetDb(FALLBACK_DB).db);
