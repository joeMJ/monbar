# monbar - Monitoring-Status in der GNOME-Leiste

> [!WARNING]
> **Privates Hobbyprojekt – nicht gepflegt / unmaintained.**
> Dieses Repository ist für meinen eigenen Gebrauch gedacht und wird nur aus Bequemlichkeit öffentlich bereitgestellt.
>
> * **Keine Unterstützung:** Issues und Pull Requests werden nicht bearbeitet, Feature-Wünsche nicht umgesetzt. Bitte keine Issues eröffnen.
> * **Keine Garantie:** Bereitstellung „wie besehen“, ohne jede Gewährleistung und Haftung. Nutzung auf eigenes Risiko.
> * **Eigene Umgebung:** Entwickelt und getestet nur auf meinen eigenen Ubuntu-Rechnern (24.04 / 26.04, GNOME 46–50). Auf anderen Systemen kann es fehlschlagen.
> * **Zugangsdaten & Netzwerk:** Die Extension läuft mit den Rechten deiner GNOME-Sitzung. Das Secret des CheckMK-Automationsbenutzers und der Uptime-Kuma-API-Key werden im GNOME-Schlüsselbund (libsecret) gespeichert – verschlüsselt, solange du abgemeldet bist; während der Sitzung können Programme deines Benutzers sie lesen. Verwende am besten einen eigenen CheckMK-Benutzer mit reinen Leserechten und einen eigenen Uptime-Kuma-API-Key. Sie ruft regelmäßig die REST API deiner CheckMK-Instanz, den `/metrics`-Endpunkt deiner Uptime-Kuma-Instanz und für die Update-Prüfung eine entfernte `metadata.json` ab. **Lies den Code, bevor du ihn installierst.**
> * **Keine Updates zugesichert:** Es kann jederzeit ohne Ankündigung Änderungen, Brüche oder die Löschung des Repos geben. Gern selbst forken und anpassen.
>
> *Private hobby project, unmaintained, provided as-is. No support, no issues, no warranty. Fork it if you like.*

> **Status von CheckMK und Uptime Kuma auf einen Blick in der GNOME-Shell-Leiste**

---

## Status

In Entwicklung – noch nicht installierbar.

## Geplante Funktionen

* **Statusleiste:** Ampel-Icon mit Anzahl der Probleme (WARN / CRIT / DOWN).
* **Popup:** Liste der betroffenen Hosts, Services und Monitore je Quelle.
* **Quellen:**
  * **CheckMK** über die REST API (Automationsbenutzer).
  * **Uptime Kuma** über den Prometheus-Endpunkt `/metrics` (API-Key).

---

## Lizenz

[Apache License 2.0](LICENSE)
