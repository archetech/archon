import { Alert, Box, Chip, List, ListItemButton, ListItemText, Paper, Typography } from '@mui/material';
import { useEffect, useRef, useState } from 'react';
import { api, type JobLine, type JobSummary } from '../api';
import { clockTime, duration } from '../format';

interface Props {
    jobs: JobSummary[];
    selected: string | null;
    onSelect: (id: string) => void;
}

const STATUS: Record<JobSummary['status'], { label: string, color: 'default' | 'success' | 'error' }> = {
    running: { label: 'Running', color: 'default' },
    succeeded: { label: 'Succeeded', color: 'success' },
    failed: { label: 'Failed', color: 'error' },
};

function elapsed(job: JobSummary): string {
    if (!job.finishedAt) {
        return duration(job.startedAt);
    }
    const seconds = Math.round((Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000);
    return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

function JobOutput({ id }: { id: string }) {
    const [lines, setLines] = useState<JobLine[]>([]);
    const [end, setEnd] = useState<JobSummary | null>(null);
    const box = useRef<HTMLDivElement>(null);

    useEffect(() => {
        setLines([]);
        setEnd(null);
        const source = new EventSource(api.jobStreamUrl(id));
        // Each connection, including an automatic reconnect, replays the
        // job's output from the start.
        source.onopen = () => setLines([]);
        source.addEventListener('line', e => setLines(current => [...current, JSON.parse((e as MessageEvent).data)]));
        source.addEventListener('end', e => {
            setEnd(JSON.parse((e as MessageEvent).data));
            source.close();
        });
        return () => source.close();
    }, [id]);

    useEffect(() => {
        if (box.current) {
            box.current.scrollTop = box.current.scrollHeight;
        }
    }, [lines]);

    return (
        <>
            {end?.status === 'failed' && <Alert severity="error">{end.error}</Alert>}
            <Box
                ref={box}
                role="log"
                sx={{ maxHeight: '60vh', minHeight: 240, overflow: 'auto', bgcolor: '#0D0E10', color: '#E4E4E7', borderRadius: 1.5, p: 1.5, fontFamily: 'ui-monospace, monospace', fontSize: 12.5, lineHeight: 1.55 }}
            >
                {lines.map((line, i) => (
                    <Box key={i} sx={{ display: 'flex', gap: 1.25 }}>
                        <Box component="span" sx={{ color: '#A1A1AA', flex: 'none' }}>{clockTime(line.time)}</Box>
                        <Box component="span" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{line.text}</Box>
                    </Box>
                ))}
            </Box>
        </>
    );
}

export default function JobsPage({ jobs, selected, onSelect }: Props) {
    const current = jobs.find(j => j.id === selected) ?? jobs[0];

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Box>
                <Typography variant="h2" component="h1">Jobs</Typography>
                <Typography variant="body2" color="text.secondary">One job runs at a time, and keeps running if you close the page.</Typography>
            </Box>
            {!current && <Typography color="text.secondary">No jobs yet.</Typography>}
            {current && (
                <Paper variant="outlined" sx={{ p: 2.5, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
                        <Typography variant="h3" component="h2">{current.title}</Typography>
                        <Chip label={STATUS[current.status].label} color={STATUS[current.status].color} variant="outlined" />
                    </Box>
                    <JobOutput key={`${current.id}-${current.status}`} id={current.id} />
                </Paper>
            )}
            {jobs.length > 0 && (
                <Paper variant="outlined">
                    <Typography variant="h3" component="h2" sx={{ px: 2.5, pt: 2 }}>History</Typography>
                    <List>
                        {jobs.map(job => (
                            <ListItemButton key={job.id} selected={job.id === current?.id} onClick={() => onSelect(job.id)}>
                                <ListItemText
                                    primary={job.title}
                                    secondary={`${new Date(job.startedAt).toLocaleString()} · ${elapsed(job)}`}
                                />
                                <Chip size="small" label={STATUS[job.status].label} color={STATUS[job.status].color} variant="outlined" />
                            </ListItemButton>
                        ))}
                    </List>
                </Paper>
            )}
        </Box>
    );
}
