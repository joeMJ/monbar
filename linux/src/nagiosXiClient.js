/**
 * nagiosXiClient.js - Treiber „nagiosxi-rest“: Nagios XI REST API
 *
 * Basis:     https://<server>/nagiosxi/api/v1
 * Anmeldung: API-Key des Benutzers (in XI unter „Help → API Docs“ bzw. im Benutzerprofil),
 *            als Parameter apikey=… – der Objects-Bereich ist nur lesend.
 *
 *   GET /objects/hoststatus?apikey=…&current_state=ne:0
 *   GET /objects/servicestatus?apikey=…&current_state=ne:0
 *
 * Die Filter werden zusätzlich in monbar angewandt: Kennt ein älteres XI den Filter
 * nicht und liefert alles, bleibt das Ergebnis trotzdem richtig.
 *
 * EXPERIMENTELL: nach der XI-Dokumentation gebaut, noch an keinem echten System getestet.
 */

import { createSession, httpGetJson } from './http.js';
import {
    nagiosXiApiBase, nagiosXiHostProblems, nagiosXiServiceProblems, nagiosXiNames,
} from './monUtil.js';

export class NagiosXiClient {
    constructor() {
        this._session = createSession(20);
    }

    destroy() {
        this._session?.abort();
        this._session = null;
    }

    async _objects(target, secret, endpoint, params, cancellable) {
        const query = [`apikey=${encodeURIComponent(secret)}`,
            ...Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`)].join('&');
        const res = await httpGetJson(this._session, `${nagiosXiApiBase(target)}/objects/${endpoint}?${query}`, {
            headers: { 'Accept': 'application/json' },
            insecure: target.insecure,
            cancellable,
        });
        if (!res.ok)
            return res;
        // XI meldet einen falschen Key mit HTTP 200 und {"error": "…"}
        if (typeof res.json?.error === 'string')
            return { ok: false, error: /key|auth|permission/i.test(res.json.error) ? 'auth' : 'format', message: res.json.error };
        return res;
    }

    _hostParam(hosts) {
        return Array.isArray(hosts) && hosts.length === 1 ? { host_name: hosts[0] } : {};
    }

    async fetchProblems(target, secret, plan, { hardOnly = true } = {}, cancellable = null) {
        const problems = [];

        if (plan.hosts !== false) {
            const res = await this._objects(target, secret, 'hoststatus',
                { current_state: 'ne:0', ...this._hostParam(plan.hosts) }, cancellable);
            if (!res.ok)
                return res;
            problems.push(...nagiosXiHostProblems(res.json, target, { hardOnly }));
        }

        if (plan.services !== false) {
            const res = await this._objects(target, secret, 'servicestatus',
                { current_state: 'ne:0', ...this._hostParam(plan.services) }, cancellable);
            if (!res.ok)
                return res;
            problems.push(...nagiosXiServiceProblems(res.json, target, { hardOnly }));
        }

        return { ok: true, problems, notes: [] };
    }

    async test(target, secret, cancellable = null) {
        const res = await this._objects(target, secret, 'hoststatus', { records: '1' }, cancellable);
        if (!res.ok)
            return res;
        const total = Number(res.json?.recordcount ?? res.json?.hoststatuslist?.recordcount);
        return { ok: true, message: `Verbunden – Nagios XI${Number.isFinite(total) ? `, ${total} Hosts` : ''}` };
    }

    async listHosts(target, secret, cancellable = null) {
        const res = await this._objects(target, secret, 'hoststatus', {}, cancellable);
        if (!res.ok)
            return res;
        return { ok: true, items: nagiosXiNames(res.json, 'hoststatus') };
    }

    async listServices(target, secret, host, cancellable = null) {
        const res = await this._objects(target, secret, 'servicestatus', { host_name: host }, cancellable);
        if (!res.ok)
            return res;
        return { ok: true, items: nagiosXiNames(res.json, 'servicestatus') };
    }
}
