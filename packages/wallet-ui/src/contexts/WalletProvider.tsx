import {
    createContext,
    Dispatch,
    ReactNode,
    SetStateAction,
    useContext,
    useEffect,
    useRef,
    useState,
} from "react";
import DrawbridgeClient from "@didcid/clients/drawbridge";
import Keymaster from "@didcid/keymaster";
import { WalletBase, StoredWallet } from '@didcid/keymaster/types';
import { isWalletEncFile } from '@didcid/keymaster/wallet/typeGuards';
import CipherWeb from "@didcid/cipher";
import WalletJsonMemory from "@didcid/keymaster/wallet/json-memory";
import { encryptWithPassphrase } from '@didcid/cipher/passphrase';

const gatekeeper = new DrawbridgeClient();
const cipher = new CipherWeb();

interface WalletContextValue {
    pendingMnemonic: string;
    setPendingMnemonic: Dispatch<SetStateAction<string>>;
    pendingWallet: unknown;
    setPendingWallet: Dispatch<SetStateAction<unknown>>;
    initialiseServices: () => Promise<void>;
    initialiseWallet: () => Promise<void>;
    handleWalletUploadFile: (uploaded: unknown) => Promise<void>;
    refreshFlag: number;
    keymaster: Keymaster | null;
    hasLightning: boolean;
    hasDidComm: boolean;
    // Extension-only host mode; false in a wallet that has no full-page view.
    isBrowser: boolean;
    reloadBrowserWallet: () => Promise<void>;
}

// Where the passphrase lives between sessions. react-wallet keeps it in its own
// session storage; the extension's popup is destroyed on close, so it asks the
// background script. Neither belongs in shared code.
export interface WalletSession {
    get: () => string | Promise<string>;
    set: (passphrase: string) => void | Promise<void>;
    clear: () => void | Promise<void>;
}

// The modals are injected as components rather than shared, because the two
// wallets style their dialogs differently (#893 restyled react-wallet's and not
// the extension's) and a refactor should not quietly restyle either. Only the
// props this provider passes are specified here.
export interface WalletModalComponents {
    Passphrase: React.ComponentType<any>;
    Warning: React.ComponentType<any>;
    Mnemonic: React.ComponentType<any>;
}

export interface WalletProviderProps {
    children: ReactNode;
    // The wallet backend: WalletWeb in a page, WalletChrome in an extension.
    walletStore: WalletBase;
    session: WalletSession;
    // Resolved per app: localStorage here, chrome.storage.sync there.
    resolveGatekeeperUrl: () => string | Promise<string>;
    modals: WalletModalComponents;
    // Extension-only: its full-page view behaves differently from its popup.
    // Undefined in a wallet that has no such mode.
    isBrowser?: boolean;
}

const WalletContext = createContext<WalletContextValue | null>(null);

const INCORRECT_PASSPHRASE = "Incorrect passphrase";

