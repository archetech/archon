import { Alert, Box, Button, Checkbox, Chip, FormControlLabel, Paper, Skeleton, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import { api, ApiError, type ActionPreview, type ActionRequest } from '../api';

interface Props {
    request: ActionRequest;
    onRequest: (request: ActionRequest) => void;
    onBack: () => void;
    onStarted: (jobId: string) => void;
    onUnauthorized: () => void;
}

const MONO = { fontFamily: 'ui-monospace, monospace' };

export default function ActionPage({ request, onRequest, onBack, onStarted, onUnauthorized }: Props) {
    const [preview, setPreview] = useState<ActionPreview | null>(null);
    const [error, setError] = useState('');
    const [confirmed, setConfirmed] = useState(false);
    const [busy, setBusy] = useState(false);

    const handle = (e: unknown) => {
        if (e instanceof ApiError && e.status === 401) {
            onUnauthorized();
        }
        setError(e instanceof Error ? e.message : String(e));
    };

    // Only the preview for the request on screen counts: a response to an
    // earlier one (before the down box was toggled, say) is dropped, so the
    // command reviewed is always the command that runs.
    useEffect(() => {
        let current = true;
        setPreview(null);
        setError('');
        setConfirmed(false);
        api.previewAction(request).then(p => current && setPreview(p), e => current && handle(e));
        return () => {
            current = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [request]);

    async function run() {
        setBusy(true);
        setError('');
        try {
            const { id } = await api.runAction(request, confirmed);
            onStarted(id);
        }
        catch (e) {
            handle(e);
            setBusy(false);
        }
    }

    const wholeNodeStop = request.action === 'stop' && !request.service;
    const needsConfirm = (preview?.stateful.length ?? 0) > 0;

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Box>
                <Typography variant="h2" component="h1">{preview?.title ?? 'Review'}</Typography>
                <Typography variant="body2" color="text.secondary">Nothing runs until you confirm. This is what will happen.</Typography>
            </Box>

            {!preview && !error && <Skeleton variant="rounded" height={160} />}

            {preview && (
                <Paper variant="outlined" sx={{ p: 2.5, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                    <Typography sx={{ ...MONO, fontSize: 13.5 }}>$ {preview.command}</Typography>
                    {preview.empty
                        ? <Typography color="text.secondary">Nothing to do: {request.service ? `${request.service} is already ${request.action === 'start' ? 'running' : 'stopped'}` : 'every service is already in that state'}.</Typography>
                        : (
                            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
                                {preview.services.map(s => (
                                    <Chip
                                        key={s.service}
                                        label={`${s.service}${s.stateful ? ' · stateful' : ''}${s.oneShot ? ' · runs again' : ''}`}
                                        color={s.stateful ? 'warning' : 'default'}
                                        variant="outlined"
                                        sx={MONO}
                                    />
                                ))}
                            </Box>
                        )}
                </Paper>
            )}

            {wholeNodeStop && (
                <FormControlLabel
                    control={<Checkbox checked={!!request.down} onChange={e => onRequest({ action: 'stop', ...(e.target.checked ? { down: true } : {}) })} />}
                    label="Also remove the containers and network (docker compose down). Data on disk and volumes are kept."
                />
            )}

            {needsConfirm && preview && (
                <Alert severity="warning" icon={false}>
                    <FormControlLabel
                        control={<Checkbox checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />}
                        label={`I understand that ${preview.stateful.join(', ')} ${preview.stateful.length === 1 ? 'holds' : 'hold'} state and will be interrupted.`}
                    />
                </Alert>
            )}

            {error && <Alert severity="error">{error}</Alert>}

            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5 }}>
                <Button
                    variant="contained"
                    color={request.action === 'stop' ? 'error' : 'primary'}
                    disabled={busy || !preview || preview.empty || (needsConfirm && !confirmed)}
                    onClick={run}
                >
                    {preview?.title ?? 'Run'}
                </Button>
                <Button onClick={onBack}>Back</Button>
            </Box>
        </Box>
    );
}
