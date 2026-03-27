import 'express-session';

declare module 'express-session' {
    interface SessionData {
        user?: {
            did: string;
        };
        challenge?: string;
    }
}
