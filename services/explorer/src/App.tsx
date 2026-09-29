import React, {useEffect, useMemo, useState} from 'react';
import JsonViewer from "./components/JsonViewer.js";
import Events from "./components/Events.js";
import GatekeeperClient from '@didcid/clients/gatekeeper';
import { createTheme, ThemeProvider } from "@mui/material/styles";
import {
    Alert,
    AlertColor,
    Box,
    CssBaseline,
    Snackbar,
    Typography,
} from "@mui/material";
import Header from "./components/Header.js";
import { GatekeeperEvent } from "@didcid/gatekeeper/types";
import { Routes, Route, useNavigate, useLocation, Navigate } from 'react-router-dom';

import { getRuntimeConfig } from './runtimeConfig.js';

const gatekeeper = new GatekeeperClient();

// A page of events is an indexed query on the Gatekeeper, cheap to repeat.
const EVENTS_REFRESH_MS = 10_000;

// A fetch cannot be cancelled, so one started for an earlier filter or visit
// to /events finishes anyway. Later fetches wait for it rather than overlap.
let eventsFetch: Promise<unknown> | undefined;

interface SnackbarState {
    open: boolean;
    message: string;
    severity: AlertColor;
}

function App() {
    const [isReady, setIsReady] = useState<boolean>(false);
    const [snackbar, setSnackbar] = useState<SnackbarState>({
        open: false,
        message: "",
        severity: "warning",
    });
    const [darkMode, setDarkMode] = useState<boolean>(false);
    const [events, setEvents] = useState<GatekeeperEvent[]>([]);
    const [total, setTotal] = useState<number>(0);
    const [eventCount, setEventCount] = useState<number>(50);
    const [page, setPage] = useState<number>(0);
    const [registry, setRegistry] = useState<string>("All");

    const [dateFrom, setDateFrom] = useState<string>(() => {
        const dayAgo = new Date();
        dayAgo.setDate(dayAgo.getDate() - 1);
        return dayAgo.toISOString().slice(0, 10);
    });
    const [dateTo, setDateTo] = useState<string>(() => {
        return new Date().toISOString().slice(0, 10);
    });

    const navigate = useNavigate();
    const showingEvents = useLocation().pathname.replace(/\/+$/, '') === '/events';

    function handleViewDid(did: string) {
        navigate(`/search?did=${encodeURIComponent(did)}`);
    }

    const setError = (error: any) => {
        const errorMessage = error.error || error.message || String(error);
        setSnackbar({
            open: true,
            message: errorMessage,
            severity: "error",
        });
    };

    const theme = useMemo(() => createTheme({
        palette: {
            mode: darkMode ? 'dark' : 'light',
        },
    }), [darkMode]);

    function handleThemeToggle(event: React.ChangeEvent<HTMLInputElement>) {
        const isDark = event.target.checked;
        setDarkMode(isDark);
        localStorage.setItem('archon-explorer-theme-mode', isDark ? 'dark' : 'light');
    }

    useEffect(() => {
        const themeMode = localStorage.getItem('archon-explorer-theme-mode');
        if (themeMode) {
            setDarkMode(themeMode === 'dark');
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleSnackbarClose = () => {
        setSnackbar((prev) => ({ ...prev, open: false }));
    };

    useEffect(() => {
        let interval: NodeJS.Timeout;

        async function init() {
            await gatekeeper.connect({
                url: getRuntimeConfig().gatekeeperUrl,
                waitUntilReady: true,
                intervalSeconds: 5,
                chatty: true,
            });

            interval = setInterval(async () => {
                if (await gatekeeper.isReady()) {
                    setIsReady(true);
                    clearInterval(interval);
                }
            }, 500);
        }

        init();
    }, []);


    // The Gatekeeper filters, orders and pages the events.
    useEffect(() => {
        if (!isReady || !showingEvents) {
            return;
        }

        let isMounted = true;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;

        function fetchPage() {
            // The From day starts at local midnight and the To day includes
            // its last millisecond; the Gatekeeper's bounds are exclusive.
            const after = dateFrom ? new Date(new Date(`${dateFrom}T00:00:00`).getTime() - 1).toISOString() : undefined;
            const before = dateTo ? new Date(new Date(`${dateTo}T23:59:59.999`).getTime() + 1).toISOString() : undefined;

            return gatekeeper.listEvents({
                after,
                before,
                registry: registry === "All" ? undefined : registry,
                limit: Number(eventCount),
                offset: page * Number(eventCount),
            });
        }

        // The next refresh is scheduled when this one finishes, and skipped
        // while the tab is hidden.
        async function refresh() {
            if (!document.hidden) {
                if (eventsFetch) {
                    await eventsFetch.catch(() => {});
                }
                // A newer effect replaced this one while it waited.
                if (!isMounted) {
                    return;
                }
                const current = fetchPage();
                eventsFetch = current;
                try {
                    const fetched = await current;
                    if (isMounted) {
                        setEvents(fetched.events);
                        setTotal(fetched.total);
                    }
                } catch (err: any) {
                    if (isMounted) {
                        setError(err);
                    }
                } finally {
                    if (eventsFetch === current) {
                        eventsFetch = undefined;
                    }
                }
            }
            if (isMounted) {
                timeoutId = setTimeout(refresh, EVENTS_REFRESH_MS);
            }
        }

        refresh();

        return () => {
            isMounted = false;
            if (timeoutId) clearTimeout(timeoutId);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isReady, showingEvents, dateFrom, dateTo, registry, page, eventCount]);

    const totalPages = Math.ceil(total / eventCount);

    return (
        <ThemeProvider theme={theme}>
            <CssBaseline />
            <Box sx={{
                bgcolor: 'background.default',
                color: 'text.primary',
                minHeight: '100vh',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'flex-start'
            }}>
                <Box sx={{ width: '900px', boxSizing: 'border-box', p: 2 }}>
                    <Snackbar
                        open={snackbar.open}
                        autoHideDuration={5000}
                        onClose={handleSnackbarClose}
                        anchorOrigin={{ vertical: "top", horizontal: "center" }}
                    >
                        <Alert
                            onClose={handleSnackbarClose}
                            severity={snackbar.severity}
                            sx={{ width: "100%" }}
                        >
                            {snackbar.message}
                        </Alert>
                    </Snackbar>

                    {isReady &&
                        <Box>
                            <Header
                                handleThemeToggle={handleThemeToggle}
                                darkMode={darkMode}
                            />
                            <Routes>
                                <Route
                                    path="/"
                                    element={<Navigate to="/search" replace />}
                                />
                                <Route
                                    path="/search"
                                    element={
                                        <JsonViewer
                                            gatekeeper={gatekeeper}
                                            setError={setError}
                                        />
                                    }
                                />
                                <Route
                                    path="/events"
                                    element={
                                        <Events
                                            events={events}
                                            eventCount={eventCount}
                                            page={page}
                                            dateFrom={dateFrom}
                                            dateTo={dateTo}
                                            registry={registry}
                                            totalPages={totalPages}
                                            setEventCount={setEventCount}
                                            setPage={setPage}
                                            setRegistry={setRegistry}
                                            setDateFrom={setDateFrom}
                                            setDateTo={setDateTo}
                                            onDidClick={handleViewDid}
                                            setError={setError}
                                        />
                                    }
                                />
                                <Route
                                    path="*"
                                    element={<Typography>404 Not Found</Typography>}
                                />
                            </Routes>
                        </Box>
                    }
                </Box>
            </Box>
        </ThemeProvider>
    );
}

export default App;
