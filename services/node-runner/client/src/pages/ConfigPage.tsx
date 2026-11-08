import { Alert, Box, Button, Chip, FormControlLabel, Paper, Skeleton, Switch, Tab, Tabs, TextField, Typography } from '@mui/material';
import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, type ConfigView, type Draft, type SettingView, type Warning } from '../api';
import CreateEnvCard from '../components/CreateEnvCard';

interface Props {
    draft: Draft;
    onDraft: (draft: Draft) => void;
    onReview: () => void;
    onUnauthorized: () => void;
}

const MONO = { fontFamily: 'ui-monospace, monospace' };

export function draftCount(draft: Draft, view: ConfigView | null): number {
    const enabled = view?.profiles.filter(p => p.enabled).map(p => p.name).sort().join(',');
    const profilesChanged = draft.profiles !== undefined && [...draft.profiles].sort().join(',') !== enabled;
    return Object.keys(draft.settings).length + (profilesChanged ? 1 : 0);
}

function SettingField({ setting, draft, onChange, onDiscard }: {
    setting: SettingView;
    draft: string | undefined;
    onChange: (value: string) => void;
    onDiscard: () => void;
}) {
    const [replacing, setReplacing] = useState(false);
    const changed = draft !== undefined;
    const value = draft ?? setting.value ?? '';

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, py: 1.75, borderTop: 1, borderColor: 'divider' }}>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
                <Typography sx={{ ...MONO, fontSize: 13.5, fontWeight: 600, wordBreak: 'break-all' }}>{setting.key}</Typography>
                {changed && <Chip size="small" color="primary" label="changed" />}
                {changed && <Button size="small" onClick={() => { onDiscard(); setReplacing(false); }}>Undo</Button>}
            </Box>
            {setting.description && <Typography variant="body2" color="text.secondary">{setting.description}</Typography>}
            {setting.secret && !replacing && !changed
                ? (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                        <Typography variant="body2" sx={{ fontWeight: 500 }} color={setting.set ? 'success.main' : 'text.secondary'}>
                            {setting.set ? 'Set' : 'Not set'}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">The value is never shown.</Typography>
                        <Button size="small" variant="outlined" onClick={() => setReplacing(true)}>{setting.set ? 'Replace' : 'Set'}</Button>
                    </Box>
                )
                : (
                    <TextField
                        size="small"
                        type={setting.secret ? 'password' : 'text'}
                        value={value}
                        onChange={e => onChange(e.target.value)}
                        placeholder={setting.secret ? 'New value' : setting.example ?? (setting.default || '(empty)')}
                        autoComplete="off"
                        slotProps={{ htmlInput: { 'aria-label': setting.key, style: MONO } }}
                        autoFocus={replacing}
                    />
                )}
            <Typography variant="caption" color="text.secondary">
                {setting.secret
                    ? 'Write-only.'
                    : [
                        `Default: ${setting.default || '(empty)'}`,
                        setting.example && `Example: ${setting.example}`,
                        !setting.inEnv && 'Not in .env',
                    ].filter(Boolean).join(' · ')}
            </Typography>
        </Box>
    );
}

