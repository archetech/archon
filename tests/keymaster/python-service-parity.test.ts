import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

// The Python keymaster service is meant to be a drop-in replacement for the JS
// one -- same paths, same auth. Nothing checked that, and the result was #920:
// the Python flavor served NONE of the DIDComm surface. Eleven SDK methods
// worked against one flavor and 404'd against the other, silently, from the day
// DIDComm landed (#633) until a review of #919 happened to notice.
//
// This compares the two route surfaces directly. It cannot tell whether the
// handlers behave alike -- python/keymaster_service/tests/test_app_partial_parity.py
// does that -- but a whole protocol going missing is exactly what it catches.

const TS_DIR = 'services/keymaster/server/src';
const TS_API = join(TS_DIR, 'keymaster-api.ts');
const PY_APP = 'python/keymaster_service/src/keymaster_service/app.py';

type Route = string; // "PROTECTED POST /didcomm/send"

// Express `:name` and FastAPI `{name}` mean the same thing; the name itself is
// local to each flavor and carries no contract.
function normalize(path: string): string {
    return path.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':param').replace(/\{[A-Za-z_][A-Za-z0-9_]*\}/g, ':param');
}

// Which file defines each `createXRouter` mount. Found by looking for the
// export rather than by transforming the name into a filename: createDidCommRouter
// lives in keymaster-didcomm-router.ts, not keymaster-did-comm-router.ts, and a
// name-mangling guess that misses drops that router from the comparison
// entirely -- silently, which is the exact failure this file exists to catch.
function routerFile(factory: string): string | undefined {
    return readdirSync(TS_DIR)
        .filter(name => name.endsWith('.ts'))
        .find(name => new RegExp(`export function ${factory}\\b`).test(readFileSync(join(TS_DIR, name), 'utf-8')));
}

function tsRoutes(): Route[] {
    const api = readFileSync(TS_API, 'utf-8');

    // Everything mounted after createRequireAdminKey sits behind the admin key.
    // Reading the mount order rather than hardcoding a list means a router moved
    // across that line shows up here as the auth change it is.
    const mounts = [...api.matchAll(/v1router\.use\((create[A-Za-z]+)\(/g)].map(m => m[1]);
    const guard = mounts.indexOf('createRequireAdminKey');
    expect(guard).toBeGreaterThan(-1);

    const routes: Route[] = [];

    for (const [index, factory] of mounts.entries()) {
        if (factory === 'createRequireAdminKey') {
            continue;
        }

        const file = routerFile(factory);
        // Loudly, not by skipping: an unresolved router would quietly shrink the
        // JS side of the comparison and make the parity assertions pass.
        expect(file).toBeDefined();

        const scope = index < guard ? 'PUBLIC' : 'PROTECTED';
        const source = readFileSync(join(TS_DIR, file as string), 'utf-8');

        for (const match of source.matchAll(/router\.(get|post|put|delete)\('([^']+)'/g)) {
            routes.push(`${scope} ${match[1].toUpperCase()} ${normalize(match[2])}`);
        }
    }

    return routes;
}

function pyRoutes(): Route[] {
    const source = readFileSync(PY_APP, 'utf-8');

    return [...source.matchAll(/@(public|protected)_api\.(get|post|put|delete)\("([^"]+)"/g)].map(
        m => `${m[1].toUpperCase()} ${m[2].toUpperCase()} ${normalize(m[3])}`
    );
}

describe('python keymaster service route parity', () => {
    it('finds routes on both sides', () => {
        // Guard the guard: a regex that silently stopped matching would make
        // every comparison below vacuously true.
        expect(tsRoutes().length).toBeGreaterThan(100);
        expect(pyRoutes().length).toBeGreaterThan(100);
    });

    it('serves every route the JS service serves, with the same auth', () => {
        const python = new Set(pyRoutes());
        const missing = [...new Set(tsRoutes())].filter(route => !python.has(route)).sort();

        expect(missing).toStrictEqual([]);
    });

    it('serves no route the JS service does not', () => {
        // The other direction matters too: a Python-only endpoint is a surface
        // no OpenAPI document describes and no JS client can reach.
        const typescript = new Set(tsRoutes());
        const extra = [...new Set(pyRoutes())].filter(route => !typescript.has(route)).sort();

        expect(extra).toStrictEqual([]);
    });

    it('declares literal paths before the parameter templates that would swallow them', () => {
        // FastAPI matches in declaration order, so `DELETE /addresses/{address}`
        // declared first would take `DELETE /addresses/publish` and try to
        // remove an address literally named "publish".
        const source = readFileSync(PY_APP, 'utf-8');
        const declared = [...source.matchAll(/@(?:public|protected)_api\.(get|post|put|delete)\("([^"]+)"/g)].map(
            m => ({ method: m[1], path: m[2] })
        );

        const shadowed: string[] = [];

        for (const [index, route] of declared.entries()) {
            if (route.path.includes('{')) {
                continue;
            }

            const earlier = declared.slice(0, index).find(other =>
                other.method === route.method &&
                other.path.includes('{') &&
                new RegExp(`^${other.path.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(route.path)
            );

            if (earlier) {
                shadowed.push(`${route.method.toUpperCase()} ${route.path} is shadowed by ${earlier.path}`);
            }
        }

        expect(shadowed).toStrictEqual([]);
    });
});
