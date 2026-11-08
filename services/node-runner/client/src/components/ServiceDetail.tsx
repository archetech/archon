import CloseIcon from '@mui/icons-material/Close';
import { Alert, Box, Button, Drawer, IconButton, Typography } from '@mui/material';
import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, type ActionRequest, type LogEntry, type ServiceStatus } from '../api';
import { clockTime, duration } from '../format';
import StatusBadge from './StatusBadge';

const TAIL = 50;
const POLL_MS = 5000;

interface Props {
    service: ServiceStatus | null;
    onClose: () => void;
    onOpenLogs: (service: string) => void;
    onAction: (request: ActionRequest) => void;
    onUnauthorized: () => void;
}

function Row({ label, children }: { label: string, children: ReactNode }) {
    return (
        <>
            <Typography component="dt" variant="body2" color="text.secondary">{label}</Typography>
            <Typography component="dd" variant="body2" sx={{ m: 0, wordBreak: 'break-all' }}>{children}</Typography>
        </>
    );
}

export default function ServiceDetail({ service, onClose, onOpenLogs, onAction, onUnauthorized }: Props) {
    const name = service?.service ?? null;
    const [tail, setTail] = useState<LogEntry[]>([]);
    const [error, setError] = useState('');

    useEffect(() => {
        setTail([]);
        setError('');
        if (!name) {
            return undefined;
        }
        let cancelled = false;
        const load = () => api.logs([name], TAIL).then(r => {
            if (!cancelled) {
                setTail(r.entries);
                setError('');
            }
        }, e => {
            if (cancelled) {
                return;
            }
            if (e instanceof ApiError && e.status === 401) {
                onUnauthorized();
            }
            setError(e instanceof Error ? e.message : String(e));
        });
        load();
        const timer = setInterval(load, POLL_MS);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [name, onUnauthorized]);

    return (
        <Drawer anchor="right" open={!!service} onClose={onClose} slotProps={{ paper: { sx: { width: { xs: '100%', sm: 480 }, p: 3, gap: 2.5 } } }}>
            {service && (
                <>
                    <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1 }}>
                        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, minWidth: 0 }}>
                            <Typography variant="h3" component="h2" sx={{ fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all' }}>
                                {service.service}
                            </Typography>
                            <StatusBadge health={service.health} suffix={service.failingStreak ? `${service.failingStreak} failed checks in a row` : undefined} />
                        </Box>
                        <IconButton aria-label="Close" onClick={onClose}><CloseIcon /></IconButton>
                    </Box>

                    {service.healthOutput && service.health !== 'healthy' && (
                        <Alert severity={service.health === 'unhealthy' ? 'error' : 'info'}>
                            <Typography variant="caption" component="div" sx={{ fontWeight: 600 }}>Last health check</Typography>
                            <Box component="pre" sx={{ m: 0, whiteSpace: 'pre-wrap', fontSize: 12 }}>{service.healthOutput}</Box>
                        </Alert>
                    )}

                    <Box component="dl" sx={{ m: 0, display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '8px 16px' }}>
                        <Row label="Health from">{service.hasHealthcheck ? 'Docker healthcheck' : 'No health check defined'}</Row>
                        <Row label="State">{service.state}{service.exitCode !== null ? ` (exit ${service.exitCode})` : ''}</Row>
                        {service.startedAt && service.state === 'running' && <Row label="Up">{duration(service.startedAt)}</Row>}
                        <Row label="Restarts">{service.restarts}</Row>
                        <Row label="Container">{service.container}</Row>
                        <Row label="Image">{service.image}</Row>
                        <Row label="Ports">{service.ports.length ? service.ports.join(', ') : 'none published'}</Row>
                    </Box>

                    {service.stateful && (
                        <Alert severity="warning">Holds state: restarting it interrupts work in progress.</Alert>
                    )}

                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, minHeight: 0, flex: 1 }}>
                        <Typography variant="subtitle2" color="text.secondary">Recent log</Typography>
                        {error && <Alert severity="warning">{error}</Alert>}
                        <Box sx={{ flex: 1, overflow: 'auto', bgcolor: '#0D0E10', color: '#E4E4E7', borderRadius: 1, p: 1.5, fontFamily: 'ui-monospace, monospace', fontSize: 12, lineHeight: 1.55 }}>
                            {tail.length === 0 && <Box sx={{ color: '#A1A1AA' }}>No log lines.</Box>}
                            {tail.map((entry, i) => (
                                <Box key={i} sx={{ display: 'flex', gap: 1.25, color: entry.stream === 'stderr' ? '#FCA5A5' : undefined }}>
                                    <Box component="span" sx={{ color: '#A1A1AA', flex: 'none' }}>{clockTime(entry.time)}</Box>
                                    <Box component="span" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{entry.text}</Box>
                                </Box>
                            ))}
                        </Box>
                    </Box>

                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                        {['running', 'restarting', 'paused'].includes(service.state)
                            ? (
                                <>
                                    <Button variant="outlined" onClick={() => onAction({ action: 'restart', service: service.service })}>Restart</Button>
                                    <Button variant="outlined" color="error" onClick={() => onAction({ action: 'stop', service: service.service })}>Stop</Button>
                                </>
                            )
                            : <Button variant="outlined" onClick={() => onAction({ action: 'start', service: service.service })}>Start</Button>}
                        <Button variant="outlined" onClick={() => onOpenLogs(service.service)}>Open in Logs</Button>
                    </Box>
                </>
            )}
        </Drawer>
    );
}
