import { Alert, Box, Button, Checkbox, FormControlLabel, Paper, Skeleton, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type UpdateStatus } from '../api';

interface Props {
    onStarted: (jobId: string) => void;
    onUnauthorized: () => void;
}

const MONO = { fontFamily: 'ui-monospace, monospace' };

export default function UpdatesPage({ onStarted, onUnauthorized }: Props) {
    const [status, setStatus] = useState<UpdateStatus | null>(null);
    const [error, setError] = useState('');
    const [checking, setChecking] = useState(false);
    const [confirmed, setConfirmed] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);

    const handle = useCallback((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) {
            onUnauthorized();
        }
        setError(e instanceof Error ? e.message : String(e));
    }, [onUnauthorized]);

    const load = useCallback(async (fetchRemote: boolean) => {
        setChecking(fetchRemote);
        try {
            setStatus(await api.updates(fetchRemote));
            setError('');
        }
        catch (e) {
            handle(e);
        }
        setChecking(false);
    }, [handle]);

    useEffect(() => {
        load(true);
    }, [load]);

    async function changeChannel(channel: 'release' | 'main' | null) {
        if (!channel || channel === status?.channel) {
            return;
        }
        try {
            await api.setChannel(channel);
            await load(false);
        }
        catch (e) {
            handle(e);
        }
    }

    async function update() {
        setBusy(true);
        setError('');
        try {
            const { id } = await api.runUpdate(confirmed.filter(name => status?.statefulAtRisk.includes(name)));
            onStarted(id);
        }
        catch (e) {
            handle(e);
            setBusy(false);
        }
    }

    if (!status) {
        return error ? <Alert severity="error">{error}</Alert> : <Skeleton variant="rounded" height={240} />;
    }

    const busyHost = status.load.load1 > status.load.cores;

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Typography variant="h2" component="h1">Updates</Typography>

            <Paper variant="outlined" sx={{ p: 2.5, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1.5 }}>
                    <Typography sx={{ fontWeight: 600 }}>Channel</Typography>
                    <ToggleButtonGroup exclusive size="small" value={status.channel} onChange={(_e, value) => changeChannel(value)} aria-label="Update channel">
                        <ToggleButton value="release">Releases</ToggleButton>
                        <ToggleButton value="main">main</ToggleButton>
                    </ToggleButtonGroup>
                    <Typography variant="body2" color="text.secondary">
                        {status.channel === 'release' ? 'Follows tagged releases (v*).' : 'Follows the head of main.'}
                    </Typography>
                </Box>
                <Box component="dl" sx={{ m: 0, display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '8px 16px' }}>
                    <Typography component="dt" variant="body2" color="text.secondary">Running</Typography>
                    <Typography component="dd" variant="body2" sx={{ m: 0, ...MONO }}>
                        {status.current.describe}{status.current.branch ? ` on ${status.current.branch}` : ''}
                    </Typography>
                    <Typography component="dt" variant="body2" color="text.secondary">Available</Typography>
                    <Typography component="dd" variant="body2" sx={{ m: 0 }}>
                        {status.target ? `${status.target.label} · ${status.commits.length} new commit${status.commits.length === 1 ? '' : 's'}` : status.note ?? 'Up to date'}
                    </Typography>
                    <Typography component="dt" variant="body2" color="text.secondary">Host load</Typography>
                    <Typography component="dd" variant="body2" sx={{ m: 0 }} color={busyHost ? 'warning.main' : undefined}>
                        {status.load.load1.toFixed(2)} on {status.load.cores} cores{busyHost ? ' · the build will wait for it to drop' : ''}
                    </Typography>
                </Box>
                <Box>
                    <Button variant="outlined" disabled={checking} onClick={() => load(true)}>{checking ? 'Checking…' : 'Check for updates'}</Button>
                </Box>
            </Paper>

            {status.fetchError && <Alert severity="warning">Could not fetch updates: {status.fetchError}</Alert>}
            {status.dirty.length > 0 && (
                <Alert severity="warning">
                    Tracked files have local changes, so an update would not run: {status.dirty.join(', ')}. Commit or discard them on the host first.
                </Alert>
            )}

            {status.target && (
                <Paper variant="outlined" sx={{ p: 2.5, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                    <Typography variant="h3" component="h2">
                        {status.unfinished ? `Finish the update to ${status.target.label}` : `What ${status.target.label} brings`}
                    </Typography>
                    {status.unfinished
                        ? <Alert severity="info">{status.note}</Alert>
                        : (
                            <Box>
                                {status.commits.map(commit => (
                                    <Box key={commit.sha} sx={{ display: 'flex', gap: 1.5, py: 0.75, borderTop: 1, borderColor: 'divider' }}>
                                        <Typography variant="body2" sx={{ ...MONO, color: 'primary.main', flex: 'none' }}>{commit.sha}</Typography>
                                        <Typography variant="body2">{commit.subject}</Typography>
                                    </Box>
                                ))}
                            </Box>
                        )}
                    <Typography variant="body2" color="text.secondary">
                        Updating checks out {status.target.label}, rebuilds the images (which waits while the host is busy), and recreates
                        the containers whose image or configuration changed. If node-runner itself changed, it replaces itself last.
                    </Typography>
                    {status.statefulAtRisk.length > 0 && (
                        <Alert severity="warning" icon={false}>
                            <Typography variant="body2" sx={{ mb: 0.5 }}>
                                These hold state and are restarted only if you allow it and their image or configuration changed.
                                If one needs restarting without your permission, the update stops after building, and you finish it here.
                            </Typography>
                            {status.statefulAtRisk.map(name => (
                                <FormControlLabel
                                    key={name}
                                    control={(
                                        <Checkbox
                                            checked={confirmed.includes(name)}
                                            onChange={e => setConfirmed(current => e.target.checked ? [...current, name] : current.filter(n => n !== name))}
                                        />
                                    )}
                                    label={<Box component="span" sx={MONO}>Allow restarting {name}</Box>}
                                />
                            ))}
                        </Alert>
                    )}
                    {error && <Alert severity="error">{error}</Alert>}
                    <Box>
                        <Button variant="contained" disabled={busy || status.dirty.length > 0} onClick={update}>
                            {status.unfinished ? 'Finish the update' : `Update to ${status.target.label}`}
                        </Button>
                    </Box>
                </Paper>
            )}
            {!status.target && error && <Alert severity="error">{error}</Alert>}
        </Box>
    );
}
