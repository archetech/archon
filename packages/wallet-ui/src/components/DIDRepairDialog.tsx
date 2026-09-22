import { useCallback, useEffect, useRef, useState } from 'react';
import {
    Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle,
    LinearProgress, Stack, TextField, Typography,
} from '@mui/material';
import type { CheckDIDResult, RepairDIDResult } from '@didcid/clients/keymaster-types';

type Props = {
    did: string;
    checkDID: (did: string) => Promise<CheckDIDResult>;
    repairDID: (did: string) => Promise<RepairDIDResult>;
    onClose: () => void;
    onRepaired?: (did: string) => void | Promise<void>;
};

// Shared by wallets and standalone clients; all repair decisions remain in Keymaster.
export default function DIDRepairDialog({ did, checkDID, repairDID, onClose, onRepaired }: Props) {
    const [target, setTarget] = useState(did);
    const [report, setReport] = useState<CheckDIDResult | RepairDIDResult>();
    const [busy, setBusy] = useState<'checking' | 'repairing' | null>(null);
    const [error, setError] = useState('');
    const request = useRef(0);
    const invalidate = useCallback(() => { request.current++; }, []);

    const inspect = useCallback(async (value: string) => {
        const current = ++request.current;
        setTarget(value);
        setReport(undefined);
        setError('');
        setBusy('checking');
        try {
            const result = await checkDID(value);
            if (current === request.current) setReport(result);
        } catch (e: any) {
            if (current === request.current) setError(String(e?.error || e?.message || e));
        } finally {
            if (current === request.current) setBusy(null);
        }
    }, [checkDID]);

    useEffect(() => {
        void inspect(did);
        return invalidate;
    }, [did, inspect, invalidate]);

    async function repair() {
        if (busy || !report?.canRepair || !report.changes) return;
        const current = ++request.current;
        setBusy('repairing');
        setError('');
        try {
            // Use the checked DID, not an alias whose mapping could have changed.
            const result = await repairDID(report.did);
            if (current !== request.current) return;
            setReport(result);
            if (result.submitted) {
                try { await onRepaired?.(result.did); }
                catch { if (current === request.current) setError('Repair accepted, but the background document view could not be refreshed.'); }
            }
        } catch (e: any) {
            if (current === request.current) {
                setReport(undefined);
                setError(String(e?.error || e?.message || e));
            }
        } finally {
            if (current === request.current) setBusy(null);
        }
    }

    return (
        <Dialog open onClose={() => { if (busy !== 'repairing') onClose(); }} fullWidth maxWidth="md" aria-labelledby="did-repair-title">
            <DialogTitle id="did-repair-title">Check / Repair DID</DialogTitle>
            <DialogContent>
                <Stack spacing={2} sx={{ pt: 1 }}>
                    <Typography variant="body2">Inspect the latest document for known problems. Checking does not change the DID.</Typography>
                    <TextField label="DID or alias" value={target} fullWidth disabled={busy === 'repairing'}
                        onChange={event => {
                            invalidate();
                            setTarget(event.target.value);
                            setReport(undefined);
                            setError('');
                            setBusy(null);
                        }}
                        onKeyDown={event => {
                            if (event.key === 'Enter' && target.trim() && !busy) void inspect(target.trim());
                        }}
                    />
                    <Button onClick={() => void inspect(target.trim())} disabled={!!busy || !target.trim()}>Check DID</Button>
                    {busy && <Box role="status"><Typography>{busy === 'checking' ? 'Checking DID…' : 'Submitting repair…'}</Typography><LinearProgress /></Box>}
                    {error && <Alert severity="error">{error}</Alert>}
                    {report && <>
                        <Typography sx={{ overflowWrap: 'anywhere' }}>{report.did}</Typography>
                        {'submitted' in report && <Alert severity={report.submitted ? 'success' : 'info'}>
                            {report.submitted
                                ? (report.confirmed ? 'Repair accepted and confirmed.' : 'Repair accepted; awaiting confirmation.')
                                : 'No repair was submitted.'}
                        </Alert>}
                        <Typography variant="body2">Current document: {report.confirmed ? 'confirmed' : 'pending confirmation'}</Typography>
                        {!report.issues.length && <Alert severity="success">No known problems found.</Alert>}
                        {report.issues.map((issue, index) => <Alert severity="warning" key={`${issue.code}-${index}`}>
                            {issue.message}
                            {issue.relatedDid && <Box sx={{ mt: 1, overflowWrap: 'anywhere' }}>
                                <Typography variant="body2">Related DID: {issue.relatedDid}</Typography>
                                <Button disabled={!!busy} onClick={() => void inspect(issue.relatedDid!)}>Check controller DID</Button>
                            </Box>}
                        </Alert>)}
                        {report.reason && <Alert severity="info">{report.reason}</Alert>}
                        {report.issues.length > 0 && !report.canRepair && <Typography variant="body2">Repair is unavailable for this DID in this wallet.</Typography>}
                        {report.changes && <Box>
                            <Typography component="h3" variant="subtitle1">Proposed changes</Typography>
                            <Typography variant="body2">Repair replaces the document components shown below. Other components are preserved.</Typography>
                            <Box component="pre" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 280, overflow: 'auto', p: 2, bgcolor: 'action.hover' }}>
                                {JSON.stringify(report.changes, null, 2)}
                            </Box>
                        </Box>}
                    </>}
                </Stack>
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose} disabled={busy === 'repairing'}>Close</Button>
                <Button variant="contained" disabled={!!busy || !report?.canRepair || !report.changes} onClick={() => void repair()}>Repair DID</Button>
            </DialogActions>
        </Dialog>
    );
}
