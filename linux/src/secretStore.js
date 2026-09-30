/**
 * secretStore.js - Zugangsdaten der Ziele im GNOME-Schlüsselbund (libsecret / Secret Service)
 *
 * Jedes Ziel hat einen eigenen Eintrag (Attribut `key` = target-<id>). Die Secrets
 * liegen verschlüsselt im Login-Schlüsselbund, nie in dconf. Sichtbar/löschbar in
 * „Passwörter und Verschlüsselung“ (Seahorse) unter „monbar – <Name des Ziels>“.
 *
 * WICHTIG: Im GNOME-Shell-Prozess (extension.js) nur lookupSecretNoPrompt()
 * verwenden. Die übrigen Funktionen können bei gesperrtem Schlüsselbund einen
 * Entsperr-Dialog auslösen – das hat in dwdbar GNOME Shell zum Absturz gebracht
 * (free(): invalid pointer, z. B. nach Login per FIDO-Stick). Sie sind nur für
 * prefs.js (eigener Prozess) gedacht.
 */

import Secret from 'gi://Secret';
import GLib from 'gi://GLib';

const SCHEMA = new Secret.Schema(
    'org.gnome.shell.extensions.monbar',
    Secret.SchemaFlags.NONE,
    { 'key': Secret.SchemaAttributeType.STRING }
);

const NAME_PATTERN = /^target-t[a-z0-9]{6,16}$/;

const attributes = name => ({ 'key': name });

function checkName(name) {
    if (!NAME_PATTERN.test(name ?? ''))
        throw new Error(`Unbekannter Schlüsselbund-Eintrag: ${name}`);
}

/** Bezeichnung des Eintrags in „Passwörter und Verschlüsselung“. */
export function secretLabel(targetName) {
    return `monbar – ${targetName}`;
}

// ---------------------------------------------------------------------------
// Varianten MIT möglichem Entsperr-Dialog – nur für prefs.js
// ---------------------------------------------------------------------------

/**
 * Liest einen Eintrag aus dem Schlüsselbund.
 * @param {string} name
 * @param {Gio.Cancellable} [cancellable=null]
 * @returns {Promise<string|null>} Wert oder null, wenn nichts hinterlegt ist
 */
export function lookupSecret(name, cancellable = null) {
    checkName(name);
    return new Promise((resolve, reject) => {
        Secret.password_lookup(SCHEMA, attributes(name), cancellable, (_src, res) => {
            try {
                resolve(Secret.password_lookup_finish(res) || null);
            } catch (e) {
                reject(e);
            }
        });
    });
}

/**
 * Speichert einen Eintrag im Login-Schlüsselbund (überschreibt einen vorhandenen).
 * @param {string} name
 * @param {string} value
 * @param {string} label - Anzeigename, siehe secretLabel()
 * @param {Gio.Cancellable} [cancellable=null]
 * @returns {Promise<boolean>}
 */
export function storeSecret(name, value, label, cancellable = null) {
    checkName(name);
    return new Promise((resolve, reject) => {
        Secret.password_store(SCHEMA, attributes(name), Secret.COLLECTION_DEFAULT,
            label, value, cancellable, (_src, res) => {
                try {
                    resolve(Secret.password_store_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

/**
 * Entfernt einen Eintrag aus dem Schlüsselbund.
 * @param {string} name
 * @param {Gio.Cancellable} [cancellable=null]
 * @returns {Promise<boolean>} true, wenn ein Eintrag gelöscht wurde
 */
export function clearSecret(name, cancellable = null) {
    checkName(name);
    return new Promise((resolve, reject) => {
        Secret.password_clear(SCHEMA, attributes(name), cancellable, (_src, res) => {
            try {
                resolve(Secret.password_clear_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

// ---------------------------------------------------------------------------
// Variante OHNE Entsperr-Dialog – für den GNOME-Shell-Prozess
// ---------------------------------------------------------------------------

/**
 * Bricht ein Promise nach `seconds` mit einem Fehler ab. Verhindert, dass ein
 * hängender Secret-Service den Abruf-Zyklus der Extension dauerhaft blockiert.
 */
function withTimeout(promise, seconds) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            if (!settled) {
                settled = true;
                reject(new Error('Zeitüberschreitung beim Zugriff auf den Schlüsselbund'));
            }
            return GLib.SOURCE_REMOVE;
        });
        const done = fn => value => {
            if (settled)
                return;
            settled = true;
            GLib.Source.remove(id);
            fn(value);
        };
        promise.then(done(resolve), done(reject));
    });
}

function getService(cancellable) {
    return new Promise((resolve, reject) => {
        Secret.Service.get(Secret.ServiceFlags.NONE, cancellable, (_src, res) => {
            try {
                resolve(Secret.Service.get_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

function searchItems(service, name, cancellable) {
    // Bewusst OHNE Secret.SearchFlags.UNLOCK: gesperrte Einträge werden nur
    // gemeldet, nie entsperrt – es erscheint kein Dialog.
    return new Promise((resolve, reject) => {
        service.search(SCHEMA, attributes(name),
            Secret.SearchFlags.ALL | Secret.SearchFlags.LOAD_SECRETS,
            cancellable, (_src, res) => {
                try {
                    resolve(service.search_finish(res) ?? []);
                } catch (e) {
                    reject(e);
                }
            });
    });
}

async function lookupNoPrompt(name, cancellable) {
    const service = await getService(cancellable);
    const items = await searchItems(service, name, cancellable);
    if (items.length === 0)
        return { value: null, locked: false };

    const unlocked = items.find(item => !item.locked);
    if (!unlocked)
        return { value: null, locked: true };

    return { value: unlocked.get_secret()?.get_text() || null, locked: false };
}

/**
 * Liest einen Eintrag, ohne jemals einen Entsperr-Dialog auszulösen.
 * Wirft nie wegen eines gesperrten Schlüsselbunds, sondern meldet ihn.
 * @param {string} name
 * @param {Gio.Cancellable} [cancellable=null]
 * @returns {Promise<{value: string|null, locked: boolean}>}
 *   locked = true: Eintrag vorhanden, aber Schlüsselbund gesperrt
 */
export function lookupSecretNoPrompt(name, cancellable = null) {
    checkName(name);
    return withTimeout(lookupNoPrompt(name, cancellable), 15);
}
