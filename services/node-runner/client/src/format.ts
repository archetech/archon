import type { Health, StatusReport } from './api';

export function duration(fromIso: string | null, now = Date.now()): string {
    if (!fromIso) {
        return '';
    }
    const seconds = Math.max(0, Math.floor((now - Date.parse(fromIso)) / 1000));
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days) {
        return `${days}d ${hours}h`;
    }
    if (hours) {
        return `${hours}h ${minutes}m`;
    }
    if (minutes) {
        return `${minutes}m`;
    }
    return `${seconds}s`;
}

export function clockTime(iso: string): string {
    if (!iso) {
        return '';
    }
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString([], { hour12: false });
}

export const HEALTH_LABEL: Record<Health, string> = {
    healthy: 'Healthy',
    unhealthy: 'Unhealthy',
    starting: 'Starting',
    running: 'Running · no health check',
    restarting: 'Restarting',
    completed: 'Completed',
    failed: 'Failed',
    stopped: 'Stopped',
};

// Health that needs the operator's attention.
export const PROBLEM: Health[] = ['unhealthy', 'restarting', 'failed'];

// A stable color slot per service name, for telling merged log lines apart.
export function colorSlot(name: string, slots: number): number {
    let hash = 0;
    for (const char of name) {
        hash = (hash * 31 + char.charCodeAt(0)) % 9973;
    }
    return hash % slots;
}

export interface Verdict {
    severity: 'success' | 'info' | 'warning' | 'error';
    text: string;
    // The services the verdict is about, worst first.
    services: string[];
}

// One summary of the whole node. Only running services that pass their checks
// (or have none) and init containers that completed count as fine; anything
// stopped or still starting is said so, and an empty project is not healthy.
export function verdict(report: StatusReport): Verdict {
    const named = (health: Health[]) => report.services.filter(s => health.includes(s.health)).map(s => s.service);
    const problems = named(PROBLEM);
    if (problems.length) {
        return { severity: 'error', text: `${problems.length} need attention: ${problems.join(', ')}`, services: problems };
    }
    if (!report.services.length) {
        return { severity: 'info', text: `No containers in project ${report.project}`, services: [] };
    }
    const stopped = named(['stopped']);
    if (stopped.length) {
        return { severity: 'warning', text: `${stopped.length} stopped: ${stopped.join(', ')}`, services: stopped };
    }
    const starting = named(['starting']);
    if (starting.length) {
        return { severity: 'info', text: `${starting.length} starting: ${starting.join(', ')}`, services: starting };
    }
    const unchecked = named(['running']).length;
    return {
        severity: 'success',
        text: unchecked ? `All running services up; ${unchecked} have no health check` : 'All services healthy',
        services: [],
    };
}
