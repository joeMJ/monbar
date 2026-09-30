/**
 * prefs.js - Libadwaita / GTK4 Einstellungsdialog für monbar (GNOME 46 - 50)
 */

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { lookupSecret, storeSecret, clearSecret, secretLabel } from './src/secretStore.js';
import { UpdateChecker } from './src/updater.js';
import { loadTargetTypes, updateTargetTypes, targetTypesInfo } from './src/targetDb.js';
import { createDrivers, destroyDrivers } from './src/drivers.js';
import {
    typeIds, getType, fieldLabel, hasCapability, getIntervalChoices,
    parseTargets, serializeTargets, makeTarget, parseSubscriptions, serializeSubscriptions,
    makeSubscription, secretName, normalizeUrl, isValidSite, targetProblem, effectiveInterval,
    isValidPattern, ALL_HOSTS,
} from './src/monUtil.js';

const esc = text => GLib.markup_escape_text(String(text ?? ''), -1);

const minutesLabel = min => (min < 60 ? `${min} ${min === 1 ? 'Minute' : 'Minuten'}`
    : min === 60 ? '1 Stunde' : `${min / 60} Stunden`);

const ERROR_TEXTS = {
    auth: 'Zugangsdaten werden abgelehnt',
    notfound: 'Nicht gefunden – Server-URL (und Instanz) prüfen',
    tls: 'Zertifikat wird nicht akzeptiert – ggf. „Zertifikat nicht prüfen“ einschalten',
    network: 'Server nicht erreichbar',
    format: 'Unerwartete Antwort',
    server: 'Serverfehler',
    ratelimit: 'Zu viele Anfragen',
    http: 'Abfrage fehlgeschlagen',
};

const errorText = res => {
    const base = ERROR_TEXTS[res.error] ?? 'Fehler';
    return res.message && !base.includes(res.message) ? `${base}: ${res.message}` : base;
};

