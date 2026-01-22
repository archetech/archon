import { Buffer } from 'buffer';
import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import GatekeeperClient from '@didcid/gatekeeper/client';
import CipherWeb from '@didcid/cipher/web';
import Keymaster from '@didcid/keymaster';
import WalletWeb from '@didcid/keymaster/wallet/web';
import WalletCache from '@didcid/keymaster/wallet/cache';
import WalletJsonMemory from "@didcid/keymaster/wallet/json-memory";
import { isWalletEncFile } from '@didcid/keymaster/wallet/typeGuards';
import KeymasterUI from './KeymasterUI.js';
import PassphraseModal from './PassphraseModal';
import WarningModal from './WarningModal';
import MnemonicModal from './MnemonicModal';
import { encMnemonic } from '@didcid/keymaster/encryption';
import './App.css';

global.Buffer = Buffer;

const { protocol, hostname } = window.location;
const gatekeeper = new GatekeeperClient();
await gatekeeper.connect({ url: `${protocol}//${hostname}:4224` });
const cipher = new CipherWeb();

function App() {
    const [isReady, setIsReady] = useState(false);
    const [modalAction, setModalAction] = useState(null);
    const [passphraseErrorText, setPassphraseErrorText] = useState("");
    const [keymaster, setKeymaster] = useState(null);
    const [kmEpoch, setKmEpoch] = useState(0);
    const [uploadAction, setUploadAction] = useState(null);
    const [pendingWallet, setPendingWallet] = useState(null);
    const [showResetConfirm, setShowResetConfirm] = useState(false);
    const [showResetSetup, setShowResetSetup] = useState(false);
    const [showRecoverMnemonic, setShowRecoverMnemonic] = useState(false);
    const [mnemonicErrorText, setMnemonicErrorText] = useState("");
    const [recoveredMnemonic, setRecoveredMnemonic] = useState("");
    const [showRecoverSetup, setShowRecoverSetup] = useState(false);
    const [searchParams] = useSearchParams();
    const challengeDID = searchParams.get('challenge');

    useEffect(() => {
        const init = async () => {
            const walletWeb = new WalletWeb();
            const walletData = await walletWeb.loadWallet();

            if (!walletData) {
                setModalAction('set-passphrase');
            } else {
                setModalAction('decrypt');
            }
        };
        init();
    }, []);

    const buildKeymaster = async (wallet, passphrase) => {
        const instance = new Keymaster({ gatekeeper, wallet, cipher, passphrase });

        try {
            // check pass & convert to v1 if needed
            await instance.loadWallet();
        } catch {
            setPassphraseErrorText('Incorrect passphrase');
            return;
        }

        setModalAction(null);
        setPendingWallet(null);
        setUploadAction(null);
        setPassphraseErrorText("");
        setKeymaster(instance);
        setKmEpoch((e) => e + 1);
        setIsReady(true);
    };

    async function rebuildKeymaster(passphrase) {
        const walletWeb = new WalletWeb();
        const walletCached = new WalletCache(walletWeb);
        await buildKeymaster(walletCached, passphrase);
    }

    async function handlePassphraseSubmit(passphrase) {
        setPassphraseErrorText("");

        const walletWeb = new WalletWeb();
        const walletMemory = new WalletJsonMemory();

        if (uploadAction && pendingWallet) {
            if (modalAction === 'decrypt') {
                await walletMemory.saveWallet(pendingWallet, true);

                try {
                    const km = new Keymaster({ gatekeeper, wallet: walletMemory, cipher, passphrase });
                    // check pass
                    await km.loadWallet();
                    await walletWeb.saveWallet(pendingWallet, true);
                } catch {
                    setPassphraseErrorText('Incorrect passphrase');
                    return;
                }
            }
        }

        await rebuildKeymaster(passphrase);
    }

    function handleStartReset() {
        setPassphraseErrorText("");
        setShowResetConfirm(true);
    }

    function handleStartRecover() {
        setMnemonicErrorText("");
        setShowRecoverMnemonic(true);
        setPassphraseErrorText("");

        // only nullify modalAction if we are uploading a wallet, otherwise
        // leave passphrase modal open in case the user cancels
        if (uploadAction !== null) {
            setModalAction(null);
        }
    }

    function handleConfirmReset() {
        setShowResetConfirm(false);
        setShowResetSetup(true);
    }

    function handleCancelReset() {
        setShowResetConfirm(false);
    }

    async function handleResetPassphraseSubmit(newPassphrase) {
        try {
            const walletWeb = new WalletWeb();
            const km = new Keymaster({ gatekeeper, wallet: walletWeb, cipher, passphrase: newPassphrase });
            await km.newWallet(undefined, true);
            setShowResetSetup(false);
            await rebuildKeymaster(newPassphrase);
        } catch {
            setPassphraseErrorText('Failed to reset wallet. Try again.');
        }
    }

    async function handleWalletUploadFile(uploaded) {
        setPendingWallet(uploaded);

        if (isWalletEncFile(uploaded)) {
            setUploadAction('upload-enc-v1');
            setModalAction('decrypt');
        } else {
            window.alert('Unsupported wallet type');
        }
    }

    function handleModalClose() {
        setModalAction(null);
        setPendingWallet(null);
        setPassphraseErrorText("");
    }

    async function handleRecoverMnemonicSubmit(mnemonic) {
        setMnemonicErrorText("");
        try {
            const walletWeb = new WalletWeb();
            let stored = pendingWallet && isWalletEncFile(pendingWallet)
                ? pendingWallet
                : await walletWeb.loadWallet();

            if (!isWalletEncFile(stored)) {
                setMnemonicErrorText('Recovery not available for this wallet type.');
                return;
            }

            const hdkey = cipher.generateHDKey(mnemonic);
            const { publicJwk, privateJwk } = cipher.generateJwk(hdkey.privateKey);
            cipher.decryptMessage(publicJwk, privateJwk, stored.enc);

            setRecoveredMnemonic(mnemonic);
            setShowRecoverMnemonic(false);
            setShowRecoverSetup(true);
        } catch {
            setMnemonicErrorText('Mnemonic is incorrect. Try again.');
        }
    }

    async function handleRecoverPassphraseSubmit(newPassphrase) {
        if (!recoveredMnemonic) {
            return;
        }
        try {
            const walletWeb = new WalletWeb();
            const base = pendingWallet && isWalletEncFile(pendingWallet)
                ? pendingWallet
                : await walletWeb.loadWallet();

            if (!isWalletEncFile(base)) {
                setPassphraseErrorText('Recovery not available for this wallet type.');
                return;
            }

            const mnemonicEnc = await encMnemonic(recoveredMnemonic, newPassphrase);
            const updated = {
                version: base.version,
                seed: { mnemonicEnc },
                enc: base.enc
            };

            await walletWeb.saveWallet(updated, true);
            setRecoveredMnemonic("");
            setShowRecoverSetup(false);
            await rebuildKeymaster(newPassphrase);
        } catch {
            setPassphraseErrorText('Failed to update passphrase. Try again.');
        }
    }

    return (
        <>
            <PassphraseModal
                isOpen={modalAction !== null && !showResetSetup && !showRecoverSetup}
                title={modalAction === 'set-passphrase'
                    ? 'Set a Passphrase' : 'Enter Your Wallet Passphrase'}
                errorText={passphraseErrorText}
                onSubmit={handlePassphraseSubmit}
                onClose={handleModalClose}
                encrypt={modalAction === 'set-passphrase'}
                showCancel={pendingWallet !== null}
                upload={uploadAction !== null}
                onStartReset={handleStartReset}
                onStartRecover={
                    modalAction === 'decrypt' &&
                        (uploadAction === null || uploadAction === 'upload-enc-v1')
                        ? handleStartRecover
                        : undefined
                }
            />

            <MnemonicModal
                isOpen={showRecoverMnemonic}
                errorText={mnemonicErrorText}
                onSubmit={handleRecoverMnemonicSubmit}
                onClose={() => setShowRecoverMnemonic(false)}
            />

            <WarningModal
                isOpen={showResetConfirm}
                title="Overwrite wallet with a new one?"
                warningText="This will delete your current wallet data in this browser and create a brand new one."
                onSubmit={handleConfirmReset}
                onClose={handleCancelReset}
            />

            <PassphraseModal
                isOpen={showResetSetup}
                title="Set a Passphrase"
                errorText={passphraseErrorText}
                onSubmit={handleResetPassphraseSubmit}
                onClose={() => setShowResetSetup(false)}
                encrypt={true}
                showCancel={true}
            />

            <PassphraseModal
                isOpen={showRecoverSetup}
                title="Set a New Passphrase"
                errorText={passphraseErrorText}
                onSubmit={handleRecoverPassphraseSubmit}
                onClose={() => setShowRecoverSetup(false)}
                encrypt={true}
                showCancel={true}
            />

            {isReady && keymaster && (
                <KeymasterUI
                    key={`km-${kmEpoch}`}
                    keymaster={keymaster}
                    title={'Keymaster Browser Wallet Demo'}
                    challengeDID={challengeDID}
                    onWalletUpload={handleWalletUploadFile}
                />
            )}
        </>
    );
}

export default App;
