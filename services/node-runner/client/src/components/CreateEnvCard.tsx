import { Alert, Box, Button, Paper, TextField, Typography } from '@mui/material';
import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';

const MIN_LENGTH = 12;
const MAX_NAME_LENGTH = 32;
// sample.env's names, which every node set up from it would share.
const SAMPLE_NAMES = ['mynodeID', 'mynodeName'];

// Mirrors node-runner's check, which follows Keymaster's rule for ID names.
function nameProblem(value: string): string {
    if (!value) {
        return '';
    }
    if (value !== value.trim()) {
        return 'Cannot start or end with a space';
    }
    if (value.length > MAX_NAME_LENGTH) {
        return `At most ${MAX_NAME_LENGTH} characters`;
    }
    if (SAMPLE_NAMES.includes(value)) {
        return 'Choose a name of your own, not the one in sample.env';
    }
    return '';
}

// Shown when the node has no .env: creates one from sample.env rather than
// letting edits build a partial file.
export default function CreateEnvCard({ onCreated, onUnauthorized }: { onCreated: () => void, onUnauthorized: () => void }) {
    const [nodeId, setNodeId] = useState('');
    const [nodeName, setNodeName] = useState('');
    const [passphrase, setPassphrase] = useState('');
    const [confirm, setConfirm] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    const short = passphrase.length > 0 && passphrase.length < MIN_LENGTH;
    const mismatch = confirm.length > 0 && confirm !== passphrase;
    const nodeIdProblem = nameProblem(nodeId);
    const nodeNameProblem = nameProblem(nodeName);
    const namesOk = nodeId !== '' && nodeName !== '' && !nodeIdProblem && !nodeNameProblem;

    async function create(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        setError('');
        try {
            await api.createEnv({ passphrase, nodeId, nodeName });
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
                <Typography component="li" variant="body2">the names below as <code>ARCHON_NODE_ID</code> and <code>ARCHON_NODE_NAME</code>;</Typography>
                <Typography component="li" variant="body2">the passphrase below as <code>ARCHON_PASSPHRASE</code>;</Typography>
                <Typography component="li" variant="body2">no profiles, so the node starts as a core node. Enable profiles afterwards on the Profiles tab.</Typography>
            </Box>
            <TextField
                label="Node agent name"
                value={nodeId}
                onChange={e => setNodeId(e.target.value)}
                autoComplete="off"
                required
                error={!!nodeIdProblem}
                helperText={nodeIdProblem || 'The name of the node\'s own agent in its wallet. Choose it now: changing it later creates a new agent.'}
            />
            <TextField
                label="Node name"
                value={nodeName}
                onChange={e => setNodeName(e.target.value)}
                autoComplete="off"
                required
                error={!!nodeNameProblem}
                helperText={nodeNameProblem || 'How the node appears to its peers on the Hyperswarm network.'}
            />
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
                <Button type="submit" variant="contained" disabled={busy || !namesOk || passphrase.length < MIN_LENGTH || confirm !== passphrase}>
                    Create .env
                </Button>
            </Box>
        </Paper>
    );
}