export default class MonBarPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(720, 820);

        loadTargetTypes(this.path);
        const drivers = createDrivers();
        window.connect('close-request', () => {
            destroyDrivers(drivers);
            return false;
        });

        // Eigene Schreibzugriffe erkennen, damit Änderungen von außen (z. B. der
        // „Ignorieren“-Knopf im Popup) die Seiten neu aufbauen, eigene aber nicht.
        let ownWrite = 0;
        const loadTargets = () => parseTargets(settings.get_string('targets'));
        const saveTargets = list => {
            ownWrite++;
            settings.set_string('targets', serializeTargets(list));
            ownWrite--;
        };
        const updateTarget = (id, patch) => {
            saveTargets(loadTargets().map(t => (t.id === id ? { ...t, ...patch } : t)));
        };
        const getTarget = id => loadTargets().find(t => t.id === id) ?? null;
        const loadSubs = () => parseSubscriptions(settings.get_string('subscriptions'));
        const saveSubs = list => {
            ownWrite++;
            settings.set_string('subscriptions', serializeSubscriptions(list));
            ownWrite--;
        };
        const updateSub = (id, patch) => saveSubs(loadSubs().map(s => (s.id === id ? { ...s, ...patch } : s)));
        const bumpSecretRevision = () => settings.set_int('secret-revision', settings.get_int('secret-revision') + 1);

        /** Secret eines Ziels (in den Einstellungen darf der Schlüsselbund nach dem Passwort fragen). */
        const secretFor = async target => {
            try {
                return await lookupSecret(secretName(target.id));
            } catch (e) {
                console.warn(`[monbar] Schlüsselbund nicht erreichbar: ${e.message}`);
                return null;
            }
        };

        /** Ruft eine Treiber-Methode mit dem Secret des Ziels auf. */
        const callDriver = async (targetId, method, ...args) => {
            const target = getTarget(targetId);
            if (!target)
                return { ok: false, error: 'http', message: 'Ziel nicht mehr vorhanden' };
            const problem = targetProblem(target);
            if (problem)
                return { ok: false, error: 'config', message: problem };
            const driver = drivers[getType(target.type).driver];
            if (!driver)
                return { ok: false, error: 'config', message: 'Kein Treiber für diese Zielart' };
            const secret = await secretFor(target);
            if (!secret)
                return { ok: false, error: 'config', message: 'Kein Secret hinterlegt' };
            return driver[method](target, secret, ...args);
        };

        const describeResult = res => (res.error === 'config' ? res.message : errorText(res));

        // ==========================================
        // Seite 1: Ziele
        //   Übersicht → Unterseite je Ziel (Allgemein, Verbindung, Zugangsdaten, Abos)
        //             → Unterseite je Server (Dienste, Log-Meldungen, Ignorieren)
        // ==========================================
        const pageTargets = new Adw.PreferencesPage({
            title: 'Ziele',
            icon_name: 'network-server-symbolic',
        });
        window.add(pageTargets);

        /** Neu aufbaubarer Bereich einer Seite: ersetzt beim nächsten Aufbau seine Gruppen. */
        const makeSection = page => {
            let groups = [];
            return {
                clear() {
                    for (const g of groups)
                        page.remove(g);
                    groups = [];
                },
                add(group) {
                    page.add(group);
                    groups.push(group);
                    return group;
                },
            };
        };

        /** Unterseite mit Kopfzeile (Titel, Untertitel) und Zurück-Pfeil. */
        const makeSubpage = (title, subtitle = '') => {
            const page = new Adw.PreferencesPage();
            const windowTitle = new Adw.WindowTitle({ title, subtitle });
            const header = new Adw.HeaderBar({ title_widget: windowTitle });
            const toolbar = new Adw.ToolbarView({ content: page });
            toolbar.add_top_bar(header);
            const nav = new Adw.NavigationPage({ title, child: toolbar });
            return { nav, page, windowTitle };
        };

        // Speichern-Funktionen der sichtbaren Eingabefelder (beim Verlassen einer Seite und beim Schließen)
        const pendingSavers = new Set();
        const flushPending = async () => {
            for (const save of [...pendingSavers])
                await save();
        };
        // Aufbau-Funktionen der gerade geöffneten Unterseiten (für Änderungen von außen)
        const openRenderers = new Set();

        const hostCache = new Map();       // Ziel-ID → Liste der Server vom Monitoring
        const serviceCache = new Map();    // Abo-ID → Liste der Dienste vom Monitoring

        const subSummary = (sub, type) => {
            const parts = [];
            const what = type.driver === 'prometheus-kuma' ? 'Monitore' : 'Dienste';
            parts.push(sub.services === 'all' ? `alle ${what}`
                : sub.services === 'none' ? 'nur Serverstatus'
                    : `${sub.selected.length} ${what} ausgewählt`);
            if (hasCapability(type, 'events'))
                parts.push(sub.events ? 'mit Log-Meldungen' : 'ohne Log-Meldungen');
            if (sub.ignore.length > 0)
                parts.push(`${sub.ignore.length} ignoriert`);
            return parts.join(' • ');
        };

        const statusImage = target => {
            const problem = targetProblem(target);
            const image = new Gtk.Image({
                icon_name: problem ? 'dialog-warning-symbolic'
                    : !target.enabled ? 'media-playback-pause-symbolic' : 'network-server-symbolic',
                valign: Gtk.Align.CENTER,
            });
            if (problem)
                image.add_css_class('warning');
            else if (!target.enabled)
                image.add_css_class('dim-label');
            return image;
        };

        const overviewSubtitle = (target, subs) => {
            const type = getType(target.type);
            const own = subs.filter(s => s.target === target.id);
            const parts = [type.name];
            const problem = targetProblem(target);
            if (problem)
                parts.push(problem);
            else
                parts.push(normalizeUrl(target.url));
            if (!target.enabled)
                parts.push('deaktiviert');
            else if (!problem)
                parts.push(own.length === 0 ? 'nichts abonniert' : `${own.length} Abo${own.length === 1 ? '' : 's'}`);
            return parts.join(' • ');
        };

        // --- Übersicht ---
        const overview = makeSection(pageTargets);
        let typeRow = null;

        const renderOverview = () => {
            overview.clear();
            const targets = loadTargets();
            const subs = loadSubs();

            const list = overview.add(new Adw.PreferencesGroup({
                title: 'Ziele',
                description: targets.length === 0
                    ? 'Noch keine Ziele eingetragen – unten eins anlegen.'
                    : 'Ein Ziel ist eine Instanz eines Monitoring-Systems. Ein Klick öffnet Verbindung, Zugangsdaten und Abos.',
            }));
            for (const target of targets) {
                const row = new Adw.ActionRow({
                    title: esc(target.name),
                    subtitle: esc(overviewSubtitle(target, subs)),
                    activatable: true,
                });
                row.add_prefix(statusImage(target));
                row.add_suffix(new Gtk.Image({ icon_name: 'go-next-symbolic', valign: Gtk.Align.CENTER }));
                row.connect('activated', () => openTarget(target.id));
                list.add(row);
            }

            const groupAdd = overview.add(new Adw.PreferencesGroup({
                title: 'Ziel hinzufügen',
                description: 'Welche Arten es gibt, steht in der Zielarten-Datenbank (Seite „Updates“). Neue Ziele abonnieren zunächst „Alle Server“.',
            }));
            const previous = typeRow ? typeIds()[typeRow.selected] : null;
            typeRow = new Adw.ComboRow({
                title: 'Zielart',
                model: new Gtk.StringList({ strings: typeIds().map(id => getType(id).name) }),
            });
            typeRow.selected = Math.max(0, typeIds().indexOf(previous));
            groupAdd.add(typeRow);

            const nameRow = new Adw.EntryRow({ title: 'Bezeichnung (optional, z. B. „Checkmk Zuhause“)' });
            groupAdd.add(nameRow);

            const addRow = new Adw.ActionRow({ title: 'Ziel anlegen und einrichten' });
            const addBtn = new Gtk.Button({
                label: 'Hinzufügen',
                valign: Gtk.Align.CENTER,
                css_classes: ['suggested-action'],
            });
            const addTarget = () => {
                const typeId = typeIds()[typeRow.selected];
                if (!typeId)
                    return;
                const target = makeTarget(typeId, nameRow.text);
                saveTargets([...loadTargets(), target]);
                saveSubs([...loadSubs(), makeSubscription(target.id, ALL_HOSTS)]);
                renderOverview();
                openTarget(target.id);
            };
            addBtn.connect('clicked', addTarget);
            nameRow.connect('entry-activated', addTarget);
            addRow.add_suffix(addBtn);
            addRow.activatable_widget = addBtn;
            groupAdd.add(addRow);
        };

        // --- Unterseite: ein Ziel ---
        const openTarget = targetId => {
            const initial = getTarget(targetId);
            if (!initial)
                return;
            const type = getType(initial.type);
            const sp = makeSubpage(initial.name, type.name);
            const section = makeSection(sp.page);
            const savers = new Set();

            const runSavers = () => {
                for (const save of savers) {
                    save();
                    pendingSavers.delete(save);
                }
                savers.clear();
            };
            const addSaver = save => {
                savers.add(save);
                pendingSavers.add(save);
            };

            const render = () => {
                runSavers();
                section.clear();
                const target = getTarget(targetId);
                if (!target)
                    return;

                // ---------- Allgemein ----------
                const gGeneral = section.add(new Adw.PreferencesGroup({ title: 'Allgemein' }));
                if (!type.known) {
                    gGeneral.add(new Adw.ActionRow({
                        title: 'Zielart unbekannt',
                        subtitle: `„${esc(target.type)}“ steht nicht (mehr) in der Zielarten-Datenbank – dieses Ziel wird nicht abgefragt.`,
                    }));
                }

                const nameEntry = new Adw.EntryRow({ title: 'Bezeichnung', text: target.name, show_apply_button: true });
                const saveName = () => {
                    const name = nameEntry.text.trim();
                    if (!name || name.length > 40) {
                        nameEntry.add_css_class('error');
                        return;
                    }
                    nameEntry.remove_css_class('error');
                    if (name === getTarget(targetId)?.name)
                        return;
                    updateTarget(targetId, { name });
                    sp.windowTitle.title = name;
                    sp.nav.title = name;
                };
                nameEntry.connect('apply', saveName);
                nameEntry.connect('entry-activated', saveName);
                addSaver(saveName);
                gGeneral.add(nameEntry);

                const activeRow = new Adw.SwitchRow({ title: 'Aktiv', subtitle: 'Deaktivierte Ziele werden nicht abgefragt' });
                activeRow.active = target.enabled;
                activeRow.connect('notify::active', () => updateTarget(targetId, { enabled: activeRow.active }));
                gGeneral.add(activeRow);

                const choices = new Set(getIntervalChoices().filter(m => m >= (type.minInterval ?? 1)));
                if (target.interval)
                    choices.add(target.interval);
                const options = [...choices].sort((a, b) => a - b);
                const intervalRow = new Adw.ComboRow({
                    title: 'Abfrageintervall',
                    model: new Gtk.StringList({
                        strings: [`Standard (${minutesLabel(effectiveInterval({ ...target, interval: null }, type))})`,
                            ...options.map(minutesLabel)],
                    }),
                });
                intervalRow.selected = target.interval ? options.indexOf(target.interval) + 1 : 0;
                intervalRow.connect('notify::selected', () => {
                    updateTarget(targetId, { interval: intervalRow.selected === 0 ? null : options[intervalRow.selected - 1] });
                });
                gGeneral.add(intervalRow);

                // ---------- Verbindung ----------
                const connFields = type.fields.filter(f => f === 'url' || f === 'site');
                const hintLines = connFields.filter(f => type.hints?.[f]).map(f => `${fieldLabel(type, f)}: ${type.hints[f]}`);
                const gConn = section.add(new Adw.PreferencesGroup({
                    title: 'Verbindung',
                    description: esc([type.description, ...hintLines].filter(Boolean).join('\n')),
                }));

                const httpWarning = new Adw.ActionRow({
                    title: 'Unverschlüsselte Verbindung',
                    subtitle: 'Mit http:// werden die Zugangsdaten im Klartext übertragen. Wenn möglich https:// verwenden.',
                    visible: /^http:\/\//i.test(target.url),
                });
                httpWarning.add_prefix(new Gtk.Image({
                    icon_name: 'dialog-warning-symbolic',
                    valign: Gtk.Align.CENTER,
                    css_classes: ['warning'],
                }));

                const fieldEntry = (group, field) => {
                    const entry = new Adw.EntryRow({
                        title: esc(fieldLabel(type, field)),
                        text: target[field] ?? '',
                        show_apply_button: true,
                        tooltip_text: type.hints?.[field] ?? '',
                    });
                    if (field === 'url')
                        entry.input_purpose = Gtk.InputPurpose.URL;
                    const save = () => {
                        const value = entry.text.trim();
                        const current = getTarget(targetId);
                        if (!current || value === (current[field] ?? ''))
                            return;
                        let clean = value;
                        if (field === 'url' && value) {
                            clean = normalizeUrl(value);
                            if (!clean) {
                                entry.add_css_class('error');
                                return;
                            }
                        }
                        if (field === 'site' && value && !isValidSite(value)) {
                            entry.add_css_class('error');
                            return;
                        }
                        entry.remove_css_class('error');
                        updateTarget(targetId, { [field]: clean });
                        if (field === 'url') {
                            if (entry.text !== clean)
                                entry.text = clean;
                            httpWarning.visible = /^http:\/\//i.test(clean);
                        }
                    };
                    entry.connect('apply', save);
                    entry.connect('entry-activated', save);
                    addSaver(save);
                    group.add(entry);
                };

                for (const field of connFields)
                    fieldEntry(gConn, field);
                gConn.add(httpWarning);

                const insecureRow = new Adw.SwitchRow({
                    title: 'Zertifikat nicht prüfen',
                    subtitle: 'Nur für selbst signierte Zertifikate im eigenen Netz. Die Verbindung bleibt verschlüsselt, aber der Server wird nicht mehr sicher erkannt.',
                });
                insecureRow.active = target.insecure;
                insecureRow.connect('notify::active', () => updateTarget(targetId, { insecure: insecureRow.active }));
                gConn.add(insecureRow);

                if (type.docsUrl) {
                    const docsRow = new Adw.ActionRow({
                        title: 'Dokumentation',
                        subtitle: esc(type.docsUrl.replace('https://', '')),
                    });
                    const docsBtn = new Gtk.Button({ label: 'Öffnen', valign: Gtk.Align.CENTER });
                    docsBtn.connect('clicked', () => {
                        try {
                            Gio.AppInfo.launch_default_for_uri(type.docsUrl, null);
                        } catch (e) {
                            docsRow.subtitle = `Link konnte nicht geöffnet werden: ${esc(e.message)}`;
                        }
                    });
                    docsRow.add_suffix(docsBtn);
                    gConn.add(docsRow);
                }

                // ---------- Zugangsdaten ----------
                const credHints = ['username', 'secret'].filter(f => type.fields.includes(f) && type.hints?.[f])
                    .map(f => `${fieldLabel(type, f)}: ${type.hints[f]}`);
                const gCred = section.add(new Adw.PreferencesGroup({
                    title: 'Zugangsdaten',
                    description: esc(credHints.join('\n')),
                }));
                if (type.fields.includes('username'))
                    fieldEntry(gCred, 'username');

                const secretRow = new Adw.PasswordEntryRow({
                    title: esc(fieldLabel(type, 'secret')),
                    show_apply_button: true,
                });
                gCred.add(secretRow);
                const secretInfo = new Adw.ActionRow({
                    title: 'Speicherort',
                    subtitle: 'GNOME-Schlüsselbund – wird geladen …',
                });
                gCred.add(secretInfo);

                let storedSecret = null;
                lookupSecret(secretName(targetId))
                    .then(value => {
                        storedSecret = value ?? '';
                        secretRow.text = storedSecret;
                        secretInfo.subtitle = storedSecret
                            ? 'Im GNOME-Schlüsselbund hinterlegt (verschlüsselt)'
                            : 'Noch kein Secret hinterlegt';
                    })
                    .catch(e => {
                        secretInfo.subtitle = `Schlüsselbund nicht erreichbar: ${esc(e.message)}`;
                    });
                const saveSecret = async () => {
                    const value = secretRow.text.trim();
                    if (storedSecret === null || value === storedSecret)
                        return;
                    try {
                        const name = getTarget(targetId)?.name ?? initial.name;
                        if (value)
                            await storeSecret(secretName(targetId), value, secretLabel(name));
                        else
                            await clearSecret(secretName(targetId));
                        storedSecret = value;
                        secretInfo.subtitle = value
                            ? 'Im GNOME-Schlüsselbund gespeichert (verschlüsselt)'
                            : 'Secret aus dem Schlüsselbund entfernt';
                        bumpSecretRevision();
                    } catch (e) {
                        secretInfo.subtitle = `Speichern fehlgeschlagen: ${esc(e.message)}`;
                    }
                };
                secretRow.connect('apply', saveSecret);
                secretRow.connect('entry-activated', saveSecret);
                addSaver(saveSecret);

                const testRow = new Adw.ActionRow({
                    title: 'Verbindung testen',
                    subtitle: 'Prüft Adresse und Zugangsdaten',
                });
                const testIcon = new Gtk.Image({ icon_name: 'network-server-symbolic', valign: Gtk.Align.CENTER });
                testRow.add_prefix(testIcon);
                const testBtn = new Gtk.Button({ label: 'Testen', valign: Gtk.Align.CENTER });
                testBtn.connect('clicked', async () => {
                    testBtn.sensitive = false;
                    testRow.subtitle = 'Verbinde …';
                    await flushPending();
                    const res = await callDriver(targetId, 'test');
                    for (const c of ['success', 'error'])
                        testIcon.remove_css_class(c);
                    if (res.ok) {
                        testIcon.icon_name = 'emblem-ok-symbolic';
                        testIcon.add_css_class('success');
                        testRow.subtitle = esc(res.message);
                    } else {
                        testIcon.icon_name = 'dialog-warning-symbolic';
                        testIcon.add_css_class('error');
                        testRow.subtitle = esc(describeResult(res));
                    }
                    testBtn.sensitive = true;
                });
                testRow.add_suffix(testBtn);
                testRow.activatable_widget = testBtn;
                gCred.add(testRow);

                // ---------- Abos ----------
                const subs = loadSubs().filter(s => s.target === targetId)
                    .sort((a, b) => (a.host === ALL_HOSTS ? -1 : b.host === ALL_HOSTS ? 1 : a.host.localeCompare(b.host)));
                const gSubs = section.add(new Adw.PreferencesGroup({
                    title: 'Abos',
                    description: subs.length === 0
                        ? 'Nichts abonniert – von diesem Ziel wird nichts angezeigt. Unten „Alle Server“ oder einzelne Server hinzufügen.'
                        : 'Welche Server angezeigt werden. Ein Klick öffnet Dienste, Log-Meldungen und Ignorierliste des Servers. Ein einzeln abonnierter Server hat Vorrang vor „Alle Server“.',
                }));
                for (const sub of subs) {
                    const row = new Adw.ActionRow({
                        title: esc(sub.host === ALL_HOSTS ? 'Alle Server' : sub.host),
                        subtitle: esc(subSummary(sub, type)),
                        activatable: true,
                    });
                    row.add_prefix(new Gtk.Image({
                        icon_name: sub.host === ALL_HOSTS ? 'view-grid-symbolic' : 'computer-symbolic',
                        valign: Gtk.Align.CENTER,
                    }));
                    row.add_suffix(new Gtk.Image({ icon_name: 'go-next-symbolic', valign: Gtk.Align.CENTER }));
                    row.connect('activated', () => openSub(targetId, sub.id, render));
                    gSubs.add(row);
                }

                // Server hinzufügen
                const subscribed = new Set(subs.map(s => s.host));
                const addHost = host => {
                    const h = host.trim();
                    if (!h || h.length > 200 || subscribed.has(h))
                        return false;
                    const sub = makeSubscription(targetId, h);
                    saveSubs([...loadSubs(), sub]);
                    render();
                    return true;
                };

                const gAddHost = section.add(new Adw.PreferencesGroup({
                    title: 'Server abonnieren',
                    description: 'Servernamen eingeben oder die Liste vom Monitoring laden.',
                }));
                const manual = new Adw.EntryRow({
                    title: subscribed.has(ALL_HOSTS) ? 'Servername' : 'Servername (oder * für alle Server)',
                    show_apply_button: true,
                });
                const addManual = () => {
                    if (!addHost(manual.text))
                        manual.add_css_class('error');
                };
                manual.connect('apply', addManual);
                manual.connect('entry-activated', addManual);
                gAddHost.add(manual);

                const hosts = hostCache.get(targetId) ?? null;
                const free = (hosts ?? []).filter(h => !subscribed.has(h));
                const loadRow = new Adw.ActionRow({
                    title: 'Server vom Monitoring laden',
                    subtitle: hosts === null ? 'Braucht gültige Verbindung und Zugangsdaten'
                        : free.length === 0 ? 'Alle Server sind bereits abonniert'
                            : `${free.length} Server noch nicht abonniert`,
                });
                const loadBtn = new Gtk.Button({
                    icon_name: 'view-refresh-symbolic',
                    valign: Gtk.Align.CENTER,
                    tooltip_text: 'Serverliste laden',
                });
                loadBtn.connect('clicked', async () => {
                    loadBtn.sensitive = false;
                    loadRow.subtitle = 'Lade …';
                    await flushPending();
                    const res = await callDriver(targetId, 'listHosts');
                    loadBtn.sensitive = true;
                    if (!res.ok) {
                        loadRow.subtitle = esc(describeResult(res));
                        return;
                    }
                    hostCache.set(targetId, res.items);
                    render();
                });
                loadRow.add_suffix(loadBtn);
                loadRow.activatable_widget = loadBtn;
                gAddHost.add(loadRow);

                if (free.length > 0) {
                    const hostList = new Adw.ExpanderRow({
                        title: 'Verfügbare Server',
                        subtitle: `${free.length} Server – mit + abonnieren`,
                        expanded: true,
                    });
                    for (const host of free) {
                        const row = new Adw.ActionRow({ title: esc(host) });
                        const btn = new Gtk.Button({
                            icon_name: 'list-add-symbolic',
                            valign: Gtk.Align.CENTER,
                            tooltip_text: 'Abonnieren',
                            css_classes: ['flat'],
                        });
                        btn.connect('clicked', () => addHost(host));
                        row.add_suffix(btn);
                        row.activatable_widget = btn;
                        hostList.add_row(row);
                    }
                    gAddHost.add(hostList);
                }

                // ---------- Entfernen ----------
                const gDelete = section.add(new Adw.PreferencesGroup());
                const deleteRow = new Adw.ActionRow({
                    title: 'Ziel entfernen',
                    subtitle: 'Löscht das Ziel, seine Abos und das Secret im Schlüsselbund',
                });
                const deleteBtn = new Gtk.Button({
                    label: 'Entfernen',
                    valign: Gtk.Align.CENTER,
                    css_classes: ['destructive-action'],
                });
                let armed = false;
                deleteBtn.connect('clicked', async () => {
                    if (!armed) {
                        armed = true;
                        deleteBtn.label = 'Wirklich entfernen?';
                        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
                            armed = false;
                            if (deleteBtn.get_root())
                                deleteBtn.label = 'Entfernen';
                            return GLib.SOURCE_REMOVE;
                        });
                        return;
                    }
                    for (const save of savers)
                        pendingSavers.delete(save);
                    savers.clear();
                    try {
                        await clearSecret(secretName(targetId));
                    } catch (e) {
                        console.warn(`[monbar] Secret konnte nicht gelöscht werden: ${e.message}`);
                    }
                    saveSubs(loadSubs().filter(s => s.target !== targetId));
                    saveTargets(loadTargets().filter(t => t.id !== targetId));
                    hostCache.delete(targetId);
                    window.pop_subpage();
                });
                deleteRow.add_suffix(deleteBtn);
                gDelete.add(deleteRow);
            };

            sp.nav.connect('hidden', () => {
                // Seite verlassen (zurück zur Übersicht oder weiter zu einem Server)
                runSavers();
                renderOverview();
            });
            sp.nav.connect('showing', () => openRenderers.add(render));
            sp.nav.connect('hiding', () => openRenderers.delete(render));

            render();
            window.push_subpage(sp.nav);
        };

        // --- Unterseite: ein abonnierter Server ---
        const openSub = (targetId, subId, onClose) => {
            const target = getTarget(targetId);
            const initial = loadSubs().find(s => s.id === subId);
            if (!target || !initial)
                return;
            const type = getType(target.type);
            const isAll = initial.host === ALL_HOSTS;
            const what = type.driver === 'prometheus-kuma' ? 'Monitore' : 'Dienste';
            const sp = makeSubpage(isAll ? 'Alle Server' : initial.host, target.name);
            const section = makeSection(sp.page);

            const render = () => {
                section.clear();
                const sub = loadSubs().find(s => s.id === subId);
                if (!sub)
                    return;

                // ---------- Dienste ----------
                const modes = isAll ? ['all', 'none'] : ['all', 'selected', 'none'];
                const modeLabels = { all: 'Alle', selected: 'Nur ausgewählte', none: 'Keine (nur Serverstatus)' };
                const gServices = section.add(new Adw.PreferencesGroup({
                    title: what,
                    description: isAll
                        ? `Gilt für alle Server dieses Ziels. Einzelne ${what} wählst du aus, indem du den Server einzeln abonnierst.`
                        : `Welche ${what} dieses Servers angezeigt werden. Der Serverstatus selbst (z. B. DOWN) wird immer angezeigt.`,
                }));
                const modeRow = new Adw.ComboRow({
                    title: 'Anzeigen',
                    model: new Gtk.StringList({ strings: modes.map(m => modeLabels[m]) }),
                });
                modeRow.selected = Math.max(0, modes.indexOf(sub.services));
                modeRow.connect('notify::selected', () => {
                    updateSub(subId, { services: modes[modeRow.selected] });
                    render();
                });
                gServices.add(modeRow);

                if (!isAll && sub.services === 'selected') {
                    const loaded = serviceCache.get(subId) ?? [];
                    const names = [...new Set([...sub.selected, ...loaded])].sort((a, b) => a.localeCompare(b));
                    const loadRow = new Adw.ActionRow({
                        title: `${what} vom Monitoring laden`,
                        subtitle: loaded.length ? `${loaded.length} ${what} geladen – Haken setzen, was angezeigt werden soll`
                            : `${sub.selected.length} ausgewählt`,
                    });
                    const loadBtn = new Gtk.Button({
                        icon_name: 'view-refresh-symbolic',
                        valign: Gtk.Align.CENTER,
                        tooltip_text: `${what} laden`,
                    });
                    loadBtn.connect('clicked', async () => {
                        loadBtn.sensitive = false;
                        loadRow.subtitle = 'Lade …';
                        const res = await callDriver(targetId, 'listServices', sub.host);
                        loadBtn.sensitive = true;
                        if (!res.ok) {
                            loadRow.subtitle = esc(describeResult(res));
                            return;
                        }
                        if (res.items.length === 0) {
                            loadRow.subtitle = `Keine ${what} gefunden – stimmt der Servername?`;
                            return;
                        }
                        serviceCache.set(subId, res.items);
                        render();
                    });
                    loadRow.add_suffix(loadBtn);
                    loadRow.activatable_widget = loadBtn;
                    gServices.add(loadRow);

                    for (const name of names) {
                        const row = new Adw.ActionRow({ title: esc(name) });
                        const check = new Gtk.CheckButton({
                            active: sub.selected.includes(name),
                            valign: Gtk.Align.CENTER,
                        });
                        check.connect('toggled', () => {
                            const s = loadSubs().find(x => x.id === subId);
                            if (!s)
                                return;
                            const selected = check.active
                                ? [...new Set([...s.selected, name])]
                                : s.selected.filter(n => n !== name);
                            updateSub(subId, { selected });
                        });
                        row.add_prefix(check);
                        row.activatable_widget = check;
                        gServices.add(row);
                    }
                }

                // ---------- Log-Meldungen ----------
                if (hasCapability(type, 'events')) {
                    const gEvents = section.add(new Adw.PreferencesGroup({
                        title: 'Log-Meldungen',
                        description: 'Offene Meldungen der Checkmk Event Console (Syslog, SNMP-Traps, Logdateien). Log-Dienste wie „Log System“ oder „Log Security“ sind normale Dienste und werden oben mit ausgewählt.',
                    }));
                    const eventsRow = new Adw.SwitchRow({ title: 'Meldungen der Event Console anzeigen' });
                    eventsRow.active = sub.events;
                    eventsRow.connect('notify::active', () => updateSub(subId, { events: eventsRow.active }));
                    gEvents.add(eventsRow);
                }

                // ---------- Ignorieren ----------
                const gIgnore = section.add(new Adw.PreferencesGroup({
                    title: 'Ignorieren',
                    description: `Muster: * = beliebige Zeichen, ? = genau ein Zeichen, Groß-/Kleinschreibung egal. Sie gelten für Namen von ${what} und für den Text von Log-Meldungen.${isAll ? ' Diese Liste gilt für alle Server des Ziels.' : ''} Der Knopf mit dem durchgestrichenen Auge im Popup trägt hier ein Muster ein.`,
                }));
                if (sub.ignore.length === 0) {
                    gIgnore.add(new Adw.ActionRow({ title: 'Nichts ignoriert', css_classes: ['dim-label'] }));
                }
                for (const pattern of sub.ignore) {
                    const row = new Adw.ActionRow({ title: esc(pattern) });
                    row.add_prefix(new Gtk.Image({ icon_name: 'view-conceal-symbolic', valign: Gtk.Align.CENTER }));
                    const removeBtn = new Gtk.Button({
                        icon_name: 'user-trash-symbolic',
                        valign: Gtk.Align.CENTER,
                        tooltip_text: 'Nicht mehr ignorieren',
                        css_classes: ['flat'],
                    });
                    removeBtn.connect('clicked', () => {
                        const s = loadSubs().find(x => x.id === subId);
                        if (s)
                            updateSub(subId, { ignore: s.ignore.filter(p => p !== pattern) });
                        render();
                    });
                    row.add_suffix(removeBtn);
                    gIgnore.add(row);
                }
                const ignoreEntry = new Adw.EntryRow({
                    title: type.driver === 'prometheus-kuma'
                        ? 'Muster hinzufügen, z. B. Test* oder *intern*'
                        : 'Muster hinzufügen, z. B. Filesystem /boot*, Log * oder *Codeintegrität*',
                    show_apply_button: true,
                });
                const addPattern = () => {
                    const pattern = ignoreEntry.text.trim();
                    if (!isValidPattern(pattern)) {
                        ignoreEntry.add_css_class('error');
                        return;
                    }
                    const s = loadSubs().find(x => x.id === subId);
                    if (s && !s.ignore.includes(pattern))
                        updateSub(subId, { ignore: [...s.ignore, pattern] });
                    render();
                };
                ignoreEntry.connect('apply', addPattern);
                ignoreEntry.connect('entry-activated', addPattern);
                gIgnore.add(ignoreEntry);

                // ---------- Entfernen ----------
                const gRemove = section.add(new Adw.PreferencesGroup());
                const removeRow = new Adw.ActionRow({
                    title: isAll ? 'Abo „Alle Server“ entfernen' : 'Server nicht mehr abonnieren',
                    subtitle: isAll ? 'Danach werden nur noch einzeln abonnierte Server angezeigt' : '',
                });
                const removeBtn = new Gtk.Button({ label: 'Entfernen', valign: Gtk.Align.CENTER });
                removeBtn.connect('clicked', () => {
                    saveSubs(loadSubs().filter(s => s.id !== subId));
                    serviceCache.delete(subId);
                    window.pop_subpage();
                });
                removeRow.add_suffix(removeBtn);
                gRemove.add(removeRow);
            };

            sp.nav.connect('hidden', () => onClose());
            sp.nav.connect('showing', () => openRenderers.add(render));
            sp.nav.connect('hiding', () => openRenderers.delete(render));
            render();
            window.push_subpage(sp.nav);
        };

        renderOverview();

        // Änderungen von außen (Ignorieren-Knopf im Popup, zweites Einstellungsfenster)
        const onExternalChange = () => {
            if (ownWrite > 0)
                return;
            renderOverview();
            for (const render of openRenderers)
                render();
        };
        const signals = [
            settings.connect('changed::subscriptions', onExternalChange),
            settings.connect('changed::targets', onExternalChange),
        ];
        window.connect('close-request', () => {
            for (const save of pendingSavers)
                save();
            for (const id of signals)
                settings.disconnect(id);
            return false;
        });

        // ==========================================
        // Seite 2: Allgemein
        // ==========================================
        const pageGeneral = new Adw.PreferencesPage({
            title: 'Allgemein',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(pageGeneral);

        const groupPanel = new Adw.PreferencesGroup({
            title: 'Anzeige',
            description: 'Neben dem Symbol zeigt eine rote Zahl die Störungen (CRIT, DOWN), eine gelbe die Warnungen (WARN, UNKNOWN, PENDING).',
        });
        pageGeneral.add(groupPanel);

        const positionRow = new Adw.ComboRow({
            title: 'Position im Panel',
            subtitle: 'Wähle den Anzeigeort in der oberen Leiste',
            model: new Gtk.StringList({
                strings: ['Mitte (neben Datum/Uhrzeit)', 'Rechts (neben Quick Settings)'],
            }),
        });
        positionRow.selected = settings.get_string('panel-position') === 'center' ? 0 : 1;
        positionRow.connect('notify::selected', () => {
            settings.set_string('panel-position', positionRow.selected === 0 ? 'center' : 'right');
        });
        groupPanel.add(positionRow);

        const addSwitch = (group, key, title, subtitle) => {
            const row = new Adw.SwitchRow({ title, subtitle });
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
            return row;
        };
        addSwitch(groupPanel, 'show-ok-icon', 'Symbol auch ohne Meldungen zeigen',
            'Aus: Das Symbol erscheint nur bei Störungen, Warnungen oder Verbindungsproblemen');

        const groupFilter = new Adw.PreferencesGroup({ title: 'Filter' });
        pageGeneral.add(groupFilter);
        addSwitch(groupFilter, 'show-acknowledged', 'Quittierte Probleme anzeigen',
            'Probleme, die im Monitoring bereits bestätigt wurden');
        addSwitch(groupFilter, 'show-downtime', 'Probleme in Wartung anzeigen',
            'Hosts und Dienste in einer geplanten Wartungszeit (Downtime / Maintenance)');
        addSwitch(groupFilter, 'hard-states-only', 'Nur bestätigte Zustände (Checkmk)',
            'Service-Probleme erst zeigen, wenn Checkmk sie nach allen Wiederholungen bestätigt hat (Hard State)');

        const groupNotify = new Adw.PreferencesGroup({
            title: 'Benachrichtigungen',
            description: 'Gemeldet werden nur neu aufgetretene Probleme – nach dem Anmelden gibt es keine Flut für bestehende.',
        });
        pageGeneral.add(groupNotify);
        addSwitch(groupNotify, 'notify-enabled', 'Bei neuen Meldungen benachrichtigen', '');
        const severityRow = new Adw.ComboRow({
            title: 'Benachrichtigen ab',
            model: new Gtk.StringList({ strings: ['Störungen', 'Warnungen und Störungen'] }),
        });
        severityRow.selected = settings.get_string('notify-min-severity') === 'warn' ? 1 : 0;
        severityRow.connect('notify::selected', () => {
            settings.set_string('notify-min-severity', severityRow.selected === 1 ? 'warn' : 'crit');
        });
        settings.bind('notify-enabled', severityRow, 'sensitive', Gio.SettingsBindFlags.GET);
        groupNotify.add(severityRow);

        // ==========================================
        // Seite 3: Updates
        // ==========================================
        const pageUpdate = new Adw.PreferencesPage({
            title: 'Updates',
            icon_name: 'software-update-available-symbolic',
        });
        window.add(pageUpdate);

        const installedName = this.metadata['version-name'] ?? String(this.metadata.version || 1);
        const installedVersion = Number(this.metadata.version || 1);
        const updateCommand = 'curl -fsSL https://raw.githubusercontent.com/joeMJ/monbar/main/install.sh | bash';

        // --- Programm (Git) ---
        const groupUpdate = new Adw.PreferencesGroup({
            title: 'Programm',
            description: 'Prüfung auf neue Versionen über GitHub (github.com/joeMJ/monbar). Neuer Programmcode wird erst nach dem Ab- und Anmelden aktiv.',
        });
        pageUpdate.add(groupUpdate);

        const updateEnableRow = new Adw.SwitchRow({
            title: 'Automatische Versionsprüfung',
            subtitle: 'Prüft regelmäßig, ob im Git-Repository ein Update vorliegt (Hinweis im Popup)',
        });
        settings.bind('update-check-enabled', updateEnableRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        groupUpdate.add(updateEnableRow);

        const gitUrlRow = new Adw.EntryRow({ title: 'Git Repository URL' });
        settings.bind('git-update-url', gitUrlRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        groupUpdate.add(gitUrlRow);

        const gitRawUrlRow = new Adw.EntryRow({ title: 'Raw Metadata URL (Versionsabgleich)' });
        settings.bind('git-raw-metadata-url', gitRawUrlRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        groupUpdate.add(gitRawUrlRow);

        const statusRow = new Adw.ActionRow({
            title: `Installierte Version: v${installedName}`,
            subtitle: 'Noch nicht geprüft',
        });
        const statusIcon = new Gtk.Image({ icon_name: 'view-refresh-symbolic', valign: Gtk.Align.CENTER });
        statusRow.add_prefix(statusIcon);
        const checkBtn = new Gtk.Button({ label: 'Jetzt prüfen', valign: Gtk.Align.CENTER });
        statusRow.add_suffix(checkBtn);
        groupUpdate.add(statusRow);

        const installRow = new Adw.ActionRow({
            title: 'Installieren / aktualisieren',
            subtitle: `Im Terminal: ${updateCommand}`,
            subtitle_selectable: true,
        });
        const updateBtn = new Gtk.Button({
            label: 'Jetzt aktualisieren',
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        updateBtn.connect('clicked', () => {
            const error = launchInTerminal(
                `${updateCommand}; echo; read -r -p 'Fertig – danach ab- und wieder anmelden. Enter schließt das Fenster.'`);
            if (error)
                installRow.subtitle = `${error} – bitte manuell ausführen: ${updateCommand}`;
        });
        installRow.add_suffix(updateBtn);
        groupUpdate.add(installRow);

        const checker = new UpdateChecker(installedVersion);
        const setIconState = (icon, name, cssClass) => {
            icon.icon_name = name;
            for (const c of ['success', 'warning', 'error'])
                icon.remove_css_class(c);
            if (cssClass)
                icon.add_css_class(cssClass);
        };
        const setStatus = (icon, subtitle, cssClass = null) => {
            setIconState(statusIcon, icon, cssClass);
            statusRow.subtitle = esc(subtitle);
        };
        const checkProgram = async () => {
            checkBtn.sensitive = false;
            setStatus('view-refresh-symbolic', 'Prüfe auf neue Version …');
            try {
                const r = await checker.checkForUpdates(settings.get_string('git-raw-metadata-url'));
                if (r.error)
                    setStatus('dialog-warning-symbolic', `Prüfung fehlgeschlagen: ${r.error}`, 'warning');
                else if (r.updateAvailable)
                    setStatus('software-update-available-symbolic',
                        `Neue Version verfügbar: v${r.remoteVersionName} (installiert: v${installedName}). Mit „Jetzt aktualisieren“ installieren und danach ab- und wieder anmelden.`,
                        'warning');
                else
                    setStatus('emblem-ok-symbolic', `Aktuell – v${installedName} ist die neueste Version`, 'success');
            } catch (e) {
                setStatus('dialog-warning-symbolic', `Prüfung fehlgeschlagen: ${e.message}`, 'warning');
            }
            checkBtn.sensitive = true;
        };
        checkBtn.connect('clicked', checkProgram);
        if (settings.get_boolean('update-check-enabled'))
            checkProgram();

        // --- Zielarten-Datenbank ---
        const groupDb = new Adw.PreferencesGroup({
            title: 'Zielarten-Datenbank',
            description: 'Welche Monitoring-Systeme monbar kennt, steht als JSON im Git-Repository. Ein Update der Datenbank wirkt sofort, ohne Ab- und Anmelden. Völlig neue Systeme brauchen zusätzlich ein Programm-Update.',
        });
        pageUpdate.add(groupDb);

        const dbAutoRow = new Adw.SwitchRow({
            title: 'Datenbank automatisch aktualisieren',
            subtitle: 'Lädt stündlich eine neuere Version (reine Daten, keine Programme)',
        });
        settings.bind('target-db-auto-update', dbAutoRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        groupDb.add(dbAutoRow);

        const dbUrlRow = new Adw.EntryRow({ title: 'URL der Zielarten-Datenbank (https)' });
        settings.bind('target-db-url', dbUrlRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        groupDb.add(dbUrlRow);

        const dbRow = new Adw.ActionRow({ title: 'Installierte Datenbank' });
        const dbIcon = new Gtk.Image({ icon_name: 'emblem-ok-symbolic', valign: Gtk.Align.CENTER });
        dbRow.add_prefix(dbIcon);
        const dbBtn = new Gtk.Button({ label: 'Jetzt aktualisieren', valign: Gtk.Align.CENTER });
        dbRow.add_suffix(dbBtn);
        groupDb.add(dbRow);

        const describeDb = () => {
            const info = targetTypesInfo();
            dbRow.title = `Installierte Datenbank: v${info.version}`;
            return `${info.count} Zielart${info.count === 1 ? '' : 'en'}: ${typeIds().map(id => getType(id).name).join(', ')}${info.updated ? ` • Stand ${info.updated}` : ''}`;
        };
        const setDbStatus = (icon, text, cssClass = null) => {
            setIconState(dbIcon, icon, cssClass);
            dbRow.subtitle = esc(text);
        };
        setDbStatus('emblem-ok-symbolic', describeDb());

        const checkDb = async () => {
            dbBtn.sensitive = false;
            setDbStatus('view-refresh-symbolic', 'Prüfe auf neue Datenbank …');
            const r = await updateTargetTypes(settings.get_string('target-db-url'));
            if (r.status === 'updated') {
                // Der Zähler stößt den Neuaufbau dieser Seiten und das Neuladen in der Extension an
                settings.set_int('target-db-revision', settings.get_int('target-db-revision') + 1);
                const skipped = r.skipped > 0 ? ` (${r.skipped} unbekannte oder ungültige Einträge übersprungen)` : '';
                setDbStatus('emblem-ok-symbolic',
                    `Aktualisiert: v${r.localVersion} → v${r.remoteVersion} – sofort aktiv. ${describeDb()}${skipped}`, 'success');
            } else if (r.status === 'current') {
                setDbStatus('emblem-ok-symbolic', `Aktuell – ${describeDb()}`, 'success');
            } else {
                setDbStatus('dialog-warning-symbolic', `Prüfung fehlgeschlagen: ${r.error}`, 'warning');
            }
            dbBtn.sensitive = true;
        };
        dbBtn.connect('clicked', checkDb);
        if (settings.get_boolean('target-db-auto-update'))
            checkDb();

        // Neue Datenbank (von hier oder im Hintergrund von der Extension geladen)
        const dbSignal = settings.connect('changed::target-db-revision', () => {
            loadTargetTypes(this.path);
            renderOverview();
            for (const render of openRenderers)
                render();
            setDbStatus('emblem-ok-symbolic', describeDb());
        });
        window.connect('close-request', () => {
            settings.disconnect(dbSignal);
            return false;
        });
    }
}

/**
 * Startet einen Befehl in einem Terminalfenster (bevorzugt das Standard-Terminal
 * über xdg-terminal-exec, sonst Ptyxis, GNOME Terminal, x-terminal-emulator).
 * @param {string} command - Shell-Befehl für bash -c
 * @returns {string|null} Fehlermeldung oder null bei Erfolg
 */
function launchInTerminal(command) {
    const candidates = [
        ['xdg-terminal-exec', []],
        ['ptyxis', ['--']],
        ['gnome-terminal', ['--']],
        ['x-terminal-emulator', ['-e']],
    ];
    for (const [program, prefix] of candidates) {
        const path = GLib.find_program_in_path(program);
        if (!path)
            continue;
        try {
            Gio.Subprocess.new([path, ...prefix, 'bash', '-c', command], Gio.SubprocessFlags.NONE);
            return null;
        } catch (e) {
            console.warn(`[monbar] ${program} konnte nicht gestartet werden: ${e.message}`);
        }
    }
    return 'Kein Terminal gefunden';
}
