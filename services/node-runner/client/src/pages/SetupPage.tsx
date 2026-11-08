import { Alert, Button, TextField, Typography } from '@mui/material';
import { useState, type FormEvent } from 'react';
import { api } from '../api';
import AuthCard from '../components/AuthCard';

interface Props {
    minPasswordLength: number;
    onDone: () => void;
}

export default function SetupPage({ minPasswordLength, onDone }: Props) {
    const [code, setCode] = useState('');
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    const mismatch = confirm.length > 0 && confirm !== password;
    const short = password.length > 0 && password.length < minPasswordLength;

    async function submit(event: FormEvent) {
        event.preventDefault();
        if (mismatch || short) {
            return;
        }
        setBusy(true);
        setError('');
        try {
            await api.setup(code, password);
            onDone();
        }
        catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setBusy(false);
        }
    }

    return (
        <AuthCard eyebrow="node-runner · first run" title="Set the admin password" onSubmit={submit}>
            <Typography variant="body2" color="text.secondary">
                Enter the one-time setup code. The installer printed it, and node-runner wrote it
                to <code>data/node-runner/setup-code</code> and its log.
            </Typography>
            <TextField
                label="Setup code"
                value={code}
                onChange={e => setCode(e.target.value)}
                placeholder="XXXX-XXXX-XXXX"
                autoComplete="one-time-code"
                autoFocus
                required
                slotProps={{ htmlInput: { style: { fontFamily: 'ui-monospace, monospace', letterSpacing: '0.08em' } } }}
            />
            <TextField
                label="Password"
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoComplete="new-password"
                required
                error={short}
                helperText={`At least ${minPasswordLength} characters. Only its hash is stored.`}
            />
            <TextField
                label="Confirm password"
                type="password"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                autoComplete="new-password"
                required
                error={mismatch}
                helperText={mismatch ? 'The passwords do not match' : ' '}
            />
            {error && <Alert severity="error">{error}</Alert>}
            <Button type="submit" variant="contained" size="large" disabled={busy || !code || !password || mismatch || short}>
                Set password
            </Button>
        </AuthCard>
    );
}
