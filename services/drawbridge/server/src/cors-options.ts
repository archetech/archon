import type { CorsOptions } from 'cors';

// Response headers a browser script may read across origins. A 402 challenge
// carries its payment requests in headers: the L402 macaroon and invoice in
// WWW-Authenticate, the NUT-24 request in X-Cashu, and a priced operation's
// price. Without exposing them, a browser client could find them only in the
// response body.
export const PAYMENT_CHALLENGE_HEADERS = ['WWW-Authenticate', 'X-Cashu', 'X-L402-Price', 'X-L402-Operation'];

export const DEFAULT_CORS_OPTIONS: CorsOptions = {
    exposedHeaders: PAYMENT_CHALLENGE_HEADERS,
};
