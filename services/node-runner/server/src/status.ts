import type { ContainerInspect, ContainerSummary, DockerApi } from './docker.js';

export type Health =
    | 'healthy'      // running and passing its healthcheck
    | 'unhealthy'    // running and failing its healthcheck
    | 'starting'     // running, healthcheck not yet decided
    | 'running'      // running with no healthcheck
    | 'restarting'
    | 'completed'    // a one-shot container that exited 0
    | 'failed'       // exited non-zero
    | 'stopped';

export type Group = 'Core' | 'Chains' | 'Lightning' | 'Gateway' | 'Storage' | 'Observability' | 'Apps' | 'Other';

export const GROUP_ORDER: Group[] = ['Core', 'Chains', 'Lightning', 'Gateway', 'Storage', 'Observability', 'Apps', 'Other'];

export interface ServiceStatus {
    service: string;
    container: string;
    group: Group;
    stateful: boolean;
    image: string;
    state: string;
    health: Health;
    hasHealthcheck: boolean;
    healthOutput: string | null;
    failingStreak: number;
    startedAt: string | null;
    finishedAt: string | null;
    exitCode: number | null;
    restarts: number;
    ports: string[];
}

export interface StatusReport {
    project: string;
    services: ServiceStatus[];
    counts: Record<Health, number>;
}

const GROUP_RULES: [RegExp, Group][] = [
    [/^(gatekeeper|keymaster|redis|mongodb|ipfs|hyperswarm-mediator|cli)$/, 'Core'],
    [/^(cln-|lnbits|rtl|lightning-|cashu)/, 'Lightning'],
    [/^(btc|zcash|eth|sol)-|^(bitcoind|zebra)/, 'Chains'],
    [/^(drawbridge|tor$|herald|didcomm)/, 'Gateway'],
    [/^(pinning|filecoin)/, 'Storage'],
    [/^(prometheus|grafana)$/, 'Observability'],
    [/(-client$|^react-wallet$|^explorer$)/, 'Apps'],
];

export function groupOf(service: string): Group {
    return GROUP_RULES.find(([pattern]) => pattern.test(service))?.[1] ?? 'Other';
}

// Services whose restart interrupts something costly: databases, the IPFS
// store, and Lightning nodes with open channels.
const STATEFUL = /^(redis|mongodb|ipfs|lnbits)$|^cln-|^(bitcoind|zebra)/;

export function isStateful(service: string): boolean {
    return STATEFUL.test(service);
}

export function formatPorts(ports: ContainerSummary['Ports']): string[] {
    // Docker lists a port bound on all interfaces once per address family
    // (0.0.0.0 and ::); the IPv4 entry stands for both.
    const published = ports
        .filter(port => port.PublicPort && port.IP !== '::')
        .map(port => (port.IP ? port.IP + ':' : '') + `${port.PublicPort}→${port.PrivatePort}/${port.Type}`);
    return [...new Set(published)].sort();
}

// Init containers run once and exit; the stack names them `*-init`. A restart
// policy cannot tell them apart: some long-running daemons have none either,
// and one that stopped cleanly is stopped, not completed.
export function isOneShot(service: string): boolean {
    return service.endsWith('-init');
}

function hasHealthcheck(inspect: ContainerInspect): boolean {
    const test = inspect.Config.Healthcheck?.Test;
    return !!test && test.length > 0 && test[0] !== 'NONE';
}

function healthOf(service: string, inspect: ContainerInspect): Health {
    const state = inspect.State;
    if (state.Restarting || state.Status === 'restarting') {
        return 'restarting';
    }
    if (state.Running) {
        switch (state.Health?.Status) {
        case 'healthy': return 'healthy';
        case 'unhealthy': return 'unhealthy';
        case 'starting': return 'starting';
        default: return 'running';
        }
    }
    if (state.Status === 'exited') {
        if (state.ExitCode !== 0) {
            // 143 and 137 are SIGTERM and SIGKILL, what `docker stop` sends:
            // unless the kernel's OOM killer sent it, the container was
            // stopped, not failed.
            const stoppedBySignal = (state.ExitCode === 137 || state.ExitCode === 143) && !state.OOMKilled;
            return stoppedBySignal ? 'stopped' : 'failed';
        }
        return isOneShot(service) ? 'completed' : 'stopped';
    }
    return 'stopped';
}

// Docker reports unset times as the zero time.
function time(value: string | undefined): string | null {
    return value && !value.startsWith('0001-') ? value : null;
}

export function serviceStatus(summary: ContainerSummary, inspect: ContainerInspect): ServiceStatus {
    const service = summary.Labels['com.docker.compose.service'] ?? summary.Names[0]?.replace(/^\//, '') ?? summary.Id;
    const log = inspect.State.Health?.Log ?? [];
    const last = log[log.length - 1];
    const running = inspect.State.Running;
    return {
        service,
        container: summary.Names[0]?.replace(/^\//, '') ?? summary.Id,
        group: groupOf(service),
        stateful: isStateful(service),
        image: inspect.Config.Image,
        state: inspect.State.Status,
        health: healthOf(service, inspect),
        hasHealthcheck: hasHealthcheck(inspect),
        healthOutput: last ? last.Output.trim().slice(-500) || null : null,
        failingStreak: inspect.State.Health?.FailingStreak ?? 0,
        startedAt: time(inspect.State.StartedAt),
        finishedAt: running ? null : time(inspect.State.FinishedAt),
        exitCode: running ? null : inspect.State.ExitCode,
        restarts: inspect.RestartCount,
        ports: formatPorts(summary.Ports),
    };
}

export function emptyCounts(): Record<Health, number> {
    return { healthy: 0, unhealthy: 0, starting: 0, running: 0, restarting: 0, completed: 0, failed: 0, stopped: 0 };
}

export async function statusReport(docker: DockerApi, project: string): Promise<StatusReport> {
    const containers = await docker.listContainers(project);
    const services = await Promise.all(containers.map(async summary => serviceStatus(summary, await docker.inspect(summary.Id))));
    services.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || a.service.localeCompare(b.service));
    const counts = emptyCounts();
    services.forEach(service => { counts[service.health] += 1; });
    return { project, services, counts };
}
