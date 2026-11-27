import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
    VariablesProvider,
    useVariablesContext,
    type VariablesStore,
} from '../../../../packages/wallet-ui/src/contexts/VariablesProvider';

// The shared variables hold the wallet state every tab reads. A host that
// supplies a store (the extension) has the persistent setters written through
// to it; a host without one (react-wallet) keeps them in memory only.

let store!: ReturnType<typeof vi.fn<VariablesStore>>;

beforeEach(() => {
    store = vi.fn<VariablesStore>().mockResolvedValue(undefined);
});

function withStore({ children }: { children: ReactNode }) {
    return <VariablesProvider store={store}>{children}</VariablesProvider>;
}

function withoutStore({ children }: { children: ReactNode }) {
    return <VariablesProvider>{children}</VariablesProvider>;
}

describe('VariablesProvider', () => {
    it('starts empty, on the hyperswarm registry', () => {
        const { result } = renderHook(() => useVariablesContext(), { wrapper: withoutStore });

        expect(result.current.currentId).toBe('');
        expect(result.current.validId).toBe(false);
        expect(result.current.registry).toBe('hyperswarm');
        expect(result.current.registries).toEqual([]);
        expect(result.current.manifest).toBeUndefined();
        expect(result.current.aliasList).toEqual({});
        expect(result.current.dmailList).toEqual({});
        expect(result.current.issuedEdit).toBe(false);
    });

    it.each([
        ['setCurrentId', 'currentId', 'currentId', 'Alice'],
        ['setHeldDID', 'heldDID', 'heldDID', 'did:cid:held'],
        ['setAlias', 'alias', 'aliasName', 'friend'],
        ['setAliasDID', 'aliasDID', 'aliasDID', 'did:cid:friend'],
        ['setRegistry', 'registry', 'registry', 'BTC:mainnet'],
    ] as const)('%s updates %s and writes it to the store as %s', async (setter, field, key, value) => {
        const { result } = renderHook(() => useVariablesContext(), { wrapper: withStore });

        await act(() => result.current[setter](value));

        expect(result.current[field]).toBe(value);
        expect(store).toHaveBeenCalledExactlyOnceWith(key, value);
    });

    it('keeps values in memory when the host has no store', async () => {
        const { result } = renderHook(() => useVariablesContext(), { wrapper: withoutStore });

        await act(() => result.current.setCurrentId('Alice'));
        await act(() => result.current.storeState('anything', true));

        expect(result.current.currentId).toBe('Alice');
        expect(store).not.toHaveBeenCalled();
    });

    it('passes storeState straight through to the store', async () => {
        const { result } = renderHook(() => useVariablesContext(), { wrapper: withStore });

        await act(() => result.current.storeState('flag', false));

        expect(store).toHaveBeenCalledExactlyOnceWith('flag', false);
    });

    it('resets the credential state without writing to the store', async () => {
        const { result } = renderHook(() => useVariablesContext(), { wrapper: withStore });
        await act(async () => {
            await result.current.setCurrentId('Alice');
            await result.current.setHeldDID('did:cid:held');
            await result.current.setAlias('friend');
            await result.current.setAliasDID('did:cid:friend');
            await result.current.setRegistry('BTC:mainnet');
        });
        store.mockClear();

        act(() => result.current.resetCredentialState());

        expect(result.current.currentId).toBe('');
        expect(result.current.heldDID).toBe('');
        expect(result.current.alias).toBe('');
        expect(result.current.aliasDID).toBe('');
        expect(result.current.registry).toBe('hyperswarm');
        expect(store).not.toHaveBeenCalled();
    });

    it('restores stored credential fields and leaves missing ones alone', async () => {
        const { result } = renderHook(() => useVariablesContext(), { wrapper: withStore });
        await act(() => result.current.setAlias('kept'));

        await act(() => result.current.refreshCredentialsStored({ heldDID: 'did:cid:held', aliasDID: 'did:cid:friend' }));

        expect(result.current.heldDID).toBe('did:cid:held');
        expect(result.current.aliasDID).toBe('did:cid:friend');
        expect(result.current.alias).toBe('kept');

        await act(() => result.current.refreshCredentialsStored({ aliasName: 'restored' }));

        expect(result.current.alias).toBe('restored');
        expect(result.current.heldDID).toBe('did:cid:held');
    });

    it('restores a stored registry only when there is one', async () => {
        const { result } = renderHook(() => useVariablesContext(), { wrapper: withStore });

        await act(() => result.current.refreshRegistryStored({}));
        expect(result.current.registry).toBe('hyperswarm');

        await act(() => result.current.refreshRegistryStored({ registry: 'BTC:signet' }));
        expect(result.current.registry).toBe('BTC:signet');
    });

    it('exposes plain state setters for the lists', () => {
        const { result } = renderHook(() => useVariablesContext(), { wrapper: withStore });

        act(() => {
            result.current.setIdList(['Alice']);
            result.current.setAgentList(['Alice', 'Bob']);
            result.current.setAliasList({ friend: 'did:cid:friend' });
            result.current.setIssuedEdit(true);
        });

        expect(result.current.idList).toEqual(['Alice']);
        expect(result.current.agentList).toEqual(['Alice', 'Bob']);
        expect(result.current.aliasList).toEqual({ friend: 'did:cid:friend' });
        expect(result.current.issuedEdit).toBe(true);
        expect(store).not.toHaveBeenCalled();
    });

    it('refuses to be used outside the provider', () => {
        // React logs the uncaught render error; keep it out of the output.
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            expect(() => renderHook(() => useVariablesContext()))
                .toThrow('useVariablesContext must be used within VariablesProvider');
        } finally {
            consoleError.mockRestore();
        }
    });
});
