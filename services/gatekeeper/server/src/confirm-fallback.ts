import type { DidCidDocument, ResolveDIDOptions } from '@didcid/gatekeeper/types';

export const CONFIRM_FALLBACK_HEADER = 'X-Archon-Confirm-Fallback';

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export function shouldTryConfirmFallback(
    doc: DidCidDocument,
    options: ResolveDIDOptions,
    confirmFallbackURL?: string,
    alreadyFallback: boolean = false,
    latest?: DidCidDocument
): boolean {
    return options.confirm === true &&
        Boolean(confirmFallbackURL) &&
        !alreadyFallback &&
        (doc.didResolutionMetadata?.error === 'notFound' ||
            (!doc.didResolutionMetadata?.error &&
                (doc.didDocumentMetadata?.confirmed !== true ||
                    Number(latest?.didDocumentMetadata?.versionSequence) > Number(doc.didDocumentMetadata?.versionSequence))));
}

function resolveQueryParams(options: ResolveDIDOptions): URLSearchParams {
    const params = new URLSearchParams();

    if (options.versionTime) {
        params.set('versionTime', options.versionTime);
    }

    if (options.versionSequence !== undefined) {
        params.set('versionSequence', String(options.versionSequence));
    }

    if (options.confirm !== undefined) {
        params.set('confirm', String(options.confirm));
    }

    if (options.verify !== undefined) {
        params.set('verify', String(options.verify));
    }

    return params;
}

export async function resolveFromConfirmFallback(
    did: string,
    options: ResolveDIDOptions,
    confirmFallbackURL: string,
    timeoutMs: number,
    fetchImpl: FetchLike = fetch,
    local?: DidCidDocument
): Promise<DidCidDocument | null> {
    const baseURL = confirmFallbackURL.replace(/\/+$/, '');
    const url = new URL(`${baseURL}/api/v1/did/${encodeURIComponent(did)}`);
    url.search = resolveQueryParams(options).toString();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetchImpl(url, {
            signal: controller.signal,
            headers: {
                [CONFIRM_FALLBACK_HEADER]: '1',
            },
        });

        if (!response.ok) {
            return null;
        }

        const doc = await response.json() as DidCidDocument;
        const metadata = doc.didDocumentMetadata;
        const sequence = Number(metadata?.versionSequence);
        if (doc.didResolutionMetadata?.error || doc.didDocument?.id !== did || metadata?.confirmed !== true ||
            !Number.isSafeInteger(sequence) || sequence < 1 ||
            (options.versionSequence !== undefined && sequence > options.versionSequence)) return null;
        // A peer must improve the confirmed prefix, not replace it with an older answer.
        if (local?.didDocumentMetadata?.confirmed === true &&
            sequence <= Number(local.didDocumentMetadata.versionSequence)) return null;
        if (options.versionTime) {
            const time = Date.parse(metadata.deleted ?? metadata.updated ?? metadata.created ?? '');
            const cutoff = Date.parse(options.versionTime);
            if (!Number.isFinite(time) || !Number.isFinite(cutoff) || time > cutoff) return null;
        }
        return doc;
    } finally {
        clearTimeout(timeout);
    }
}
