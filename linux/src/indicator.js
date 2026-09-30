/**
 * indicator.js - Panel Button & Popup-Menü UI für monbar
 */

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { formatSince, formatClock, summarize } from './monUtil.js';

const MAX_CARDS = 60;

const SEVERITY_ICONS = {
    crit: 'dialog-error-symbolic',
    unknown: 'dialog-question-symbolic',
    warn: 'dialog-warning-symbolic',
    maintenance: 'preferences-system-time-symbolic',
};

// Hinweistexte je Fehlerart eines Ziels
const HINT_TEXTS = {
    config: msg => `Einstellungen unvollständig – ${msg}`,
    locked: () => 'Schlüsselbund gesperrt – wird abgefragt, sobald er entsperrt ist.',
    nokey: () => 'Kein Secret hinterlegt – bitte in den Einstellungen eintragen.',
    auth: () => 'Zugangsdaten werden abgelehnt – Benutzer und Secret prüfen.',
    notfound: msg => msg || 'Adresse nicht gefunden – Server-URL (und Instanz) prüfen.',
    format: msg => msg || 'Unerwartete Antwort – Server-URL prüfen.',
    tls: () => 'Zertifikat wird nicht akzeptiert – bei selbst signierten Zertifikaten „Zertifikat nicht prüfen“ einschalten.',
    network: () => 'Nicht erreichbar – Netzwerk oder Server prüfen.',
    server: msg => `Serverfehler (${msg}) – später erneut.`,
    ratelimit: () => 'Zu viele Anfragen – Abfrageintervall erhöhen.',
    http: msg => `Abfrage fehlgeschlagen (${msg}).`,
};

function hintText(error) {
    const fn = HINT_TEXTS[error.kind] ?? HINT_TEXTS.http;
    return fn(error.message || error.kind);
}

