import React, { useEffect, useState, useRef } from "react";
import {
    useNavigate,
    useParams,
    BrowserRouter as Router,
    Link,
    Routes,
    Route,
} from "react-router-dom";
import { Alert, Box, Button, TextField, Typography } from '@mui/material';
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

// Dynamic basename: /member/* routes work at root, everything else under /app
const getBasename = () => {
    const path = window.location.pathname;
    if (path.startsWith('/member/') || path === '/member') {
        return '';
    }
    return '/app';
};

function App() {
    return (
        <Router basename={getBasename()}>
            <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/login" element={<ViewLogin />} />
                <Route path="/logout" element={<ViewLogout />} />
                <Route path="/members" element={<ViewMembers />} />
                <Route path="/owner" element={<ViewOwner />} />
                <Route path="/profile/:did" element={<ViewProfile />} />
                <Route path="/member/:name" element={<ViewMember />} />
                <Route path="/credential" element={<ViewCredential />} />
                <Route path="*" element={<NotFound />} />
            </Routes>
        </Router>
    );
}

function Header({ title, showTagline = false } : { title: string, showTagline?: boolean }) {
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
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    <img src="/archon-logo.png" alt="Logo" style={{ width: 64, height: 64 }} />
                    <Typography variant="h3" component="h1" sx={{ fontWeight: 700, color: '#1a1a1a' }}>
                        {title}
                    </Typography>
                </Box>
            </Link>
            {showTagline && (
                <Typography variant="subtitle1" sx={{ color: '#666', fontStyle: 'italic' }}>
                    Self-Sovereign Identity for Everyone
                </Typography>
            )}
        </Box>
    )
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
    }, []);

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
                <p>Loading...</p>
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
{`# Set up environment
export ARCHON_GATEKEEPER_URL=https://archon.technology
export ARCHON_PASSPHRASE="your-secret-passphrase"

# Create wallet and identity
npx @didcid/keymaster create-wallet
npx @didcid/keymaster create-id myagent`}
                        </Typography>
                        <Typography variant="body2" sx={{ color: '#888', mb: 2, mt: 3 }}>
                            Then authenticate and claim your name:
                        </Typography>
                        <Typography variant="body2" component="pre" sx={{ color: '#ccc', mb: 2, fontFamily: 'monospace', fontSize: '0.8rem', whiteSpace: 'pre-wrap' }}>
{`# 1. Get challenge
CHALLENGE=$(curl -s ${publicUrl}/api/challenge | jq -r .challenge)

# 2. Create response
RESPONSE=$(npx @didcid/keymaster create-response $CHALLENGE)

# 3. Authenticate (save session cookie)
curl -c cookies.txt "${publicUrl}/api/login?response=$RESPONSE"

# 4. Claim your name
curl -b cookies.txt -X POST ${publicUrl}/api/profile/name \\
  -H "Content-Type: application/json" -d '{"name": "myagent"}'

# 5. Get your verifiable credential
curl -b cookies.txt -X POST ${publicUrl}/api/credential/request`}
                        </Typography>
                        <Typography variant="body2" sx={{ color: '#888', mt: 2 }}>
                            MCP Server: <a href="https://www.npmjs.com/package/@archon-protocol/mcp-server" target="_blank" rel="noopener noreferrer" style={{ color: '#00d4aa' }}>@archon-protocol/mcp-server</a>
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
    const [responseDID, setResponseDID] = useState<string>('');
    const [loggingIn, setLoggingIn] = useState<boolean>(false);
    const [challengeURL, setChallengeURL] = useState<string | null>(null);
    const [extensionURL, setExtensionURL] = useState<string>('');
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
                setExtensionURL(`archon://auth?challenge=${challenge}`);
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
    }, []);

    async function login() {
        setLoggingIn(true);

        try {
            const getAuth = await api.post(`/login`, { challenge: challengeDID, response: responseDID });

            if (getAuth.data.authenticated) {
                navigate('/');
            }
            else {
                alert('login failed');
            }
        }
        catch (error: any) {
            window.alert(error);
        }

        setLoggingIn(false);
    }

    async function copyToClipboard(text: string) {
        try {
            await navigator.clipboard.writeText(text);
            setChallengeCopied(true);
        }
        catch (error: any) {
            window.alert('Failed to copy text: ' + error);
        }
    }

    return (
        <div className="App">
            <Header title="Login" />
            <Table style={{ width: '800px' }}>
                <TableBody>
                    <TableRow>
                        <TableCell>Challenge:</TableCell>
                        <TableCell>
                            {challengeURL &&
                                <a href={challengeURL} target="_blank" rel="noopener noreferrer">
                                    <QRCodeSVG value={challengeURL} />
                                </a>
                            }
                            <Typography
                                component="a"
                                href={extensionURL}
                                style={{ fontFamily: 'Courier' }}
                            >
                                {challengeDID}
                            </Typography>
                        </TableCell>
                        <TableCell>
                            <Button variant="contained" color="primary" onClick={() => copyToClipboard(challengeDID)} disabled={challengeCopied}>
                                Copy
                            </Button>
                        </TableCell>
                    </TableRow>
                    <TableRow>
                        <TableCell>Response:</TableCell>
                        <TableCell>
                            <TextField
                                label="Response DID"
                                style={{ width: '600px', fontFamily: 'Courier' }}
                                value={responseDID}
                                onChange={(e) => setResponseDID(e.target.value)}
                                fullWidth
                                margin="normal"
                                slotProps={{
                                    htmlInput: {
                                        maxLength: 80,
                                    },
                                }}
                            />
                        </TableCell>
                        <TableCell>
                            <Button variant="contained" color="primary" onClick={login} disabled={!responseDID || loggingIn}>
                                Login
                            </Button>
                        </TableCell>
                    </TableRow>
                </TableBody>
            </Table>
        </div>
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
        return (
            <div className="App">
                <Header title="Member Directory" />
                <p>Loading directory...</p>
            </div>
        );
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
                                    {entry.name}@{serviceDomain}
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
                                        View DID Doc
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
    const [auth, setAuth] = useState<AuthState | null>(null);
    const [profile, setProfile] = useState<any>(null);
    const [currentName, setCurrentName] = useState<string>("");
    const [newName, setNewName] = useState<string>("");

    useEffect(() => {
        const init = async () => {
            try {
                const getAuth = await api.get(`/check-auth`);
                const auth: AuthState = getAuth.data;

                setAuth(auth);

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
        try {
            const name = newName.trim();
            await api.put(`/profile/${profile.did}/name`, { name });
            setNewName(name);
            setCurrentName(name);
            profile.name = name;
        }
        catch (error: any) {
            window.alert(error);
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
            <Table style={{ width: '800px' }}>
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
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                                    <TextField
                                        label=""
                                        value={newName}
                                        onChange={(e) => setNewName(e.target.value)}
                                        slotProps={{
                                            htmlInput: {
                                                maxLength: 20,
                                            },
                                        }}
                                        sx={{ width: 300 }}
                                        margin="normal"
                                        fullWidth
                                    />
                                    <Button
                                        variant="contained"
                                        color="primary"
                                        onClick={saveName}
                                        disabled={newName === currentName}
                                    >
                                        Save
                                    </Button>
                                </Box>
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
        </div>
    )
}

function ViewCredential() {
    const [credentialData, setCredentialData] = useState<any>(null);
    const [loading, setLoading] = useState<boolean>(true);
    const [requesting, setRequesting] = useState<boolean>(false);
    const [error, setError] = useState<string>('');
    const [serviceDomain, setServiceDomain] = useState<string>('');
    const navigate = useNavigate();

    const fetchCredential = async () => {
        try {
            const configResponse = await api.get('/config');
            setServiceDomain(configResponse.data.serviceDomain);

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

    useEffect(() => {
        fetchCredential();
    }, []);

    const requestCredential = async () => {
        setRequesting(true);
        setError('');
        try {
            const response = await api.post('/credential/request');
            setCredentialData({
                hasCredential: true,
                ...response.data
            });
        }
        catch (err: any) {
            setError(err.response?.data?.error || 'Failed to request credential');
        }
        finally {
            setRequesting(false);
        }
    };

    if (loading) {
        return (
            <div className="App">
                <Header title="My Credential" />
                <p>Loading...</p>
            </div>
        );
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
                            Get Your Verified Name Credential
                        </Typography>
                        <Typography variant="body1" sx={{ mb: 3, color: '#666' }}>
                            Request a verifiable credential that proves you own your name.
                            <br />
                            This credential is cryptographically signed and can be verified by anyone.
                        </Typography>
                        
                        {credentialData?.name ? (
                            <Button 
                                variant="contained" 
                                color="primary" 
                                onClick={requestCredential}
                                disabled={requesting}
                                size="large"
                            >
                                {requesting ? 'Requesting...' : `Request Credential for ${credentialData.name}@${serviceDomain}`}
                            </Button>
                        ) : (
                            <Box>
                                <Typography variant="body1" sx={{ color: '#e74c3c', mb: 2 }}>
                                    You need to set a name first before requesting a credential.
                                </Typography>
                                <Button component={Link} to={`/profile/${credentialData?.did || ''}`} variant="outlined">
                                    Go to Profile
                                </Button>
                            </Box>
                        )}
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
                                {credentialData.credentialName}@{serviceDomain}
                            </Typography>
                            <Typography variant="body2" sx={{ color: '#666', mt: 1 }}>
                                Issued: {credentialData.credentialIssuedAt ? 
                                    format(new Date(credentialData.credentialIssuedAt), 'MMM d, yyyy h:mm a') : 
                                    'Unknown'}
                            </Typography>
                        </Box>

                        {credentialData.needsUpdate && (
                            <Box sx={{ 
                                backgroundColor: '#fff3e0', 
                                borderRadius: 2, 
                                p: 2, 
                                mb: 3,
                                border: '1px solid #ffe0b2'
                            }}>
                                <Typography variant="body1" sx={{ color: '#e65100' }}>
                                    ⚠️ Your name has changed to {credentialData.currentName}@{serviceDomain}.
                                    Update your credential to reflect your new name.
                                </Typography>
                                <Button 
                                    variant="contained" 
                                    color="warning" 
                                    onClick={requestCredential}
                                    disabled={requesting}
                                    sx={{ mt: 2 }}
                                >
                                    {requesting ? 'Updating...' : 'Update Credential'}
                                </Button>
                            </Box>
                        )}

                        <Typography variant="h6" sx={{ mb: 2 }}>Credential DID</Typography>
                        <Typography 
                            variant="body2" 
                            sx={{ 
                                fontFamily: 'monospace', 
                                backgroundColor: '#f5f5f5', 
                                p: 2, 
                                borderRadius: 1,
                                wordBreak: 'break-all',
                                mb: 3
                            }}
                        >
                            {credentialData.credentialDid}
                        </Typography>

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
    const [memberData, setMemberData] = useState<any>(null);
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<string>('');
    const [serviceDomain, setServiceDomain] = useState<string>('');

    useEffect(() => {
        const fetchMember = async () => {
            try {
                const configResponse = await api.get('/config');
                setServiceDomain(configResponse.data.serviceDomain);

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

    if (loading) {
        return (
            <div className="App">
                <Header title={`${name}@${serviceDomain}`} />
                <p>Loading...</p>
            </div>
        );
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

    return (
        <div className="App">
            <Header title={`${name}@${serviceDomain}`} />
            
            <Box sx={{ maxWidth: 800, mx: 'auto' }}>
                <Box sx={{ 
                    backgroundColor: '#f8f9fa', 
                    borderRadius: 2, 
                    p: 3, 
                    mb: 3,
                    border: '1px solid #e9ecef',
                    textAlign: 'center'
                }}>
                    <Typography variant="h4" sx={{ fontWeight: 600, color: '#2c3e50', mb: 1 }}>
                        {memberData?.name}@{serviceDomain}
                    </Typography>
                    <Typography variant="body1" sx={{ fontFamily: 'monospace', color: '#666', wordBreak: 'break-all' }}>
                        {memberData?.did}
                    </Typography>
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
                        {JSON.stringify(memberData?.didDocument, null, 2)}
                    </pre>
                </Box>

                <Box sx={{ mt: 3, display: 'flex', gap: 2, justifyContent: 'center' }}>
                    <Button component={Link} to="/members" variant="outlined">
                        ← Back to Directory
                    </Button>
                    <Button 
                        component="a" 
                        href={`https://explorer.archon.technology/search?did=${memberData?.did}`}
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

function NotFound() {
    const navigate = useNavigate();

    useEffect(() => {
        navigate("/");
    });

    return null;
}

export default App;
