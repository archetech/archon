import React, { useMemo } from 'react';
import GrantsView from '@didcid/wallet-ui/grants';

// The view is shared with the wallets, where it is the Grants section of the
// Auth tab. It gets each method by name here, like the Cashu panel's, so what
// this client offers stays in its own source, where
// tests/wallet/ui-capability-parity.test.ts looks for it.
//
// `request` is a grant request to show for review: one named in the address
// this client was opened at. `did` is the identity's DID, which a rename does
// not change: the view keeps what it knows of an identity's revocations by it.
export default function GrantsPanel({ keymaster, identity, did, registries, request, showError, showSuccess }) {
    const actions = useMemo(() => ({
        createAsset: (data, options) => keymaster.createAsset(data, options),
        listAssets: owner => keymaster.listAssets(owner),
        listRevocations: owner => keymaster.listRevocations(owner),
        resolveDID: (did, options) => keymaster.resolveDID(did, options),
        updateGrant: (did, changes) => keymaster.updateGrant(did, changes),
        revokeDID: did => keymaster.revokeDID(did),
    }), [keymaster]);

    return (
        <GrantsView
            key={`${identity} ${did}`}
            keymaster={actions}
            identity={identity}
            sessionKey={did || identity}
            registries={registries || []}
            request={request}
            notify={{ error: showError, success: showSuccess }}
        />
    );
}
