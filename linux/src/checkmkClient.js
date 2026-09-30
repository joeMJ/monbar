/**
 * checkmkClient.js - Treiber „checkmk-rest“: Checkmk REST API
 *
 * Basis:   <url>/<site>/check_mk/api/<version>   (v1 ab Checkmk 2.5, 1.0 bis 2.4)
 * Anmeldung: Authorization: Bearer <Automationsbenutzer> <Secret>
 *
 * Abgefragt werden nur Probleme (Livestatus-Filter state != 0), nicht alle Objekte:
 *   GET /domain-types/host/collections/all            Hosts nicht UP
 *   GET /domain-types/service/collections/all         Services nicht OK
 *   GET /domain-types/event_console/collections/all   offene Event-Console-Meldungen
 */

import { createSession, httpGetJson } from './http.js';
import {
    getType, hasCapability, checkmkApiBase, checkmkCollectionQuery, checkmkRows,
    checkmkHostQuery, checkmkServiceQuery, checkmkHostProblems, checkmkServiceProblems,
    checkmkEventProblems, CHECKMK_HOST_COLUMNS, CHECKMK_SERVICE_COLUMNS,
} from './monUtil.js';

const DEFAULT_VERSIONS = ['v1', '1.0'];

export class CheckmkClient {
    constructor() {
        this._session = createSession(20);
        this._versions = new Map();          // Ziel-ID → erkannte API-Version
        this._noStateType = new Set();       // Ziele, deren Server den Filter state_type ablehnt
        this._noEvents = new Set();          // Ziele ohne Event-Console-Endpunkt
    }

    destroy() {
        this._session?.abort();
        this._session = null;
    }

    _headers(target, secret) {
        return {
            'Authorization': `Bearer ${target.username} ${secret}`,
            'Accept': 'application/json',
        };
    }

    _opts(target, secret, cancellable) {
        return { headers: this._headers(target, secret), insecure: target.insecure, cancellable };
    }

    /** Ermittelt die API-Version (v1 oder 1.0) über /version. */
    async _version(target, secret, cancellable, force = false) {
        if (!force && this._versions.has(target.id))
            return { ok: true, version: this._versions.get(target.id) };

        const versions = getType(target.type).options?.apiVersions ?? DEFAULT_VERSIONS;
        let last = null;
        for (const v of versions) {
            const res = await httpGetJson(this._session, `${checkmkApiBase(target, v)}/version`,
                this._opts(target, secret, cancellable));
            if (res.ok) {
                this._versions.set(target.id, v);
                return { ok: true, version: v, info: res.json };
            }
            last = res;
            // 404: diese Version gibt es hier nicht → nächste; alles andere ist ein echter Fehler
            if (res.error !== 'notfound')
                break;
        }
        return {
            ok: false,
            error: last?.error ?? 'notfound',
            message: last?.error === 'notfound'
                ? 'REST API nicht gefunden – stimmen Server-URL und Instanz?'
                : last?.message ?? 'Unbekannter Fehler',
        };
    }

    async _collection(target, secret, version, domain, columns, query, cancellable) {
        const url = `${checkmkApiBase(target, version)}/domain-types/${domain}/collections/all?${checkmkCollectionQuery(columns, query)}`;
        return httpGetJson(this._session, url, this._opts(target, secret, cancellable));
    }

