// Types
export type {
    L402CaveatSet,
    L402Token,
    LightningInvoice,
    LightningPaymentResult,
    CashuPayment,
    CashuRedemptionResult,
    PaymentVerificationResult,
    ClnConfig,
    CashuConfig,
    L402MiddlewareOptions,
    L402Store,
    MacaroonRecord,
    PaymentRecord,
    PendingInvoiceData,
    RateLimitResult,
    OperationPrice,
    OperationPricingConfig,
    L402AccessCredentialSubject,
    L402MacaroonData,
    PaymentAnalytics,
    CaveatContext,
} from './types.js';

// Errors
export {
    L402Error,
    PaymentRequiredError,
    InvalidMacaroonError,
    MacaroonRevokedError,
    PaymentVerificationError,
    RateLimitExceededError,
    InsufficientScopeError,
} from './errors.js';

// Caveats
export {
    encodeCaveat,
    decodeCaveat,
    caveatsToConditions,
    conditionsToCaveats,
    validateCaveatSet,
    isCaveatSatisfied,
} from './caveats.js';

// Macaroon
export {
    createMacaroon,
    verifyMacaroon,
    extractCaveats,
    generateMacaroonId,
    verifyPreimage,
} from './macaroon.js';

// Lightning
export {
    createInvoice,
    checkInvoice,
    waitInvoice,
} from './lightning.js';

// Cashu
export {
    verifyCashuToken,
    redeemCashuToken,
    isTrustedMint,
} from './cashu.js';

// Payment
export { verifyPayment } from './payment.js';

// Rate Limiter
export { checkLimit, recordRequest, checkAndRecordRequest } from './rate-limiter.js';

// Pricing
export { routeToScope, getPriceForOperation, loadPricingFromEnv } from './pricing.js';

// Middleware
export {
    createL402Middleware,
    handlePaymentCompletion,
    handleRevokeMacaroon,
    handleL402Status,
    handleGetPayments,
} from './middleware.js';

// Credential
export { L402AccessCredentialSchema, buildL402AccessClaims } from './credential.js';

// Stores
export { L402StoreMemory } from './store-memory.js';
export { L402StoreRedis } from './store-redis.js';

// Analytics
export { getPaymentAnalytics } from './analytics.js';
