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

// For unit tests
export class ExpectedExceptionError extends ArchonError {
    static type = 'Expected to throw an exception';

    constructor() {
        super(ExpectedExceptionError.type);
    }
}
