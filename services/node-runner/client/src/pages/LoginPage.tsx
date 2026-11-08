import { Alert, Button, TextField, Typography } from '@mui/material';
import { useState, type FormEvent } from 'react';
import { api } from '../api';
import AuthCard from '../components/AuthCard';

export default function LoginPage({ onDone }: { onDone: () => void }) {
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    async function submit(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        setError('');
        try {
            await api.login(password);
            onDone();
        }
        catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setBusy(false);
        }
    }

    return (
        <AuthCard eyebrow="node-runner" title="Sign in" onSubmit={submit}>
            <TextField
                label="Admin password"
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoComplete="current-password"
                autoFocus
                required
            />
            {error && <Alert severity="error">{error}</Alert>}
            <Button type="submit" variant="contained" size="large" disabled={busy || !password}>Sign in</Button>
            <Typography variant="caption" color="text.secondary">
                Forgot it? Delete <code>data/node-runner/admin-password</code> on the host to set a new one.
            </Typography>
        </AuthCard>
    );
}
