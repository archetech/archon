import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';

// Two services that publish one host port both start on a node that enables only
// one of them. On a node that enables both, the second fails to bind and compose
// stops starting what comes after it. Nothing shows this until an operator turns
// both profiles on.

const COMPOSE_DIR = 'docker/compose';

// Services that are never run together, so that sharing a port is how one stands
// in for the other.
const ALTERNATIVES: string[][] = [
    // The Gatekeeper's two runtimes, and the pair run side by side to compare them.
    ['gatekeeper-ts.yml:gatekeeper', 'gatekeeper-rust.yml:gatekeeper', 'gatekeeper-parity.yml:gatekeeper-ts'],
    // The Keymaster's two runtimes.
    ['keymaster-ts.yml:keymaster', 'keymaster-py.yml:keymaster'],
    // Testnet4 with a node of the operator's own, or with a hosted one.
    ['btc-testnet4.yml:btc-t4-wallet', 'btc-testnet4-hosted.yml:btc-t4-hosted-wallet'],
];

// Collisions that exist and are not alternatives. Each is a defect: a node that
// enables both services cannot start the second. An entry here is removed when
// its collision is.
const KNOWN_COLLISIONS: Record<string, string[]> = {
    '4236': ['btc-signet.yml:btc-signet-mediator', 'didcomm.yml:didcomm'],
};

// The default a compose value takes when its variables are unset.
function withDefaults(value: string): string {
    return value.replace(/\$\{[A-Za-z0-9_]+:?-([^}]*)\}/g, '$1');
}

// The host ports a service publishes: for `host:container`, `ip:host:container`
// and their `/protocol` forms.
function hostPorts(ports: unknown): string[] {
    if (!Array.isArray(ports)) {
        return [];
    }

    return ports.flatMap(port => {
        if (typeof port !== 'string') {
            return typeof port?.published === 'string' || typeof port?.published === 'number' ? [`${withDefaults(String(port.published))}/${port.protocol ?? 'tcp'}`] : [];
        }

        const [mapping, protocol = 'tcp'] = withDefaults(port).split('/');
        const parts = mapping.split(':');

        return parts.length >= 2 ? [`${parts[parts.length - 2]}/${protocol}`] : [];
    });
}

const files = readdirSync(COMPOSE_DIR).filter(file => /\.ya?ml$/.test(file));
const publishers = new Map<string, string[]>();

for (const file of files) {
    const services = parseYaml(readFileSync(join(COMPOSE_DIR, file), 'utf-8'), { merge: true })?.services ?? {};

    for (const [name, service] of Object.entries<{ ports?: unknown }>(services)) {
        for (const port of new Set(hostPorts(service.ports))) {
            publishers.set(port, [...publishers.get(port) ?? [], `${file}:${name}`]);
        }
    }
}

const isAlternative = (services: string[]) => ALTERNATIVES.some(group => services.every(service => group.includes(service)));

describe('compose host ports', () => {
    it('reads the ports the compose files publish', () => {
        expect(publishers.get('4224/tcp')).toContain('gatekeeper-rust.yml:gatekeeper');
        expect(publishers.get('4233/tcp')).toStrictEqual(['memeplex.yml:memeplex-indexer']);
    });

    it('gives no two services that can run together the same host port', () => {
        const collisions = Object.fromEntries([...publishers]
            .filter(([, services]) => services.length > 1 && !isAlternative(services))
            .map(([port, services]) => [port.replace('/tcp', ''), services.sort()]));

        expect(collisions).toStrictEqual(KNOWN_COLLISIONS);
    });
});
