import { Alert, Box, Button, Card, CardActionArea, Chip, Skeleton, Typography } from '@mui/material';
import { useMemo, useState } from 'react';
import type { ServiceStatus, StatusReport } from '../api';
import ServiceDetail from '../components/ServiceDetail';
import StatusBadge from '../components/StatusBadge';
import { duration, PROBLEM, verdict } from '../format';

interface Props {
    report: StatusReport | null;
    error: string;
    onOpenLogs: (service: string) => void;
    onUnauthorized: () => void;
}

function meta(service: ServiceStatus): string {
    if (service.health === 'completed' || service.health === 'failed' || service.health === 'stopped') {
        return service.finishedAt ? `exited ${service.exitCode ?? ''} · ${duration(service.finishedAt)} ago` : service.state;
    }
    const parts = [service.hasHealthcheck ? 'Docker healthcheck' : 'No health check', `up ${duration(service.startedAt)}`];
    if (service.restarts) {
        parts.push(`${service.restarts} restart${service.restarts === 1 ? '' : 's'}`);
    }
    return parts.join(' · ');
}

function describe(report: StatusReport): string {
    const c = report.counts;
    const parts = [
        `${c.healthy} healthy`,
        c.unhealthy && `${c.unhealthy} unhealthy`,
        c.starting && `${c.starting} starting`,
        c.restarting && `${c.restarting} restarting`,
        c.running && `${c.running} running without a health check`,
        c.failed && `${c.failed} failed`,
        c.stopped && `${c.stopped} stopped`,
        c.completed && `${c.completed} init containers completed`,
    ].filter(Boolean);
    return `${report.services.length} containers in project ${report.project}: ${parts.join(', ')}.`;
}

export default function OverviewPage({ report, error, onOpenLogs, onUnauthorized }: Props) {
    const [selected, setSelected] = useState<string | null>(null);

    const groups = useMemo(() => {
        const map = new Map<string, ServiceStatus[]>();
        report?.services.forEach(s => map.set(s.group, [...(map.get(s.group) ?? []), s]));
        return [...map.entries()];
    }, [report]);

    if (!report) {
        return error
            ? <Alert severity="error">{error}</Alert>
            : <Skeleton variant="rounded" height={240} />;
    }

    const summary = verdict(report);
    const selectedService = report.services.find(s => s.service === selected) ?? null;

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
            {error && <Alert severity="warning">Status is not updating: {error}</Alert>}
            <Alert
                severity={summary.severity}
                action={summary.services.length > 0 && <Button color="inherit" size="small" onClick={() => setSelected(summary.services[0])}>Show</Button>}
            >
                {summary.text}
                {report.services.length === 0 && '. The node is not running, or node-runner is looking at a different project.'}
            </Alert>
            <Typography variant="body2" color="text.secondary">{describe(report)}</Typography>

            {groups.map(([group, services]) => (
                <Box component="section" key={group} sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
                    <Typography variant="overline" component="h2" color="text.secondary">{group}</Typography>
                    <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 1.25 }}>
                        {services.map(service => (
                            <Card
                                key={service.service}
                                variant="outlined"
                                sx={{
                                    borderColor: selected === service.service ? 'primary.main' : PROBLEM.includes(service.health) ? 'error.main' : undefined,
                                }}
                            >
                                <CardActionArea onClick={() => setSelected(service.service)} sx={{ p: 1.75, display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 1 }}>
                                    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
                                        <Typography sx={{ fontFamily: 'ui-monospace, monospace', fontSize: 13.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                            {service.service}
                                        </Typography>
                                        {service.stateful && <Chip label="stateful" size="small" color="warning" variant="outlined" />}
                                    </Box>
                                    <StatusBadge health={service.health} />
                                    <Typography variant="caption" color="text.secondary">{meta(service)}</Typography>
                                </CardActionArea>
                            </Card>
                        ))}
                    </Box>
                </Box>
            ))}

            <ServiceDetail
                service={selectedService}
                onClose={() => setSelected(null)}
                onOpenLogs={onOpenLogs}
                onUnauthorized={onUnauthorized}
            />
        </Box>
    );
}
