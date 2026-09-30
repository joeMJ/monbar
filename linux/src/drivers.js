/**
 * drivers.js - Treiber, die monbar mitbringt
 *
 * Die Zielarten-Datenbank verweist per `driver` auf einen dieser Einträge. Wer eine
 * neue Art von Monitoring-System anbinden will (z. B. Nagios), schreibt einen Client
 * mit denselben Methoden (fetchProblems, test, listHosts, listServices, destroy),
 * trägt ihn hier und in DRIVERS (targetTypes.js) ein und ergänzt die Datenbank.
 */

import { CheckmkClient } from './checkmkClient.js';
import { KumaClient } from './kumaClient.js';
import { IcingaClient } from './icingaClient.js';
import { NagiosClient } from './nagiosClient.js';
import { NagiosXiClient } from './nagiosXiClient.js';

const FACTORIES = {
    'checkmk-rest': () => new CheckmkClient(),
    'prometheus-kuma': () => new KumaClient(),
    'icinga2-rest': () => new IcingaClient(),
    'nagios-statusjson': () => new NagiosClient(),
    'nagiosxi-rest': () => new NagiosXiClient(),
};

/** Legt je Treiber einen Client an. */
export function createDrivers() {
    return Object.fromEntries(Object.entries(FACTORIES).map(([id, make]) => [id, make()]));
}

export function destroyDrivers(drivers) {
    for (const d of Object.values(drivers ?? {}))
        d.destroy?.();
}
