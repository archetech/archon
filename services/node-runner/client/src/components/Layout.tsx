import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import { AppBar, Badge, Box, Button, Chip, CircularProgress, Link, Tab, Tabs, Toolbar, Typography } from '@mui/material';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type ActionRequest, type Draft, type Info, type JobSummary, type StatusReport } from '../api';
import { verdict } from '../format';
import ActionPage from '../pages/ActionPage';
import ConfigPage from '../pages/ConfigPage';
import JobsPage from '../pages/JobsPage';
import LogsPage from '../pages/LogsPage';
import OverviewPage from '../pages/OverviewPage';
import ReviewPage from '../pages/ReviewPage';
import UpdatesPage from '../pages/UpdatesPage';

const POLL_MS = 5000;

type Page = 'overview' | 'logs' | 'config' | 'review' | 'action' | 'updates' | 'jobs';

const PATHS: Record<Page, string> = { overview: '/', logs: '/logs', config: '/config', review: '/review', action: '/action', updates: '/updates', jobs: '/jobs' };

interface Route {
    page: Page;
    services: string[];
    job: string | null;
}

function routeFromLocation(): Route {
    const path = window.location.pathname;
    const page = (Object.entries(PATHS).find(([, p]) => p !== '/' && path.startsWith(p))?.[0] ?? 'overview') as Page;
    const params = new URLSearchParams(window.location.search);
    return { page, services: params.get('services')?.split(',').filter(Boolean) ?? [], job: params.get('job') };
}

// Grafana's published host port, when the observability profile runs it.
// Grafana serves plain HTTP there, whatever scheme node-runner is reached by.
function grafanaUrl(report: StatusReport | null): string | null {
    const grafana = report?.services.find(s => s.service === 'grafana' && s.state === 'running');
    const port = grafana?.ports[0]?.match(/(\d+)→/)?.[1];
    return port ? `http://${window.location.hostname}:${port}` : null;
}

export default function Layout({ onSignedOut }: { onSignedOut: () => void }) {
    const [route, setRoute] = useState<Route>(routeFromLocation);
    const [info, setInfo] = useState<Info | null>(null);
    const [report, setReport] = useState<StatusReport | null>(null);
    const [jobs, setJobs] = useState<JobSummary[]>([]);
    const [statusError, setStatusError] = useState('');
    // The configuration draft lives here so it survives moving between the
    // Configuration and Review pages.
    const [draft, setDraft] = useState<Draft>({ settings: {} });
    // The service or node action being reviewed.
    const [action, setAction] = useState<ActionRequest | null>(null);

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
        const load = () => {
            api.status().then(r => {
                if (!cancelled) {
                    setReport(r);
                    setStatusError('');
                }
            }, e => !cancelled && handle(e));
            api.jobs().then(r => !cancelled && setJobs(r.jobs), () => {});
        };
        load();
        const timer = setInterval(load, POLL_MS);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [handle]);

    useEffect(() => {
        const onPop = () => setRoute(routeFromLocation());
        window.addEventListener('popstate', onPop);
        return () => window.removeEventListener('popstate', onPop);
    }, []);

    const navigate = useCallback((page: Page, extra: { services?: string[], job?: string } = {}) => {
        const params = new URLSearchParams();
        if (extra.services?.length) {
            params.set('services', extra.services.join(','));
        }
        if (extra.job) {
            params.set('job', extra.job);
        }
        const query = params.toString();
        window.history.pushState(null, '', query ? `${PATHS[page]}?${query}` : PATHS[page]);
        setRoute({ page, services: extra.services ?? [], job: extra.job ?? null });
    }, []);

    const review = useCallback((request: ActionRequest) => {
        setAction(request);
        navigate('action');
    }, [navigate]);

    const jobStarted = useCallback((id: string) => {
        api.jobs().then(r => setJobs(r.jobs), () => {});
        navigate('jobs', { job: id });
    }, [navigate]);

    // Only an applied configuration change retires the draft.
    const configApplied = useCallback((id: string) => {
        setDraft({ settings: {} });
        jobStarted(id);
    }, [jobStarted]);

    const actionStarted = useCallback((id: string) => {
        setAction(null);
        jobStarted(id);
    }, [jobStarted]);

    const summary = report ? verdict(report) : null;
    const running = jobs.find(j => j.status === 'running');
    const grafana = grafanaUrl(report);
    const tab = route.page === 'review' ? 'config' : route.page === 'action' ? 'overview' : route.page;
    const drafted = Object.keys(draft.settings).length + (draft.profiles ? 1 : 0);

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
                    {running && (
                        <Chip
                            size="small"
                            icon={<CircularProgress size={12} />}
                            label={`Running: ${running.title}`}
                            onClick={() => navigate('jobs', { job: running.id })}
                        />
                    )}
                    <Box sx={{ flex: 1 }} />
                    {grafana && <Link href={grafana} target="_blank" rel="noreferrer">Grafana</Link>}
                    <Button variant="outlined" size="small" onClick={() => api.logout().finally(onSignedOut)}>Sign out</Button>
                </Toolbar>
                <Tabs
                    value={tab}
                    onChange={(_e, value: Page) => navigate(value)}
                    sx={{ px: 2 }}
                    variant="scrollable"
                    allowScrollButtonsMobile
                    aria-label="Sections"
                >
                    <Tab value="overview" label="Overview" />
                    <Tab value="logs" label="Logs" />
                    <Tab value="config" label={<Badge color="primary" badgeContent={drafted} invisible={!drafted}>Configuration</Badge>} />
                    <Tab value="updates" label="Updates" />
                    <Tab value="jobs" label="Jobs" />
                </Tabs>
            </AppBar>
            <Box component="main" sx={{ maxWidth: 1400, mx: 'auto', p: { xs: 2, md: 3 } }}>
                {route.page === 'overview' && (
                    <OverviewPage
                        report={report}
                        error={statusError}
                        onOpenLogs={service => navigate('logs', { services: [service] })}
                        onAction={review}
                        onUnauthorized={onSignedOut}
                    />
                )}
                {route.page === 'logs' && <LogsPage report={report} initialServices={route.services} onUnauthorized={onSignedOut} />}
                {route.page === 'config' && (
                    <ConfigPage draft={draft} onDraft={setDraft} onReview={() => navigate('review')} onUnauthorized={onSignedOut} />
                )}
                {route.page === 'review' && (
                    <ReviewPage draft={draft} onBack={() => navigate('config')} onStarted={configApplied} onUnauthorized={onSignedOut} />
                )}
                {route.page === 'action' && (action
                    ? <ActionPage request={action} onRequest={setAction} onBack={() => navigate('overview')} onStarted={actionStarted} onUnauthorized={onSignedOut} />
                    : <OverviewPage report={report} error={statusError} onOpenLogs={service => navigate('logs', { services: [service] })} onAction={review} onUnauthorized={onSignedOut} />)}
                {route.page === 'updates' && <UpdatesPage onStarted={jobStarted} onUnauthorized={onSignedOut} />}
                {route.page === 'jobs' && <JobsPage jobs={jobs} selected={route.job} onSelect={id => navigate('jobs', { job: id })} />}
            </Box>
        </Box>
    );
}
