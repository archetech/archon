import { Alert, Box, Button, Chip, FormControlLabel, MenuItem, Switch, TextField, Typography } from '@mui/material';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type LogEntry, type StatusReport } from '../api';
import { clockTime, colorSlot } from '../format';

const MAX_LINES = 5000;
const FLUSH_MS = 200;
const RECONNECT_MS = 3000;
const TAILS = [200, 1000, 5000];
const SERVICE_COLORS = ['#93C5FD', '#FCD34D', '#86EFAC', '#F9A8D4', '#C4B5FD', '#67E8F9', '#FDBA74'];

interface Props {
    report: StatusReport | null;
    initialServices: string[];
    onUnauthorized: () => void;
}

type Keyed = LogEntry & { key: string };

// Docker trims trailing zeros from timestamp fractions; the server sends a
// padded key so lines from several containers merge in time order.
function insertSorted(lines: Keyed[], incoming: Keyed[]): Keyed[] {
    const merged = lines.concat(incoming);
    merged.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return merged.length > MAX_LINES ? merged.slice(merged.length - MAX_LINES) : merged;
}

function highlight(text: string, query: string): ReactNode {
    if (!query) {
        return text;
    }
    const lower = text.toLowerCase();
    const parts: ReactNode[] = [];
    let at = 0;
    for (let i = lower.indexOf(query); i >= 0; i = lower.indexOf(query, at)) {
        parts.push(text.slice(at, i), <mark key={i}>{text.slice(i, i + query.length)}</mark>);
        at = i + query.length;
    }
    parts.push(text.slice(at));
    return parts;
}

