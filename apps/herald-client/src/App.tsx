import React, { useEffect, useState, useRef } from "react";
import {
    useNavigate,
    useParams,
    BrowserRouter as Router,
    Link,
    Routes,
    Route,
} from "react-router-dom";
import { Alert, Avatar, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, TextField, Typography } from '@mui/material';
import { Table, TableBody, TableRow, TableCell } from '@mui/material';
import axios from 'axios';
import { format, differenceInDays } from 'date-fns';
import { QRCodeSVG } from 'qrcode.react';

import './App.css';

const api = axios.create({
    baseURL: import.meta.env.VITE_API_URL || '/api',
    withCredentials: true,
});

interface AuthState {
    isAuthenticated: boolean;
    userDID: string;
    isOwner: boolean;
    profile?: {
        logins?: number;
        name?: string;
        [key: string]: any;
    }
    [key: string]: any;
}

function App() {
    return (
        <Router>
            <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/login" element={<ViewLogin />} />
                <Route path="/logout" element={<ViewLogout />} />
                <Route path="/members" element={<ViewMembers />} />
                <Route path="/owner" element={<ViewOwner />} />
                <Route path="/profile/:did" element={<ViewProfile />} />
                <Route path="/member/:name" element={<ViewMember />} />
                <Route path="/id/:name" element={<ViewIdentity />} />
                <Route path="/directory" element={<ViewDirectory />} />
                <Route path="/credential" element={<ViewCredential />} />
                <Route path="*" element={<NotFound />} />
            </Routes>
        </Router>
    );
}

function buildWalletUrl(walletUrl: string, params: Record<string, string>) {
    try {
        const url = new URL(walletUrl);

        for (const [key, value] of Object.entries(params)) {
            url.searchParams.set(key, value);
        }

        return url.toString();
    }
    catch {
        return null;
    }
}

// Shared by the two member views: `/member/:name` (raw document) and
// `/id/:name` (cards). Both need the same payload plus the service config that
// supplies the handle domain and wallet deep-link base.
function useMemberData(name: string | undefined) {
    const [memberData, setMemberData] = useState<any>(null);
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<string>('');
    const [serviceDomain, setServiceDomain] = useState<string>('');
    const [walletUrl, setWalletUrl] = useState<string>('');

    useEffect(() => {
        const fetchMember = async () => {
            try {
                const configResponse = await api.get('/config');
                setServiceDomain(configResponse.data.serviceDomain);
                setWalletUrl(configResponse.data.walletUrl);

                const response = await api.get(`/member/${name}`);
                setMemberData(response.data);
            }
            catch (err: any) {
                setError(err.response?.data?.error || 'Member not found');
            }
            finally {
                setLoading(false);
            }
        };

        if (name) {
            fetchMember();
        }
    }, [name]);

    return { memberData, loading, error, serviceDomain, walletUrl };
}

// A credential's issuer is a bare DID. When that DID belongs to a member of
// this service the handle is far more informative, so invert the public name
// registry to look it up. A failed fetch is not worth surfacing — the DID is
// still shown, it just stays unresolved.
function useNameByDid() {
    const [nameByDid, setNameByDid] = useState<Record<string, string>>({});

    useEffect(() => {
        const fetchRegistry = async () => {
            try {
                const response = await api.get('/registry');
                const names = response.data?.names || {};
                const inverted: Record<string, string> = {};

                for (const [name, did] of Object.entries(names)) {
                    inverted[did as string] = name;
                }

                setNameByDid(inverted);
            }
            catch {
                setNameByDid({});
            }
        };

        fetchRegistry();
    }, []);

    return nameByDid;
}

function useCopyDid() {
    const [didCopied, setDidCopied] = useState<boolean>(false);

    async function copyDid(text: string) {
        try {
            await navigator.clipboard.writeText(text);
            setDidCopied(true);
        }
        catch (copyError: any) {
            window.alert('Failed to copy text: ' + copyError);
        }
    }

    return { didCopied, copyDid };
}

// A service entry's endpoint is either a plain URI or the DIDComm object form
// carrying routing keys. Everything downstream wants the URI.
function serviceEndpointUri(endpoint: any): string {
    if (typeof endpoint === 'string') {
        return endpoint;
    }

    return endpoint?.uri || '';
}

// Only linkify schemes a browser can actually follow. Anything else (did:, a
// bare host, an unrecognised scheme) renders as text so the page never emits a
// link that silently does nothing.
function isFollowableUri(uri: string): boolean {
    return /^(https?|mailto):/i.test(uri);
}

// Onion endpoints are common in practice (Drawbridge publishes its Lightning
// and DIDComm endpoints over Tor). They are valid but unreachable from an
// ordinary browser, so label them instead of offering a link that just errors.
function isOnionUri(uri: string): boolean {
    try {
        return new URL(uri).hostname.endsWith('.onion');
    }
    catch {
        return false;
    }
}

const SERVICE_LABELS: Record<string, string> = {
    DIDCommMessaging: 'DIDComm Messaging',
    Email: 'Email',
    Lightning: 'Lightning',
};

function serviceLabel(type: string): string {
    return SERVICE_LABELS[type] || type || 'Service';
}

// The fragment identifies the entry within the document (`did:cid:abc#lightning`).
function serviceFragment(id: string): string {
    const hash = (id || '').indexOf('#');
    return hash === -1 ? '' : id.slice(hash);
}

// Naming a credential is best-effort. In practice `type` is often the bare
// ["VerifiableCredential"] and `credentialSchema.id` is an opaque DID, so the
// most specific name usually sits in the subject's own `credentialType` claim.
function credentialType(credential: any): string {
    const claimed = credential?.credentialSubject?.credentialType;

    if (typeof claimed === 'string' && claimed) {
        return claimed;
    }

    const types = Array.isArray(credential?.type) ? credential.type : [];
    const specific = types.filter((type: string) => type !== 'VerifiableCredential');

    return specific.length > 0 ? specific.join(', ') : 'Verifiable Credential';
}

// `credentialSubject` has no fixed shape — it carries whatever the issuer
// asserted. Claims are rendered generically rather than per-schema so a
// credential type this page has never seen still displays its contents.
function humanizeKey(key: string): string {
    const spaced = key
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .trim();

    return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

function formatClaim(value: any): string {
    if (value === null || value === undefined || value === '') {
        return '—';
    }

    if (typeof value === 'boolean') {
        return value ? 'yes' : 'no';
    }

    if (Array.isArray(value)) {
        if (value.length === 0) {
            return 'none';
        }

        return value.every(item => typeof item !== 'object' || item === null)
            ? value.join(', ')
            : JSON.stringify(value);
    }

    if (typeof value === 'object') {
        // One level of nesting reads better inline than as raw JSON.
        return Object.entries(value)
            .map(([key, nested]) => `${humanizeKey(key)}: ${formatClaim(nested)}`)
            .join(' · ');
    }

    // Claims routinely carry ISO timestamps (`registeredAt`, `issuedAt`). Match
    // the full date-time form only — a plain `2026-01-31` is already readable,
    // and parsing it would shift it by the viewer's timezone offset.
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})$/.test(value)) {
        return formatTimestamp(value);
    }

    return String(value);
}

