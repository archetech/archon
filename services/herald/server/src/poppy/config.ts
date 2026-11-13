// Personal Agent Protocol (Poppy) Company configuration for a Herald domain.
// Herald is reached at `<public origin>/names`, so the Poppy issuer and its
// endpoints live under `/names/poppy`, apart from Herald's OIDC issuer at
// `/names`. Keeping them apart stops Poppy's metadata from changing how
// existing OIDC relying parties behave.

// Version 0.4, the 1.0 release candidate. Before 1.0 a Personal Agent uses a
// poppy.json only if its minor version matches one the agent implements.
export const POPPY_PROTOCOL_VERSION = '0.4';

export const SCOPES = {
    'profile:read': 'View your Herald profile, name and membership credential',
    'name:write': 'Claim, change or release your Herald name',
} as const;

export type PoppyScope = keyof typeof SCOPES;

// What the most consequential action under each scope does (spec 4.7).
// Releasing a name revokes its membership credential and frees the name for
// someone else, which cannot be undone.
export const SCOPE_HINTS: Record<PoppyScope, { changes: 'none' | 'reversible' | 'irreversible'; personal_data: boolean }> = {
    'profile:read': { changes: 'none', personal_data: true },
    'name:write': { changes: 'irreversible', personal_data: true },
};

// Draft 0.2 defined these names itself. Grants issued under them are read as
// the scopes that replace them.
const LEGACY_SCOPES: Record<string, PoppyScope> = {
    'poppy:read': 'profile:read',
    'poppy:write': 'name:write',
};

export function currentScopes(scope: string[]): string[] {
    return [...new Set(scope.map(item => LEGACY_SCOPES[item] ?? item))];
}

export interface PoppyConfig {
    origin: string;
    domain: string;
    issuer: string;
    // The domain as a protected resource (RFC 9728): what its metadata names,
    // and what the issuer lists in protected_resources.
    resource: string;
    organizationName: string;
    walletUrl: string;
    accessTokenSeconds: number;
    sessionSeconds: number;
    refreshTokenSeconds: number;
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
        resource: `https://${url.hostname.toLowerCase()}`,
        organizationName,
        walletUrl,
        accessTokenSeconds: 60 * 60,
        sessionSeconds: 30 * 24 * 60 * 60,
        refreshTokenSeconds: 90 * 24 * 60 * 60,
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
    return {
        protocol_version: POPPY_PROTOCOL_VERSION,
        organization: {
            name: config.organizationName,
            domain: config.domain,
        },
        // The sign-in types offered are read from the issuer's
        // grant_types_supported, and the issuer from the domain's protected
        // resource metadata (spec 3.2).
        auth: {
            issuer: config.issuer,
            scopes: SCOPES,
            scope_hints: SCOPE_HINTS,
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

// Served at /.well-known/oauth-protected-resource on the domain: how a
// Personal Agent finds the issuer (spec 3.2). Herald's OIDC issuer at /names
// is not an authorization server for this resource and is not listed.
export function protectedResourceMetadata(config: PoppyConfig) {
    return {
        resource: config.resource,
        authorization_servers: [config.issuer],
        scopes_supported: Object.keys(SCOPES),
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
        protected_resources: [config.resource],
        grant_types_supported: [
            'authorization_code',
            'refresh_token',
            'urn:ietf:params:oauth:grant-type:device_code',
        ],
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['private_key_jwt'],
        token_endpoint_auth_signing_alg_values_supported: ['ES256', 'PS384', 'RS256'],
        revocation_endpoint_auth_methods_supported: ['private_key_jwt'],
        authorization_response_iss_parameter_supported: true,
        client_id_metadata_document_supported: true,
        scopes_supported: Object.keys(SCOPES),
    };
}
