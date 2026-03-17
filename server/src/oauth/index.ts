import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';

// Generate ES256 signing key at startup (or load from env)
let jwtSigningKey: CryptoKey | null = null;
let jwtPublicJWK: any = null;
const JWT_KEY_ID = 'archon-social-signing-key-1';

async function initJWTKeys(): Promise<void> {
    if (!jwtSigningKey) {
        // Generate ephemeral key pair (in production, persist this)
        const { privateKey, publicKey } = await generateKeyPair('ES256');
        jwtSigningKey = privateKey as CryptoKey;
        
        // Export public key as JWK for JWKS endpoint
        jwtPublicJWK = await exportJWK(publicKey);
        jwtPublicJWK.kid = JWT_KEY_ID;
        jwtPublicJWK.use = 'sig';
        jwtPublicJWK.alg = 'ES256';
        
        console.log('Generated ES256 JWT signing key, kid:', JWT_KEY_ID);
    }
}

async function getJWTSigningKey(): Promise<CryptoKey> {
    await initJWTKeys();
    return jwtSigningKey!;
}

function getJWKS(): any {
    return {
        keys: jwtPublicJWK ? [jwtPublicJWK] : []
    };
}

const router = Router();

// In-memory stores (replace with DB in production)
const authCodes: Map<string, AuthCode> = new Map();
const accessTokens: Map<string, AccessToken> = new Map();

// Registered OAuth clients
const clients: Map<string, OAuthClient> = new Map();

interface OAuthClient {
    client_id: string;
    client_secret: string;
    name: string;
    redirect_uris: string[];
}

interface AuthCode {
    code: string;
    client_id: string;
    redirect_uri: string;
    did: string;
    scope: string;
    created_at: number;
    expires_at: number;
}

interface AccessToken {
    token: string;
    client_id: string;
    did: string;
    scope: string;
    expires_at: number;
}

// Initialize with a demo client
clients.set('demo-client', {
    client_id: 'demo-client',
    client_secret: 'demo-secret',
    name: 'Demo Application',
    redirect_uris: [
        'http://localhost:3001/callback',
        'http://localhost:4000/callback',
        'http://megaflax.local:4000/callback',
        'http://megaflax.local:3001/callback'
    ]
});

// Grafana dashboard - requires membership VC
clients.set('grafana-dashboard', {
    client_id: 'grafana-dashboard',
    client_secret: process.env.GRAFANA_OAUTH_SECRET || 'grafana-secret-change-me',
    name: 'Archon Grafana Dashboard',
    redirect_uris: [
        'https://grafana.archon.technology/oauth2/callback',
        'http://localhost:4180/oauth2/callback'
    ]
});

// Helper functions
function generateCode(): string {
    return crypto.randomBytes(32).toString('hex');
}

function generateToken(): string {
    return crypto.randomBytes(48).toString('hex');
}

