/**
 * nagiosClient.js - Treiber „nagios-statusjson“: Nagios Core ab 4.0.7
 *
 * Basis:     <Weboberfläche>/cgi-bin/statusjson.cgi, z. B. https://server/nagios
 * Anmeldung: HTTP Basic Auth – dieselben Zugangsdaten wie für die Weboberfläche.
 *            Der Benutzer muss die Hosts/Dienste sehen dürfen (cgi.cfg, z. B.
 *            authorized_for_all_hosts / authorized_for_all_services).
 *
 *   ?query=hostlist&details=true&hoststatus=down+unreachable&formatoptions=enumerate
 *   ?query=servicelist&details=true&servicestatus=warning+critical+unknown&formatoptions=enumerate
 *
 * EXPERIMENTELL: nach Dokumentation und Quellcode der JSON-CGI gebaut, noch an keinem
 * echten System getestet.
 */

import { createSession, httpGetJson, basicAuth } from './http.js';
import {
    nagiosQueryUrl, nagiosResultError, nagiosHostProblems, nagiosServiceProblems, nagiosNames,
} from './monUtil.js';

export class NagiosClient {
    constructor() {
        this._session = createSession(20);
    }

    destroy() {
        this._session?.abort();
        this._session = null;
    }

    async _query(target, secret, query, params, cancellable) {
        const res = await httpGetJson(this._session, nagiosQueryUrl(target, query, params), {
            headers: {
                'Authorization': basicAuth(target.username, secret),
                'Accept': 'application/json',
            },
            insecure: target.insecure,
            cancellable,
        });
        if (!res.ok)
            return res.error === 'notfound'
                ? { ...res, message: 'statusjson.cgi nicht gefunden – stimmt die Adresse der Weboberfläche (z. B. …/nagios)?' }
                : res;
        const error = nagiosResultError(res.json);
        if (error)
            return { ok: false, error: 'format', message: error };
        return res;
    }

    /** Die CGI kennt nur einen Host je Abfrage – bei mehreren Hosts alle holen, monbar filtert. */
    _hostParam(hosts) {
        return Array.isArray(hosts) && hosts.length === 1 ? hosts[0] : null;
    }

    async fetchProblems(target, secret, plan, { hardOnly = true } = {}, cancellable = null) {
        const problems = [];

        if (plan.hosts !== false) {
            const res = await this._query(target, secret, 'hostlist', {
                details: 'true',
                hoststatus: 'down+unreachable',
                formatoptions: 'enumerate',
            }, cancellable);
            if (!res.ok)
                return res;
            problems.push(...nagiosHostProblems(res.json, target, { hardOnly }));
        }

        if (plan.services !== false) {
            const res = await this._query(target, secret, 'servicelist', {
                details: 'true',
                servicestatus: 'warning+critical+unknown',
                formatoptions: 'enumerate',
                hostname: this._hostParam(plan.services),
            }, cancellable);
            if (!res.ok)
                return res;
            problems.push(...nagiosServiceProblems(res.json, target, { hardOnly }));
        }

        return { ok: true, problems, notes: [] };
    }

    async test(target, secret, cancellable = null) {
        const res = await this._query(target, secret, 'programstatus', {}, cancellable);
        if (!res.ok)
            return res;
        const version = res.json?.data?.programstatus?.version;
        return { ok: true, message: `Verbunden – Nagios Core${version ? ` ${version}` : ''}` };
    }

    async listHosts(target, secret, cancellable = null) {
        const res = await this._query(target, secret, 'hostlist', {}, cancellable);
        if (!res.ok)
            return res;
        return { ok: true, items: nagiosNames(res.json) };
    }

    async listServices(target, secret, host, cancellable = null) {
        const res = await this._query(target, secret, 'servicelist', { hostname: host }, cancellable);
        if (!res.ok)
            return res;
        return { ok: true, items: nagiosNames(res.json, host) };
    }
}
