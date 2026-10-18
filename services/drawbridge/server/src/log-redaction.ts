// Request logs record headers. These carry bearer secrets on some routes:
// Session Tokens and DPoP Proofs, session and sign-in cookies, and
// authorization codes in redirect locations.
export const REDACTED_LOG_PATHS = [
    'req.headers.authorization',
    'req.headers.dpop',
    'req.headers.cookie',
    'req.headers["x-archon-admin-key"]',
    'res.headers["set-cookie"]',
    'res.headers.location',
];
