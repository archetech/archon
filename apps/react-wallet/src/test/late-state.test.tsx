import { describe, it, expect } from 'vitest';
import { act, render } from '@testing-library/react';
import { SnackbarProvider, useSnackbar, useIsMounted } from '@didcid/wallet-ui';

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
