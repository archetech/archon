// Request logs record headers. These carry bearer secrets on some routes:
// Session Tokens and DPoP Proofs, session and sign-in cookies, authorization
// codes in redirect locations, and Cashu tokens, which stay spendable when a
// payment is refused before redemption.
export const REDACTED_LOG_PATHS = [
    'req.headers.authorization',
    'req.headers.dpop',
    'req.headers.cookie',
    'req.headers["x-archon-admin-key"]',
    'req.headers["x-cashu"]',
    'res.headers["set-cookie"]',
    'res.headers.location',
];
