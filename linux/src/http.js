/**
 * http.js - Gemeinsamer HTTP-Abruf für alle Treiber (libsoup 3)
 */

import Soup from 'gi://Soup?version=3.0';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { httpErrorKind, networkErrorKind } from './monUtil.js';

try {
    Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');
} catch (e) {
    // Bereits promisified
}

const MAX_BODY_BYTES = 8 * 1024 * 1024;

export function createSession(timeout = 20) {
    return new Soup.Session({
        timeout,
        user_agent: 'monbar-gnome-extension',
    });
}

/**
 * GET-Anfrage. Wirft nie – Fehler kommen als `{ok: false, error, message, status}`
 * zurück (error: auth | notfound | ratelimit | server | http | tls | network | cancelled).
 *
 * @param {Soup.Session} session
 * @param {string} url - bereits kodierte Adresse
 * @param {object} [opts]
 * @param {object} [opts.headers]
 * @param {boolean} [opts.insecure] - Zertifikat nicht prüfen (selbst signiert)
 * @param {Gio.Cancellable} [opts.cancellable]
 * @returns {Promise<{ok: boolean, status: number, text: string, error: string|null, message: string}>}
 */
export async function httpGet(session, url, { headers = {}, insecure = false, cancellable = null } = {}) {
    try {
        const message = new Soup.Message({
            method: 'GET',
            uri: GLib.Uri.parse(url, GLib.UriFlags.ENCODED),
        });
        for (const [name, value] of Object.entries(headers))
            message.request_headers.append(name, value);
        if (insecure)
            message.connect('accept-certificate', () => true);

        const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable);
        const status = message.get_status();
        if (bytes.get_size() > MAX_BODY_BYTES)
            return { ok: false, status, text: '', error: 'http', message: 'Antwort unerwartet groß' };

        const text = new TextDecoder('utf-8').decode(bytes.toArray());
        const ok = status >= 200 && status < 300;
        return {
            ok,
            status,
            text,
            error: ok ? null : httpErrorKind(status),
            message: ok ? '' : `HTTP ${status}`,
        };
    } catch (e) {
        if (cancellable?.is_cancelled())
            return { ok: false, status: 0, text: '', error: 'cancelled', message: 'Abgebrochen' };
        return { ok: false, status: 0, text: '', error: networkErrorKind(e.message), message: e.message };
    }
}

/** Wie httpGet, wertet die Antwort aber als JSON aus. */
export async function httpGetJson(session, url, opts = {}) {
    const res = await httpGet(session, url, opts);
    if (!res.ok)
        return { ...res, json: null };
    try {
        return { ...res, json: JSON.parse(res.text) };
    } catch (_e) {
        return { ...res, ok: false, json: null, error: 'format', message: 'Antwort ist kein JSON – stimmen URL und Instanz?' };
    }
}

/** Basic-Auth-Kopfzeile. */
export function basicAuth(username, password) {
    return `Basic ${GLib.base64_encode(new TextEncoder().encode(`${username}:${password}`))}`;
}
