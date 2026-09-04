import { describe, it, expect, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SnackbarProvider, useSnackbar, useIsMounted, whileMounted } from '@didcid/wallet-ui';

// Refresh work awaits the network and is started from effects, so it can resolve
// after its screen has gone. Reporting the error then raises a snackbar for a
// component nobody is showing, and under test threw `window is not defined`
// because jsdom had already been torn down (#1035).
//
// The teardown itself cannot be staged from inside a test, so what is asserted
// here is the mechanism the guard depends on, and that the guard does not cost
// the reporting it exists to filter.

function Probe({ onReady }: { onReady: (isMounted: () => boolean) => void }) {
    onReady(useIsMounted());
    return null;
}

function Capture({ onReady }: { onReady: (setError: (e: unknown) => void) => void }) {
    onReady(useSnackbar().setError);
    return null;
}

describe('useIsMounted', () => {
    it('reports true while mounted and false afterwards', () => {
        let isMounted!: () => boolean;

        const { unmount } = render(<Probe onReady={(fn) => { isMounted = fn; }} />);

        expect(isMounted()).toBe(true);

        unmount();

        expect(isMounted()).toBe(false);
    });
});

describe('whileMounted', () => {
    it('passes the update through while mounted', () => {
        const update = vi.fn();

        whileMounted(update, () => true)('a value');

        expect(update).toHaveBeenCalledWith('a value');
    });

    it('drops the update once unmounted', () => {
        // What a rejected request does when its screen has already gone. There
        // is nothing left to render, so the updater is what gets watched.
        const update = vi.fn();

        whileMounted(update, () => false)('a value');

        expect(update).not.toHaveBeenCalled();
    });

    it('is what the snackbar reports through', () => {
        // Guards the wiring rather than the behaviour: after unmount there is
        // nothing left to observe, so the two tests above would keep passing if
        // the provider quietly went back to calling the updater directly.
        const source = readFileSync(
            resolve(process.cwd(), '../../packages/wallet-ui/src/contexts/SnackbarProvider.tsx'),
            'utf-8',
        );

        expect(source).toContain('whileMounted(setSnackbar, isMounted)');
    });
});

describe('snackbar reporting', () => {
    it('still shows an error raised while mounted', () => {
        let report!: (e: unknown) => void;

        const { getByText } = render(
            <SnackbarProvider>
                <Capture onReady={(fn) => { report = fn; }} />
            </SnackbarProvider>
        );

        act(() => {
            report(new Error('visible failure'));
        });

        expect(getByText('visible failure')).toBeTruthy();
    });
});
