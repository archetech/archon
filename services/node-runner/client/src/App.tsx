import { Box, CircularProgress } from '@mui/material';
import { useCallback, useEffect, useState } from 'react';
import { api, type Session } from './api';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import SetupPage from './pages/SetupPage';

export default function App() {
    const [session, setSession] = useState<Session | null>(null);
    const [error, setError] = useState('');

    const refresh = useCallback(async () => {
        try {
            setSession(await api.session());
            setError('');
        }
        catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }, []);

    useEffect(() => {
        refresh();
    }, [refresh]);

    if (!session) {
        return (
            <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', p: 2 }}>
                {error ? <Box role="alert">node-runner is not reachable: {error}</Box> : <CircularProgress aria-label="Loading" />}
            </Box>
        );
    }
    if (!session.configured) {
        return <SetupPage minPasswordLength={session.minPasswordLength} onDone={refresh} />;
    }
    if (!session.authenticated) {
        return <LoginPage onDone={refresh} />;
    }
    return <Layout onSignedOut={refresh} />;
}
