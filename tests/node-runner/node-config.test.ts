import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NodeConfig, type Draft } from '../../services/node-runner/server/src/node-config.ts';
import { FakeCompose, FakeDocker, type FakeContainer } from './helpers.ts';

const SAMPLE = `# General
ARCHON_NODE_NAME=mynode
# Protects admin routes.
ARCHON_ADMIN_API_KEY=CHANGE_ME
ARCHON_UID=1000
ARCHON_GID=1000
ARCHON_PASSPHRASE=CHANGE_ME

# Drawbridge
# ARCHON_HERALD_URL=http://herald:4230

# React wallet
ARCHON_REACT_WALLET_GATEKEEPER_URL=
`;

const ENV = `# my node
COMPOSE_PROJECT_NAME=archon
COMPOSE_PROFILES=lightning,react-wallet
ARCHON_NODE_NAME=alpha
ARCHON_ADMIN_API_KEY=super-secret
ARCHON_UID=1000
ARCHON_GID=1000
ARCHON_PASSPHRASE=wallet-passphrase
MY_OWN_SETTING=kept
`;

const SERVICES = {
    gatekeeper: { vars: ['ARCHON_NODE_NAME', 'ARCHON_ADMIN_API_KEY'] },
    redis: {},
    'cln-mainnet-node': { profiles: ['lightning'] },
    'lightning-mediator': { profiles: ['lightning'], vars: ['ARCHON_ADMIN_API_KEY'] },
    'lnbits-init': { profiles: ['lightning'] },
    'react-wallet': { profiles: ['react-wallet'], buildVars: ['ARCHON_REACT_WALLET_GATEKEEPER_URL'] },
    herald: { profiles: ['herald'], vars: ['ARCHON_HERALD_URL'] },
    explorer: { profiles: ['explorer'], buildVars: ['ARCHON_EXPLORER_URL'] },
};

let nodeDir: string;
let dataDir: string;
let compose: FakeCompose;
let docker: FakeDocker;
let config: NodeConfig;
let load: number;

// Containers as `up` left them from the current .env.
function running(): FakeContainer[] {
    return ['gatekeeper', 'redis', 'cln-mainnet-node', 'lightning-mediator', 'react-wallet'].map(service => ({
        service,
        hash: compose.currentHash(service),
        inspect: { State: { Health: { Status: 'healthy', FailingStreak: 0 } } },
    } as FakeContainer)).concat([{
        service: 'lnbits-init',
        hash: compose.currentHash('lnbits-init'),
        inspect: { State: { Status: 'exited', Running: false, ExitCode: 0 }, HostConfig: { RestartPolicy: { Name: 'no' } } },
    }]);
}

beforeEach(() => {
    nodeDir = mkdtempSync(join(tmpdir(), 'node-runner-node-'));
    dataDir = join(nodeDir, 'data', 'node-runner');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(nodeDir, 'sample.env'), SAMPLE);
    writeFileSync(join(nodeDir, '.env'), ENV, { mode: 0o640 });
    compose = new FakeCompose(nodeDir, SERVICES);
    docker = new FakeDocker(running());
    load = 0.5;
    config = new NodeConfig({
        nodeDir, dataDir, project: 'archon', compose, docker, ids: { uid: 1000, gid: 1000 },
        loadAverage: () => load, cpuCount: () => 4, sleep: async () => { load = 0.5; }, healthTimeoutMs: 0,
    });
});

afterEach(() => {
    rmSync(nodeDir, { recursive: true, force: true });
});

const plan = async (draft: Draft) => {
    const { plan: p, ...rest } = await config.preview(draft);
    const names = (items: { service: string }[]) => items.map(i => i.service);
    return { ...rest, rebuild: names(p.rebuild), create: names(p.create), recreate: names(p.recreate), start: names(p.start), stop: names(p.stop), unchanged: p.unchanged, raw: p };
};

