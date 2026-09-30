/**
 * extension.js - Haupteinstiegspunkt für monbar (GNOME 46 - 50)
 */

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { MonIndicator } from './src/indicator.js';
import { createDrivers, destroyDrivers } from './src/drivers.js';
import { UpdateChecker } from './src/updater.js';
import { lookupSecretNoPrompt } from './src/secretStore.js';
import { loadTargetTypes, updateTargetTypes } from './src/targetDb.js';
import {
    getType, parseTargets, parseSubscriptions, serializeSubscriptions, secretName, targetProblem,
    effectiveInterval, isDue, queryPlan, filterProblems, sortProblems, newProblems, guiLink,
    addIgnoreForProblem,
} from './src/monUtil.js';

const TICK_SECONDS = 30;
const MANUAL_REFRESH_GAP_MS = 10 * 1000;
const META_CHECK_MS = 60 * 60 * 1000;
const MAX_NOTIFY_SINGLE = 3;

export default class MonBarExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._cancellable = new Gio.Cancellable();

        // Zielarten (mitgeliefert oder heruntergeladen, die neuere gilt)
        this._typesInfo = loadTargetTypes(this.path);
        this._drivers = createDrivers();
        this._updateChecker = new UpdateChecker(this.metadata.version || 1);

        this._results = new Map();       // Ziel-ID → letztes Ergebnis
        this._lastAttempt = new Map();   // Ziel-ID → letzter Abfrageversuch (ms)
        this._knownKeys = new Map();     // Ziel-ID → Schlüssel der zuletzt gezeigten Meldungen
        this._planSignature = this._currentPlanSignature();
        this._lastUpdateStatus = null;
        this._lastTimestamp = null;
        this._lastFetchStart = 0;
        this._lastMetaCheck = 0;
        this._isOffline = false;
        this._refreshing = false;
        this._pendingRefresh = false;
        this._pendingForce = false;

        this._timeoutId = null;
        this._retryTimeoutId = null;
        this._resumeTimeoutId = null;
        this._debounceId = null;
        this._networkMonitor = null;
        this._netChangedId = null;
        this._sleepSignalId = null;

        this._createIndicator();

        // Nur auf die relevanten Einstellungen reagieren
        this._settingsSignals = [];
        const on = (key, fn) => this._settingsSignals.push(this._settings.connect(`changed::${key}`, fn));
        on('panel-position', () => this._repositionIndicator());
        on('show-ok-icon', () => this._applyDataToUI());
        on('show-acknowledged', () => this._applyDataToUI());
        on('show-downtime', () => this._applyDataToUI());
        on('hard-states-only', () => this._scheduleDebouncedRefresh());
        // Ziele ändern sich beim Tippen in den Einstellungen → kurz warten, dann abfragen
        on('targets', () => {
            this._applyDataToUI();
            this._scheduleDebouncedRefresh();
        });
        on('subscriptions', () => {
            this._applyDataToUI();
            // Neu abfragen nur, wenn sich ändert, WAS abgefragt wird (nicht bei Ignorierlisten)
            const signature = this._currentPlanSignature();
            if (signature !== this._planSignature) {
                this._planSignature = signature;
                this._scheduleDebouncedRefresh();
            }
        });
        on('secret-revision', () => this.refreshData({ force: true }));
        on('target-db-revision', () => {
            this._typesInfo = loadTargetTypes(this.path);
            this._applyDataToUI();
        });

        this._setupNetworkMonitor();
        this._setupSleepMonitor();
        this._restartTimer();

        this._applyDataToUI();
        this.refreshData({ force: true });
    }

    disable() {
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }

        for (const key of ['_timeoutId', '_retryTimeoutId', '_resumeTimeoutId', '_debounceId'])
            this._clearSource(key);

        if (this._netChangedId && this._networkMonitor) {
            this._networkMonitor.disconnect(this._netChangedId);
            this._netChangedId = null;
        }
        this._networkMonitor = null;

        if (this._sleepSignalId) {
            Gio.DBus.system.signal_unsubscribe(this._sleepSignalId);
            this._sleepSignalId = null;
        }

        if (this._settingsSignals && this._settings) {
            for (const id of this._settingsSignals)
                this._settings.disconnect(id);
            this._settingsSignals = [];
        }

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        destroyDrivers(this._drivers);
        this._drivers = null;
        this._results = null;
        this._lastAttempt = null;
        this._knownKeys = null;
        this._updateChecker = null;
        this._settings = null;
    }

    // -----------------------------------------------------------------------
    // Überwachung von Netzwerk und Standby
    // -----------------------------------------------------------------------

    _setupNetworkMonitor() {
        try {
            this._networkMonitor = Gio.NetworkMonitor.get_default();
            if (this._networkMonitor) {
                this._netChangedId = this._networkMonitor.connect('network-changed', (_monitor, available) => {
                    if (available && this._isOffline)
                        this._scheduleResumeRefresh(3);
                });
            }
        } catch (e) {
            console.warn(`[monbar] Failed to initialize NetworkMonitor: ${e.message}`);
        }
    }

    _setupSleepMonitor() {
        try {
            this._sleepSignalId = Gio.DBus.system.signal_subscribe(
                'org.freedesktop.login1',
                'org.freedesktop.login1.Manager',
                'PrepareForSleep',
                '/org/freedesktop/login1',
                null,
                Gio.DBusSignalFlags.NONE,
                (_conn, _sender, _path, _iface, _signal, params) => {
                    try {
                        const [aboutToSuspend] = params.recursiveUnpack();
                        if (aboutToSuspend) {
                            this._clearSource('_retryTimeoutId');
                            this._clearSource('_resumeTimeoutId');
                        } else {
                            this._restartTimer();
                            // Nach dem Aufwachen ist der Stand veraltet → neu abfragen,
                            // sobald das Netzwerk wieder da ist
                            this._scheduleResumeRefresh(6, true);
                        }
                    } catch (err) {
                        console.warn(`[monbar] Error in PrepareForSleep signal callback: ${err.message}`);
                    }
                }
            );
        } catch (e) {
            console.warn(`[monbar] Failed to subscribe to PrepareForSleep: ${e.message}`);
        }
    }

    _clearSource(field) {
        if (this[field]) {
            GLib.Source.remove(this[field]);
            this[field] = null;
        }
    }

    _scheduleResumeRefresh(seconds, force = false) {
        this._clearSource('_resumeTimeoutId');
        this._resumeTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._resumeTimeoutId = null;
            this.refreshData({ force });
            return GLib.SOURCE_REMOVE;
        });
    }

    _scheduleDebouncedRefresh() {
        this._clearSource('_debounceId');
        this._debounceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
            this._debounceId = null;
            this.refreshData({ force: true });
            return GLib.SOURCE_REMOVE;
        });
    }

    _scheduleRetry(seconds) {
        this._clearSource('_retryTimeoutId');
        this._retryTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._retryTimeoutId = null;
            this.refreshData({ force: true });
            return GLib.SOURCE_REMOVE;
        });
    }

    // -----------------------------------------------------------------------
    // Indicator & Timer
    // -----------------------------------------------------------------------

    _createIndicator() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        this._indicator = new MonIndicator(this);
        const position = this._settings.get_string('panel-position') || 'right';
        // Links hinten anhängen (hinter „Aktivitäten“ und bereits vorhandene Symbole,
        // z. B. snmpbar), in der Mitte und rechts wie gewohnt vorne
        Main.panel.addToStatusArea(this.uuid, this._indicator, position === 'left' ? -1 : 0, position);
    }

    _repositionIndicator() {
        this._createIndicator();
        this._applyDataToUI();
    }

    _restartTimer() {
        this._clearSource('_timeoutId');
        // Der Takt ist kurz, abgefragt wird aber nur, was laut Intervall des Ziels fällig ist.
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TICK_SECONDS, () => {
            this.refreshData();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _currentPlanSignature() {
        const subs = parseSubscriptions(this._settings.get_string('subscriptions'));
        return JSON.stringify(parseTargets(this._settings.get_string('targets'))
            .map(t => [t.id, queryPlan(subs, t.id)]));
    }

    // -----------------------------------------------------------------------
    // Schlüsselbund
    // -----------------------------------------------------------------------

    /**
     * Liest ein Secret – niemals mit Entsperr-Dialog, da ein Dialog aus dem
     * Shell-Prozess GNOME Shell abstürzen lassen kann.
     * @returns {Promise<{value: string|null, locked: boolean}>}
     */
    async _getSecret(name) {
        try {
            return await lookupSecretNoPrompt(name, this._cancellable);
        } catch (e) {
            if (!this._cancellable?.is_cancelled())
                console.warn(`[monbar] Schlüsselbund nicht lesbar: ${e.message}`);
            return { value: null, locked: false };
        }
    }

    // -----------------------------------------------------------------------
    // Datenabruf
    // -----------------------------------------------------------------------

    /**
     * Fragt ein Ziel ab und legt das Ergebnis in this._results ab. Bei einem Fehler
     * bleiben die zuletzt bekannten Meldungen stehen (als veraltet gekennzeichnet).
     */
    async _fetchTarget(target, subs) {
        this._lastAttempt.set(target.id, Date.now());
        const previous = this._results.get(target.id);
        const fail = (kind, message = '') => {
            this._results.set(target.id, {
                ok: false,
                problems: previous?.problems ?? [],
                stale: !!previous?.problems?.length,
                fetchedAt: previous?.fetchedAt ?? null,
                error: { kind, message },
                notes: [],
            });
        };

        const configError = targetProblem(target);
        if (configError)
            return fail('config', configError);

        const plan = queryPlan(subs, target.id);
        if (!plan.any) {
            this._results.set(target.id, {
                ok: true, problems: [], stale: false, fetchedAt: Date.now(), error: null, notes: ['nosubs'],
            });
            return;
        }

        const type = getType(target.type);
        const driver = this._drivers?.[type.driver];
        if (!driver)
            return fail('config', 'Kein Treiber für diese Zielart – monbar aktualisieren');

        const { value: secret, locked } = await this._getSecret(secretName(target.id));
        if (!secret) {
            if (locked)
                this._scheduleRetry(60);   // ohne Dialog warten, bis der Schlüsselbund entsperrt ist
            return fail(locked ? 'locked' : 'nokey');
        }

        const res = await driver.fetchProblems(target, secret, plan,
            { hardOnly: this._settings?.get_boolean('hard-states-only') ?? true }, this._cancellable);
        if (!this._results)
            return;               // inzwischen deaktiviert
        if (res.error === 'cancelled') {
            this._lastAttempt.delete(target.id);
            return;
        }
        if (!res.ok) {
            if (res.error === 'network' || res.error === 'server')
                this._lastAttempt.delete(target.id);   // beim nächsten Takt erneut versuchen
            console.log(`[monbar] ${target.name}: ${res.error} ${res.message ?? ''}`);
            return fail(res.error, res.message ?? '');
        }

        this._results.set(target.id, {
            ok: true,
            problems: res.problems,
            stale: false,
            fetchedAt: Date.now(),
            error: null,
            notes: res.notes ?? [],
        });
    }

    /**
     * @param {object} [opts]
     * @param {boolean} [opts.force]  alle aktiven Ziele abfragen, unabhängig vom Intervall
     * @param {boolean} [opts.manual] per Knopfdruck ausgelöst (mindestens 10 s Abstand)
     */
    async refreshData(opts = {}) {
        if (!this._settings || !this._indicator)
            return;

        if (this._refreshing) {
            this._pendingRefresh = true;
            this._pendingForce = this._pendingForce || !!opts.force;
            return;
        }

        if (opts.manual && Date.now() - this._lastFetchStart < MANUAL_REFRESH_GAP_MS) {
            this._applyDataToUI();
            return;
        }

        this._refreshing = true;
        this._lastFetchStart = Date.now();

        try {
            const targets = parseTargets(this._settings.get_string('targets'));
            const subs = parseSubscriptions(this._settings.get_string('subscriptions'));

            // Ergebnisse entfernter oder deaktivierter Ziele verwerfen
            const active = new Set(targets.filter(t => t.enabled).map(t => t.id));
            for (const map of [this._results, this._lastAttempt, this._knownKeys]) {
                for (const id of [...map.keys()]) {
                    if (!active.has(id))
                        map.delete(id);
                }
            }

            // Versions- und Datenbankprüfung höchstens einmal pro Stunde
            const metaDue = Date.now() - this._lastMetaCheck >= META_CHECK_MS;
            if (metaDue)
                this._lastMetaCheck = Date.now();
            const updatePromise = metaDue && this._settings.get_boolean('update-check-enabled')
                ? this._updateChecker.checkForUpdates(this._settings.get_string('git-raw-metadata-url'), this._cancellable)
                : Promise.resolve(null);
            const dbPromise = metaDue && this._settings.get_boolean('target-db-auto-update')
                ? updateTargetTypes(this._settings.get_string('target-db-url'), this._cancellable)
                : Promise.resolve(null);

            const due = targets.filter(t => t.enabled && (opts.force || isDue({
                lastAttemptAt: this._lastAttempt.get(t.id) ?? 0,
                intervalMin: effectiveInterval(t),
            })));

            if (due.length > 0) {
                await Promise.all(due.map(t => this._fetchTarget(t, subs)));
                if (!this._settings || !this._results)
                    return;
                const results = due.map(t => this._results.get(t.id)).filter(Boolean);
                this._isOffline = results.length > 0 && results.every(r => r.error?.kind === 'network');
                if (results.some(r => r.ok))
                    this._lastTimestamp = new Date();
                if (this._isOffline)
                    this._scheduleRetry(120);
                this._checkNotifications(targets.filter(t => due.includes(t)), subs);
            }

            const updateStatus = await updatePromise;
            if (updateStatus)
                this._lastUpdateStatus = updateStatus;

            const dbResult = await dbPromise;
            if (dbResult?.status === 'updated' && this._settings) {
                console.log(`[monbar] Zielarten-Datenbank auf v${dbResult.remoteVersion} aktualisiert.`);
                this._settings.set_int('target-db-revision', this._settings.get_int('target-db-revision') + 1);
            }
        } catch (e) {
            console.warn(`[monbar] Error in refreshData: ${e.message}`);
            this._scheduleRetry(120);
        } finally {
            this._refreshing = false;
        }

        this._applyDataToUI();

        if (this._pendingRefresh) {
            const force = this._pendingForce;
            this._pendingRefresh = false;
            this._pendingForce = false;
            this.refreshData({ force });
        }
    }

    // -----------------------------------------------------------------------
    // Aufbereitung & Benachrichtigungen
    // -----------------------------------------------------------------------

    _filterOpts() {
        return {
            showAcknowledged: this._settings.get_boolean('show-acknowledged'),
            showDowntime: this._settings.get_boolean('show-downtime'),
        };
    }

    /** Sichtbare Meldungen eines Ziels (Abos, Ignorierlisten, Anzeige-Optionen angewandt). */
    _visibleFor(target, subs) {
        const result = this._results?.get(target.id);
        if (!result)
            return [];
        return filterProblems(result.problems, subs, target.id, this._filterOpts())
            .map(p => ({ ...p, targetName: target.name, link: guiLink(target, p) }));
    }

    /**
     * Meldet neu aufgetretene Probleme. Die erste erfolgreiche Abfrage eines Ziels
     * legt nur den Ausgangsstand fest – nach dem Anmelden kommt also keine Flut.
     */
    _checkNotifications(targets, subs) {
        const enabled = this._settings.get_boolean('notify-enabled');
        const minSeverity = this._settings.get_string('notify-min-severity');
        const fresh = [];

        for (const target of targets) {
            const result = this._results.get(target.id);
            if (!result?.ok)
                continue;
            const visible = this._visibleFor(target, subs);
            const known = this._knownKeys.get(target.id);
            if (known && enabled)
                fresh.push(...newProblems(known, visible, minSeverity));
            this._knownKeys.set(target.id, new Set(visible.map(p => p.key)));
        }

        if (fresh.length === 0)
            return;
        const title = p => (p.kind === 'host' ? p.host : `${p.host} – ${p.name}`);
        try {
            if (fresh.length <= MAX_NOTIFY_SINGLE) {
                for (const p of sortProblems(fresh)) {
                    Main.notify(`${p.severity === 'crit' ? 'Störung' : 'Warnung'}: ${title(p)}`,
                        `${p.label}${p.text ? ` – ${p.text}` : ''} (${p.targetName})`);
                }
            } else {
                const crit = fresh.filter(p => p.severity === 'crit').length;
                Main.notify(`${fresh.length} neue Meldungen${crit ? `, davon ${crit} Störungen` : ''}`,
                    sortProblems(fresh).slice(0, 5).map(title).join(', ') + (fresh.length > 5 ? ' …' : ''));
            }
        } catch (e) {
            console.warn(`[monbar] Benachrichtigung fehlgeschlagen: ${e.message}`);
        }
    }

    /** Vom Popup: Meldung künftig ignorieren (Muster ins passende Abo). */
    ignoreProblem(problem) {
        if (!this._settings)
            return;
        const subs = parseSubscriptions(this._settings.get_string('subscriptions'));
        const r = addIgnoreForProblem(subs, problem);
        if (!r)
            return;
        this._settings.set_string('subscriptions', serializeSubscriptions(r.subs));
        const sub = r.subs.find(s => s.id === r.subId);
        const target = parseTargets(this._settings.get_string('targets')).find(t => t.id === problem.target);
        const where = sub?.host === '*' ? 'Alle Server' : sub?.host ?? problem.host;
        try {
            Main.notify('Meldung wird ignoriert',
                `Muster „${r.pattern}“ – wieder anzeigen unter Einstellungen → Ziele → ${target?.name ?? 'Ziel'} → ${where} → Ignorieren.`);
        } catch (_e) {
            // egal
        }
    }

    _applyDataToUI() {
        if (!this._indicator || !this._settings)
            return;

        const targets = parseTargets(this._settings.get_string('targets'));
        const subs = parseSubscriptions(this._settings.get_string('subscriptions'));
        const status = [];
        let items = [];
        for (const target of targets.filter(t => t.enabled)) {
            const result = this._results.get(target.id);
            const visible = this._visibleFor(target, subs);
            items = items.concat(visible);
            status.push({
                target,
                count: visible.length,
                error: result?.error ?? null,
                stale: !!result?.stale,
                notes: result?.notes ?? [],
                fetched: !!result,
            });
        }

        this._indicator.updateUI({
            items: sortProblems(items),
            status,
            configured: targets.length > 0,
            isOffline: this._isOffline,
            lastTimestamp: this._lastTimestamp,
            updateStatus: this._lastUpdateStatus,
        });
    }
}