// Export for use by main server
export function createOAuthRoutes(getKeymaster: () => any, getMemberByDID: (did: string) => any) {
    // Get keymaster lazily (it may not be initialized yet)
    const keymaster = () => getKeymaster();
    
    // Pending authorizations (challenge -> OAuth params)
    const pendingAuths: Map<string, {
        client_id: string;
        redirect_uri: string;
        state: string;
        scope: string;
        challenge: string;
    }> = new Map();

    /**
     * GET /oauth/authorize
     * Authorization endpoint - creates challenge for user
     */
    router.get('/authorize', async (req: Request, res: Response) => {
        try {
            const { client_id, redirect_uri, response_type, state, scope } = req.query;

            // Validate required params
            if (!client_id || !redirect_uri || response_type !== 'code') {
                return res.status(400).json({
                    error: 'invalid_request',
                    error_description: 'Missing required parameters'
                });
            }

            // Validate client
            const client = clients.get(client_id as string);
            if (!client) {
                return res.status(400).json({
                    error: 'invalid_client',
                    error_description: 'Unknown client_id'
                });
            }

            // Validate redirect_uri
            if (!client.redirect_uris.includes(redirect_uri as string)) {
                return res.status(400).json({
                    error: 'invalid_request',
                    error_description: 'Invalid redirect_uri'
                });
            }

            // Create DID challenge with OAuth context
            const publicUrl = process.env.NS_PUBLIC_URL || `http://localhost:${process.env.NS_HOST_PORT || 3300}`;
            const challenge = await keymaster().createChallenge({
                callback: `${publicUrl}/oauth/callback`,
                oauth: {
                    client_id,
                    redirect_uri,
                    scope: scope || 'openid profile',
                    state: state || ''
                }
            });

            // Store pending authorization
            pendingAuths.set(challenge, {
                client_id: client_id as string,
                redirect_uri: redirect_uri as string,
                state: (state as string) || '',
                scope: (scope as string) || 'openid profile',
                challenge
            });

            // Return challenge for client to display
            const walletUrl = process.env.NS_WALLET_URL || 'https://wallet.archon.technology';
            const challengeURL = `${walletUrl}?challenge=${challenge}`;

            // If explicitly requesting JSON (API call), return JSON
            const wantsJson = req.headers.accept?.includes('application/json') && 
                              !req.headers.accept?.includes('text/html');
            if (wantsJson) {
                return res.json({
                    challenge,
                    challengeURL,
                    client_name: client.name,
                    scope: scope || 'openid profile'
                });
            }

            // Otherwise redirect to consent page (or return simple HTML)
            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Sign in with ${process.env.NS_SERVICE_NAME || 'Name Service'}</title>
                    <script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js"></script>
                    <style>
                        body { 
                            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; 
                            max-width: 400px; 
                            margin: 40px auto; 
                            text-align: center;
                            padding: 20px;
                        }
                        h1 { font-size: 24px; margin-bottom: 10px; }
                        .subtitle { color: #666; margin-bottom: 30px; }
                        .qr-container { 
                            margin: 20px auto;
                            cursor: pointer;
                        }
                        .qr-container canvas {
                            border-radius: 12px;
                            box-shadow: 0 4px 12px rgba(0,0,0,0.1);
                        }
                        .qr-container:hover canvas {
                            box-shadow: 0 6px 20px rgba(0,0,0,0.15);
                        }
                        .open-wallet {
                            display: inline-block;
                            background: #4f46e5;
                            color: white;
                            padding: 12px 24px;
                            border-radius: 8px;
                            text-decoration: none;
                            font-weight: 600;
                            margin: 20px 0;
                        }
                        .open-wallet:hover { background: #4338ca; }
                        .did { 
                            font-family: monospace; 
                            font-size: 11px; 
                            background: #f3f4f6; 
                            padding: 12px; 
                            border-radius: 8px;
                            word-break: break-all;
                            color: #666;
                        }
                        .status { color: #666; font-size: 14px; margin-top: 20px; }
                        .spinner { animation: spin 1s linear infinite; display: inline-block; }
                        @keyframes spin { to { transform: rotate(360deg); } }
                    </style>
                </head>
                <body>
                    <h1>Sign in with ${process.env.NS_SERVICE_NAME || 'Name Service'}</h1>
                    <p class="subtitle"><strong>${client.name}</strong> wants to access your profile</p>
                    
                    <a href="${challengeURL}" target="_blank" class="qr-container" title="Click to open in wallet">
                        <canvas id="qr"></canvas>
                    </a>
                    
                    <p><a href="${challengeURL}" target="_blank" class="open-wallet">📱 Open in Wallet</a></p>
                    
                    <p class="did">${challenge}</p>
                    
                    <p class="status"><span class="spinner">⏳</span> Waiting for response...</p>
                    
                    <script>
                        // Poll for completion (separate from QR to ensure it runs)
                        setInterval(async () => {
                            try {
                                const res = await fetch('/oauth/poll?challenge=${challenge}');
                                const data = await res.json();
                                if (data.redirect) {
                                    window.location.href = data.redirect;
                                }
                            } catch (e) {
                                console.error('Poll error:', e);
                            }
                        }, 2000);
                    </script>
                    <script>
                        // Generate QR code (optional, may fail)
                        try {
                            QRCode.toCanvas(document.getElementById('qr'), '${challengeURL}', {
                                width: 240,
                                margin: 2,
                                color: { dark: '#1f2937', light: '#ffffff' }
                            });
                        } catch (e) {
                            console.warn('QR code generation failed:', e);
                            document.getElementById('qr').outerHTML = '<p style="color:#666;font-size:12px;">QR code unavailable</p>';
                        }
                    </script>
                </body>
                </html>
            `);
        } catch (error: any) {
            console.error('OAuth authorize error:', error);
            res.status(500).json({ error: 'server_error', error_description: error.message });
        }
    });

    /**
     * POST /oauth/callback
     * Receives response DID from wallet
     */
    router.post('/callback', async (req: Request, res: Response) => {
        try {
            const { response } = req.body;
            
            if (!response) {
                return res.status(400).json({ error: 'missing_response' });
            }

            // Verify the response
            const verify = await keymaster().verifyResponse(response, { retries: 10 });

            if (!verify.match) {
                return res.status(401).json({ error: 'invalid_response' });
            }

            const challengeDID = verify.challenge;
            const userDID = verify.responder;

            // Find pending authorization
            const pending = pendingAuths.get(challengeDID);
            if (!pending) {
                return res.status(400).json({ error: 'unknown_challenge' });
            }

            // Check if client requires membership (grafana-dashboard)
            if (pending.client_id === 'grafana-dashboard') {
                const member = await getMemberByDID(userDID);
                if (!member || !member.credentialDid) {
                    return res.status(403).json({ 
                        error: 'access_denied',
                        error_description: 'You must be a registered member of archon.social to access this resource'
                    });
                }
            }

            // Generate authorization code
            const code = generateCode();
            const authCode: AuthCode = {
                code,
                client_id: pending.client_id,
                redirect_uri: pending.redirect_uri,
                did: userDID,
                scope: pending.scope,
                created_at: Date.now(),
                expires_at: Date.now() + 600000 // 10 minutes
            };
            authCodes.set(code, authCode);

            // Clean up pending auth
            pendingAuths.delete(challengeDID);

            // Store redirect for polling
            const redirectKey = `redirect:${challengeDID}`;
            const redirectUrl = `${pending.redirect_uri}?code=${code}&state=${pending.state}`;
            (pendingAuths as any)[redirectKey] = redirectUrl;
            console.log('Stored redirect:', { redirectKey, redirectUrl });

            res.json({ 
                success: true, 
                redirect: `${pending.redirect_uri}?code=${code}&state=${pending.state}`
            });
        } catch (error: any) {
            console.error('OAuth callback error:', error);
            res.status(500).json({ error: 'server_error', error_description: error.message });
        }
    });

    /**
     * GET /oauth/poll
     * Polls for auth completion (for browser flow)
     */
    router.get('/poll', (req: Request, res: Response) => {
        const { challenge } = req.query;
        const redirectKey = `redirect:${challenge}`;
        const redirect = (pendingAuths as any)[redirectKey];
        
        console.log('Poll check:', { challenge, redirectKey, hasRedirect: !!redirect });
        
        if (redirect) {
            delete (pendingAuths as any)[redirectKey];
            return res.json({ redirect });
        }
        
        res.json({ pending: true });
    });

    /**
     * POST /oauth/token
     * Token endpoint - exchanges code for tokens
     * Supports both client_secret_basic (header) and client_secret_post (body)
     */
    router.post('/token', async (req: Request, res: Response) => {
        try {
            const { grant_type, code, redirect_uri } = req.body;
            
            // Extract client credentials from Basic auth header OR body
            let client_id = req.body.client_id;
            let client_secret = req.body.client_secret;
            
            const authHeader = req.headers.authorization;
            if (authHeader && authHeader.startsWith('Basic ')) {
                const base64Credentials = authHeader.substring(6);
                const credentials = Buffer.from(base64Credentials, 'base64').toString('utf8');
                const [basicId, basicSecret] = credentials.split(':');
                client_id = basicId;
                client_secret = basicSecret;
            }

            if (grant_type !== 'authorization_code') {
                return res.status(400).json({
                    error: 'unsupported_grant_type'
                });
            }

            // Validate client credentials
            const client = clients.get(client_id);
            if (!client || client.client_secret !== client_secret) {
                console.log('Client auth failed:', { 
                    client_id, 
                    hasClient: !!client, 
                    expectedSecret: client?.client_secret?.substring(0, 8) + '...',
                    receivedSecret: client_secret?.substring(0, 8) + '...',
                    authHeader: authHeader ? 'present' : 'missing',
                    bodyClientId: req.body.client_id,
                    bodyHasSecret: !!req.body.client_secret
                });
                return res.status(401).json({
                    error: 'invalid_client'
                });
            }

            // Validate authorization code
            const authCode = authCodes.get(code);
            if (!authCode) {
                return res.status(400).json({
                    error: 'invalid_grant',
                    error_description: 'Invalid or expired code'
                });
            }

            if (authCode.client_id !== client_id || authCode.redirect_uri !== redirect_uri) {
                return res.status(400).json({
                    error: 'invalid_grant',
                    error_description: 'Code was issued to different client/redirect'
                });
            }

            if (Date.now() > authCode.expires_at) {
                authCodes.delete(code);
                return res.status(400).json({
                    error: 'invalid_grant',
                    error_description: 'Code has expired'
                });
            }

            // Generate access token (opaque, for /userinfo)
            const access_token = generateToken();
            const tokenData: AccessToken = {
                token: access_token,
                client_id,
                did: authCode.did,
                scope: authCode.scope,
                expires_at: Date.now() + 3600000 // 1 hour
            };
            accessTokens.set(access_token, tokenData);

            // Delete used auth code
            authCodes.delete(code);

            // Generate JWT id_token
            const member = await getMemberByDID(authCode.did);
            const baseUrl = process.env.NS_PUBLIC_URL || `http://localhost:${process.env.NS_HOST_PORT || 3300}`;
            const issuer = `${baseUrl}/oauth`;  // Must match OIDC discovery issuer
            const now = Math.floor(Date.now() / 1000);

            // Get ES256 signing key
            const signingKey = await getJWTSigningKey();

            // Create and sign id_token
            const id_token = await new SignJWT({
                name: member?.name || authCode.did,
                preferred_username: member?.handle,
                picture: member?.avatar,
                did: authCode.did  // Include DID as custom claim
            })
                .setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid: JWT_KEY_ID })
                .setSubject(authCode.did)
                .setIssuer(issuer)
                .setAudience(client_id)
                .setIssuedAt(now)
                .setExpirationTime(now + 3600)
                .sign(signingKey);

            res.json({
                access_token,
                id_token,
                token_type: 'Bearer',
                expires_in: 3600,
                scope: authCode.scope
            });
        } catch (error: any) {
            console.error('OAuth token error:', error);
            res.status(500).json({ error: 'server_error', error_description: error.message });
        }
    });

    /**
     * GET /oauth/userinfo
     * Returns user profile for valid access token
     */
    router.get('/userinfo', async (req: Request, res: Response) => {
        try {
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                return res.status(401).json({ error: 'invalid_token' });
            }

            const token = authHeader.substring(7);
            const tokenData = accessTokens.get(token);

            if (!tokenData) {
                return res.status(401).json({ error: 'invalid_token' });
            }

            if (Date.now() > tokenData.expires_at) {
                accessTokens.delete(token);
                return res.status(401).json({ error: 'token_expired' });
            }

            // Get member info
            const member = await getMemberByDID(tokenData.did);

            res.json({
                sub: tokenData.did,
                name: member?.name || tokenData.did,
                preferred_username: member?.handle,
                picture: member?.avatar,
                updated_at: Math.floor(Date.now() / 1000)
            });
        } catch (error: any) {
            console.error('OAuth userinfo error:', error);
            res.status(500).json({ error: 'server_error', error_description: error.message });
        }
    });

    /**
     * GET /.well-known/jwks.json
     * JSON Web Key Set for verifying id_tokens
     */
    router.get('/.well-known/jwks.json', async (_req: Request, res: Response) => {
        // Ensure keys are initialized
        await initJWTKeys();
        res.json(getJWKS());
    });

    /**
     * GET /.well-known/openid-configuration
     * OIDC Discovery document
     */
    router.get('/.well-known/openid-configuration', (_req: Request, res: Response) => {
        const baseUrl = process.env.NS_PUBLIC_URL || `http://localhost:${process.env.NS_HOST_PORT || 3300}`;
        const issuer = `${baseUrl}/oauth`;  // Issuer matches where discovery is served
        
        res.json({
            issuer,
            authorization_endpoint: `${baseUrl}/oauth/authorize`,
            token_endpoint: `${baseUrl}/oauth/token`,
            userinfo_endpoint: `${baseUrl}/oauth/userinfo`,
            jwks_uri: `${baseUrl}/oauth/.well-known/jwks.json`,
            response_types_supported: ['code'],
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['ES256'],
            scopes_supported: ['openid', 'profile'],
            claims_supported: ['sub', 'name', 'preferred_username', 'picture']
        });
    });

    /**
     * POST /oauth/clients (admin only - for future)
     * Register a new OAuth client
     */
    router.post('/clients', (req: Request, res: Response) => {
    // TODO: Add admin authentication
        const { name, redirect_uris } = req.body;
        
        const client_id = crypto.randomBytes(16).toString('hex');
        const client_secret = crypto.randomBytes(32).toString('hex');
        
        clients.set(client_id, {
            client_id,
            client_secret,
            name,
            redirect_uris
        });
        
        res.json({ client_id, client_secret, name, redirect_uris });
    });

    return router;
}

export default router;
