import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NodeConfig, type Draft } from '../../services/node-runner/server/src/node-config.ts';
import { FakeCompose, FakeDocker, type FakeContainer } from './helpers.ts';

const SAMPLE = `# General
ARCHON_NODE_NAME=mynode
# Protects admin routes.
ARCHON_ADMIN_API_KEY=CHANGE_ME

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
        nodeDir, dataDir, project: 'archon', compose, docker,
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

        expect(view.profiles).toEqual([
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

        expect(compose.commands).toEqual([['up', '-d']]);
        expect(lines).toContain('$ docker compose up -d');
        expect(lines.at(-1)).toBe('Done.');
    });

    it('builds what a build argument changed, then stops what a profile removal left running', async () => {
        await run({ settings: { ARCHON_REACT_WALLET_GATEKEEPER_URL: 'https://gk.example' }, profiles: ['react-wallet'] }, true);

        expect(compose.commands).toEqual([
            ['build', 'react-wallet'],
            ['stop', 'cln-mainnet-node', 'lightning-mediator'],
            ['up', '-d'],
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

    it('creates .env when the node has none', async () => {
        rmSync(join(nodeDir, '.env'));
        await run({ settings: { ARCHON_NODE_NAME: 'beta' } }, true);

        expect(readFileSync(join(nodeDir, '.env'), 'utf-8')).toBe('ARCHON_NODE_NAME=beta\n');
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