export function WalletProvider(
    { children, walletStore, session, resolveGatekeeperUrl, modals, isBrowser = false }: WalletProviderProps
) {
    const { Passphrase: PassphraseModal, Warning: WarningModal, Mnemonic: MnemonicModal } = modals;
    const [passphraseErrorText, setPassphraseErrorText] = useState<string>("");
    const [pendingMnemonic, setPendingMnemonic] = useState<string>("");
    const [pendingWallet, setPendingWallet] = useState<unknown>(null);
    const [modalAction, setModalAction] = useState<null | "decrypt" | "set-passphrase">(null);
    const [uploadAction, setUploadAction] = useState<null | "upload-enc-v1">(null);
    const [isReady, setIsReady] = useState<boolean>(false);
    const [showResetConfirm, setShowResetConfirm] = useState<boolean>(false);
    const [showResetSetup, setShowResetSetup] = useState<boolean>(false);
    const [showRecoverMnemonic, setShowRecoverMnemonic] = useState(false);
    const [mnemonicErrorText, setMnemonicErrorText] = useState("");
    const [recoveredMnemonic, setRecoveredMnemonic] = useState("");
    const [showRecoverSetup, setShowRecoverSetup] = useState(false);
    const [refreshFlag, setRefreshFlag] = useState<number>(0);
    const [hasLightning, setHasLightning] = useState<boolean>(false);
    // Unknown (a node that serves no capability manifest) is permissive, matching
    // the gate inside Keymaster: show the surface and let the operation fail late
    // rather than hiding it against every older node.
    const [hasDidComm, setHasDidComm] = useState<boolean>(true);

    const keymasterRef = useRef<Keymaster | null>(null);

    useEffect(() => {
        async function init() {
            await initialiseServices()
            await initialiseWallet();
        }
        init();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    async function initialiseWallet() {
        const walletData = await walletStore.loadWallet();

        const pass = await session.get();
        if (!pendingMnemonic && pass) {
            const res = await rebuildKeymaster(pass);
            if (res) {
                return;
            }
            setPassphraseErrorText("");
            await session.clear();
        }

        if (!walletData || pendingMnemonic) {
            // eslint-disable-next-line sonarjs/no-duplicate-string
            setModalAction('set-passphrase');
        } else {
            setModalAction('decrypt');
        }
    }

    async function initialiseServices() {
        try {
            const gatekeeperUrl = await resolveGatekeeperUrl();
            await gatekeeper.connect({ url: gatekeeperUrl });
            setHasLightning(await gatekeeper.isLightningSupported());
        } catch (error) {
            console.error('Failed to connect to gatekeeper:', error);
        }
    }

    const buildKeymaster = async (wallet: WalletBase, passphrase: string) => {
        const instance = new Keymaster({ gatekeeper, wallet, cipher, passphrase });

        if (pendingMnemonic) {
            await instance.newWallet(pendingMnemonic, true);
            await instance.recoverWallet();
        } else {
            try {
                // check pass & convert to v1 if needed
                await instance.loadWallet();
            } catch (error: any) {
                const message = error?.message || String(error);
                if (message.includes('Incorrect passphrase')) {
                    setPassphraseErrorText(INCORRECT_PASSPHRASE);
                } else {
                    setPassphraseErrorText(message);
                }
                return false;
            }
        }

        setModalAction(null);
        setPendingWallet(null);
        setPendingMnemonic("");
        setUploadAction(null);
        setPassphraseErrorText("");
        keymasterRef.current = instance;
        try {
            const capabilities = await instance.getNodeCapabilities();
            setHasDidComm(capabilities?.didcomm !== false);
        } catch (error) {
            console.error('Failed to read node capabilities:', error);
        }
        setRefreshFlag(r => r + 1);
        setIsReady(true);
        await session.set(passphrase);

        return true;
    };

    async function rebuildKeymaster(passphrase: string) {
        return await buildKeymaster(walletStore, passphrase);
    }

    async function handlePassphraseSubmit(passphrase: string) {
        setPassphraseErrorText("");

        const walletMemory = new WalletJsonMemory();

        if (uploadAction && pendingWallet && modalAction === 'decrypt') {
            await walletMemory.saveWallet(pendingWallet as StoredWallet, true);

            try {
                const km = new Keymaster({ gatekeeper, wallet: walletMemory, cipher, passphrase });
                // check pass
                await km.loadWallet();
                await walletStore.saveWallet(pendingWallet as StoredWallet, true);
            } catch (error: any) {
                const message = error?.message || String(error);
                if (message.includes('Incorrect passphrase')) {
                    setPassphraseErrorText(INCORRECT_PASSPHRASE);
                } else {
                    setPassphraseErrorText(message);
                }
                return;
            }
        }

        await rebuildKeymaster(passphrase);
    }

    async function handlePassphraseClose() {
        setPendingWallet(null);
        setPendingMnemonic("");
        setPassphraseErrorText("");

        const walletData = await walletStore.loadWallet();
        if (walletData) {
            setModalAction(null);
        }
    }

    // Deep links (archon:// URLs opened by the OS) are react-wallet's alone --
    // it is the Capacitor app that can be launched by one. That handling lives
    // in its own useDeepLinks hook rather than here, so this provider carries no
    // code the other wallet can never run.

    // The extension's full-page view can be reloaded while the popup holds the
    // passphrase; a wallet with no such mode leaves isBrowser false and this is
    // a no-op.
    async function reloadBrowserWallet() {
        if (!isBrowser) {
            return;
        }

        const pass = await session.get();
        if (!pass) {
            return;
        }

        await rebuildKeymaster(pass);
    }

    async function handleWalletUploadFile(uploaded: unknown) {
        setPendingWallet(uploaded);

        if (isWalletEncFile(uploaded)) {
            setUploadAction('upload-enc-v1');
            setModalAction('decrypt');
        } else {
            window.alert('Unsupported wallet type');
        }
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

    async function handleResetPassphraseSubmit(newPassphrase: string) {
        try {
            const km = new Keymaster({ gatekeeper, wallet: walletStore, cipher, passphrase: newPassphrase });
            await km.newWallet(undefined, true);
            setShowResetSetup(false);
            await rebuildKeymaster(newPassphrase);
        } catch {
            setPassphraseErrorText('Failed to reset wallet. Try again.');
        }
    }

    async function handleRecoverMnemonicSubmit(mnemonic: string) {
        setMnemonicErrorText("");
        try {
            let stored = pendingWallet && isWalletEncFile(pendingWallet)
                ? pendingWallet
                : await walletStore.loadWallet();

            if (!isWalletEncFile(stored)) {
                setMnemonicErrorText('Recovery not available for this wallet type.');
                return;
            }

            const hdkey = cipher.generateHDKey(mnemonic);
            const { publicJwk, privateJwk } = cipher.generateJwk(hdkey.privateKey!);
            cipher.decryptMessage(privateJwk, stored.enc, publicJwk);

            setRecoveredMnemonic(mnemonic);
            setShowRecoverMnemonic(false);
            setShowRecoverSetup(true);
        } catch {
            setMnemonicErrorText('Mnemonic is incorrect. Try again.');
        }
    }

    async function handleRecoverPassphraseSubmit(newPassphrase: string) {
        if (!recoveredMnemonic) {
            return;
        }
        try {
            const base = pendingWallet && isWalletEncFile(pendingWallet)
                ? pendingWallet
                : await walletStore.loadWallet();

            if (!isWalletEncFile(base)) {
                setPassphraseErrorText('Recovery not available for this wallet type.');
                return;
            }

            const mnemonicEnc = await encryptWithPassphrase(recoveredMnemonic, newPassphrase);
            const updated = {
                version: base.version,
                seed: { mnemonicEnc },
                enc: base.enc
            };

            await walletStore.saveWallet(updated, true);
            setRecoveredMnemonic("");
            setShowRecoverSetup(false);
            await rebuildKeymaster(newPassphrase);
        } catch {
            setPassphraseErrorText('Failed to update passphrase. Try again.');
        }
    }

    const value: WalletContextValue = {
        pendingMnemonic,
        setPendingMnemonic,
        pendingWallet,
        setPendingWallet,
        initialiseServices,
        initialiseWallet,
        handleWalletUploadFile,
        refreshFlag,
        keymaster: keymasterRef.current,
        hasLightning,
        hasDidComm,
        isBrowser,
        reloadBrowserWallet,
    };

    return (
        <>
            <PassphraseModal
                isOpen={modalAction !== null && !showResetSetup && !showRecoverSetup}
                title={modalAction === 'set-passphrase'
                    ? 'Set a Passphrase' : 'Enter Your Wallet Passphrase'}
                errorText={passphraseErrorText}
                onSubmit={handlePassphraseSubmit}
                onClose={handlePassphraseClose}
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

            {isReady && (
                <WalletContext.Provider value={value}>
                    {children}
                </WalletContext.Provider>
            )}
        </>
    );
}

export function useWalletContext() {
    const context = useContext(WalletContext);
    if (!context) {
        throw new Error("Failed to get context from WalletContext.Provider");
    }
    return context;
}
