import { Alert, Box, Button, Checkbox, Chip, FormControlLabel, Paper, Skeleton, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import { api, ApiError, type Draft, type PlanService, type Preview } from '../api';

interface Props {
    draft: Draft;
    onBack: () => void;
    onStarted: (jobId: string) => void;
    onUnauthorized: () => void;
}

const MONO = { fontFamily: 'ui-monospace, monospace' };

const SECTIONS: { key: keyof Omit<Preview['plan'], 'unchanged'>, title: string, help: string }[] = [
    { key: 'rebuild', title: 'Rebuild', help: 'A build setting changed, so the image is built first; up alone would reuse the old one.' },
    { key: 'create', title: 'Create', help: 'Its profile is turned on.' },
    { key: 'recreate', title: 'Recreate', help: 'Replaced so it picks up the change.' },
    { key: 'start', title: 'Start', help: 'Not running now; up starts it.' },
    { key: 'stop', title: 'Stop', help: 'Its profile is turned off. up would leave it running, so it is stopped explicitly. Its data stays on disk.' },
];

function ServiceChip({ item }: { item: PlanService }) {
    const label = `${item.service}${item.stateful ? ' · stateful' : ''}${item.oneShot ? ' · runs again' : ''}`;
    return <Chip label={label} color={item.stateful ? 'warning' : 'default'} variant="outlined" sx={MONO} />;
}

export default function ReviewPage({ draft, onBack, onStarted, onUnauthorized }: Props) {
    const [preview, setPreview] = useState<Preview | null>(null);
    const [error, setError] = useState('');
    const [confirmed, setConfirmed] = useState(false);
    const [busy, setBusy] = useState(false);

    const handle = (e: unknown) => {
        if (e instanceof ApiError && e.status === 401) {
            onUnauthorized();
        }
        setError(e instanceof Error ? e.message : String(e));
    };

    useEffect(() => {
        api.preview(draft).then(setPreview, handle);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [draft]);

    async function apply() {
        setBusy(true);
        setError('');
        try {
            const { id } = await api.apply(draft, confirmed);
            onStarted(id);
        }
        catch (e) {
            handle(e);
            setBusy(false);
        }
    }

    if (!preview) {
        return (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {error ? <Alert severity="error">{error}</Alert> : <Skeleton variant="rounded" height={240} />}
                <Box><Button onClick={onBack}>Back</Button></Box>
            </Box>
        );
    }

    const needsConfirm = preview.stateful.length > 0;

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Box>
                <Typography variant="h2" component="h1">Review configuration changes</Typography>
                <Typography variant="body2" color="text.secondary">Nothing runs until you apply. This is what will happen.</Typography>
            </Box>

            {preview.empty && <Alert severity="info">These edits leave .env unchanged.</Alert>}

            {preview.diff.length > 0 && (
                <Paper variant="outlined" sx={{ p: 2.5 }}>
                    <Typography variant="h3" component="h2" sx={{ mb: 1 }}>Changes to .env</Typography>
                    <Box sx={{ ...MONO, fontSize: 13, lineHeight: 1.7, overflowX: 'auto' }}>
                        {preview.diff.map(line => line.secret
                            ? <Box key={line.key} sx={{ whiteSpace: 'pre', color: 'warning.main' }}>~ {line.key}=•••••• (changed, not shown)</Box>
                            : (
                                <Box key={line.key}>
                                    {line.before !== null && <Box sx={{ whiteSpace: 'pre', color: 'error.main' }}>- {line.key}={line.before}</Box>}
                                    <Box sx={{ whiteSpace: 'pre', color: 'success.main' }}>+ {line.key}={line.after ?? ''}</Box>
                                </Box>
                            ))}
                    </Box>
                </Paper>
            )}

            {preview.warnings.map(w => <Alert key={w.message} severity="warning">{w.message}</Alert>)}

            {SECTIONS.filter(s => preview.plan[s.key].length).map(s => (
                <Paper key={s.key} variant="outlined" sx={{ p: 2.5, display: 'flex', flexDirection: 'column', gap: 1.25 }}>
                    <Box>
                        <Typography variant="h3" component="h2">{s.title} ({preview.plan[s.key].length})</Typography>
                        <Typography variant="body2" color="text.secondary">{s.help}</Typography>
                    </Box>
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
                        {preview.plan[s.key].map(item => <ServiceChip key={item.service} item={item} />)}
                    </Box>
                </Paper>
            ))}

            <Typography variant="body2" color="text.secondary">
                {preview.plan.unchanged} other running service{preview.plan.unchanged === 1 ? ' is' : 's are'} not touched.
            </Typography>

            {needsConfirm && (
                <Alert severity="warning" icon={false}>
                    <FormControlLabel
                        control={<Checkbox checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />}
                        label={`I understand that ${preview.stateful.join(', ')} ${preview.stateful.length === 1 ? 'holds' : 'hold'} state and will be interrupted.`}
                    />
                </Alert>
            )}

            {error && <Alert severity="error">{error}</Alert>}

            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5 }}>
                <Button variant="contained" disabled={busy || preview.empty || (needsConfirm && !confirmed)} onClick={apply}>
                    Apply {preview.diff.length} change{preview.diff.length === 1 ? '' : 's'}
                </Button>
                <Button onClick={onBack}>Back</Button>
            </Box>
        </Box>
    );
}