describe('view', () => {
    it('shows profiles with their services, catalog settings and unknown ones', async () => {
        const view = await config.view();

        expect(view.configError).toBeNull();
        expect(view.profiles).toEqual([
            { name: 'explorer', description: 'Public DID explorer.', enabled: false, services: ['explorer'] },
            { name: 'herald', description: 'Names and .well-known endpoints.', enabled: false, services: ['herald'] },
            { name: 'lightning', description: 'Core Lightning, LNbits, RTL and the Lightning mediator.', enabled: true, services: ['cln-mainnet-node', 'lightning-mediator', 'lnbits-init'] },
            { name: 'react-wallet', description: 'Browser wallet.', enabled: true, services: ['react-wallet'] },
        ]);
        expect(view.sections.map(s => s.name)).toEqual(['General', 'Drawbridge', 'React wallet', 'Other settings in .env']);
        expect(view.sections[0].settings[0]).toEqual({ key: 'ARCHON_NODE_NAME', description: '', default: 'mynode', secret: false, value: 'alpha', set: true, inEnv: true });
        expect(view.sections[3].settings.map(s => s.key)).toEqual(['MY_OWN_SETTING']);
    });

    it('never returns a secret, only whether it is set', async () => {
        const view = await config.view();
        const secret = view.sections[0].settings.find(s => s.key === 'ARCHON_ADMIN_API_KEY')!;

        expect(secret).toMatchObject({ secret: true, value: null, set: true });
        expect(JSON.stringify(view)).not.toContain('super-secret');
    });
});

describe('preview', () => {
    it('is empty when nothing changes', async () => {
        const p = await plan({});

        expect(p.empty).toBe(true);
        expect(p.diff).toEqual([]);
    });

    it('recreates exactly the services whose configuration a setting changes', async () => {
        const p = await plan({ settings: { ARCHON_NODE_NAME: 'beta' } });

        expect(p.diff).toEqual([{ key: 'ARCHON_NODE_NAME', before: 'alpha', after: 'beta', secret: false }]);
        expect(p.recreate).toEqual(['gatekeeper']);
        expect(p.rebuild).toEqual([]);
        expect(p.unchanged).toBe(4);
    });

    it('masks a secret in the diff', async () => {
        const p = await plan({ settings: { ARCHON_ADMIN_API_KEY: 'new-secret' } });

        expect(p.diff).toEqual([{ key: 'ARCHON_ADMIN_API_KEY', before: null, after: null, secret: true }]);
        expect(JSON.stringify(p)).not.toContain('secret-');
        expect(p.recreate).toEqual(['gatekeeper', 'lightning-mediator']);
    });

    it('rebuilds a service whose build argument changes, since up alone reuses the image', async () => {
        const p = await plan({ settings: { ARCHON_REACT_WALLET_GATEKEEPER_URL: 'https://gk.example' } });

        expect(p.rebuild).toEqual(['react-wallet']);
        expect(p.recreate).toEqual([]);
    });

    it('stops the services of a removed profile and creates those of an added one', async () => {
        const p = await plan({ profiles: ['react-wallet', 'herald'] });

        expect(p.diff).toEqual([{ key: 'COMPOSE_PROFILES', before: 'lightning,react-wallet', after: 'react-wallet,herald', secret: false }]);
        expect(p.stop).toEqual(['cln-mainnet-node', 'lightning-mediator']);
        expect(p.create).toEqual(['herald']);
        expect(p.stateful).toEqual(['cln-mainnet-node']);
        expect(p.warnings.map(w => w.message)).toEqual([
            'The herald profile runs Herald, but Drawbridge only offers it when ARCHON_HERALD_URL is set.',
            'herald is enabled without drawbridge, so nothing fronts it.',
        ]);
    });

    it('marks an init container that completed as run again', async () => {
        writeFileSync(join(nodeDir, '.env'), ENV);
        const p = await plan({ settings: { ARCHON_NODE_NAME: 'beta' } });

        expect(p.raw.start).toEqual([{ service: 'lnbits-init', stateful: false, oneShot: true }]);
    });

    it('refuses managed keys, bad names, multi-line values and unknown profiles', async () => {
        await expect(config.preview({ settings: { COMPOSE_PROJECT_NAME: 'x' } })).rejects.toThrow('not edited as a setting');
        await expect(config.preview({ settings: { 'A B': 'x' } })).rejects.toThrow('Not a valid setting name');
        await expect(config.preview({ settings: { A: 'x\ny' } })).rejects.toThrow('single line');
        await expect(config.preview({ profiles: ['nope'] })).rejects.toThrow('Unknown profile: nope');
    });

    it('reports Compose\'s own error for a configuration it rejects, and leaves no draft file behind', async () => {
        compose.invalid = 'required variable ARCHON_ADMIN_API_KEY is missing a value';

        await expect(config.preview({ settings: { ARCHON_ADMIN_API_KEY: '' } })).rejects.toMatchObject({ status: 400, message: compose.invalid });
        expect(readdirSync(dataDir).filter(f => f.startsWith('draft-'))).toEqual([]);
    });

    it('does not touch .env', async () => {
        await config.preview({ settings: { ARCHON_NODE_NAME: 'beta' } });

        expect(readFileSync(join(nodeDir, '.env'), 'utf-8')).toBe(ENV);
    });
});

