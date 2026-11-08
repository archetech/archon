import { Alert, Box, Button, Paper, TextField, Typography } from '@mui/material';
import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';

const MIN_LENGTH = 12;

// Shown when the node has no .env: creates one from sample.env rather than
// letting edits build a partial file.
export default function CreateEnvCard({ onCreated, onUnauthorized }: { onCreated: () => void, onUnauthorized: () => void }) {
    const [passphrase, setPassphrase] = useState('');
    const [confirm, setConfirm] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    const short = passphrase.length > 0 && passphrase.length < MIN_LENGTH;
    const mismatch = confirm.length > 0 && confirm !== passphrase;

    async function create(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        setError('');
        try {
            await api.createEnv(passphrase);
            onCreated();
        }
        catch (e) {
            if (e instanceof ApiError && e.status === 401) {
                onUnauthorized();
            }
            setError(e instanceof Error ? e.message : String(e));
            setBusy(false);
        }
    }

    return (
        <Paper component="form" onSubmit={create} variant="outlined" sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 640 }}>
            <Typography variant="h3" component="h2">This node has no .env yet</Typography>
            <Typography variant="body2" color="text.secondary">
                node-runner creates it from <code>sample.env</code> with:
            </Typography>
            <Box component="ul" sx={{ m: 0, pl: 3, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                <Typography component="li" variant="body2">your user and group as <code>ARCHON_UID</code> and <code>ARCHON_GID</code>, so containers do not run as root;</Typography>
                <Typography component="li" variant="body2">a newly generated <code>ARCHON_ADMIN_API_KEY</code>;</Typography>
                <Typography component="li" variant="body2">the passphrase below as <code>ARCHON_PASSPHRASE</code>;</Typography>
                <Typography component="li" variant="body2">no profiles, so the node starts as a core node. Enable profiles afterwards on the Profiles tab.</Typography>
            </Box>
            <Alert severity="warning">
                The passphrase encrypts the node&apos;s wallet. Keep it safe: changing it later needs the CLI&apos;s <code>change-passphrase</code> first.
            </Alert>
            <TextField
                label="Wallet passphrase"
                type="password"
                value={passphrase}
                onChange={e => setPassphrase(e.target.value)}
                autoComplete="new-password"
                required
                error={short}
                helperText={`At least ${MIN_LENGTH} characters.`}
            />
            <TextField
                label="Confirm passphrase"
                type="password"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                autoComplete="new-password"
                required
                error={mismatch}
                helperText={mismatch ? 'The passphrases do not match' : ' '}
            />
            {error && <Alert severity="error">{error}</Alert>}
            <Box>
                <Button type="submit" variant="contained" disabled={busy || passphrase.length < MIN_LENGTH || confirm !== passphrase}>
                    Create .env
                </Button>
            </Box>
        </Paper>
    );
}
