// Attrappe für linux/src/http.js: Antworten werden je Test per setRoutes() vorgegeben.
export const calls = [];
let routes = [];
export function setRoutes(r) { routes = r; calls.length = 0; }
export function createSession() { return { abort() {} }; }
export function basicAuth(u, p) { return `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`; }
export async function httpGet(_s, url, opts = {}) {
    calls.push({ url, headers: opts.headers ?? {}, insecure: !!opts.insecure });
    const route = routes.find(r => r.match(url));
    if (!route)
        return { ok: false, status: 404, text: '', error: 'notfound', message: 'HTTP 404' };
    const status = route.status ?? 200;
    const ok = status >= 200 && status < 300;
    const kind = { 401: 'auth', 403: 'auth', 404: 'notfound', 400: 'http', 500: 'server' }[status] ?? 'http';
    return { ok, status, text: route.text ?? JSON.stringify(route.json ?? {}), error: ok ? null : kind, message: ok ? '' : `HTTP ${status}` };
}
export async function httpGetJson(s, url, opts) {
    const res = await httpGet(s, url, opts);
    if (!res.ok) return { ...res, json: null };
    try { return { ...res, json: JSON.parse(res.text) }; } catch { return { ...res, ok: false, json: null, error: 'format', message: 'kein JSON' }; }
}