describe('a node with no .env', () => {
    beforeEach(() => {
        rmSync(join(nodeDir, '.env'));
    });

    it('says so in the view, with no warnings to act on yet', async () => {
        const view = await config.view();

        expect(view.envMissing).toBe(true);
        expect(view.warnings).toEqual([]);
    });

    it('creates .env from sample.env with the operator\'s ids, a new admin key, the passphrase and no profiles', async () => {
        writeFileSync(join(nodeDir, 'sample.env'), SAMPLE.replace('# ARCHON_HERALD_URL=http://herald:4230', 'ARCHON_HERALD_URL=http://herald:4230') + 'COMPOSE_PROFILES=lightning,herald\n');

        await config.createEnv('a long wallet passphrase');

        const text = readFileSync(join(nodeDir, '.env'), 'utf-8');
        const values = Object.fromEntries(text.split('\n').filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
        expect(values).toMatchObject({ ARCHON_UID: '1000', ARCHON_GID: '1000', ARCHON_PASSPHRASE: "'a long wallet passphrase'", COMPOSE_PROFILES: '', ARCHON_HERALD_URL: '' });
        expect(values.ARCHON_ADMIN_API_KEY).toMatch(/^[0-9a-f]{64}$/);
        expect(text).toContain('# Protects admin routes.');
        expect(statSync(join(nodeDir, '.env')).mode & 0o777).toBe(0o600);

        const view = await config.view();
        expect(view.envMissing).toBe(false);
        expect(view.warnings).toEqual([]);
    });

    it('refuses a short passphrase, the placeholder, or an existing .env', async () => {
        await expect(config.createEnv('short')).rejects.toMatchObject({ status: 400 });
        await expect(config.createEnv('CHANGE_ME')).rejects.toMatchObject({ status: 400 });
        await config.createEnv('a long wallet passphrase');
        await expect(config.createEnv('another long passphrase')).rejects.toMatchObject({ status: 409, message: '.env already exists' });
    });
});

describe('required settings', () => {
    it('warns when the ids are unset, offering the operator\'s, and when secrets are missing or placeholders', async () => {
        writeFileSync(join(nodeDir, '.env'), 'ARCHON_ADMIN_API_KEY=CHANGE_ME\n');

        const view = await config.view();

        expect(view.warnings.map(w => [w.message.split(' ').slice(0, 4).join(' '), w.fix?.label])).toEqual([
            ['ARCHON_UID is not set,', 'Set ARCHON_UID=1000'],
            ['ARCHON_GID is not set,', 'Set ARCHON_GID=1000'],
            ['ARCHON_ADMIN_API_KEY is still the', undefined],
            ['ARCHON_PASSPHRASE is not set.', undefined],
        ]);
    });
});

describe('review fixes', () => {
    it('treats setting an absent key to empty as a change', async () => {
        const p = await plan({ settings: { ARCHON_HERALD_TOR_PROXY: '' } });

        expect(p.diff).toEqual([{ key: 'ARCHON_HERALD_TOR_PROXY', before: null, after: '', secret: false }]);
        expect(p.empty).toBe(false);
    });

    it('loads and previews a repair when Compose rejects the current .env', async () => {
        await config.view();
        compose.currentInvalid = 'include docker/compose/gatekeeper-typo.yml: no such file';

        const view = await config.view();
        expect(view.configError).toBe(compose.currentInvalid);
        expect(view.profiles.map(p => p.name)).toEqual(['explorer', 'herald', 'lightning', 'react-wallet']);

        const p = await plan({ settings: { ARCHON_NODE_NAME: 'fixed' } });
        expect(p.diff.map(d => d.key)).toEqual(['ARCHON_NODE_NAME']);
    });

    it('rebuilds a service whose profile this change enables, if its build changed', async () => {
        const p = await plan({ profiles: ['lightning', 'react-wallet', 'explorer'], settings: { ARCHON_EXPLORER_URL: 'http://explorer:4000' } });

        expect(p.rebuild).toEqual(['explorer']);
    });

    it('rebuilds a service being created unless node-runner built it from this build section', async () => {
        // react-wallet has no container; its build changed while it was off.
        docker.containers.splice(docker.containers.findIndex(c => c.service === 'react-wallet'), 1);
        writeFileSync(join(nodeDir, '.env'), ENV.replace('COMPOSE_PROFILES=lightning,react-wallet', 'COMPOSE_PROFILES=lightning') + 'ARCHON_REACT_WALLET_GATEKEEPER_URL=https://new\n');

        expect((await plan({ profiles: ['lightning', 'react-wallet'] })).rebuild).toEqual(['react-wallet']);

        // Once built here from that section, enabling it again does not rebuild.
        await config.build(['react-wallet'], () => {});
        expect((await plan({ profiles: ['lightning', 'react-wallet'] })).rebuild).toEqual([]);
    });

    it('builds a buildable service with no image under the load check, rather than leaving it to up', async () => {
        docker.missingImages.add('archon-react-wallet');

        const p = await plan({ settings: { ARCHON_NODE_NAME: 'beta' } });

        expect(p.rebuild).toEqual(['react-wallet']);
    });

    it('stops a crash-looping container whose profile was removed', async () => {
        docker.containers.find(c => c.service === 'lightning-mediator')!.inspect = { State: { Status: 'restarting', Running: true, Restarting: true } };

        const p = await plan({ profiles: ['react-wallet'] });

        expect(p.stop).toEqual(['cln-mainnet-node', 'lightning-mediator']);
    });

    it('refuses to apply when .env changed after the review', async () => {
        const { work } = await config.apply({ settings: { ARCHON_NODE_NAME: 'beta' } }, false);
        writeFileSync(join(nodeDir, '.env'), ENV.replace('alpha', 'edited by hand'));

        await expect(work(() => {})).rejects.toMatchObject({ status: 409, message: '.env changed since this change was reviewed; review it again' });
        expect(readFileSync(join(nodeDir, '.env'), 'utf-8')).toContain('edited by hand');
    });

    it('fails verification for a touched service that is stopped or missing', async () => {
        docker.containers.find(c => c.service === 'gatekeeper')!.inspect = { State: { Status: 'exited', Running: false, ExitCode: 0 } };
        const lines: string[] = [];

        await expect(config.verify(['gatekeeper', 'herald'], line => lines.push(line))).rejects.toThrow('Not healthy: gatekeeper, herald');
        expect(lines).toContain('  herald: no container');
    });
});

describe('apply', () => {
    async function run(draft: Draft, confirm = false) {
        const { title, work } = await config.apply(draft, confirm);
        const lines: string[] = [];
        await work(line => lines.push(line));
        return { title, lines };
    }

    it('backs up .env, rewrites it in place and runs up', async () => {
        const { title, lines } = await run({ settings: { ARCHON_NODE_NAME: 'beta' } });

        expect(title).toBe('Apply 1 configuration change');
        const env = readFileSync(join(nodeDir, '.env'), 'utf-8');
        expect(env).toBe(ENV.replace('ARCHON_NODE_NAME=alpha', 'ARCHON_NODE_NAME=beta'));
        expect(statSync(join(nodeDir, '.env')).mode & 0o777).toBe(0o640);

        const backups = readdirSync(join(dataDir, 'env-backups'));
        expect(backups).toHaveLength(1);
        expect(readFileSync(join(dataDir, 'env-backups', backups[0]), 'utf-8')).toBe(ENV);
        expect(statSync(join(dataDir, 'env-backups', backups[0])).mode & 0o777).toBe(0o600);

        expect(compose.commands).toEqual([['up', '-d', '--no-build']]);
        expect(lines).toContain('$ docker compose up -d --no-build');
        expect(lines.at(-1)).toBe('Done.');
    });

    it('builds what a build argument changed, then stops what a profile removal left running', async () => {
        await run({ settings: { ARCHON_REACT_WALLET_GATEKEEPER_URL: 'https://gk.example' }, profiles: ['react-wallet'] }, true);

        expect(compose.commands).toEqual([
            ['build', 'react-wallet'],
            ['stop', 'cln-mainnet-node', 'lightning-mediator'],
            ['up', '-d', '--no-build'],
        ]);
    });

    it('needs confirmation before interrupting a stateful service', async () => {
        await expect(config.apply({ profiles: ['react-wallet'] }, false)).rejects.toMatchObject({ status: 409, message: 'Confirm interrupting cln-mainnet-node first' });
        expect(readFileSync(join(nodeDir, '.env'), 'utf-8')).toBe(ENV);
    });

    it('refuses an empty change', async () => {
        await expect(config.apply({}, false)).rejects.toMatchObject({ status: 409, message: 'Nothing to apply' });
    });

    it('waits for the host to calm down before building', async () => {
        load = 9;
        const { lines } = await run({ settings: { ARCHON_REACT_WALLET_GATEKEEPER_URL: 'https://gk.example' } });

        expect(lines).toContain('Host load 9.00 on 4 cores; waiting before building');
        expect(compose.commands[0]).toEqual(['build', 'react-wallet']);
    });

    it('fails the job when a command fails, with .env already written and backed up', async () => {
        compose.failing = 'up';
        const { work } = await config.apply({ settings: { ARCHON_NODE_NAME: 'beta' } }, false);

        await expect(work(() => {})).rejects.toThrow('docker compose up exited with code 1');
        expect(readFileSync(join(nodeDir, '.env'), 'utf-8')).toContain('ARCHON_NODE_NAME=beta');
        expect(existsSync(join(dataDir, 'env-backups'))).toBe(true);
    });

    it('fails the job when a touched service ends up unhealthy', async () => {
        docker.containers.find(c => c.service === 'gatekeeper')!.inspect = { State: { Health: { Status: 'unhealthy', FailingStreak: 3 } } };
        const { work } = await config.apply({ settings: { ARCHON_NODE_NAME: 'beta' } }, false);
        const lines: string[] = [];

        await expect(work(line => lines.push(line))).rejects.toThrow('Not healthy: gatekeeper');
        expect(lines).toContain('  gatekeeper: unhealthy');
    });

    it('refuses to build a partial .env on a node that has none', async () => {
        rmSync(join(nodeDir, '.env'));

        await expect(config.preview({ settings: { ARCHON_NODE_NAME: 'beta' } })).rejects.toMatchObject({ status: 409, message: 'This node has no .env yet; create it on the Configuration page first' });
        await expect(config.apply({ settings: { ARCHON_NODE_NAME: 'beta' } }, true)).rejects.toMatchObject({ status: 409 });
        expect(existsSync(join(nodeDir, '.env'))).toBe(false);
    });

    it('keeps the last 20 backups', async () => {
        mkdirSync(join(dataDir, 'env-backups'));
        for (let i = 0; i < 25; i++) {
            writeFileSync(join(dataDir, 'env-backups', `2000-01-01T00-00-${String(i).padStart(2, '0')}.env`), '');
        }
        await run({ settings: { ARCHON_NODE_NAME: 'beta' } });

        const backups = readdirSync(join(dataDir, 'env-backups')).sort();
        expect(backups).toHaveLength(20);
        expect(backups[0]).toBe('2000-01-01T00-00-06.env');
    });
});
