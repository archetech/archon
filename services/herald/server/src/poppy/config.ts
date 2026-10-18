// Personal Agent Protocol (Poppy) Company configuration for a Herald domain.
// Herald is reached at `<public origin>/names`, so the Poppy issuer and its
// endpoints live under `/names/poppy`, apart from Herald's OIDC issuer at
// `/names`. Keeping them apart stops Poppy's metadata from changing how
// existing OIDC relying parties behave.

// Draft 0.2: assertions name the issuer as aud. Frozen 0.1 named the token
// endpoint, which let a Company replay assertions addressed to an endpoint
// another Company's metadata named (upstream #2).
export const POPPY_PROTOCOL_VERSION = '0.2';

export const SCOPES = {
    'poppy:read': 'View your Herald profile, name and membership credential',
    'poppy:write': 'Claim, change or release your Herald name',
} as const;

export type PoppyScope = keyof typeof SCOPES;

export interface PoppyConfig {
    origin: string;
    domain: string;
    issuer: string;
    organizationName: string;
    walletUrl: string;
    sessionTokenSeconds: number;
    sessionSeconds: number;
    accountTokenSeconds: number;
    codeSeconds: number;
    deviceCodeSeconds: number;
    deviceIntervalSeconds: number;
}

export function createPoppyConfig(publicHost: string, organizationName: string, walletUrl: string): PoppyConfig {
    const origin = publicHost.replace(/\/+$/, '');
    const url = new URL(origin);
    return {
        origin,
        domain: url.hostname.toLowerCase(),
        issuer: `${origin}/names/poppy`,
        organizationName,
        walletUrl,
        sessionTokenSeconds: 60 * 60,
        sessionSeconds: 30 * 24 * 60 * 60,
        accountTokenSeconds: 90 * 24 * 60 * 60,
        codeSeconds: 10 * 60,
        deviceCodeSeconds: 10 * 60,
        deviceIntervalSeconds: 5,
    };
}

export function endpoints(config: PoppyConfig) {
    return {
        token: `${config.issuer}/token`,
        revocation: `${config.issuer}/revoke`,
        authorization: `${config.issuer}/authorize`,
        deviceAuthorization: `${config.issuer}/device_authorization`,
        deviceVerification: `${config.issuer}/device`,
        openapi: `${config.issuer}/openapi.json`,
        api: `${config.issuer}/api`,
    };
}

export function poppyDocument(config: PoppyConfig) {
    const scopes = Object.keys(SCOPES);
    return {
        protocol_version: POPPY_PROTOCOL_VERSION,
        organization: {
            name: config.organizationName,
            domain: config.domain,
        },
        auth: {
            issuer: config.issuer,
            direct: { scopes },
            device: { scopes },
        },
        apis: [
            {
                type: 'openapi',
                url: endpoints(config).openapi,
                description: `Look up names and member profiles at ${config.domain} and resolve DIDs; once signed in, read the User's profile and membership credential and manage their name.`,
            },
        ],
    };
}

export function authorizationServerMetadata(config: PoppyConfig) {
    const e = endpoints(config);
    return {
        issuer: config.issuer,
        token_endpoint: e.token,
        revocation_endpoint: e.revocation,
        authorization_endpoint: e.authorization,
        device_authorization_endpoint: e.deviceAuthorization,
        dpop_signing_alg_values_supported: ['ES256', 'RS256'],
        poppy_domains: [config.domain],
        grant_types_supported: [
            'urn:ietf:params:oauth:grant-type:jwt-bearer',
            'authorization_code',
            'refresh_token',
            'urn:ietf:params:oauth:grant-type:device_code',
        ],
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['private_key_jwt'],
        token_endpoint_auth_signing_alg_values_supported: ['ES256', 'RS256'],
        revocation_endpoint_auth_methods_supported: ['private_key_jwt'],
        authorization_response_iss_parameter_supported: true,
        client_id_metadata_document_supported: true,
        scopes_supported: Object.keys(SCOPES),
    };
}