// `id` is the subject DID, which is the member whose page this is, and
// `credentialType` is already shown as the card's title.
const HIDDEN_CLAIMS = ['id', 'credentialType'];

function credentialClaims(credential: any): Array<[string, any]> {
    return Object.entries(credential?.credentialSubject || {})
        .filter(([key]) => !HIDDEN_CLAIMS.includes(key));
}

// Document timestamps come straight from the gatekeeper; render the raw value
// rather than "Invalid Date" if one is ever malformed.
function formatTimestamp(time: string): string {
    const date = new Date(time);

    if (isNaN(date.getTime())) {
        return time;
    }

    return format(date, 'MMM d, yyyy h:mm a');
}

function Card({ title, children, action }: { title: string, children: React.ReactNode, action?: React.ReactNode }) {
    return (
        <Box sx={{
            backgroundColor: '#f8f9fa',
            borderRadius: 2,
            p: 3,
            mb: 3,
            border: '1px solid #e9ecef',
        }}>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, mb: 2 }}>
                <Typography variant="h6" sx={{ m: 0 }}>{title}</Typography>
                {action}
            </Box>
            {children}
        </Box>
    );
}

function Field({ label, value, mono = false }: { label: string, value: React.ReactNode, mono?: boolean }) {
    return (
        <Box sx={{ display: 'flex', gap: 2, py: 0.75, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <Typography variant="body2" sx={{ color: '#666', minWidth: 120, flexShrink: 0 }}>
                {label}
            </Typography>
            <Typography
                variant="body2"
                component="div"
                sx={{
                    wordBreak: 'break-all',
                    ...(mono ? { fontFamily: 'Monaco, Consolas, monospace' } : {}),
                }}
            >
                {value}
            </Typography>
        </Box>
    );
}

function EndpointValue({ uri }: { uri: string }) {
    if (!uri) {
        return <Typography variant="body2" sx={{ color: '#999' }}>none</Typography>;
    }

    if (isOnionUri(uri)) {
        return (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                <span style={{ fontFamily: 'Monaco, Consolas, monospace' }}>{uri}</span>
                <Chip label="Tor" size="small" variant="outlined" />
            </Box>
        );
    }

    if (!isFollowableUri(uri)) {
        return <span style={{ fontFamily: 'Monaco, Consolas, monospace' }}>{uri}</span>;
    }

    return (
        <a
            href={uri}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontFamily: 'Monaco, Consolas, monospace', color: '#1976d2' }}
        >
            {uri}
        </a>
    );
}

function IssuerValue({ issuer, nameByDid, serviceDomain }: { issuer?: string, nameByDid: Record<string, string>, serviceDomain: string }) {
    if (!issuer) {
        return <span>unknown</span>;
    }

    const issuerName = nameByDid[issuer];

    if (!issuerName) {
        return <span style={{ fontFamily: 'Monaco, Consolas, monospace' }}>{issuer}</span>;
    }

    return (
        <Link to={`/id/${issuerName}`} style={{ color: '#1976d2' }}>
            {issuerName}@{serviceDomain}
        </Link>
    );
}

function Header({ title, showTagline = false }: { title: string, showTagline?: boolean }) {
    return (
        <Box
            sx={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 1,
                mb: 3,
            }}
        >
            <Link to="/" style={{ textDecoration: 'none' }}>
                <Typography variant="h3" component="h1" sx={{ fontWeight: 700, color: '#1a1a1a' }}>
                    {title}
                </Typography>
            </Link>
            {showTagline && (
                <Typography variant="subtitle1" sx={{ color: '#666', fontStyle: 'italic' }}>
                    Self-Sovereign Identity for Everyone
                </Typography>
            )}
        </Box>
    )
}

function LoadingShell({ title }: { title: string }) {
    return (
        <div className="App">
            <Header title={title} />
            <Box
                sx={{
                    maxWidth: 720,
                    mx: 'auto',
                    minHeight: 180,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: '#f8f9fa',
                    borderRadius: 2,
                    border: '1px solid #e9ecef',
                }}
            >
                <CircularProgress size={32} />
            </Box>
        </div>
    );
}