    /**
     * Probleme eines Ziels. Wirft nie.
     * @param {object} target
     * @param {string} secret
     * @param {{hosts, services, events}} plan - siehe queryPlan()
     * @param {{hardOnly: boolean}} opts
     * @param {Gio.Cancellable} cancellable
     * @returns {Promise<{ok: true, problems: object[], notes: string[]} | {ok: false, error, message}>}
     */
    async fetchProblems(target, secret, plan, { hardOnly = true } = {}, cancellable = null) {
        const ver = await this._version(target, secret, cancellable);
        if (!ver.ok)
            return ver;
        const version = ver.version;
        const problems = [];
        const notes = [];

        if (plan.hosts !== false) {
            const res = await this._collection(target, secret, version, 'host',
                CHECKMK_HOST_COLUMNS, checkmkHostQuery(plan.hosts), cancellable);
            if (!res.ok) {
                if (res.error === 'notfound')
                    this._versions.delete(target.id);   // beim nächsten Mal Version neu ermitteln
                return res;
            }
            problems.push(...checkmkHostProblems(checkmkRows(res.json), target));
        }

        if (plan.services !== false) {
            const useStateType = hardOnly && !this._noStateType.has(target.id);
            let res = await this._collection(target, secret, version, 'service',
                CHECKMK_SERVICE_COLUMNS, checkmkServiceQuery(plan.services, useStateType), cancellable);
            if (!res.ok && res.status === 400 && useStateType) {
                // Ältere Server kennen state_type als Filter nicht → ohne, dann hier nachfiltern
                this._noStateType.add(target.id);
                res = await this._collection(target, secret, version, 'service',
                    CHECKMK_SERVICE_COLUMNS.filter(c => c !== 'state_type'),
                    checkmkServiceQuery(plan.services, false), cancellable);
            }
            if (!res.ok)
                return res;
            problems.push(...checkmkServiceProblems(checkmkRows(res.json), target, { hardOnly }));
        }

        if (plan.events !== false && hasCapability(getType(target.type), 'events') && !this._noEvents.has(target.id)) {
            const single = Array.isArray(plan.events) && plan.events.length === 1
                ? `?host=${encodeURIComponent(plan.events[0])}` : '';
            const res = await httpGetJson(this._session,
                `${checkmkApiBase(target, version)}/domain-types/event_console/collections/all${single}`,
                this._opts(target, secret, cancellable));
            if (res.ok) {
                problems.push(...checkmkEventProblems(res.json, target, plan.events));
            } else if (res.error === 'cancelled') {
                return res;
            } else if (res.status === 404 || res.status === 400 || res.status === 405) {
                // Event Console nicht verfügbar (ältere Version oder deaktiviert): nicht erneut versuchen
                this._noEvents.add(target.id);
                notes.push('events-unsupported');
            } else {
                notes.push('events-failed');
            }
        } else if (this._noEvents.has(target.id) && plan.events !== false) {
            notes.push('events-unsupported');
        }

        return { ok: true, problems, notes };
    }

    /** Verbindungstest für die Einstellungen. */
    async test(target, secret, cancellable = null) {
        const ver = await this._version(target, secret, cancellable, true);
        if (!ver.ok)
            return ver;
        const v = ver.info?.versions?.checkmk ?? '';
        const edition = ver.info?.edition ? ` (${ver.info.edition})` : '';
        return { ok: true, message: `Verbunden – Checkmk ${v}${edition}, REST API ${ver.version}`.replace(/\s+,/, ',') };
    }

    /** Alle Hosts (für die Abo-Auswahl in den Einstellungen). */
    async listHosts(target, secret, cancellable = null) {
        const ver = await this._version(target, secret, cancellable);
        if (!ver.ok)
            return ver;
        // Die REST API verlangt mindestens zwei Spalten
        const res = await this._collection(target, secret, ver.version, 'host', ['name', 'alias'], null, cancellable);
        if (!res.ok)
            return res;
        const names = checkmkRows(res.json).map(r => r.name).filter(n => typeof n === 'string' && n);
        return { ok: true, items: [...new Set(names)].sort((a, b) => a.localeCompare(b)) };
    }

    /** Alle Services eines Hosts. */
    async listServices(target, secret, host, cancellable = null) {
        const ver = await this._version(target, secret, cancellable);
        if (!ver.ok)
            return ver;
        const res = await this._collection(target, secret, ver.version, 'service', ['host_name', 'description'],
            { op: '=', left: 'host_name', right: host }, cancellable);
        if (!res.ok)
            return res;
        const names = checkmkRows(res.json).map(r => r.description).filter(n => typeof n === 'string' && n);
        return { ok: true, items: [...new Set(names)].sort((a, b) => a.localeCompare(b)) };
    }
}
