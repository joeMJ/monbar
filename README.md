# monbar - Monitoring-Status in der GNOME-Leiste

> [!WARNING]
> **Privates Hobbyprojekt – nicht gepflegt / unmaintained.**
> Dieses Repository ist für meinen eigenen Gebrauch gedacht und wird nur aus Bequemlichkeit öffentlich bereitgestellt.
>
> * **Keine Unterstützung:** Issues und Pull Requests werden nicht bearbeitet, Feature-Wünsche nicht umgesetzt. Bitte keine Issues eröffnen.
> * **Keine Garantie:** Bereitstellung „wie besehen“, ohne jede Gewährleistung und Haftung. Nutzung auf eigenes Risiko.
> * **Eigene Umgebung:** Entwickelt und getestet nur auf meinen eigenen Ubuntu-Rechnern (24.04 / 26.04, GNOME 46–50). Auf anderen Systemen kann es fehlschlagen.
> * **Zugangsdaten & Netzwerk:** Die Extension läuft mit den Rechten deiner GNOME-Sitzung. Das Secret des CheckMK-Automationsbenutzers und der Uptime-Kuma-API-Key werden im GNOME-Schlüsselbund (libsecret) gespeichert – verschlüsselt, solange du abgemeldet bist; während der Sitzung können Programme deines Benutzers sie lesen. Verwende am besten einen eigenen CheckMK-Benutzer mit reinen Leserechten und einen eigenen Uptime-Kuma-API-Key. Sie ruft regelmäßig die REST API deiner CheckMK-Instanz, den `/metrics`-Endpunkt deiner Uptime-Kuma-Instanz, für die Update-Prüfung eine entfernte `metadata.json` und die Zielarten-Datenbank `targets.json` von GitHub ab. **Lies den Code, bevor du ihn installierst.**
> * **Keine Updates zugesichert:** Es kann jederzeit ohne Ankündigung Änderungen, Brüche oder die Löschung des Repos geben. Gern selbst forken und anpassen.
>
> *Private hobby project, unmaintained, provided as-is. No support, no issues, no warranty. Fork it if you like.*

> **Störungen und Warnungen aus Checkmk und Uptime Kuma auf einen Blick in der GNOME-Shell-Leiste**

---

## Plattform-Übersicht

| Plattform | Status | Verzeichnis | Tech Stack |
| :--- | :--- | :--- | :--- |
| **Linux (GNOME Shell)** | In Entwicklung (v0.2) | [`linux/`](linux/) | GNOME Shell 46–50 ESM, Libsoup 3.0, GTK4/Adw, libsecret |

---

## Funktionen

* **Statusleiste:**
  * Pulssymbol mit **roter Zahl für Störungen** (CRIT, DOWN, UNREACH) und **gelber Zahl für Warnungen** (WARN, UNKNOWN, PENDING, Zertifikat läuft bald ab).
  * Wahlweise nur sichtbar, wenn es etwas zu melden gibt.

* **Popup (bei Klick auf das Symbol):**
  * Eine Karte je Meldung: Server, Dienst oder Log-Meldung, Status, Dauer, Ausgabe des Checks.
  * Klick auf eine Karte öffnet die Stelle in der Oberfläche von Checkmk bzw. Uptime Kuma.
  * **Ignorieren-Knopf** an jeder Dienst- und Log-Meldung – sie kommt nicht wieder, bis du das Muster in den Einstellungen entfernst.
  * Hinweise je Ziel bei Verbindungsproblemen, fehlendem Secret oder gesperrtem Schlüsselbund.

* **Ziele:** beliebig viele Instanzen, auch gemischt (z. B. zwei Checkmk-Sites und ein Uptime Kuma), jede mit eigenem Intervall.

* **Abos je Ziel:**
  * **Alle Server** oder **einzelne Server** – die Serverliste wird direkt vom Monitoring geladen.
  * Je Server: **alle Dienste**, **nur ausgewählte** oder **keine** (nur Serverstatus).
  * **Log-Meldungen** aus der Checkmk Event Console an/aus.
  * **Ignorierlisten** mit Mustern (`*` = beliebige Zeichen, `?` = ein Zeichen) je Server oder für das ganze Ziel – z. B. `Log *`, `Filesystem /boot*`, `*Backup*`.

* **Filter:** quittierte Probleme und Wartungszeiten standardmäßig ausgeblendet, bei Checkmk nur bestätigte (harte) Zustände.

* **Benachrichtigungen** nur bei *neuen* Problemen – nach dem Anmelden gibt es keine Flut.

* **Zielarten-Datenbank** ([`linux/data/targets.json`](linux/data/targets.json)): Welche Monitoring-Systeme monbar kennt, steht als JSON im Repository und wird ohne Neuanmeldung aktualisiert (wie die Versender-Datenbank in packetbar).

---

## Installation Linux (Ubuntu / GNOME)

**Voraussetzungen:** Ubuntu 24.04 – 26.04 (GNOME 46–50), `curl`, `tar` und `glib-compile-schemas` (Paket `libglib2.0-bin`, auf Ubuntu vorinstalliert). Kein `sudo` nötig – alles läuft im eigenen Benutzerkonto.

### Installieren

