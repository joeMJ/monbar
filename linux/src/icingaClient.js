/**
 * icingaClient.js - Treiber „icinga2-rest“: Icinga 2 REST API
 *
 * Basis:     https://<server>:5665/v1
 * Anmeldung: HTTP Basic Auth mit einem ApiUser, z. B.
 *              object ApiUser "monbar" {
 *                password = "…"
 *                permissions = [ "objects/query/Host", "objects/query/Service" ]
 *              }
 *
 * Abgefragt werden nur Probleme (Filter state != 0):
 *   GET /v1/objects/hosts?attrs=…&filter=host.state!=0
 *   GET /v1/objects/services?attrs=…&joins=host.downtime_depth&filter=service.state!=0
 *
 * EXPERIMENTELL: nach der Icinga-Dokumentation gebaut, noch an keinem echten System getestet.
 */

import { createSession, httpGetJson, basicAuth } from './http.js';
import {
    icingaApiBase, icingaFilter, icingaQuery, icingaHostProblems, icingaServiceProblems, icingaNames,
    ICINGA_HOST_ATTRS, ICINGA_SERVICE_ATTRS,
} from './monUtil.js';

export class IcingaClient {
    constructor() {
        this._session = createSession(20);
        // Ziele, deren Server Filterausdrücke ablehnt (z. B. fehlende Berechtigung) → ohne Filter
        this._noFilter = new Set();
    }

    destroy() {
        this._session?.abort();
        this._session = null;
    }

    _opts(target, secret, cancellable) {
        return {
            headers: {
                'Authorization': basicAuth(target.username, secret),
                'Accept': 'application/json',
            },
            insecure: target.insecure,
            cancellable,
        };
    }

    async _objects(target, secret, type, attrs, { filter = null, joins = [] } = {}, cancellable = null) {
        const useFilter = filter && !this._noFilter.has(target.id);
        const url = `${icingaApiBase(target)}/objects/${type}?${icingaQuery(attrs, { filter: useFilter ? filter : null, joins })}`;
        const res = await httpGetJson(this._session, url, this._opts(target, secret, cancellable));
        if (!res.ok && useFilter && (res.status === 400 || res.status === 403)) {
            // Filter nicht erlaubt oder nicht verstanden → alles holen und in monbar filtern
            this._noFilter.add(target.id);
            return this._objects(target, secret, type, attrs, { joins }, cancellable);
        }
        return res;
    }

    async fetchProblems(target, secret, plan, { hardOnly = true } = {}, cancellable = null) {
        const problems = [];

        if (plan.hosts !== false) {
            const res = await this._objects(target, secret, 'hosts', ICINGA_HOST_ATTRS,
                { filter: icingaFilter('host', plan.hosts, hardOnly) }, cancellable);
            if (!res.ok)
                return res;
            problems.push(...icingaHostProblems(res.json, target, { hardOnly }));
        }

        if (plan.services !== false) {
            const res = await this._objects(target, secret, 'services', ICINGA_SERVICE_ATTRS,
                { filter: icingaFilter('service', plan.services, hardOnly), joins: ['host.downtime_depth'] }, cancellable);
            if (!res.ok)
                return res;
            problems.push(...icingaServiceProblems(res.json, target, { hardOnly }));
        }

        return { ok: true, problems, notes: [] };
    }

    async test(target, secret, cancellable = null) {
        const res = await this._objects(target, secret, 'hosts', ['name'], {}, cancellable);
        if (!res.ok)
            return res;
        const n = Array.isArray(res.json?.results) ? res.json.results.length : 0;
        return { ok: true, message: `Verbunden – ${n} Host${n === 1 ? '' : 's'} sichtbar` };
    }

    async listHosts(target, secret, cancellable = null) {
        const res = await this._objects(target, secret, 'hosts', ['name'], {}, cancellable);
        if (!res.ok)
            return res;
        return { ok: true, items: icingaNames(res.json) };
    }

    async listServices(target, secret, host, cancellable = null) {
        const res = await this._objects(target, secret, 'services', ['name', 'display_name', 'host_name'],
            { filter: `service.host_name==${JSON.stringify(host)}` }, cancellable);
        if (!res.ok)
            return res;
        // Ohne Filter (siehe oben) kommen alle Dienste – hier auf den Host eingrenzen
        const json = {
            results: (res.json?.results ?? []).filter(r => (r?.attrs?.host_name ?? String(r?.name ?? '').split('!')[0]) === host),
        };
        return { ok: true, items: icingaNames(json, { service: true }) };
    }
}