export const MonIndicator = GObject.registerClass(
class MonIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'MonBar Indicator', false);

        this._extension = extension;
        this._settings = extension.getSettings();

        this._pulseIcon = new Gio.FileIcon({
            file: Gio.File.new_for_path(
                GLib.build_filenamev([extension.path, 'icons', 'monbar-symbolic.svg'])),
        });

        // 1. Panel Box (Icon + Zähler Störungen / Warnungen)
        this._panelBox = new St.BoxLayout({
            style_class: 'monbar-panel-box',
            reactive: true,
            can_focus: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._panelIcon = new St.Icon({
            gicon: this._pulseIcon,
            style_class: 'system-status-icon monbar-panel-icon',
        });
        this._panelBox.add_child(this._panelIcon);

        this._critLabel = new St.Label({
            text: '',
            style_class: 'monbar-panel-count monbar-panel-count-crit',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._panelBox.add_child(this._critLabel);

        this._warnLabel = new St.Label({
            text: '',
            style_class: 'monbar-panel-count monbar-panel-count-warn',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._panelBox.add_child(this._warnLabel);

        this.add_child(this._panelBox);

        // 2. Popup Menü Aufbau
        this._buildMenu();
    }

    _buildMenu() {
        this.menu.box.add_style_class_name('monbar-menu');

        this._mainSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._mainSection);

        this._contentBox = new St.BoxLayout({
            vertical: true,
            style_class: 'monbar-content-box',
        });
        this._mainSection.actor.add_child(this._contentBox);

        // Update-Banner
        this._updateBanner = new St.BoxLayout({
            style_class: 'monbar-update-banner',
            visible: false,
        });
        this._updateBanner.add_child(new St.Icon({
            icon_name: 'software-update-available-symbolic',
            style_class: 'monbar-update-icon',
        }));
        this._updateLabel = new St.Label({
            text: 'Update verfügbar!',
            style_class: 'monbar-update-text',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._updateLabel.clutter_text.line_wrap = true;
        this._updateLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._updateBanner.add_child(this._updateLabel);
        this._contentBox.add_child(this._updateBanner);

        // Hinweise je Ziel (Verbindungsfehler, fehlendes Secret …)
        this._hintBox = new St.BoxLayout({
            vertical: true,
            style_class: 'monbar-hint-list',
            visible: false,
        });
        this._contentBox.add_child(this._hintBox);

        // Titelzeile mit Zusammenfassung
        const titleBox = new St.BoxLayout({
            style_class: 'monbar-section-title-box',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const title = new St.Label({
            text: 'Monitoring',
            style_class: 'monbar-section-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        title.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        titleBox.add_child(title);
        this._summaryLabel = new St.Label({
            text: '',
            style_class: 'monbar-section-summary',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._summaryLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        titleBox.add_child(this._summaryLabel);
        this._contentBox.add_child(titleBox);

        // Kartenliste (scrollbar, falls viele Meldungen)
        this._scroll = new St.ScrollView({
            style_class: 'monbar-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
        });
        this._listBox = new St.BoxLayout({
            vertical: true,
            style_class: 'monbar-list-box',
            x_expand: true,
        });
        if (typeof this._scroll.set_child === 'function')
            this._scroll.set_child(this._listBox);
        else
            this._scroll.add_child(this._listBox);
        this._contentBox.add_child(this._scroll);

        this._contentBox.add_child(new PopupMenu.PopupSeparatorMenuItem());

        // Footer (Stand & Buttons)
        this._footerBox = new St.BoxLayout({
            style_class: 'monbar-footer-box',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._footerStatusLabel = new St.Label({
            text: 'Initialisiere...',
            style_class: 'monbar-footer-text',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._footerBox.add_child(this._footerStatusLabel);

        const refreshBtn = new St.Button({
            style_class: 'monbar-icon-button button',
            can_focus: true,
            child: new St.Icon({ icon_name: 'view-refresh-symbolic', icon_size: 16 }),
        });
        refreshBtn.connect('clicked', () => {
            this._footerStatusLabel.text = 'Aktualisiere...';
            this._extension.refreshData({ force: true, manual: true });
        });
        this._footerBox.add_child(refreshBtn);

        const settingsBtn = new St.Button({
            style_class: 'monbar-icon-button button',
            can_focus: true,
            child: new St.Icon({ icon_name: 'emblem-system-symbolic', icon_size: 16 }),
        });
        settingsBtn.connect('clicked', () => {
            this.menu.close();
            this._extension.openPreferences();
        });
        this._footerBox.add_child(settingsBtn);

        this._contentBox.add_child(this._footerBox);
    }

    _openLink(url) {
        if (!url || !/^https?:\/\//.test(url))
            return;
        this.menu.close();
        try {
            Gio.AppInfo.launch_default_for_uri(url, null);
        } catch (e) {
            console.warn(`[monbar] Link konnte nicht geöffnet werden: ${e.message}`);
        }
    }

    /** Karte einer Meldung. Klick öffnet die Oberfläche des Monitoring-Systems. */
    _buildCard(p) {
        const outer = new St.BoxLayout({
            style_class: `monbar-card monbar-card-${p.severity}`,
            x_expand: true,
        });

        const card = new St.Button({
            style_class: 'monbar-card-main',
            can_focus: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });
        card.connect('clicked', () => this._openLink(p.link));
        outer.add_child(card);

        const row = new St.BoxLayout({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'monbar-card-row',
        });
        card.set_child(row);

        row.add_child(new St.Icon({
            icon_name: SEVERITY_ICONS[p.severity] ?? SEVERITY_ICONS.warn,
            icon_size: 24,
            style_class: 'monbar-card-icon',
            y_align: Clutter.ActorAlign.START,
        }));

        const info = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'monbar-card-info',
        });
        row.add_child(info);

        const titleText = p.kind === 'host' ? p.host : p.name;
        const title = new St.Label({ text: titleText, style_class: 'monbar-card-title' });
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        info.add_child(title);

        const where = p.kind === 'host' ? 'Server' : p.kind === 'event' ? `${p.host} • Log` : p.host;
        const subtitle = new St.Label({
            text: `${where} • ${p.targetName}`,
            style_class: 'monbar-card-subtitle',
        });
        subtitle.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
        info.add_child(subtitle);

        const statusParts = [p.label];
        const since = formatSince(p.since);
        if (since)
            statusParts.push(since);
        if (p.count > 1)
            statusParts.push(`${p.count}×`);
        if (p.acknowledged)
            statusParts.push('quittiert');
        if (p.downtime)
            statusParts.push('in Wartung');
        const status = new St.Label({
            text: statusParts.join(' • '),
            style_class: 'monbar-card-status',
        });
        status.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        info.add_child(status);

        if (p.text) {
            const detail = new St.Label({
                text: p.text,
                style_class: 'monbar-card-detail',
                x_expand: true,
            });
            detail.clutter_text.line_wrap = true;
            detail.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            detail.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            info.add_child(detail);
        }

        // Rechts: ignorieren (nicht für Server-Status – dafür das Abo ändern)
        if (p.kind !== 'host') {
            const ignoreBtn = new St.Button({
                style_class: 'monbar-icon-button monbar-ignore-button button',
                can_focus: true,
                y_align: Clutter.ActorAlign.CENTER,
                child: new St.Icon({ icon_name: 'view-conceal-symbolic', icon_size: 16 }),
            });
            ignoreBtn.connect('clicked', () => this._extension.ignoreProblem(p));
            outer.add_child(ignoreBtn);
        }

        return outer;
    }

    _setLabel(label, n) {
        label.text = String(n);
        label.visible = n > 0;
    }

    /**
     * Aktualisiert die UI.
     * @param {object} data
     * @param {object[]} data.items - sichtbare, sortierte Meldungen aller Ziele
     * @param {object[]} data.status - je aktivem Ziel {target, count, error, stale, notes, fetched}
     */
    updateUI({ items, status, configured, isOffline = false, lastTimestamp = null, updateStatus = null }) {
        const { crit, warn } = summarize(items);
        const errors = status.filter(s => s.error);

        // Panel
        this._setLabel(this._critLabel, crit);
        this._setLabel(this._warnLabel, warn);
        for (const c of ['monbar-panel-crit', 'monbar-panel-warn', 'monbar-panel-error', 'monbar-panel-idle'])
            this._panelBox.remove_style_class_name(c);
        if (crit > 0)
            this._panelBox.add_style_class_name('monbar-panel-crit');
        else if (warn > 0)
            this._panelBox.add_style_class_name('monbar-panel-warn');
        else if (errors.length > 0)
            this._panelBox.add_style_class_name('monbar-panel-error');
        else if (!configured)
            this._panelBox.add_style_class_name('monbar-panel-idle');

        const quiet = crit === 0 && warn === 0 && errors.length === 0;
        this.visible = !(quiet && configured && !this._settings.get_boolean('show-ok-icon'));

        // Zusammenfassung
        const summary = [];
        if (crit > 0)
            summary.push(`${crit} ${crit === 1 ? 'Störung' : 'Störungen'}`);
        if (warn > 0)
            summary.push(`${warn} ${warn === 1 ? 'Warnung' : 'Warnungen'}`);
        this._summaryLabel.text = summary.length > 0 ? summary.join(' • ')
            : configured && status.some(s => s.fetched && !s.error) ? 'Alles in Ordnung' : '';

        // Hinweise je Ziel
        this._hintBox.destroy_all_children();
        const hints = [];
        for (const s of status) {
            if (s.error)
                hints.push(`${s.target.name}: ${hintText(s.error)}${s.stale ? ' Angezeigt wird der letzte bekannte Stand.' : ''}`);
            else if (s.notes.includes('nosubs'))
                hints.push(`${s.target.name}: Noch nichts abonniert – in den Einstellungen unter „Abos“ Server auswählen.`);
            else if (s.notes.includes('events-unsupported'))
                hints.push(`${s.target.name}: Log-Meldungen (Event Console) sind auf diesem Server nicht verfügbar.`);
        }
        for (const text of hints) {
            const banner = new St.BoxLayout({ style_class: 'monbar-hint-banner' });
            banner.add_child(new St.Icon({
                icon_name: 'dialog-information-symbolic',
                style_class: 'monbar-hint-icon',
            }));
            const label = new St.Label({
                text,
                style_class: 'monbar-hint-text',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            label.clutter_text.line_wrap = true;
            label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            banner.add_child(label);
            this._hintBox.add_child(banner);
        }
        this._hintBox.visible = hints.length > 0;

        // Karten
        this._listBox.destroy_all_children();
        if (!configured) {
            this._listBox.add_child(new St.Label({
                text: 'Noch keine Ziele eingetragen – in den Einstellungen hinzufügen.',
                style_class: 'monbar-empty-placeholder',
                x_align: Clutter.ActorAlign.CENTER,
            }));
        } else if (items.length === 0) {
            const okBox = new St.BoxLayout({
                style_class: 'monbar-ok-box',
                x_align: Clutter.ActorAlign.CENTER,
            });
            okBox.add_child(new St.Icon({
                icon_name: 'emblem-ok-symbolic',
                icon_size: 20,
                style_class: 'monbar-ok-icon',
            }));
            okBox.add_child(new St.Label({
                text: errors.length === status.length && errors.length > 0
                    ? 'Kein Ziel erreichbar'
                    : 'Keine Störungen oder Warnungen',
                style_class: 'monbar-empty-placeholder',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            this._listBox.add_child(okBox);
        } else {
            for (const p of items.slice(0, MAX_CARDS))
                this._listBox.add_child(this._buildCard(p));
            if (items.length > MAX_CARDS) {
                this._listBox.add_child(new St.Label({
                    text: `… und ${items.length - MAX_CARDS} weitere`,
                    style_class: 'monbar-empty-placeholder',
                    x_align: Clutter.ActorAlign.CENTER,
                }));
            }
        }

        // Footer Stand
        let statusMsg = lastTimestamp instanceof Date
            ? `Stand: ${formatClock(lastTimestamp)} Uhr`
            : 'Stand: noch keine Abfrage';
        if (isOffline)
            statusMsg += ' (Offline)';
        if (status.length > 1)
            statusMsg += ` • ${status.length} Ziele`;
        this._footerStatusLabel.text = statusMsg;

        // Update-Banner
        if (updateStatus?.updateAvailable) {
            this._updateBanner.visible = true;
            this._updateLabel.text = `Update v${updateStatus.remoteVersionName ?? updateStatus.remoteVersion} verfügbar – „Jetzt aktualisieren“ in den Einstellungen`;
        } else {
            this._updateBanner.visible = false;
        }
    }
});