export default function LogsPage({ report, initialServices, onUnauthorized }: Props) {
    const [services, setServices] = useState<string[]>(initialServices);
    const [tail, setTail] = useState(200);
    const [query, setQuery] = useState('');
    const [follow, setFollow] = useState(true);
    const [lines, setLines] = useState<Keyed[]>([]);
    const [connection, setConnection] = useState<'connecting' | 'live' | 'retrying'>('connecting');
    const [failure, setFailure] = useState('');
    const scroller = useRef<HTMLDivElement>(null);

    useEffect(() => setServices(initialServices), [initialServices]);

    const servicesKey = services.join(',');

    // One EventSource per selection. When it drops (the server also ends it
    // when a container is recreated) it reconnects from the oldest of each
    // service's last lines, so no service's unseen lines are skipped, and
    // drops the lines it already holds from the overlap.
    useEffect(() => {
        const selected = servicesKey ? servicesKey.split(',') : [];
        let source: EventSource | null = null;
        let pending: Keyed[] = [];
        let retry: ReturnType<typeof setTimeout> | undefined;
        let closed = false;
        const last = new Map<string, { key: string, time: string }>();
        const seen = new Set<string>();
        const identity = (e: Keyed) => `${e.service}\u0000${e.key}\u0000${e.text}`;
        const connectedAt = Math.floor(Date.now() / 1000);

        setLines([]);
        setConnection('connecting');

        const resumeFrom = (): number => {
            const services = selected.length ? selected : [...last.keys()];
            const times = services.map(service => last.get(service)?.time);
            if (!times.length || times.some(t => !t)) {
                return connectedAt;
            }
            return Math.min(...times.map(t => Math.floor(Date.parse(t!) / 1000)));
        };

        const connect = (since?: number) => {
            source = new EventSource(api.streamUrl(selected, since ? MAX_LINES : tail, since));
            source.onopen = () => {
                setConnection('live');
                setFailure('');
            };
            source.addEventListener('log', event => {
                const entry = JSON.parse((event as MessageEvent).data) as Keyed;
                const id = identity(entry);
                if (seen.has(id)) {
                    return;
                }
                seen.add(id);
                if (seen.size > MAX_LINES * 4) {
                    seen.clear();
                }
                pending.push(entry);
                const previous = last.get(entry.service);
                if (!previous || entry.key > previous.key) {
                    last.set(entry.service, { key: entry.key, time: entry.time });
                }
            });
            source.addEventListener('failure', event => {
                setFailure(JSON.parse((event as MessageEvent).data).error);
            });
            source.onerror = () => {
                source?.close();
                if (closed) {
                    return;
                }
                setConnection('retrying');
                // A lapsed session also lands here; recheck it.
                api.session().then(s => {
                    if (!s.authenticated) {
                        onUnauthorized();
                    }
                }, () => {});
                retry = setTimeout(() => connect(resumeFrom()), RECONNECT_MS);
            };
        };
        connect();

        const flush = setInterval(() => {
            if (pending.length) {
                const batch = pending;
                pending = [];
                setLines(current => insertSorted(current, batch));
            }
        }, FLUSH_MS);

        return () => {
            closed = true;
            source?.close();
            clearTimeout(retry);
            clearInterval(flush);
        };
    }, [servicesKey, tail, onUnauthorized]);

    const needle = query.trim().toLowerCase();
    const visible = useMemo(
        () => (needle ? lines.filter(l => `${l.service} ${l.text}`.toLowerCase().includes(needle)) : lines),
        [lines, needle],
    );

    useEffect(() => {
        if (follow && scroller.current) {
            scroller.current.scrollTop = scroller.current.scrollHeight;
        }
    }, [visible, follow]);

    // Scrolling up to read pauses following; scrolling back to the end resumes it.
    const onScroll = () => {
        const el = scroller.current;
        if (!el) {
            return;
        }
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        if (atBottom !== follow) {
            setFollow(atBottom);
        }
    };

    const toggle = (service: string) => setServices(current =>
        current.includes(service) ? current.filter(s => s !== service) : [...current, service]);

    // Every service, running or not: Docker keeps a stopped container's log,
    // and comparing failed services is the point.
    const names = (report?.services ?? []).map(s => s.service);

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 1.5 }}>
                <Typography variant="h2" component="h1">Logs</Typography>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1.5 }}>
                    <Typography variant="body2" color={connection === 'live' ? 'success.main' : 'text.secondary'} role="status">
                        {connection === 'live' ? 'Live' : connection === 'retrying' ? 'Disconnected, retrying…' : 'Connecting…'}
                    </Typography>
                    <FormControlLabel control={<Switch checked={follow} onChange={e => setFollow(e.target.checked)} />} label="Follow" />
                    <Button variant="outlined" href={api.downloadUrl(services, tail)}>Download</Button>
                </Box>
            </Box>

            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }} role="group" aria-label="Services">
                <Chip label="All services" color={services.length ? 'default' : 'primary'} variant={services.length ? 'outlined' : 'filled'} onClick={() => setServices([])} />
                {names.map(name => (
                    <Chip
                        key={name}
                        label={name}
                        aria-pressed={services.includes(name)}
                        color={services.includes(name) ? 'primary' : 'default'}
                        variant={services.includes(name) ? 'filled' : 'outlined'}
                        onClick={() => toggle(name)}
                        sx={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
                    />
                ))}
            </Box>

            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5 }}>
                <TextField label="Search" type="search" size="small" value={query} onChange={e => setQuery(e.target.value)} sx={{ flex: '1 1 280px' }} />
                <TextField select label="Lines per service" size="small" value={tail} onChange={e => setTail(Number(e.target.value))} sx={{ flex: '0 1 200px' }}>
                    {TAILS.map(n => <MenuItem key={n} value={n}>Last {n}</MenuItem>)}
                </TextField>
            </Box>

            {failure && <Alert severity="error">The log stream failed: {failure}</Alert>}

            {lines.length >= MAX_LINES && (
                <Alert severity="info">Showing the latest {MAX_LINES} lines. Download for more.</Alert>
            )}

            <Box
                ref={scroller}
                onScroll={onScroll}
                sx={{
                    height: { xs: '60vh', md: 'calc(100vh - 360px)' },
                    minHeight: 320,
                    overflow: 'auto',
                    bgcolor: '#0D0E10',
                    color: '#E4E4E7',
                    borderRadius: 1.5,
                    p: 1.5,
                    fontFamily: 'ui-monospace, monospace',
                    fontSize: 12.5,
                    lineHeight: 1.55,
                    '& mark': { bgcolor: '#FCD34D', color: '#0D0E10', borderRadius: '2px' },
                }}
            >
                {visible.length === 0 && <Box sx={{ color: '#A1A1AA' }}>{needle ? 'No lines match.' : 'No log lines yet.'}</Box>}
                {visible.map((line, i) => (
                    <Box key={`${line.key}-${i}`} sx={{ display: 'flex', gap: 1.25 }}>
                        <Box component="span" sx={{ color: '#A1A1AA', flex: 'none' }}>{clockTime(line.time)}</Box>
                        <Box component="span" sx={{ color: SERVICE_COLORS[colorSlot(line.service, SERVICE_COLORS.length)], flex: 'none', minWidth: { md: 180 } }}>
                            {line.service}
                        </Box>
                        <Box component="span" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: line.stream === 'stderr' ? '#FCA5A5' : undefined }}>
                            {highlight(line.text, needle)}
                        </Box>
                    </Box>
                ))}
            </Box>
        </Box>
    );
}
