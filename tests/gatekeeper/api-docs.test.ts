import fs from 'fs';

const routeFiles = [
    'services/gatekeeper/server/src/v1-health-router.ts',
    'services/gatekeeper/server/src/v1-did-router.ts',
    'services/gatekeeper/server/src/v1-sync-router.ts',
    'services/gatekeeper/server/src/v1-ipfs-router.ts',
    'services/gatekeeper/server/src/v1-block-router.ts',
    'services/gatekeeper/server/src/v1-search-router.ts',
    'services/gatekeeper/server/src/gatekeeper-api.ts',
    'services/gatekeeper/server/src/identifiers-router.ts',
];

const mounts: Record<string, string> = {
    'services/gatekeeper/server/src/identifiers-router.ts': '/1.0/identifiers',
};

function expressPathToOpenApi(path: string): string {
    return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function registeredRoutes(): string[] {
    const routes = new Set<string>();
    const routePattern = /(?:router|app|identifiersRouter)\.(get|post|put|delete)\(['"]([^'"]+)['"]/g;

    for (const file of routeFiles) {
        const source = fs.readFileSync(file, 'utf8');
        for (const match of source.matchAll(routePattern)) {
            const method = match[1].toUpperCase();
            const routePath = expressPathToOpenApi(`${mounts[file] ?? ''}${match[2]}`);
            routes.add(`${method} ${routePath}`);
        }
    }

    return [...routes].sort();
}

function documentedRoutes(): string[] {
    const spec = JSON.parse(fs.readFileSync('docs/gatekeeper-api.json', 'utf8')) as {
        paths: Record<string, Record<string, unknown>>;
    };
    const routes = new Set<string>();

    for (const [routePath, operations] of Object.entries(spec.paths)) {
        for (const method of Object.keys(operations)) {
            routes.add(`${method.toUpperCase()} ${routePath}`);
        }
    }

    return [...routes].sort();
}

describe('Gatekeeper API docs', () => {
    it('documents every registered HTTP route', () => {
        expect(documentedRoutes()).toEqual(registeredRoutes());
    });
});
