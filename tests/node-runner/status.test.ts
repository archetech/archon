import { formatPorts, groupOf, isStateful, statusReport } from '../../services/node-runner/server/src/status.ts';
import { FakeDocker } from './helpers.ts';

describe('groupOf', () => {
    it.each([
        ['gatekeeper', 'Core'],
        ['redis', 'Core'],
        ['hyperswarm-mediator', 'Core'],
        ['btc-mainnet-wallet', 'Chains'],
        ['zcash-mainnet-mediator', 'Chains'],
        ['sol-devnet-mediator', 'Chains'],
        ['cln-mainnet-node', 'Lightning'],
        ['lnbits-init', 'Lightning'],
        ['lightning-mediator', 'Lightning'],
        ['cashu-mint', 'Lightning'],
        ['drawbridge-client', 'Gateway'],
        ['tor', 'Gateway'],
        ['herald-client', 'Gateway'],
        ['pinning-mediator', 'Storage'],
        ['grafana', 'Observability'],
        ['react-wallet', 'Apps'],
        ['keymaster-client', 'Apps'],
        ['something-new', 'Other'],
    ])('puts %s in %s', (service, group) => {
        expect(groupOf(service)).toBe(group);
    });
});

describe('isStateful', () => {
    it('marks databases, IPFS and Lightning nodes', () => {
        expect(['redis', 'mongodb', 'ipfs', 'cln-mainnet-node', 'lnbits'].every(isStateful)).toBe(true);
        expect(['gatekeeper', 'lnbits-init', 'drawbridge', 'grafana'].some(isStateful)).toBe(false);
    });
});

describe('formatPorts', () => {
    it('lists published ports once, dropping the IPv6 duplicate of an all-interfaces binding', () => {
        expect(formatPorts([
            { IP: '0.0.0.0', PrivatePort: 4222, PublicPort: 4222, Type: 'tcp' },
            { IP: '::', PrivatePort: 4222, PublicPort: 4222, Type: 'tcp' },
            { IP: '127.0.0.1', PrivatePort: 3000, PublicPort: 3000, Type: 'tcp' },
            { PrivatePort: 6379, Type: 'tcp' },
        ])).toEqual(['0.0.0.0:4222→4222/tcp', '127.0.0.1:3000→3000/tcp']);
    });
});

describe('statusReport', () => {
    const docker = new FakeDocker([
        { service: 'grafana' },
        { service: 'gatekeeper', inspect: { State: { Health: { Status: 'healthy', FailingStreak: 0 } }, Config: { Healthcheck: { Test: ['CMD', 'true'] } } } },
        {
            service: 'zcash-mainnet-wallet',
            inspect: {
                RestartCount: 3,
                State: { Health: { Status: 'unhealthy', FailingStreak: 4, Log: [{ Start: '', End: '', ExitCode: 1, Output: '  connection refused\n' }] } },
                Config: { Healthcheck: { Test: ['CMD-SHELL', 'curl -f localhost'] } },
            },
        },
        { service: 'keymaster', inspect: { State: { Health: { Status: 'starting', FailingStreak: 0 } } } },
        { service: 'cli', inspect: { Config: { Healthcheck: { Test: ['NONE'] } } } },
        { service: 'tor', inspect: { State: { Status: 'restarting', Running: true, Restarting: true } } },
        { service: 'lnbits-init', inspect: { State: { Status: 'exited', Running: false, ExitCode: 0, FinishedAt: '2026-11-08T10:01:00Z' }, HostConfig: { RestartPolicy: { Name: 'no' } } } },
        { service: 'rtl-init', inspect: { State: { Status: 'exited', Running: false, ExitCode: 1 }, HostConfig: { RestartPolicy: { Name: 'no' } } } },
        { service: 'didcomm', inspect: { State: { Status: 'exited', Running: false, ExitCode: 0 } } },
        { service: 'react-wallet', inspect: { State: { Status: 'created', Running: false } } },
    ]);

    it('reports each service\'s health from Docker', async () => {
        const report = await statusReport(docker, 'archon');
        const health = Object.fromEntries(report.services.map(s => [s.service, s.health]));

        expect(health).toEqual({
            gatekeeper: 'healthy',
            'zcash-mainnet-wallet': 'unhealthy',
            keymaster: 'starting',
            grafana: 'running',
            cli: 'running',
            tor: 'restarting',
            'lnbits-init': 'completed',
            'rtl-init': 'failed',
            didcomm: 'stopped',
            'react-wallet': 'stopped',
        });
    });

    it('says whether a service has a healthcheck, and why it is failing', async () => {
        const report = await statusReport(docker, 'archon');
        const zcash = report.services.find(s => s.service === 'zcash-mainnet-wallet')!;

        expect(zcash).toMatchObject({ hasHealthcheck: true, healthOutput: 'connection refused', failingStreak: 4, restarts: 3, stateful: false });
        expect(report.services.find(s => s.service === 'cli')!.hasHealthcheck).toBe(false);
        expect(report.services.find(s => s.service === 'grafana')!.hasHealthcheck).toBe(false);
    });

    it('omits Docker\'s zero time and keeps exit details only for stopped containers', async () => {
        const report = await statusReport(docker, 'archon');

        expect(report.services.find(s => s.service === 'gatekeeper')).toMatchObject({ finishedAt: null, exitCode: null });
        expect(report.services.find(s => s.service === 'lnbits-init')).toMatchObject({ finishedAt: '2026-11-08T10:01:00Z', exitCode: 0 });
    });

    it('sorts by group, then name, and counts each health', async () => {
        const report = await statusReport(docker, 'archon');

        expect(report.services.map(s => s.service)).toEqual([
            'cli', 'gatekeeper', 'keymaster',
            'zcash-mainnet-wallet',
            'lnbits-init', 'rtl-init',
            'didcomm', 'tor',
            'grafana',
            'react-wallet',
        ]);
        expect(report.counts).toEqual({ healthy: 1, unhealthy: 1, starting: 1, running: 2, restarting: 1, completed: 1, failed: 1, stopped: 2 });
    });

    it('sees only its own project', async () => {
        expect((await statusReport(docker, 'other')).services).toEqual([]);
    });
});
