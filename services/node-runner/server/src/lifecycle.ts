import type { DockerApi } from './docker.js';
import type { JobLog } from './jobs.js';
import { ConfigError, type NodeConfig, type PlanService } from './node-config.js';
import { isOneShot, isStateful } from './status.js';

export type Action = 'start' | 'stop' | 'restart';

export interface ActionRequest {
    action: Action;
    // One service, or the whole node when absent.
    service?: string;
    // Whole-node stop only: remove the containers and network as well
    // (`docker compose down`). Volumes and data are never removed.
    down?: boolean;
}

export interface ActionPreview {
    title: string;
    command: string;
    services: PlanService[];
    stateful: string[];
    empty: boolean;
}

const ACTIONS: Action[] = ['start', 'stop', 'restart'];

function item(service: string): PlanService {
    return { service, stateful: isStateful(service), ...(isOneShot(service) ? { oneShot: true } : {}) };
}

export function parseActionRequest(body: unknown): ActionRequest {
    const { action, service, down } = (body ?? {}) as Record<string, unknown>;
    if (!ACTIONS.includes(action as Action)) {
        throw new ConfigError(`Unknown action: ${String(action)}`);
    }
    if (service !== undefined && (typeof service !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(service))) {
        throw new ConfigError('Not a valid service name');
    }
    if (down !== undefined && (action !== 'stop' || service !== undefined)) {
        throw new ConfigError('Only stopping the whole node can remove its containers');
    }
    return { action: action as Action, ...(service ? { service } : {}), ...(down === true ? { down: true } : {}) };
}

// Starting, stopping and restarting services or the whole node, each previewed
// and then run as a job like a configuration change.
export class Lifecycle {
    constructor(
        private readonly options: { project: string, docker: DockerApi, nodeConfig: NodeConfig },
    ) {}

    private async containers() {
        const list = await this.options.docker.listContainers(this.options.project);
        return new Map(list.map(c => [c.Labels['com.docker.compose.service'], c]));
    }

    async preview(request: ActionRequest): Promise<ActionPreview> {
        const containers = await this.containers();
        const running = [...containers.entries()].filter(([, c]) => c.State === 'running').map(([s]) => s);

        if (request.service) {
            const container = containers.get(request.service);
            if (!container) {
                throw new ConfigError(`No container for ${request.service}; enable its profile in Configuration`, 404);
            }
            const isRunning = container.State === 'running';
            const affected = request.action === 'start' ? (isRunning ? [] : [request.service]) : (isRunning ? [request.service] : []);
            if (request.action === 'restart' && !isRunning) {
                affected.push(request.service);
            }
            const services = affected.map(item);
            return {
                title: `${request.action[0].toUpperCase()}${request.action.slice(1)} ${request.service}`,
                command: `docker compose ${request.action} ${request.service}`,
                services,
                stateful: request.action === 'start' ? [] : services.filter(s => s.stateful).map(s => s.service),
                empty: services.length === 0,
            };
        }

        if (request.action === 'stop') {
            const services = running.sort().map(item);
            return {
                title: request.down ? 'Stop the node and remove its containers' : 'Stop the node',
                command: request.down ? 'docker compose down' : 'docker compose stop',
                services: request.down ? [...containers.keys()].sort().map(item) : services,
                stateful: services.filter(s => s.stateful).map(s => s.service),
                empty: request.down ? containers.size === 0 : services.length === 0,
            };
        }

        if (request.action === 'start') {
            // Starting the node is `up -d` with the current configuration: the
            // same plan a configuration change with no edits would run.
            const { plan } = await this.options.nodeConfig.preview({});
            const services = [...plan.create, ...plan.recreate, ...plan.start];
            return {
                title: 'Start the node',
                command: 'docker compose up -d',
                services,
                stateful: plan.recreate.filter(s => s.stateful).map(s => s.service),
                empty: services.length === 0,
            };
        }

        const services = running.sort().map(item);
        return {
            title: 'Restart the node',
            command: 'docker compose restart',
            services,
            stateful: services.filter(s => s.stateful).map(s => s.service),
            empty: services.length === 0,
        };
    }

    async run(request: ActionRequest, confirmStateful: boolean): Promise<{ title: string, work: (log: JobLog) => Promise<void> }> {
        const preview = await this.preview(request);
        if (preview.empty) {
            throw new ConfigError('Nothing to do', 409);
        }
        if (preview.stateful.length && !confirmStateful) {
            throw new ConfigError(`Confirm interrupting ${preview.stateful.join(', ')} first`, 409);
        }
        const { nodeConfig } = this.options;
        const services = preview.services.map(s => s.service);
        return {
            title: preview.title,
            work: async log => {
                if (request.service) {
                    await nodeConfig.runCompose([request.action, request.service], log);
                    if (request.action !== 'stop') {
                        await nodeConfig.verify([request.service], log);
                    }
                }
                else if (request.action === 'stop') {
                    await nodeConfig.runCompose(request.down ? ['down'] : ['stop'], log);
                }
                else if (request.action === 'start') {
                    await nodeConfig.runCompose(['up', '-d'], log);
                    await nodeConfig.verify(services, log);
                }
                else {
                    await nodeConfig.runCompose(['restart'], log);
                    await nodeConfig.verify(services, log);
                }
                log('Done.');
            },
        };
    }
}
