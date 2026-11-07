import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';

// Compose labels an image with the service that built it, and an image's ID covers
// its labels. Services that build one tag therefore leave it with a different ID from
// build to build, depending on which finished last, although the contents are the
// same. `docker compose up` then recreates every container on that image: on the
// bundled node, a Lightning restart for a rebuild that changed nothing in it.

const COMPOSE_DIR = 'docker/compose';

type Service = { image?: string; build?: unknown; pull_policy?: string };

function services(file: string): Record<string, Service> {
    return parseYaml(readFileSync(join(COMPOSE_DIR, file), 'utf-8'), { merge: true })?.services ?? {};
}

const files = readdirSync(COMPOSE_DIR).filter(file => /\.ya?ml$/.test(file));

describe('compose images', () => {
    it('finds the compose files', () => {
        expect(files).toContain('lightning.yml');
    });

    it.each(files)('%s builds each image from one service', (file) => {
        const builders = new Map<string, string[]>();
        for (const [name, service] of Object.entries(services(file))) {
            if (service.image && service.build) {
                builders.set(service.image, [...(builders.get(service.image) ?? []), name]);
            }
        }

        const shared = [...builders].filter(([, names]) => names.length > 1);
        expect(shared).toEqual([]);
    });

    it('runs the CLN image in the init containers without building or pulling it', () => {
        const { 'cln-mainnet-node': node, ...rest } = services('lightning.yml');
        const inits = Object.entries(rest).filter(([, service]) => service.image === node.image);

        expect(node.build).toBeDefined();
        expect(inits.map(([name]) => name).sort()).toEqual(['drawbridge-init', 'lnbits-init', 'rtl-init']);
        for (const [, service] of inits) {
            expect(service.build).toBeUndefined();
            expect(service.pull_policy).toBe('never');
        }
    });
});