```bash
curl -fsSL https://raw.githubusercontent.com/joeMJ/monbar/main/install.sh | bash
```

Das Skript lädt den aktuellen Stand per HTTPS von GitHub in ein temporäres Verzeichnis, installiert die Extension nach `~/.local/share/gnome-shell/extensions/` und räumt danach auf.

> [!NOTE]
> Unter Wayland lädt GNOME Shell neue oder aktualisierte Extensions erst nach dem **Ab- und wieder Anmelden**.

### Aktualisieren

Denselben Befehl erneut ausführen oder in den Einstellungen unter *Updates* auf **Jetzt aktualisieren** klicken – Ziele, Abos und Secrets bleiben erhalten. Liegt eine neue Version vor, zeigt das Popup einen Hinweis.

```bash
curl -fsSL https://raw.githubusercontent.com/joeMJ/monbar/main/install.sh | bash
```

### Deinstallieren

```bash
curl -fsSL https://raw.githubusercontent.com/joeMJ/monbar/main/install.sh | bash -s -- --uninstall
```

Entfernt die Extension, alle Einstellungen, die heruntergeladene Zielarten-Datenbank und alle Secrets von monbar aus dem Schlüsselbund. (Über den Extension-Manager deinstalliert, bleiben Einstellungen und Secrets erhalten.)

### Erst ansehen, dann ausführen

```bash
curl -fsSLO https://raw.githubusercontent.com/joeMJ/monbar/main/install.sh
less install.sh
bash install.sh
```

### Einstellungen

Über das Zahnrad im Popup oder:

```bash
gnome-extensions prefs monbar@johnlose.de
```

### Alternative: Git-Klon (für Entwicklung)

```bash
git clone https://github.com/joeMJ/monbar.git
cd monbar
./install.sh
```

Update mit `./update.sh` (führt `git pull` aus), Deinstallation mit `./uninstall.sh`.

---

## Einrichtung

### Checkmk

1. In Checkmk unter *Setup → Benutzer* einen **Automationsbenutzer** anlegen (z. B. `monbar`) mit einer Rolle, die nur lesen darf, z. B. *Guest user*. Für Log-Meldungen braucht die Rolle zusätzlich das Recht, Ereignisse der Event Console zu sehen.
2. In monbar unter *Ziele* ein Ziel „Checkmk“ anlegen und eintragen:
   * **Server-URL** ohne Instanz, z. B. `https://monitor.example.lan`
   * **Instanz (Site)**, z. B. `mysite`
   * **Automationsbenutzer** und **Automation-Secret**
3. **Verbindung testen.** monbar erkennt selbst, ob die REST API als `v1` (ab Checkmk 2.5) oder `1.0` (bis 2.4) vorliegt.

### Uptime Kuma

1. In Uptime Kuma unter *Einstellungen → API-Keys* einen Key anlegen.
2. In monbar ein Ziel „Uptime Kuma“ mit **Server-URL** (z. B. `http://192.168.1.10:3001`) und dem **API-Key** anlegen. Das Benutzerfeld bleibt leer.
3. Monitore werden nach Hostname bzw. Host der URL zu „Servern“ gruppiert, damit Abos und Ignorierlisten wie bei Checkmk funktionieren.

### Aufbau der Einstellungen

* **Ziele** – Übersicht aller Ziele. Ein Klick öffnet die Seite des Ziels mit den Abschnitten *Allgemein*, *Verbindung*, *Zugangsdaten*, *Abos* und *Server abonnieren*.
* **Seite eines Servers** (Klick auf ein Abo) – *Dienste* (alle, ausgewählte oder keine), *Log-Meldungen* (Event Console) und *Ignorieren*.
* **Allgemein** – Anzeige, Filter, Benachrichtigungen. **Updates** – Programm und Zielarten-Datenbank.

Neue Ziele abonnieren automatisch **Alle Server**. Log-Dienste wie „Log System“ zeigen im Popup nur die gemeldete Log-Zeile; der Ignorieren-Knopf blendet dann genau diese Meldung aus, nicht das ganze Log.

---

## Neue Zielarten

Die Zielarten-Datenbank enthält nur Daten: Namen, Felder, Status-Übersetzung, Intervalle. Der Programmcode, der ein System abfragt (der **Treiber**), ist fest in monbar hinterlegt; Adressen und Zugangsdaten kommen nie aus der Datenbank.

* Eine Zielart, die einen **vorhandenen Treiber** nutzt, kommt per Datenbank-Update – ohne neue Version.
* Ein System mit **neuem Protokoll** (z. B. Nagios) braucht einen neuen Treiber in [`linux/src/drivers.js`](linux/src/drivers.js) (Methoden `fetchProblems`, `test`, `listHosts`, `listServices`) plus Eintrag in `DRIVERS` ([`targetTypes.js`](linux/src/targetTypes.js)) und in der Datenbank.

## Tests

Die reine Logik und die Treiber (mit HTTP-Attrappe) lassen sich ohne GNOME prüfen:

```bash
node tests/run.mjs
node --import ./tests/mock/register.mjs tests/drivers.mjs
```

Nach jeder Änderung an `linux/data/targets.json` einmal `node tests/run.mjs` laufen lassen.

---

## Lizenz

[Apache License 2.0](LICENSE)
