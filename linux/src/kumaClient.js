/**
 * kumaClient.js - Treiber „prometheus-kuma“: Uptime Kuma über /metrics
 *
 * GET <url>/metrics  (Prometheus-Textformat)
 * Anmeldung per HTTP Basic Auth:
 *   - mit API-Key:  Benutzername leer (wird ignoriert), Passwort = API-Key
 *   - ohne API-Key: Uptime-Kuma-Benutzer und -Passwort (nur solange nie ein Key angelegt wurde)
 *
 * Die Socket.io-Schnittstelle von Uptime Kuma wird bewusst nicht genutzt: Sie ist
 * intern, nicht versioniert und ändert sich ohne Ankündigung.
 */

import { createSession, httpGet, basicAuth } from './http.js';
import {
    getType, normalizeUrl, parsePrometheus, kumaMonitors, kumaProblems, kumaInventory,
} from './monUtil.js';

export class KumaClient {
    constructor() {
        this._session = createSession(20);
    }

    destroy() {
        this._session?.abort();
        this._session = null;
    }

    async _monitors(target, secret, cancellable) {
        const url = normalizeUrl(target.url);
        const res = await httpGet(this._session, `${url}/metrics`, {
            headers: {
                'Authorization': basicAuth(target.username ?? '', secret),
                'Accept': 'text/plain',
            },
            insecure: target.insecure,
            cancellable,
        });
        if (!res.ok)
            return res;
        if (!/monitor_status/.test(res.text) && !/^#\s*(HELP|TYPE)/m.test(res.text))
            return { ok: false, error: 'format', message: 'Keine Prometheus-Daten – stimmt die Server-URL?' };
        return { ok: true, monitors: kumaMonitors(parsePrometheus(res.text)) };
    }

    /**
     * Probleme eines Ziels. Wirft nie. Die Auswahl nach Abos geschieht danach
     * zentral in filterProblems().
     */
    async fetchProblems(target, secret, _plan, _opts = {}, cancellable = null) {
        const res = await this._monitors(target, secret, cancellable);
        if (!res.ok)
            return res;
        return { ok: true, problems: kumaProblems(res.monitors, target), notes: [] };
    }

    async test(target, secret, cancellable = null) {
        const res = await this._monitors(target, secret, cancellable);
        if (!res.ok)
            return res;
        const n = res.monitors.length;
        return { ok: true, message: `Verbunden – ${n} Monitor${n === 1 ? '' : 'e'} gefunden` };
    }

    async listHosts(target, secret, cancellable = null) {
        const res = await this._monitors(target, secret, cancellable);
        if (!res.ok)
            return res;
        return { ok: true, items: [...kumaInventory(res.monitors, getType(target.type)).keys()] };
    }

    async listServices(target, secret, host, cancellable = null) {
        const res = await this._monitors(target, secret, cancellable);
        if (!res.ok)
            return res;
        return { ok: true, items: kumaInventory(res.monitors, getType(target.type)).get(host) ?? [] };
    }
}