export default function ConfigPage({ draft, onDraft, onReview, onUnauthorized }: Props) {
    const [view, setView] = useState<ConfigView | null>(null);
    const [error, setError] = useState('');
    const [tab, setTab] = useState<'profiles' | 'settings'>('profiles');
    const [query, setQuery] = useState('');
    const [changedOnly, setChangedOnly] = useState(false);

    useEffect(() => {
        api.config().then(setView, e => {
            if (e instanceof ApiError && e.status === 401) {
                onUnauthorized();
            }
            setError(e instanceof Error ? e.message : String(e));
        });
    }, [onUnauthorized]);

    const enabled = useMemo(() => draft.profiles ?? view?.profiles.filter(p => p.enabled).map(p => p.name) ?? [], [draft.profiles, view]);

    const setSetting = (key: string, value: string) => onDraft({ ...draft, settings: { ...draft.settings, [key]: value } });
    const discard = (key: string) => {
        const { [key]: _gone, ...rest } = draft.settings;
        onDraft({ ...draft, settings: rest });
    };
    const toggleProfile = (name: string) => {
        const next = enabled.includes(name) ? enabled.filter(p => p !== name) : [...enabled, name];
        onDraft({ ...draft, profiles: next });
    };
    const fix = (warning: Warning) => warning.fix && setSetting(warning.fix.key, warning.fix.value);

    const needle = query.trim().toLowerCase();
    const sections = useMemo(() => (view?.sections ?? []).map(section => ({
        ...section,
        settings: section.settings.filter(s =>
            (!needle || `${s.key} ${s.description}`.toLowerCase().includes(needle))
            && (!changedOnly || s.key in draft.settings || (s.secret ? s.set : (s.value ?? '') !== s.default))),
    })).filter(s => s.settings.length), [view, needle, changedOnly, draft.settings]);

    if (!view) {
        return error ? <Alert severity="error">{error}</Alert> : <Skeleton variant="rounded" height={320} />;
    }

    if (view.envMissing) {
        return (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Typography variant="h2" component="h1">Configuration</Typography>
                <CreateEnvCard onCreated={() => api.config().then(setView, e => setError(e instanceof Error ? e.message : String(e)))} onUnauthorized={onUnauthorized} />
            </Box>
        );
    }

    const count = draftCount(draft, view);

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', gap: 1 }}>
                <Typography variant="h2" component="h1">Configuration</Typography>
                <Typography variant="body2" color="text.secondary">
                    Changes stay a draft until you review and apply them. <code>.env</code> is backed up first.
                </Typography>
            </Box>

            {view.configError && (
                <Alert severity="error">
                    Compose rejects the current .env: {view.configError}. Fix the setting below and apply; the review checks the corrected file.
                </Alert>
            )}

            {view.warnings.map(w => (
                <Alert key={w.message} severity="warning" action={w.fix && <Button color="inherit" size="small" onClick={() => fix(w)}>{w.fix.label}</Button>}>
                    {w.message}
                </Alert>
            ))}

            <Tabs value={tab} onChange={(_e, value) => setTab(value)} sx={{ borderBottom: 1, borderColor: 'divider' }}>
                <Tab value="profiles" label="Profiles" />
                <Tab value="settings" label="Settings" />
            </Tabs>

            {tab === 'profiles' && (
                <Paper variant="outlined" sx={{ px: 2.5 }}>
                    {view.profiles.map((profile, i) => {
                        const on = enabled.includes(profile.name);
                        return (
                            <Box key={profile.name} sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 1.75, borderTop: i ? 1 : 0, borderColor: 'divider' }}>
                                <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 0.25 }}>
                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                        <Typography sx={{ ...MONO, fontSize: 14, fontWeight: 600 }}>{profile.name}</Typography>
                                        {on !== profile.enabled && <Chip size="small" color="primary" label="changed" />}
                                    </Box>
                                    {profile.description && <Typography variant="body2" color="text.secondary">{profile.description}</Typography>}
                                    <Typography variant="caption" color="text.secondary" sx={MONO}>{profile.services.join(' · ')}</Typography>
                                </Box>
                                <Switch checked={on} onChange={() => toggleProfile(profile.name)} slotProps={{ input: { 'aria-label': `${profile.name} profile` } }} />
                            </Box>
                        );
                    })}
                </Paper>
            )}

            {tab === 'settings' && (
                <>
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1.5 }}>
                        <TextField label="Search settings" type="search" size="small" value={query} onChange={e => setQuery(e.target.value)} sx={{ flex: '1 1 280px' }} />
                        <FormControlLabel control={<Switch checked={changedOnly} onChange={e => setChangedOnly(e.target.checked)} />} label="Changed from default" />
                    </Box>
                    {sections.length === 0 && <Typography color="text.secondary">No settings match.</Typography>}
                    {sections.map(section => (
                        <Paper key={section.name} variant="outlined" component="section" sx={{ px: 2.5, pt: 2 }}>
                            <Typography variant="h3" component="h2" sx={{ mb: 1 }}>{section.name}</Typography>
                            {section.settings.map(setting => (
                                <SettingField
                                    key={setting.key}
                                    setting={setting}
                                    draft={draft.settings[setting.key]}
                                    onChange={value => setSetting(setting.key, value)}
                                    onDiscard={() => discard(setting.key)}
                                />
                            ))}
                        </Paper>
                    ))}
                </>
            )}

            {count > 0 && (
                <Paper
                    elevation={6}
                    sx={{ position: 'sticky', bottom: 16, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1.5, px: 2.5, py: 1.75 }}
                >
                    <Typography sx={{ flex: '1 1 200px', fontWeight: 500 }}>{count} unapplied change{count === 1 ? '' : 's'}</Typography>
                    <Button onClick={() => onDraft({ settings: {} })}>Discard</Button>
                    <Button variant="contained" onClick={onReview}>Review changes</Button>
                </Paper>
            )}
        </Box>
    );
}
