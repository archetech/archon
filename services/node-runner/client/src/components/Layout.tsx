import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import { AppBar, Box, Button, Chip, Link, Tab, Tabs, Toolbar, Typography } from '@mui/material';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Info, type StatusReport } from '../api';
import { verdict } from '../format';
import LogsPage from '../pages/LogsPage';
import OverviewPage from '../pages/OverviewPage';

const POLL_MS = 5000;

type Page = 'overview' | 'logs';

function pageFromLocation(): Page {
    return window.location.pathname.startsWith('/logs') ? 'logs' : 'overview';
}

// Grafana's published host port, when the observability profile runs it.
// Grafana serves plain HTTP there, whatever scheme node-runner is reached by.
function grafanaUrl(report: StatusReport | null): string | null {
    const grafana = report?.services.find(s => s.service === 'grafana' && s.state === 'running');
    const port = grafana?.ports[0]?.match(/(\d+)→/)?.[1];
    return port ? `http://${window.location.hostname}:${port}` : null;
}

export default function Layout({ onSignedOut }: { onSignedOut: () => void }) {
    const [page, setPage] = useState<Page>(pageFromLocation);
    const [logServices, setLogServices] = useState<string[]>(() => new URLSearchParams(window.location.search).get('services')?.split(',').filter(Boolean) ?? []);
    const [info, setInfo] = useState<Info | null>(null);
    const [report, setReport] = useState<StatusReport | null>(null);
    const [statusError, setStatusError] = useState('');

    const handle = useCallback((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) {
            onSignedOut();
            return;
        }
        setStatusError(error instanceof Error ? error.message : String(error));
    }, [onSignedOut]);

    useEffect(() => {
        api.info().then(setInfo, handle);
    }, [handle]);

    useEffect(() => {
        let cancelled = false;
        const load = () => api.status().then(r => {
            if (!cancelled) {
                setReport(r);
                setStatusError('');
            }
        }, e => !cancelled && handle(e));
        load();
        const timer = setInterval(load, POLL_MS);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [handle]);

    useEffect(() => {
        const onPop = () => setPage(pageFromLocation());
        window.addEventListener('popstate', onPop);
        return () => window.removeEventListener('popstate', onPop);
    }, []);

    const navigate = useCallback((next: Page, services: string[] = []) => {
        const query = next === 'logs' && services.length ? `?services=${services.join(',')}` : '';
        window.history.pushState(null, '', `${next === 'logs' ? '/logs' : '/'}${query}`);
        setLogServices(services);
        setPage(next);
    }, []);

    const summary = report ? verdict(report) : null;
    const grafana = grafanaUrl(report);

    return (
        <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
            <AppBar position="static" color="inherit" elevation={0} sx={{ borderBottom: 1, borderColor: 'divider' }}>
                <Toolbar sx={{ flexWrap: 'wrap', gap: 1.5, py: 1 }}>
                    <DnsOutlinedIcon color="primary" aria-hidden="true" />
                    <Typography variant="h3" component="span">node-runner</Typography>
                    {info && (
                        <Typography variant="body2" color="text.secondary" sx={{ fontFamily: 'ui-monospace, monospace' }}>
                            {info.project} · {info.gitCommit}
                        </Typography>
                    )}
                    {summary && (
                        <Chip
                            size="small"
                            color={summary.severity}
                            variant="outlined"
                            label={summary.severity === 'success' ? 'All up' : summary.text.split(':')[0]}
                        />
                    )}
                    <Box sx={{ flex: 1 }} />
                    {grafana && <Link href={grafana} target="_blank" rel="noreferrer">Grafana</Link>}
                    <Button variant="outlined" size="small" onClick={() => api.logout().finally(onSignedOut)}>Sign out</Button>
                </Toolbar>
                <Tabs
                    value={page}
                    onChange={(_e, value: Page) => navigate(value)}
                    sx={{ px: 2 }}
                    aria-label="Sections"
                >
                    <Tab value="overview" label="Overview" />
                    <Tab value="logs" label="Logs" />
                </Tabs>
            </AppBar>
            <Box component="main" sx={{ maxWidth: 1400, mx: 'auto', p: { xs: 2, md: 3 } }}>
                {page === 'overview'
                    ? <OverviewPage report={report} error={statusError} onOpenLogs={service => navigate('logs', [service])} onUnauthorized={onSignedOut} />
                    : <LogsPage report={report} initialServices={logServices} onUnauthorized={onSignedOut} />}
            </Box>
        </Box>
    );
}
