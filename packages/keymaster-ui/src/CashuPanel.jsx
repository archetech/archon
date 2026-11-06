import React, { useMemo } from 'react';
import CashuView from '@didcid/wallet-ui/cashu';

// The view is shared with the wallets. It gets each method by name here, like the DID
// repair callbacks, so what this client offers stays in its own source, where
// tests/wallet/ui-capability-parity.test.ts looks for it.
export default function CashuPanel({ keymaster, identity, hasCashu, hasDidComm, recipients, showError, showSuccess, showAlert }) {
    const actions = useMemo(() => ({
        addCashu: name => keymaster.addCashu(name),
        removeCashu: (force, name) => keymaster.removeCashu(force, name),
        addCashuMint: (url, name) => keymaster.addCashuMint(url, name),
        removeCashuMint: (url, force, name) => keymaster.removeCashuMint(url, force, name),
        listCashuMints: name => keymaster.listCashuMints(name),
        getCashuBalance: (mint, name) => keymaster.getCashuBalance(mint, name),
        createCashuMintQuote: (amount, mint, name) => keymaster.createCashuMintQuote(amount, mint, name),
        claimCashuMintQuote: (quote, mint, name) => keymaster.claimCashuMintQuote(quote, mint, name),
        listCashuQuotes: (mint, name) => keymaster.listCashuQuotes(mint, name),
        meltCashu: (bolt11, mint, name) => keymaster.meltCashu(bolt11, mint, name),
        sendCashu: (amount, mint, name) => keymaster.sendCashu(amount, mint, name),
        receiveCashu: (token, name) => keymaster.receiveCashu(token, name),
        checkCashu: (mint, name) => keymaster.checkCashu(mint, name),
        restoreCashu: (mint, name) => keymaster.restoreCashu(mint, name),
        listCashuSends: (mint, name) => keymaster.listCashuSends(mint, name),
        reclaimCashu: (operationId, name) => keymaster.reclaimCashu(operationId, name),
        sendCashuTo: (recipient, amount, options) => keymaster.sendCashuTo(recipient, amount, options),
        listCashuMessages: name => keymaster.listCashuMessages(name),
        receiveCashuMessages: name => keymaster.receiveCashuMessages(name),
        getLightningBalance: name => keymaster.getLightningBalance(name),
        payLightningInvoice: (bolt11, name) => keymaster.payLightningInvoice(bolt11, name),
        decodeLightningInvoice: bolt11 => keymaster.decodeLightningInvoice(bolt11),
    }), [keymaster]);

    return (
        <CashuView
            key={identity}
            keymaster={actions}
            identity={identity}
            hasNodeMint={hasCashu}
            hasDidComm={hasDidComm}
            recipients={recipients}
            notify={{ error: showError, success: showSuccess, warning: showAlert }}
        />
    );
}
