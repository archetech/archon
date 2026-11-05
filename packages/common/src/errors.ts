export class ArchonError extends Error {
    public type: string;
    public detail?: string;

    constructor(type: string, detail?: string) {
        const message = detail ? `${type}: ${detail}` : type;
        super(message);
        this.type = type;
        this.detail = detail;
    }
}

export class InvalidDIDError extends ArchonError {
    static type = 'Invalid DID';

    constructor(detail?: string) {
        super(InvalidDIDError.type, detail);
    }
}

export class InvalidParameterError extends ArchonError {
    static type = 'Invalid parameter';

    constructor(detail?: string) {
        super(InvalidParameterError.type, detail);
    }
}

export class InvalidOperationError extends ArchonError {
    static type = 'Invalid operation';

    constructor(detail?: string) {
        super(InvalidOperationError.type, detail);
    }
}

export class KeymasterError extends ArchonError {
    static type = 'Keymaster';

    constructor(detail?: string) {
        super(KeymasterError.type, detail);
    }
}

export class UnknownIDError extends ArchonError {
    static type = 'Unknown ID';

    constructor(detail?: string) {
        super(UnknownIDError.type, detail);
    }
}

export class LightningNotConfiguredError extends ArchonError {
    static type = 'Lightning not configured';

    constructor(detail?: string) {
        super(LightningNotConfiguredError.type, detail);
    }
}

export class LightningUnavailableError extends ArchonError {
    static type = 'Lightning service unavailable';

    constructor(detail?: string) {
        super(LightningUnavailableError.type, detail);
    }
}

export class CashuNotConfiguredError extends ArchonError {
    static type = 'Cashu not configured';

    constructor(detail?: string) {
        super(CashuNotConfiguredError.type, detail);
    }
}

export class CashuUnavailableError extends ArchonError {
    static type = 'Cashu mint unavailable';

    constructor(detail?: string) {
        super(CashuUnavailableError.type, detail);
    }
}

export class CashuMintNotAddedError extends ArchonError {
    static type = 'Cashu mint not added';

    constructor(detail?: string) {
        super(CashuMintNotAddedError.type, detail);
    }
}

export class CashuMintUnsupportedError extends ArchonError {
    static type = 'Cashu mint unsupported';

    constructor(detail?: string) {
        super(CashuMintUnsupportedError.type, detail);
    }
}

export class CashuInsufficientFundsError extends ArchonError {
    static type = 'Insufficient ecash';

    constructor(detail?: string) {
        super(CashuInsufficientFundsError.type, detail);
    }
}

export class CashuQuoteUnpaidError extends ArchonError {
    static type = 'Cashu quote not paid';

    constructor(detail?: string) {
        super(CashuQuoteUnpaidError.type, detail);
    }
}

export class CashuTokenLockedError extends ArchonError {
    static type = 'Cashu token locked';

    constructor(detail?: string) {
        super(CashuTokenLockedError.type, detail);
    }
}

export class CashuTokenSpentError extends ArchonError {
    static type = 'Cashu token already spent';

    constructor(detail?: string) {
        super(CashuTokenSpentError.type, detail);
    }
}

export class CashuStateError extends ArchonError {
    static type = 'Cashu state present';

    constructor(detail?: string) {
        super(CashuStateError.type, detail);
    }
}

export class WalletNotFoundError extends ArchonError {
    static type = 'Wallet not found';

    constructor(detail?: string) {
        super(WalletNotFoundError.type, detail);
    }
}

// For unit tests
export class ExpectedExceptionError extends ArchonError {
    static type = 'Expected to throw an exception';

    constructor() {
        super(ExpectedExceptionError.type);
    }
}
