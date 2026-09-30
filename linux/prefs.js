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
        // ==========================================
        const pageTargets = new Adw.PreferencesPage({
            title: 'Ziele',
            icon_name: 'network-server-symbolic',
        });
        window.add(pageTargets);

        const groupAdd = new Adw.PreferencesGroup({
            title: 'Ziel hinzufügen',
            description: 'Ein Ziel ist eine Instanz eines Monitoring-Systems, z. B. dein Checkmk-Server. Welche Arten es gibt, steht in der Zielarten-Datenbank (Seite „Updates“).',
        });
        pageTargets.add(groupAdd);

        const typeRow = new Adw.ComboRow({ title: 'Zielart' });
        const fillTypeRow = () => {
            const previous = typeIds()[typeRow.selected];
            typeRow.model = new Gtk.StringList({ strings: typeIds().map(id => getType(id).name) });
            const idx = typeIds().indexOf(previous);
            typeRow.selected = idx >= 0 ? idx : 0;
        };
        fillTypeRow();
        groupAdd.add(typeRow);

        const nameRow = new Adw.EntryRow({ title: 'Bezeichnung (optional, z. B. „Checkmk Zuhause“)' });
        groupAdd.add(nameRow);

        const addTargetRow = new Adw.ActionRow({
            title: 'Ziel anlegen',
            subtitle: 'Danach Adresse und Zugangsdaten eintragen. „Alle Server“ wird automatisch abonniert.',
        });
        const addTargetBtn = new Gtk.Button({
            label: 'Hinzufügen',
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        addTargetRow.add_suffix(addTargetBtn);
        addTargetRow.activatable_widget = addTargetBtn;
        groupAdd.add(addTargetRow);

        const groupTargets = new Adw.PreferencesGroup({ title: 'Eingetragene Ziele' });
        pageTargets.add(groupTargets);

        const expandedTargets = new Set();
        // Speichern-Funktionen der sichtbaren Eingabefelder (vor einem Neuaufbau und beim Schließen)
        const pendingSavers = new Set();
        let targetRows = [];

        const flushPending = async () => {
            for (const save of [...pendingSavers])
                await save();
        };

        const rebuildTargets = () => {
            for (const save of pendingSavers)
                save();
            pendingSavers.clear();
            for (const row of targetRows)
                groupTargets.remove(row);
            targetRows = [];

            const targets = loadTargets();
            groupTargets.description = targets.length === 0
                ? 'Noch keine Ziele eingetragen.'
                : `${targets.length} Ziel${targets.length === 1 ? '' : 'e'}`;

            for (const target of targets) {
                const row = buildTargetRow(target);
                groupTargets.add(row);
                targetRows.push(row);
            }
        };

        const targetSubtitle = target => {
            const type = getType(target.type);
            const parts = [type.name];
            if (!target.enabled)
                parts.push('deaktiviert');
            const problem = targetProblem(target);
            parts.push(problem ?? normalizeUrl(target.url));
            return parts.join(' • ');
        };

        const buildTargetRow = target => {
            const type = getType(target.type);
            const expander = new Adw.ExpanderRow({
                title: esc(target.name),
                subtitle: esc(targetSubtitle(target)),
                show_enable_switch: false,
                expanded: expandedTargets.has(target.id),
            });
            expander.connect('notify::expanded', () => {
                if (expander.expanded)
                    expandedTargets.add(target.id);
                else
                    expandedTargets.delete(target.id);
            });
            const refreshSubtitle = () => {
                const t = getTarget(target.id);
                if (t)
                    expander.subtitle = esc(targetSubtitle(t));
            };

            if (!type.known) {
                expander.add_row(new Adw.ActionRow({
                    title: 'Zielart unbekannt',
                    subtitle: `„${esc(target.type)}“ steht nicht (mehr) in der Zielarten-Datenbank – dieses Ziel wird nicht abgefragt.`,
                }));
            } else if (type.description) {
                expander.add_row(new Adw.ActionRow({ title: esc(type.name), subtitle: esc(type.description) }));
            }

            // Aktiv
            const activeRow = new Adw.SwitchRow({ title: 'Aktiv', subtitle: 'Deaktivierte Ziele werden nicht abgefragt' });
            activeRow.active = target.enabled;
            activeRow.connect('notify::active', () => {
                updateTarget(target.id, { enabled: activeRow.active });
                refreshSubtitle();
            });
            expander.add_row(activeRow);

            // Name
            const nameEntry = new Adw.EntryRow({ title: 'Bezeichnung', text: target.name, show_apply_button: true });
            nameEntry.connect('apply', () => {
                const name = nameEntry.text.trim();
                if (!name || name.length > 40) {
                    nameEntry.add_css_class('error');
                    return;
                }
                nameEntry.remove_css_class('error');
                updateTarget(target.id, { name });
                expander.title = esc(name);
                rebuildSubs();
            });
            expander.add_row(nameEntry);

            // Felder der Zielart (ohne Secret)
            const httpWarning = new Adw.ActionRow({
                title: 'Unverschlüsselte Verbindung',
                subtitle: 'Mit http:// wird das Secret im Klartext übertragen. Wenn möglich https:// verwenden.',
                visible: /^http:\/\//i.test(target.url),
            });
            httpWarning.add_prefix(new Gtk.Image({
                icon_name: 'dialog-warning-symbolic',
                valign: Gtk.Align.CENTER,
                css_classes: ['warning'],
            }));
            for (const field of type.fields.filter(f => f !== 'secret')) {
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
                    const current = getTarget(target.id);
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
                    updateTarget(target.id, { [field]: clean });
                    if (field === 'url') {
                        entry.text = clean;
                        httpWarning.visible = /^http:\/\//i.test(clean);
                    }
                    refreshSubtitle();
                };
                entry.connect('apply', save);
                entry.connect('entry-activated', save);
                pendingSavers.add(save);
                expander.add_row(entry);
                if (type.hints?.[field] && field === 'url')
                    expander.add_row(new Adw.ActionRow({ subtitle: esc(type.hints[field]), css_classes: ['dim-label'] }));
            }
            expander.add_row(httpWarning);

            // Secret im Schlüsselbund
            const secretRow = new Adw.PasswordEntryRow({
                title: esc(fieldLabel(type, 'secret')),
                show_apply_button: true,
            });
            expander.add_row(secretRow);
            const secretInfo = new Adw.ActionRow({
                title: 'Speicherort',
                subtitle: 'GNOME-Schlüsselbund – wird geladen …',
            });
            expander.add_row(secretInfo);

            let storedSecret = null;
            lookupSecret(secretName(target.id))
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
                    const name = getTarget(target.id)?.name ?? target.name;
                    if (value)
                        await storeSecret(secretName(target.id), value, secretLabel(name));
                    else
                        await clearSecret(secretName(target.id));
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
            pendingSavers.add(saveSecret);

            // Zertifikat
            const insecureRow = new Adw.SwitchRow({
                title: 'Zertifikat nicht prüfen',
                subtitle: 'Nur für selbst signierte Zertifikate im eigenen Netz. Die Verbindung bleibt verschlüsselt, aber der Server wird nicht mehr sicher erkannt.',
            });
            insecureRow.active = target.insecure;
            insecureRow.connect('notify::active', () => updateTarget(target.id, { insecure: insecureRow.active }));
            expander.add_row(insecureRow);

            // Intervall
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
                updateTarget(target.id, { interval: intervalRow.selected === 0 ? null : options[intervalRow.selected - 1] });
            });
            expander.add_row(intervalRow);

            // Verbindung testen
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
                const res = await callDriver(target.id, 'test');
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
            expander.add_row(testRow);

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
                expander.add_row(docsRow);
            }

            // Entfernen (zweiter Klick bestätigt)
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
                pendingSavers.delete(saveSecret);
                try {
                    await clearSecret(secretName(target.id));
                } catch (e) {
                    console.warn(`[monbar] Secret konnte nicht gelöscht werden: ${e.message}`);
                }
                saveSubs(loadSubs().filter(s => s.target !== target.id));
                saveTargets(loadTargets().filter(t => t.id !== target.id));
                expandedTargets.delete(target.id);
                rebuildTargets();
                rebuildSubs();
            });
            deleteRow.add_suffix(deleteBtn);
            expander.add_row(deleteRow);

            return expander;
        };

        const addTarget = () => {
            const typeId = typeIds()[typeRow.selected];
            if (!typeId)
                return;
            const target = makeTarget(typeId, nameRow.text);
            saveTargets([...loadTargets(), target]);
            saveSubs([...loadSubs(), makeSubscription(target.id, ALL_HOSTS)]);
            expandedTargets.add(target.id);
            nameRow.text = '';
            addTargetRow.subtitle = `Angelegt: ${esc(target.name)} – jetzt Adresse und Zugangsdaten eintragen`;
            rebuildTargets();
            rebuildSubs();
        };
        addTargetBtn.connect('clicked', addTarget);
        nameRow.connect('entry-activated', addTarget);

        // ==========================================
        // Seite 2: Abos
        // ==========================================
        const pageSubs = new Adw.PreferencesPage({
            title: 'Abos',
            icon_name: 'view-list-symbolic',
        });
        window.add(pageSubs);

        const groupSubsInfo = new Adw.PreferencesGroup({
            title: 'Abos',
            description: 'Je Ziel legst du fest, welche Server angezeigt werden – alle oder einzelne – und je Server, welche Dienste und ob Log-Meldungen. Ignorier-Muster: * = beliebige Zeichen, ? = genau ein Zeichen. Sie gelten für Dienstnamen und Log-Texte; die Liste unter „Alle Server“ gilt für das ganze Ziel.',
        });
        pageSubs.add(groupSubsInfo);

        let subGroups = [];
        const expandedSubs = new Set();
        const hostCache = new Map();       // Ziel-ID → Liste der Server
        const serviceCache = new Map();    // Abo-ID → Liste der Dienste
        const openHostLists = new Set();   // Ziele, deren Serverliste aufgeklappt ist

        const subSummary = (sub, type) => {
            const parts = [];
            parts.push(sub.services === 'all' ? 'alle Dienste'
                : sub.services === 'none' ? 'nur Serverstatus'
                    : `${sub.selected.length} Dienst${sub.selected.length === 1 ? '' : 'e'} ausgewählt`);
            if (hasCapability(type, 'events'))
                parts.push(sub.events ? 'mit Log-Meldungen' : 'ohne Log-Meldungen');
            if (sub.ignore.length > 0)
                parts.push(`${sub.ignore.length} ignoriert`);
            return parts.join(' • ');
        };

        const rebuildSubs = () => {
            for (const g of subGroups)
                pageSubs.remove(g);
            subGroups = [];

            const targets = loadTargets();
            const subs = loadSubs();
            if (targets.length === 0) {
                const g = new Adw.PreferencesGroup({ description: 'Zuerst auf der Seite „Ziele“ ein Ziel anlegen.' });
                pageSubs.add(g);
                subGroups.push(g);
                return;
            }

            for (const target of targets) {
                const type = getType(target.type);
                const own = subs.filter(s => s.target === target.id)
                    .sort((a, b) => (a.host === ALL_HOSTS ? -1 : b.host === ALL_HOSTS ? 1 : a.host.localeCompare(b.host)));
                const group = new Adw.PreferencesGroup({
                    title: esc(target.name),
                    description: esc(`${type.name}${own.length === 0 ? ' • nichts abonniert – es wird nichts angezeigt' : ''}`),
                });
                pageSubs.add(group);
                subGroups.push(group);

                for (const sub of own)
                    group.add(buildSubRow(target, type, sub));

                addHostPicker(group, target, own);
            }
        };

        /** Server hinzufügen: Liste vom Monitoring laden oder Namen eintippen. */
        const addHostPicker = (group, target, own) => {
            const subscribed = new Set(own.map(s => s.host));
            const addHost = host => {
                const h = host.trim();
                if (!h || h.length > 200 || subscribed.has(h))
                    return false;
                const sub = makeSubscription(target.id, h);
                saveSubs([...loadSubs(), sub]);
                expandedSubs.add(sub.id);
                rebuildSubs();
                return true;
            };

            const picker = new Adw.ExpanderRow({
                title: 'Server abonnieren',
                subtitle: hostCache.has(target.id)
                    ? `${hostCache.get(target.id).length} Server geladen`
                    : 'Liste vom Monitoring laden oder Namen eingeben',
                expanded: openHostLists.has(target.id),
            });
            picker.connect('notify::expanded', () => {
                if (picker.expanded)
                    openHostLists.add(target.id);
                else
                    openHostLists.delete(target.id);
            });

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
            picker.add_row(manual);

            const loadRow = new Adw.ActionRow({ title: 'Server vom Monitoring laden' });
            const loadBtn = new Gtk.Button({
                icon_name: 'view-refresh-symbolic',
                valign: Gtk.Align.CENTER,
                tooltip_text: 'Serverliste laden',
            });
            loadBtn.connect('clicked', async () => {
                loadBtn.sensitive = false;
                loadRow.subtitle = 'Lade …';
                await flushPending();
                const res = await callDriver(target.id, 'listHosts');
                loadBtn.sensitive = true;
                if (!res.ok) {
                    loadRow.subtitle = esc(describeResult(res));
                    return;
                }
                hostCache.set(target.id, res.items);
                openHostLists.add(target.id);
                rebuildSubs();
            });
            loadRow.add_suffix(loadBtn);
            picker.add_row(loadRow);

            const hosts = hostCache.get(target.id) ?? [];
            const free = hosts.filter(h => !subscribed.has(h));
            if (hosts.length > 0 && free.length === 0)
                loadRow.subtitle = 'Alle Server sind bereits abonniert';
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
                picker.add_row(row);
            }

            group.add(picker);
        };

        const buildSubRow = (target, type, sub) => {
            const isAll = sub.host === ALL_HOSTS;
            const expander = new Adw.ExpanderRow({
                title: esc(isAll ? 'Alle Server' : sub.host),
                subtitle: esc(subSummary(sub, type)),
                expanded: expandedSubs.has(sub.id),
            });
            expander.connect('notify::expanded', () => {
                if (expander.expanded)
                    expandedSubs.add(sub.id);
                else
                    expandedSubs.delete(sub.id);
            });
            const refreshSummary = () => {
                const s = loadSubs().find(x => x.id === sub.id);
                if (s)
                    expander.subtitle = esc(subSummary(s, type));
            };

            // Dienste
            const modes = isAll ? ['all', 'none'] : ['all', 'selected', 'none'];
            const modeLabels = { all: 'Alle', selected: 'Nur ausgewählte', none: 'Keine (nur Serverstatus)' };
            const modeRow = new Adw.ComboRow({
                title: type.driver === 'prometheus-kuma' ? 'Monitore' : 'Dienste',
                subtitle: isAll ? 'Einzelne Dienste wählst du je Server aus' : '',
                model: new Gtk.StringList({ strings: modes.map(m => modeLabels[m]) }),
            });
            modeRow.selected = Math.max(0, modes.indexOf(sub.services));
            expander.add_row(modeRow);

            // Dienst-Auswahl (nur bei einzelnen Servern)
            const serviceRows = [];
            const showServiceRows = () => {
                for (const r of serviceRows)
                    r.visible = modes[modeRow.selected] === 'selected';
            };
            if (!isAll) {
                const current = loadSubs().find(x => x.id === sub.id) ?? sub;
                const loaded = serviceCache.get(sub.id) ?? [];
                const names = [...new Set([...current.selected, ...loaded])].sort((a, b) => a.localeCompare(b));

                const loadRow = new Adw.ActionRow({
                    title: 'Dienste auswählen',
                    subtitle: loaded.length ? `${loaded.length} Dienste geladen` : 'Liste vom Monitoring laden',
                });
                const loadBtn = new Gtk.Button({
                    icon_name: 'view-refresh-symbolic',
                    valign: Gtk.Align.CENTER,
                    tooltip_text: 'Dienste laden',
                });
                loadBtn.connect('clicked', async () => {
                    loadBtn.sensitive = false;
                    loadRow.subtitle = 'Lade …';
                    await flushPending();
                    const res = await callDriver(target.id, 'listServices', sub.host);
                    loadBtn.sensitive = true;
                    if (!res.ok) {
                        loadRow.subtitle = esc(describeResult(res));
                        return;
                    }
                    if (res.items.length === 0) {
                        loadRow.subtitle = 'Keine Dienste gefunden – stimmt der Servername?';
                        return;
                    }
                    serviceCache.set(sub.id, res.items);
                    expandedSubs.add(sub.id);
                    rebuildSubs();
                });
                loadRow.add_suffix(loadBtn);
                expander.add_row(loadRow);
                serviceRows.push(loadRow);

                for (const name of names) {
                    const row = new Adw.ActionRow({ title: esc(name) });
                    const check = new Gtk.CheckButton({
                        active: current.selected.includes(name),
                        valign: Gtk.Align.CENTER,
                    });
                    check.connect('toggled', () => {
                        const s = loadSubs().find(x => x.id === sub.id);
                        if (!s)
                            return;
                        const selected = check.active
                            ? [...new Set([...s.selected, name])]
                            : s.selected.filter(n => n !== name);
                        updateSub(sub.id, { selected });
                        refreshSummary();
                    });
                    row.add_prefix(check);
                    row.activatable_widget = check;
                    expander.add_row(row);
                    serviceRows.push(row);
                }
            }
            showServiceRows();
            modeRow.connect('notify::selected', () => {
                updateSub(sub.id, { services: modes[modeRow.selected] });
                showServiceRows();
                refreshSummary();
            });

            // Log-Meldungen
            if (hasCapability(type, 'events')) {
                const eventsRow = new Adw.SwitchRow({
                    title: 'Log-Meldungen (Event Console)',
                    subtitle: 'Offene Meldungen aus Syslog, SNMP-Traps und Logdateien, die die Event Console erfasst',
                });
                eventsRow.active = sub.events;
                eventsRow.connect('notify::active', () => {
                    updateSub(sub.id, { events: eventsRow.active });
                    refreshSummary();
                });
                expander.add_row(eventsRow);
            }

            // Ignorierliste
            for (const pattern of sub.ignore) {
                const row = new Adw.ActionRow({
                    title: esc(pattern),
                    subtitle: 'wird ignoriert',
                });
                const removeBtn = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    valign: Gtk.Align.CENTER,
                    tooltip_text: 'Nicht mehr ignorieren',
                    css_classes: ['flat'],
                });
                removeBtn.connect('clicked', () => {
                    const s = loadSubs().find(x => x.id === sub.id);
                    if (s)
                        updateSub(sub.id, { ignore: s.ignore.filter(p => p !== pattern) });
                    expandedSubs.add(sub.id);
                    rebuildSubs();
                });
                row.add_suffix(removeBtn);
                expander.add_row(row);
            }
            const ignoreEntry = new Adw.EntryRow({
                title: isAll ? 'Ignorieren (gilt für das ganze Ziel), z. B. Log * oder Interface ?' : 'Ignorieren, z. B. Filesystem /boot* oder *Backup*',
                show_apply_button: true,
            });
            const addPattern = () => {
                const pattern = ignoreEntry.text.trim();
                if (!isValidPattern(pattern)) {
                    ignoreEntry.add_css_class('error');
                    return;
                }
                const s = loadSubs().find(x => x.id === sub.id);
                if (s && !s.ignore.includes(pattern))
                    updateSub(sub.id, { ignore: [...s.ignore, pattern] });
                expandedSubs.add(sub.id);
                rebuildSubs();
            };
            ignoreEntry.connect('apply', addPattern);
            ignoreEntry.connect('entry-activated', addPattern);
            expander.add_row(ignoreEntry);

            // Abo entfernen
            const removeRow = new Adw.ActionRow({
                title: isAll ? 'Abo „Alle Server“ entfernen' : 'Server nicht mehr abonnieren',
                subtitle: isAll ? 'Danach werden nur noch einzeln abonnierte Server angezeigt' : '',
            });
            const removeBtn = new Gtk.Button({
                label: 'Entfernen',
                valign: Gtk.Align.CENTER,
            });
            removeBtn.connect('clicked', () => {
                saveSubs(loadSubs().filter(s => s.id !== sub.id));
                serviceCache.delete(sub.id);
                rebuildSubs();
            });
            removeRow.add_suffix(removeBtn);
            expander.add_row(removeRow);

            return expander;
        };

        rebuildTargets();
        rebuildSubs();

        // Änderungen von außen (Ignorieren-Knopf im Popup, zweites Einstellungsfenster)
        const signals = [
            settings.connect('changed::subscriptions', () => {
                if (ownWrite === 0)
                    rebuildSubs();
            }),
            settings.connect('changed::targets', () => {
                if (ownWrite === 0) {
                    rebuildTargets();
                    rebuildSubs();
                }
            }),
        ];
        window.connect('close-request', () => {
            for (const save of pendingSavers)
                save();
            for (const id of signals)
                settings.disconnect(id);
            return false;
        });

        // ==========================================
        // Seite 3: Allgemein
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
        // Seite 4: Updates
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
            fillTypeRow();
            rebuildTargets();
            rebuildSubs();
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