function Home() {
    const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
    const [auth, setAuth] = useState<AuthState | null>(null);
    const [userDID, setUserDID] = useState<string>('');
    const [userName, setUserName] = useState<string>('');
    const [logins, setLogins] = useState<number>(0);
    const [publicUrl, setPublicUrl] = useState<string>('');
    const [serviceDomain, setServiceDomain] = useState<string>('');
    const [serviceName, setServiceName] = useState<string>('Name Service');

    const navigate = useNavigate();
    const agentDomain = (() => {
        if (serviceDomain) {
            return serviceDomain;
        }

        try {
            return publicUrl ? new URL(publicUrl).host : 'your-domain.com';
        }
        catch {
            return 'your-domain.com';
        }
    })();

    useEffect(() => {
        const init = async () => {
            try {
                const configResponse = await api.get(`/config`);
                setPublicUrl(configResponse.data.publicUrl);
                setServiceDomain(configResponse.data.serviceDomain);
                setServiceName(configResponse.data.serviceName);

                const response = await api.get(`/check-auth`);
                const auth: AuthState = response.data;
                setAuth(auth);
                setIsAuthenticated(auth.isAuthenticated);
                setUserDID(auth.userDID);

                if (auth.profile) {
                    setLogins(auth.profile.logins || 0);

                    if (auth.profile.name) {
                        setUserName(auth.profile.name);
                    }
                }
            }
            catch (error: any) {
                window.alert(error);
            }
        };

        init();
    }, [navigate]);

    async function login() {
        navigate('/login');
    }

    async function logout() {
        navigate('/logout');
    }

    if (!auth) {
        return (
            <div className="App">
                <Header title={serviceName} showTagline />
            </div>
        )
    }

    return (
        <div className="App">
            <Header title={serviceName} showTagline />

            {isAuthenticated ? (
                <Box sx={{ maxWidth: 600, mx: 'auto', textAlign: 'center' }}>
                    <Box sx={{
                        backgroundColor: '#f8f9fa',
                        borderRadius: 2,
                        p: 3,
                        mb: 3,
                        border: '1px solid #e9ecef'
                    }}>
                        <Typography variant="h5" sx={{ mb: 2, color: '#2c3e50' }}>
                            {logins > 1 ? `Welcome back, ${userName || 'friend'}!` : `Welcome aboard!`}
                        </Typography>

                        {userName ? (
                            <Typography variant="h6" sx={{ color: '#27ae60', fontWeight: 600 }}>
                                🎉 Your handle: <strong>{userName}@{serviceDomain}</strong>
                            </Typography>
                        ) : (
                            <Typography variant="body1" sx={{ color: '#e74c3c' }}>
                                You haven't claimed a name yet! Visit your profile to claim one.
                            </Typography>
                        )}
                    </Box>

                    <Typography variant="body2" sx={{ mb: 2, color: '#666' }}>
                        You have access to:
                    </Typography>

                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, justifyContent: 'center', mb: 3 }}>
                        <Button component={Link} to={`/profile/${userDID}`} variant="outlined" size="small">
                            My Profile
                        </Button>
                        <Button component={Link} to='/credential' variant="outlined" size="small" color="success">
                            My Credential
                        </Button>
                        <Button component={Link} to='/members' variant="outlined" size="small">
                            Members
                        </Button>
                        {auth.isOwner &&
                            <Button component={Link} to='/owner' variant="outlined" size="small">
                                Owner
                            </Button>
                        }
                    </Box>

                    <Button variant="contained" color="error" onClick={logout}>
                        Logout
                    </Button>
                </Box>
            ) : (
                <Box sx={{ maxWidth: 700, mx: 'auto', textAlign: 'center' }}>
                    <Box sx={{
                        backgroundColor: '#f8f9fa',
                        borderRadius: 2,
                        p: 4,
                        mb: 4,
                        border: '1px solid #e9ecef'
                    }}>
                        <Typography variant="h4" sx={{ mb: 2, fontWeight: 600, color: '#2c3e50' }}>
                            Have you named your DID?
                        </Typography>
                        <Typography variant="h6" sx={{ mb: 3, color: '#555', lineHeight: 1.6 }}>
                            Register your free name on the <strong>{serviceName}</strong> identity network.
                        </Typography>
                        <Typography variant="body1" sx={{ mb: 3, color: '#666' }}>
                            🤖 AIs and humans welcome! 🧑‍💻
                        </Typography>
                        <Typography variant="body1" sx={{ color: '#777' }}>
                            Create your self-sovereign digital identity and claim your name.
                            <br />
                            No email required. No passwords. Just your cryptographic identity.
                        </Typography>
                    </Box>

                    <Button
                        variant="contained"
                        color="primary"
                        onClick={login}
                        size="large"
                        sx={{
                            px: 5,
                            py: 1.5,
                            fontSize: '1.1rem',
                            borderRadius: 2,
                            textTransform: 'none',
                            fontWeight: 600
                        }}
                    >
                        Prove Your DID & Claim Your Name
                    </Button>

                    {/* AI Agent Instructions */}
                    <Box sx={{
                        mt: 4,
                        p: 3,
                        backgroundColor: '#1a1a2e',
                        borderRadius: 2,
                        textAlign: 'left'
                    }}>
                        <Typography variant="h6" sx={{ mb: 2, color: '#00d4aa', fontFamily: 'monospace' }}>
                            🤖 AI Agent Quick Start
                        </Typography>
                        <Typography variant="body2" sx={{ color: '#888', mb: 2 }}>
                            First time? Create your DID identity:
                        </Typography>
                        <Typography variant="body2" component="pre" sx={{ color: '#ccc', mb: 2, fontFamily: 'monospace', fontSize: '0.8rem', whiteSpace: 'pre-wrap' }}>
                            {`# Install CLI
npm install -g @didcid/keymaster

# Set up environment
export ARCHON_NODE_URL=https://archon.technology
export ARCHON_PASSPHRASE="your-secret-passphrase"

# Create wallet and identity
keymaster create-id myagent`}
                        </Typography>
                        <Typography variant="body2" sx={{ color: '#888', mb: 2, mt: 3 }}>
                            Then claim your address directly from the CLI:
                        </Typography>
                        <Typography variant="body2" component="pre" sx={{ color: '#ccc', mb: 2, fontFamily: 'monospace', fontSize: '0.8rem', whiteSpace: 'pre-wrap' }}>
                            {`# Check availability
keymaster check-address myagent@${agentDomain}

# Claim your address (credential auto-issued)
keymaster add-address myagent@${agentDomain}

# Later
keymaster list-addresses
keymaster remove-address myagent@${agentDomain}`}
                        </Typography>
                        <Typography variant="body2" sx={{ color: '#888', mb: 2 }}>
                            The lower-level HTTP API is still available for direct integrations and debugging.
                        </Typography>
                        <Typography variant="body2" sx={{ color: '#888', mt: 2 }}>
                            MCP Server: <a href="https://www.npmjs.com/package/@didcid/mcp-server" target="_blank" rel="noopener noreferrer" style={{ color: '#00d4aa' }}>@didcid/mcp-server</a>
                            {' • '}
                            Keymaster: <a href="https://www.npmjs.com/package/@didcid/keymaster" target="_blank" rel="noopener noreferrer" style={{ color: '#00d4aa' }}>@didcid/keymaster</a>
                        </Typography>
                    </Box>

                    <Box sx={{ mt: 4, pt: 3, borderTop: '1px solid #e9ecef' }}>
                        <Typography variant="body2" sx={{ color: '#888' }}>
                            Powered by <a href="https://archon.technology" target="_blank" rel="noopener noreferrer" style={{ color: '#3498db' }}>Archon Protocol</a>
                            {' • '}
                            <a href="/directory.json" target="_blank" rel="noopener noreferrer" style={{ color: '#3498db' }}>View Directory</a>
                            {' • '}
                            {publicUrl && <a href={`https://ipfs.io/ipns/${new URL(publicUrl).host}`} target="_blank" rel="noopener noreferrer" style={{ color: '#3498db' }}>IPNS Registry</a>}
                        </Typography>
                    </Box>
                </Box>
            )}
        </div>
    )
}

function ViewLogin() {
    const [challengeDID, setChallengeDID] = useState<string>('');
    const [challengeURL, setChallengeURL] = useState<string | null>(null);
    const [challengeCopied, setChallengeCopied] = useState<boolean>(false);

    const navigate = useNavigate();
    const intervalIdRef = useRef<number | null>(null);

    useEffect(() => {
        const init = async () => {
            try {
                intervalIdRef.current = window.setInterval(async () => {
                    try {
                        const response = await api.get(`/check-auth`);
                        if (response.data.isAuthenticated) {
                            if (intervalIdRef.current) {
                                clearInterval(intervalIdRef.current);
                            }
                            navigate('/');
                        }
                    } catch (error: any) {
                        console.error('Failed to check authentication:', error);
                    }
                }, 1000); // Check every second

                const response = await api.get(`/challenge`);
                const { challenge, challengeURL } = response.data;
                setChallengeDID(challenge);
                setChallengeURL(encodeURI(challengeURL));
            }
            catch (error: any) {
                window.alert(error);
            }
        };

        init();
        // Clear the interval when the component is unmounted
        return () => {
            if (intervalIdRef.current) {
                clearInterval(intervalIdRef.current);
            }
        }
    }, [navigate]);

    async function copyToClipboard(text: string) {
        try {
            await navigator.clipboard.writeText(text);
            setChallengeCopied(true);
        }
        catch (error: any) {
            window.alert('Failed to copy text: ' + error);
        }
    }

    function cancelLogin() {
        navigate('/');
    }

    return (
        <Box
            sx={{
                minHeight: '100vh',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'radial-gradient(circle at top, #f5f8ff 0%, #eef2f8 45%, #e8edf5 100%)',
                p: 2,
            }}
        >
            <Dialog
                open
                onClose={cancelLogin}
                maxWidth="xs"
                fullWidth
                PaperProps={{
                    sx: {
                        borderRadius: 3,
                        px: 1,
                        py: 1.5,
                    },
                }}
            >
                <DialogContent sx={{ textAlign: 'center', pt: 2 }}>
                    <Typography variant="h4" component="h1" sx={{ fontWeight: 700, mb: 1.5 }}>
                        Login
                    </Typography>
                    <Typography variant="body2" sx={{ color: '#666', mb: 3 }}>
                        Scan with Archon Wallet to continue.
                    </Typography>
                    {challengeURL && (
                        <Box
                            component="a"
                            href={challengeURL}
                            target="_blank"
                            rel="noopener noreferrer"
                            sx={{
                                display: 'inline-flex',
                                p: 2,
                                borderRadius: 2,
                                backgroundColor: '#fff',
                                border: '1px solid #e5e7eb',
                                boxShadow: '0 12px 30px rgba(15, 23, 42, 0.08)',
                            }}
                        >
                            <QRCodeSVG value={challengeURL} />
                        </Box>
                    )}
                </DialogContent>
                <DialogActions sx={{ justifyContent: 'center', gap: 1, pb: 3 }}>
                    <Button variant="outlined" onClick={() => copyToClipboard(challengeDID)} disabled={challengeCopied}>
                        {challengeCopied ? 'Copied' : 'Copy'}
                    </Button>
                    <Button variant="text" color="inherit" onClick={cancelLogin}>
                        Cancel
                    </Button>
                </DialogActions>
            </Dialog>
        </Box>
    )
}

