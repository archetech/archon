import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing Library cleans up by itself only with jest-style globals, which this
// configuration does not inject.
afterEach(() => {
    cleanup();
    localStorage.clear();
});
