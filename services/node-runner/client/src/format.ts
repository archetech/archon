import type { Health } from './api';

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