function ViewLogout() {
    const navigate = useNavigate();

    useEffect(() => {
        const init = async () => {
            try {
                await api.post(`/logout`);
                navigate('/');
            }
            catch (error: any) {
                window.alert('Failed to logout: ' + error);
            }
        };

        init();
    }, [navigate]);

    return null;
}

interface DirectoryEntry {
    name: string;
    did: string;
}

function ViewMembers() {
    const [directory, setDirectory] = useState<DirectoryEntry[]>([]);
    const [loading, setLoading] = useState<boolean>(true);
    const [lastUpdated, setLastUpdated] = useState<string>('');
    const [serviceDomain, setServiceDomain] = useState<string>('');
    const navigate = useNavigate();

    useEffect(() => {
        const init = async () => {
            try {
                const configResponse = await api.get(`/config`);
                setServiceDomain(configResponse.data.serviceDomain);

                const authResponse = await api.get(`/check-auth`);
                const auth = authResponse.data;

                if (!auth.isAuthenticated) {
                    navigate('/');
                    return;
                }

                // Fetch directory
                const dirResponse = await api.get(`/registry`);
                const data = dirResponse.data;

                setLastUpdated(data.updated || '');

                // Convert names object to array for easier rendering
                const entries: DirectoryEntry[] = Object.entries(data.names || {}).map(
                    ([name, did]) => ({ name, did: did as string })
                );

                // Sort alphabetically by name
                entries.sort((a, b) => a.name.localeCompare(b.name));
                setDirectory(entries);
            }
            catch (error: any) {
                console.error(error);
                navigate('/');
            }
            finally {
                setLoading(false);
            }
        };

        init();
    }, [navigate]);

    if (loading) {
        return <LoadingShell title="Member Directory" />;
    }

    return (
        <div className="App">
            <Header title="Member Directory" />

            <Box sx={{ maxWidth: 800, mx: 'auto' }}>
                <Box sx={{ mb: 3, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Typography variant="body2" sx={{ color: '#666' }}>
                        {directory.length} registered {directory.length === 1 ? 'member' : 'members'}
                    </Typography>
                    {lastUpdated && (
                        <Typography variant="body2" sx={{ color: '#888' }}>
                            Last updated: {format(new Date(lastUpdated), 'MMM d, yyyy h:mm a')}
                        </Typography>
                    )}
                </Box>

                <Table sx={{ backgroundColor: '#fff', borderRadius: 2, overflow: 'hidden' }}>
                    <TableBody>
                        {directory.map((entry) => (
                            <TableRow
                                key={entry.did}
                                sx={{
                                    '&:hover': { backgroundColor: '#f8f9fa' },
                                    cursor: 'pointer'
                                }}
                                onClick={() => navigate(`/profile/${entry.did}`)}
                            >
                                <TableCell sx={{ fontWeight: 600, fontSize: '1.1rem', color: '#2c3e50' }}>
                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                                        <Avatar
                                            src={`${api.defaults.baseURL}/name/${entry.name}/avatar`}
                                            alt={entry.name}
                                            sx={{ width: 36, height: 36 }}
                                        >
                                            {entry.name[0]?.toUpperCase()}
                                        </Avatar>
                                        {entry.name}@{serviceDomain}
                                    </Box>
                                </TableCell>
                                <TableCell sx={{ color: '#666', fontFamily: 'monospace', fontSize: '0.85rem' }}>
                                    {entry.did.substring(0, 20)}...{entry.did.substring(entry.did.length - 8)}
                                </TableCell>
                                <TableCell align="right">
                                    <Button
                                        component={Link}
                                        to={`/member/${entry.name}`}
                                        size="small"
                                        variant="outlined"
                                        onClick={(e) => e.stopPropagation()}
                                    >
                                        View Details
                                    </Button>
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>

                <Box sx={{ mt: 3, textAlign: 'center' }}>
                    <Button component={Link} to="/" variant="text">
                        ← Back to Home
                    </Button>
                </Box>
            </Box>
        </div>
    )
}

// The public directory. `/members` covers the same ground but gates on
// `/check-auth` and bounces anonymous visitors home, so it cannot be linked to
// from a public identity page. Every endpoint used here is unauthenticated.
function ViewDirectory() {
    const [directory, setDirectory] = useState<DirectoryEntry[]>([]);
    const [lastUpdated, setLastUpdated] = useState<string>('');
    const [serviceDomain, setServiceDomain] = useState<string>('');
    const [serviceName, setServiceName] = useState<string>('Directory');
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<string>('');

    useEffect(() => {
        const fetchDirectory = async () => {
            try {
                const configResponse = await api.get('/config');
                setServiceDomain(configResponse.data.serviceDomain);
                setServiceName(configResponse.data.serviceName || 'Directory');

                const registryResponse = await api.get('/registry');
                setLastUpdated(registryResponse.data.updated || '');

                const entries: DirectoryEntry[] = Object.entries(registryResponse.data.names || {})
                    .map(([name, did]) => ({ name, did: did as string }));

                entries.sort((a, b) => a.name.localeCompare(b.name));
                setDirectory(entries);
            }
            catch (err: any) {
                setError(err.response?.data?.error || 'Directory unavailable');
            }
            finally {
                setLoading(false);
            }
        };

        fetchDirectory();
    }, []);

    if (loading) {
        return <LoadingShell title="Directory" />;
    }

    if (error) {
        return (
            <div className="App">
                <Header title="Directory" />
                <Box sx={{ maxWidth: 600, mx: 'auto', textAlign: 'center' }}>
                    <Typography variant="h6" sx={{ color: '#e74c3c', mb: 2 }}>
                        {error}
                    </Typography>
                    <Button component={Link} to="/" variant="outlined">
                        ← Back to Home
                    </Button>
                </Box>
            </div>
        );
    }

    return (
        <div className="App">
            <Header title="Directory" />

            <Box sx={{ maxWidth: 800, mx: 'auto' }}>
                <Box sx={{ mb: 3, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
                    <Typography variant="body2" sx={{ color: '#666' }}>
                        {directory.length} registered {directory.length === 1 ? 'identity' : 'identities'} on {serviceName}
                    </Typography>
                    {lastUpdated && (
                        <Typography variant="body2" sx={{ color: '#888' }}>
                            Last updated: {formatTimestamp(lastUpdated)}
                        </Typography>
                    )}
                </Box>

                {directory.length === 0 ? (
                    <Box sx={{
                        backgroundColor: '#f8f9fa',
                        borderRadius: 2,
                        p: 4,
                        border: '1px solid #e9ecef',
                        textAlign: 'center',
                    }}>
                        <Typography variant="body1" sx={{ color: '#666' }}>
                            No names have been registered yet.
                        </Typography>
                    </Box>
                ) : (
                    <Table sx={{ backgroundColor: '#fff', borderRadius: 2, overflow: 'hidden' }}>
                        <TableBody>
                            {directory.map((entry) => (
                                <TableRow key={entry.did} sx={{ '&:hover': { backgroundColor: '#f8f9fa' } }}>
                                    <TableCell sx={{ fontWeight: 600, fontSize: '1.1rem', color: '#2c3e50' }}>
                                        <Link
                                            to={`/id/${entry.name}`}
                                            style={{ textDecoration: 'none', color: 'inherit' }}
                                        >
                                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                                                <Avatar
                                                    src={`${api.defaults.baseURL}/name/${entry.name}/avatar`}
                                                    alt={entry.name}
                                                    sx={{ width: 36, height: 36 }}
                                                >
                                                    {entry.name[0]?.toUpperCase()}
                                                </Avatar>
                                                {entry.name}@{serviceDomain}
                                            </Box>
                                        </Link>
                                    </TableCell>
                                    <TableCell sx={{ color: '#666', fontFamily: 'monospace', fontSize: '0.85rem' }}>
                                        {entry.did.substring(0, 20)}...{entry.did.substring(entry.did.length - 8)}
                                    </TableCell>
                                    <TableCell align="right">
                                        <Button
                                            component={Link}
                                            to={`/id/${entry.name}`}
                                            size="small"
                                            variant="outlined"
                                        >
                                            View Identity
                                        </Button>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                )}

                <Box sx={{ mt: 3, textAlign: 'center' }}>
                    <Button component={Link} to="/" variant="text">
                        ← Back to Home
                    </Button>
                </Box>
            </Box>
        </div>
    );
}

function ViewOwner() {
    const [adminInfo, setAdminInfo] = useState<any>(null);
    const [publishing, setPublishing] = useState(false);
    const [publishResult, setPublishResult] = useState<any>(null);
    const [error, setError] = useState('');
    const navigate = useNavigate();

    useEffect(() => {
        const init = async () => {
            try {
                const response = await api.get(`/admin`);
                setAdminInfo(response.data);
            }
            catch (error: any) {
                navigate('/');
            }
        };

        init();
    }, [navigate]);

    const publishToIPNS = async () => {
        setPublishing(true);
        setError('');
        setPublishResult(null);
        try {
            const response = await api.post('/admin/publish');
            setPublishResult(response.data);
        } catch (err: any) {
            setError(err.response?.data?.error || 'Failed to publish');
        } finally {
            setPublishing(false);
        }
    };

    return (
        <div className="App">
            <Header title="Owner Area" />
            <Box sx={{ maxWidth: 600, mx: 'auto', p: 3 }}>
                <Typography variant="h6" gutterBottom>Registry Management</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                    Publish the name registry to IPNS for decentralized resolution.
                </Typography>

                <Button
                    variant="contained"
                    onClick={publishToIPNS}
                    disabled={publishing}
                    sx={{ mb: 2 }}
                >
                    {publishing ? 'Publishing...' : 'Publish to IPNS'}
                </Button>

                {error && (
                    <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>
                )}

                {publishResult && (
                    <Alert severity="success" sx={{ mb: 2 }}>
                        <Typography variant="body2">
                            <strong>Published successfully!</strong><br />
                            CID: {publishResult.cid}<br />
                            IPNS: {publishResult.ipns}
                        </Typography>
                    </Alert>
                )}
            </Box>

            <Box sx={{ maxWidth: 800, mx: 'auto', p: 3 }}>
                <Typography variant="h6" gutterBottom>Database</Typography>
                <pre style={{ textAlign: 'left', overflow: 'auto' }}>{JSON.stringify(adminInfo, null, 4)}</pre>
            </Box>
        </div>
    )
}

function ViewProfile() {
    const { did } = useParams();
    const navigate = useNavigate();
    const [profile, setProfile] = useState<any>(null);
    const [currentName, setCurrentName] = useState<string>("");
    const [newName, setNewName] = useState<string>("");
    const [nameError, setNameError] = useState<string>("");
    const [nameAvailable, setNameAvailable] = useState<boolean | null>(null);

    useEffect(() => {
        const init = async () => {
            try {
                await api.get(`/check-auth`);

                const getProfile = await api.get(`/profile/${did}`);
                const profile = getProfile.data;

                setProfile(profile);

                if (profile.name) {
                    setCurrentName(profile.name);
                    setNewName(profile.name);
                }

            }
            catch (error: any) {
                navigate('/');
            }
        };

        init();
    }, [did, navigate]);

    async function saveName() {
        setNameError('');
        try {
            const name = newName.trim();
            await api.put(`/profile/${profile.did}/name`, { name });
            setNewName(name);
            setCurrentName(name);
            profile.name = name;
        }
        catch (error: any) {
            const message = error.response?.data?.message || error.response?.data?.error || 'Failed to save name';
            setNameError(message);
        }
    }

    async function deleteName() {
        if (!window.confirm(`Delete name '${currentName}'? This will also revoke your credential.`)) {
            return;
        }
        setNameError('');
        try {
            await api.delete(`/profile/${profile.did}/name`);
            setCurrentName('');
            setNewName('');
            profile.name = '';
        }
        catch (error: any) {
            const message = error.response?.data?.message || error.response?.data?.error || 'Failed to delete name';
            setNameError(message);
        }
    }

    async function checkName() {
        setNameError('');
        setNameAvailable(null);
        try {
            const name = newName.trim().toLowerCase();
            await api.get(`/name/${name}`);
            setNameAvailable(false);
            setNameError('Name already taken');
        }
        catch (error: any) {
            if (error.response?.status === 404) {
                setNameAvailable(true);
            } else {
                setNameError('Failed to check name');
            }
        }
    }

    function formatDate(time: string) {
        const date = new Date(time);
        const now = new Date();
        const days = differenceInDays(now, date);

        return `${format(date, 'yyyy-MM-dd HH:mm:ss')} (${days} days ago)`;
    }

    if (!profile) {
        return (
            <div className="App">
                <Header title="Profile" />
                <p>Loading...</p>
            </div>
        )
    }

    return (
        <div className="App">
            <Header title="Profile" />
            <Box sx={{ maxWidth: 800, mx: 'auto' }}>
                <Table sx={{ width: '100%' }}>
                    <TableBody>
                        <TableRow>
                            <TableCell>DID:</TableCell>
                            <TableCell>
                                <Typography style={{ fontFamily: 'Courier' }}>
                                    {profile.did}
                                </Typography>
                            </TableCell>
                        </TableRow>
                        <TableRow>
                            <TableCell>First login:</TableCell>
                            <TableCell>{formatDate(profile.firstLogin)}</TableCell>
                        </TableRow>
                        <TableRow>
                            <TableCell>Last login:</TableCell>
                            <TableCell>{formatDate(profile.lastLogin)}</TableCell>
                        </TableRow>
                        <TableRow>
                            <TableCell>Login count:</TableCell>
                            <TableCell>{profile.logins}</TableCell>
                        </TableRow>
                        <TableRow>
                            <TableCell>Name:</TableCell>
                            <TableCell>
                                {profile.isUser ? (
                                    <>
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                                            <TextField
                                                label=""
                                                value={newName}
                                                onChange={(e) => { setNewName(e.target.value); setNameError(''); setNameAvailable(null); }}
                                                slotProps={{
                                                    htmlInput: {
                                                        maxLength: 32,
                                                    },
                                                }}
                                                sx={{ width: 300 }}
                                                margin="normal"
                                                fullWidth
                                            />
                                            <Button
                                                variant="outlined"
                                                onClick={checkName}
                                                disabled={!newName.trim() || newName === currentName}
                                            >
                                                Check
                                            </Button>
                                            <Button
                                                variant="outlined"
                                                color="primary"
                                                onClick={saveName}
                                                disabled={newName === currentName}
                                            >
                                                Save
                                            </Button>
                                            {currentName && (
                                                <Button
                                                    variant="outlined"
                                                    color="error"
                                                    onClick={deleteName}
                                                >
                                                    Delete
                                                </Button>
                                            )}
                                        </Box>
                                        {nameError && (
                                            <Alert severity="error" sx={{ mt: 1 }}>{nameError}</Alert>
                                        )}
                                        {nameAvailable && (
                                            <Alert severity="success" sx={{ mt: 1 }}>Name is available!</Alert>
                                        )}
                                    </>
                                ) : (
                                    currentName
                                )}
                            </TableCell>
                        </TableRow>
                    </TableBody>
                </Table>
                <Box sx={{ mt: 3 }}>
                    <Button component={Link} to="/" variant="outlined">
                        ← Back to Home
                    </Button>
                </Box>
            </Box>
        </div>
    )
}

function ViewCredential() {
    const [credentialData, setCredentialData] = useState<any>(null);
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<string>('');
    const [walletUrl, setWalletUrl] = useState<string>('');
    const [credentialDidCopied, setCredentialDidCopied] = useState<boolean>(false);
    const navigate = useNavigate();

    useEffect(() => {
        const fetchCredential = async () => {
            try {
                const configResponse = await api.get('/config');
                setWalletUrl(configResponse.data.walletUrl);

                const response = await api.get('/credential');
                setCredentialData(response.data);
            }
            catch (err: any) {
                if (err.response?.status === 401) {
                    navigate('/login');
                } else {
                    setError(err.response?.data?.error || 'Failed to fetch credential');
                }
            }
            finally {
                setLoading(false);
            }
        };

        fetchCredential();
    }, [navigate]);

    const credentialWalletUrl = credentialData?.credentialDid && walletUrl
        ? buildWalletUrl(walletUrl, { credential: credentialData.credentialDid })
        : null;

    async function copyCredentialDid(text: string) {
        try {
            await navigator.clipboard.writeText(text);
            setCredentialDidCopied(true);
        }
        catch (copyError: any) {
            window.alert('Failed to copy text: ' + copyError);
        }
    }

    if (loading) {
        return <LoadingShell title="My Credential" />;
    }

    return (
        <div className="App">
            <Header title="My Credential" />

            <Box sx={{ maxWidth: 800, mx: 'auto' }}>
                {error && (
                    <Box sx={{
                        backgroundColor: '#fee',
                        border: '1px solid #fcc',
                        borderRadius: 2,
                        p: 2,
                        mb: 3
                    }}>
                        <Typography color="error">{error}</Typography>
                    </Box>
                )}

                {!credentialData?.hasCredential ? (
                    <Box sx={{
                        backgroundColor: '#f8f9fa',
                        borderRadius: 2,
                        p: 4,
                        textAlign: 'center',
                        border: '1px solid #e9ecef'
                    }}>
                        <Typography variant="h5" sx={{ mb: 2, color: '#2c3e50' }}>
                            No Credential Yet
                        </Typography>
                        <Typography variant="body1" sx={{ mb: 3, color: '#666' }}>
                            Set a name on your profile to automatically receive a verifiable credential.
                        </Typography>
                        <Button component={Link} to={`/profile/${credentialData?.did || ''}`} variant="outlined">
                            Go to Profile
                        </Button>
                    </Box>
                ) : (
                    <Box>
                        <Box sx={{
                            backgroundColor: '#e8f5e9',
                            borderRadius: 2,
                            p: 3,
                            mb: 3,
                            border: '1px solid #c8e6c9',
                            textAlign: 'center'
                        }}>
                            <Typography variant="h5" sx={{ color: '#2e7d32', mb: 1 }}>
                                ✓ Verified Name Credential
                            </Typography>
                            <Typography variant="h4" sx={{ fontWeight: 600, color: '#1b5e20' }}>
                                {credentialData.credential?.credentialSubject?.name || 'Unknown'}
                            </Typography>
                            <Typography variant="body2" sx={{ color: '#666', mt: 1 }}>
                                Issued: {credentialData.credentialIssuedAt ?
                                    format(new Date(credentialData.credentialIssuedAt), 'MMM d, yyyy h:mm a') :
                                    'Unknown'}
                            </Typography>
                        </Box>

                        <Typography variant="h6" sx={{ mb: 2 }}>Credential DID</Typography>
                        <Box
                            sx={{
                                backgroundColor: '#f5f5f5',
                                p: 2,
                                borderRadius: 1,
                                mb: 3,
                                textAlign: 'center',
                            }}
                        >
                            <a href={credentialWalletUrl || '#'} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}>
                                <QRCodeSVG value={credentialWalletUrl || credentialData.credentialDid} />
                            </a>
                            <Typography
                                variant="body2"
                                sx={{
                                    fontFamily: 'monospace',
                                    wordBreak: 'break-all',
                                    mt: 2,
                                    color: '#666',
                                }}
                            >
                                {credentialData.credentialDid}
                            </Typography>
                            <Button
                                variant="outlined"
                                size="small"
                                sx={{ mt: 1.5, textTransform: 'none' }}
                                onClick={() => copyCredentialDid(credentialData.credentialDid)}
                                disabled={credentialDidCopied}
                            >
                                {credentialDidCopied ? 'Copied' : 'Copy DID'}
                            </Button>
                        </Box>

                        <Typography variant="h6" sx={{ mb: 2 }}>Verifiable Credential</Typography>
                        <Box sx={{
                            backgroundColor: '#1e1e1e',
                            borderRadius: 2,
                            p: 2,
                            overflow: 'auto',
                            maxHeight: 400
                        }}>
                            <pre style={{
                                color: '#d4d4d4',
                                margin: 0,
                                fontSize: '0.8rem',
                                fontFamily: 'Monaco, Consolas, monospace'
                            }}>
                                {JSON.stringify(credentialData.credential, null, 2)}
                            </pre>
                        </Box>
                    </Box>
                )}

                <Box sx={{ mt: 3, textAlign: 'center' }}>
                    <Button component={Link} to="/" variant="text">
                        ← Back to Home
                    </Button>
                </Box>
            </Box>
        </div>
    );
}

function ViewMember() {
    const { name } = useParams<{ name: string }>();
    const { memberData, loading, error, serviceDomain, walletUrl } = useMemberData(name);
    const { didCopied, copyDid } = useCopyDid();

    if (loading) {
        return <LoadingShell title={`${name}@${serviceDomain}`} />;
    }

    if (error) {
        return (
            <div className="App">
                <Header title="Member Not Found" />
                <Box sx={{ maxWidth: 600, mx: 'auto', textAlign: 'center' }}>
                    <Typography variant="h6" sx={{ color: '#e74c3c', mb: 2 }}>
                        {error}
                    </Typography>
                    <Button component={Link} to="/members" variant="outlined">
                        ← Back to Directory
                    </Button>
                </Box>
            </div>
        );
    }

    const aliasWalletUrl = memberData?.didDocument?.id && walletUrl
        ? buildWalletUrl(walletUrl, {
            alias: `${name}@${serviceDomain}`,
            did: memberData.didDocument.id,
        })
        : null;

    return (
        <div className="App">
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2, mb: 3 }}>
                <Avatar
                    src={`${api.defaults.baseURL}/name/${name}/avatar`}
                    alt={name}
                    sx={{ width: 64, height: 64, fontSize: '1.75rem' }}
                >
                    {name?.[0]?.toUpperCase()}
                </Avatar>
                <Link to="/" style={{ textDecoration: 'none' }}>
                    <Typography variant="h3" component="h1" sx={{ fontWeight: 700, color: '#1a1a1a' }}>
                        {name}@{serviceDomain}
                    </Typography>
                </Link>
            </Box>

            <Box sx={{ maxWidth: 800, mx: 'auto' }}>
                <Box sx={{
                    backgroundColor: '#f8f9fa',
                    borderRadius: 2,
                    p: 3,
                    mb: 3,
                    border: '1px solid #e9ecef',
                    textAlign: 'center'
                }}>
                    {memberData?.didDocument?.id && aliasWalletUrl && (
                        <Box>
                            <a href={aliasWalletUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}>
                                <QRCodeSVG value={aliasWalletUrl} />
                            </a>
                            <Typography variant="body1" sx={{ fontFamily: 'monospace', color: '#666', wordBreak: 'break-all', mt: 2 }}>
                                {memberData.didDocument.id}
                            </Typography>
                            <Button
                                variant="outlined"
                                size="small"
                                sx={{ mt: 1.5, textTransform: 'none' }}
                                onClick={() => copyDid(memberData.didDocument.id)}
                                disabled={didCopied}
                            >
                                {didCopied ? 'Copied' : 'Copy DID'}
                            </Button>
                        </Box>
                    )}
                </Box>

                <Typography variant="h6" sx={{ mb: 2 }}>DID Document</Typography>

                <Box sx={{
                    backgroundColor: '#1e1e1e',
                    borderRadius: 2,
                    p: 2,
                    overflow: 'auto'
                }}>
                    <pre style={{
                        color: '#d4d4d4',
                        margin: 0,
                        fontSize: '0.85rem',
                        fontFamily: 'Monaco, Consolas, monospace'
                    }}>
                        {JSON.stringify(memberData, null, 2)}
                    </pre>
                </Box>

                <Box sx={{ mt: 3, display: 'flex', gap: 2, justifyContent: 'center' }}>
                    <Button component={Link} to="/members" variant="outlined">
                        ← Back to Directory
                    </Button>
                    <Button
                        component="a"
                        href={`https://explorer.archon.technology/search?did=${memberData?.id}`}
                        target="_blank"
                        variant="outlined"
                    >
                        View on Archon Explorer
                    </Button>
                </Box>
            </Box>
        </div>
    );
}

// Card-based rendering of the same payload `/member/:name` shows as raw JSON.
// The two pages are deliberately parallel: this one is the readable surface,
// `/member/:name` remains the transparency/audit view, and each links to the other.
function ViewIdentity() {
    const { name } = useParams<{ name: string }>();
    const { memberData, loading, error, serviceDomain, walletUrl } = useMemberData(name);
    const { didCopied, copyDid } = useCopyDid();
    const nameByDid = useNameByDid();

    if (loading) {
        return <LoadingShell title={`${name}@${serviceDomain}`} />;
    }

    if (error) {
        return (
            <div className="App">
                <Header title="Identity Not Found" />
                <Box sx={{ maxWidth: 600, mx: 'auto', textAlign: 'center' }}>
                    <Typography variant="h6" sx={{ color: '#e74c3c', mb: 2 }}>
                        {error}
                    </Typography>
                    <Button component={Link} to="/directory" variant="outlined">
                        ← Back to Directory
                    </Button>
                </Box>
            </div>
        );
    }

    const didDocument = memberData?.didDocument || {};
    const metadata = memberData?.didDocumentMetadata || {};
    const registration = memberData?.didDocumentRegistration || {};
    const did = didDocument.id || '';
    const services = didDocument.service || [];
    const verificationMethods = didDocument.verificationMethod || [];
    const documentData = memberData?.didDocumentData || {};
    // The manifest is a map of credential DID -> verifiable credential.
    const credentials = Object.entries(documentData.manifest || {});
    const nostr = documentData.nostr;

    const aliasWalletUrl = did && walletUrl
        ? buildWalletUrl(walletUrl, {
            alias: `${name}@${serviceDomain}`,
            did,
        })
        : null;

    return (
        <div className="App">
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2, mb: 3 }}>
                <Avatar
                    src={`${api.defaults.baseURL}/name/${name}/avatar`}
                    alt={name}
                    sx={{ width: 64, height: 64, fontSize: '1.75rem' }}
                >
                    {name?.[0]?.toUpperCase()}
                </Avatar>
                <Link to="/" style={{ textDecoration: 'none' }}>
                    <Typography variant="h3" component="h1" sx={{ fontWeight: 700, color: '#1a1a1a' }}>
                        {name}@{serviceDomain}
                    </Typography>
                </Link>
            </Box>

            <Box sx={{ maxWidth: 800, mx: 'auto' }}>
                <Box sx={{
                    backgroundColor: '#f8f9fa',
                    borderRadius: 2,
                    p: 3,
                    mb: 3,
                    border: '1px solid #e9ecef',
                    textAlign: 'center'
                }}>
                    {did && aliasWalletUrl && (
                        <Box>
                            <a href={aliasWalletUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}>
                                <QRCodeSVG value={aliasWalletUrl} />
                            </a>
                        </Box>
                    )}
                    {did && (
                        <Box>
                            <Typography variant="body1" sx={{ fontFamily: 'monospace', color: '#666', wordBreak: 'break-all', mt: 2 }}>
                                {did}
                            </Typography>
                            <Button
                                variant="outlined"
                                size="small"
                                sx={{ mt: 1.5, textTransform: 'none' }}
                                onClick={() => copyDid(did)}
                                disabled={didCopied}
                            >
                                {didCopied ? 'Copied' : 'Copy DID'}
                            </Button>
                        </Box>
                    )}
                </Box>

                <Card
                    title="Service Endpoints"
                    action={<Chip label={services.length} size="small" variant="outlined" />}
                >
                    {services.length === 0 ? (
                        <Typography variant="body2" sx={{ color: '#666' }}>
                            This identity publishes no service endpoints.
                        </Typography>
                    ) : (
                        services.map((service: any, index: number) => {
                            const endpoint = service.serviceEndpoint;
                            const uri = serviceEndpointUri(endpoint);
                            const routingKeys = typeof endpoint === 'object' ? endpoint?.routingKeys || [] : [];
                            const accept = typeof endpoint === 'object' ? endpoint?.accept || [] : [];

                            return (
                                <Box
                                    key={service.id || index}
                                    sx={{
                                        backgroundColor: '#fff',
                                        borderRadius: 1,
                                        border: '1px solid #e9ecef',
                                        p: 2,
                                        mb: index === services.length - 1 ? 0 : 2,
                                    }}
                                >
                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1, flexWrap: 'wrap' }}>
                                        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                                            {serviceLabel(service.type)}
                                        </Typography>
                                        {serviceFragment(service.id) && (
                                            <Chip
                                                label={serviceFragment(service.id)}
                                                size="small"
                                                variant="outlined"
                                                sx={{ fontFamily: 'Monaco, Consolas, monospace' }}
                                            />
                                        )}
                                    </Box>
                                    <Field label="Endpoint" value={<EndpointValue uri={uri} />} />
                                    {accept.length > 0 && (
                                        <Field label="Accepts" value={accept.join(', ')} mono />
                                    )}
                                    {routingKeys.length > 0 && (
                                        <Field
                                            label="Routing keys"
                                            value={routingKeys.map((key: string) => (
                                                <Box key={key} sx={{ fontFamily: 'Monaco, Consolas, monospace' }}>{key}</Box>
                                            ))}
                                        />
                                    )}
                                </Box>
                            );
                        })
                    )}
                </Card>

                <Card
                    title="Keys"
                    action={<Chip label={verificationMethods.length} size="small" variant="outlined" />}
                >
                    {verificationMethods.length === 0 ? (
                        <Typography variant="body2" sx={{ color: '#666' }}>
                            No verification methods published.
                        </Typography>
                    ) : (
                        verificationMethods.map((method: any, index: number) => (
                            <Box key={method.id || index} sx={{ mb: index === verificationMethods.length - 1 ? 0 : 2 }}>
                                <Field label="Method" value={serviceFragment(method.id) || method.id} mono />
                                <Field label="Type" value={method.type || 'unknown'} />
                                {method.publicKeyJwk?.crv && (
                                    <Field label="Curve" value={method.publicKeyJwk.crv} mono />
                                )}
                            </Box>
                        ))
                    )}
                </Card>

                {credentials.length > 0 && (
                    <Card
                        title="Credentials"
                        action={<Chip label={credentials.length} size="small" variant="outlined" />}
                    >
                        {credentials.map(([credentialDid, credential]: [string, any], index: number) => (
                            <Box
                                key={credentialDid}
                                sx={{
                                    backgroundColor: '#fff',
                                    borderRadius: 1,
                                    border: '1px solid #e9ecef',
                                    p: 2,
                                    mb: index === credentials.length - 1 ? 0 : 2,
                                }}
                            >
                                <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>
                                    {credentialType(credential)}
                                </Typography>

                                {credentialClaims(credential).map(([key, value]) => (
                                    <Field key={key} label={humanizeKey(key)} value={formatClaim(value)} />
                                ))}

                                <Box sx={{ borderTop: '1px solid #e9ecef', mt: 1.5, pt: 1.5 }}>
                                    <Field
                                        label="Issued by"
                                        value={<IssuerValue issuer={credential?.issuer} nameByDid={nameByDid} serviceDomain={serviceDomain} />}
                                    />
                                    {credential?.validFrom && (
                                        <Field label="Issued" value={formatTimestamp(credential.validFrom)} />
                                    )}
                                    {credential?.validUntil && (
                                        <Field label="Expires" value={formatTimestamp(credential.validUntil)} />
                                    )}
                                </Box>
                            </Box>
                        ))}
                    </Card>
                )}

                {nostr?.npub && (
                    <Card title="Nostr">
                        <Field label="npub" value={nostr.npub} mono />
                    </Card>
                )}

                <Card title="Document">
                    {didDocument.controller && (
                        <Field label="Controller" value={didDocument.controller} mono />
                    )}
                    {registration.registry && (
                        <Field label="Registry" value={registration.registry} />
                    )}
                    {metadata.created && (
                        <Field label="Created" value={formatTimestamp(metadata.created)} />
                    )}
                    {metadata.updated && (
                        <Field label="Updated" value={formatTimestamp(metadata.updated)} />
                    )}
                    {metadata.version !== undefined && (
                        <Field label="Version" value={metadata.version} />
                    )}
                    <Field
                        label="Status"
                        value={
                            metadata.deactivated
                                ? <Chip label="Deactivated" size="small" color="error" />
                                : metadata.confirmed
                                    ? <Chip label="Confirmed" size="small" color="success" />
                                    : <Chip label="Pending confirmation" size="small" />
                        }
                    />
                </Card>

                <Box sx={{ mt: 3, display: 'flex', gap: 2, justifyContent: 'center', flexWrap: 'wrap' }}>
                    <Button component={Link} to="/directory" variant="outlined">
                        ← Back to Directory
                    </Button>
                    <Button component={Link} to={`/member/${name}`} variant="outlined">
                        Raw DID Document
                    </Button>
                    {did && (
                        <Button
                            component="a"
                            href={`https://explorer.archon.technology/search?did=${did}`}
                            target="_blank"
                            variant="outlined"
                        >
                            View on Archon Explorer
                        </Button>
                    )}
                </Box>
            </Box>
        </div>
    );
}

function NotFound() {
    const navigate = useNavigate();

    useEffect(() => {
        navigate("/");
    });

    return null;
}

export default App;
