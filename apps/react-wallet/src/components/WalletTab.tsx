import { useState } from "react";
import {
    Box,
    Button,
} from "@mui/material";
import { useWalletContext } from "@didcid/wallet-ui";
import { useSnackbar } from "@didcid/wallet-ui";
import WarningModal from "../modals/WarningModal";
import { MnemonicModal } from "@didcid/wallet-ui";
import PassphraseModal from "../modals/PassphraseModal";
import WalletWeb from "@didcid/keymaster/wallet/web";
import { clearSessionPassphrase, setSessionPassphrase } from "../utils/sessionPassphrase";
import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { FilePicker } from "@capawesome/capacitor-file-picker";
import { Capacitor } from "@capacitor/core";
import PageHeader from "./layout/PageHeader";
import Section from "./layout/Section";
import ActionMenu from "./layout/ActionMenu";

const WalletTab = () => {
    const [open, setOpen] = useState<boolean>(false);
    const [mnemonicString, setMnemonicString] = useState<string>("");
    const [showMnemonicModal, setShowMnemonicModal] = useState<boolean>(false);
    const [pendingRecover, setPendingRecover] = useState<boolean>(false);
    const [checkingWallet, setCheckingWallet] = useState<boolean>(false);
    const [showFixModal, setShowFixModal] = useState<boolean>(false);
    const [checkResultMessage, setCheckResultMessage] = useState<string>("");
    const [showChangePassphrase, setShowChangePassphrase] = useState<boolean>(false);
    const [changePassError, setChangePassError] = useState<string>("");
    const {
        keymaster,
        initialiseWallet,
        handleWalletUploadFile,
        pendingMnemonic,
        setPendingMnemonic,
        pendingWallet,
        setPendingWallet,
    } = useWalletContext();
    const { setError, setSuccess } = useSnackbar();

    const handleClickOpen = () => {
        setOpen(true);
    };

    const handleClose = () => {
        setOpen(false);
        setPendingWallet(null);
        setPendingMnemonic("");
        setPendingRecover(false);
    };

    const handleCloseFixModal = () => {
        setShowFixModal(false);
        setCheckResultMessage("");
    };

    async function createNewWallet() {
        const walletWeb = new WalletWeb();
        localStorage.removeItem(walletWeb.walletName);
        clearSessionPassphrase();
        await initialiseWallet();
    }

    async function checkWallet() {
        if (!keymaster) {
            return;
        }
        setCheckingWallet(true);
        try {
            const { checked, invalid, deleted } = await keymaster.checkWallet();

            if (invalid === 0 && deleted === 0) {
                setSuccess(`${checked} DIDs checked, no problems found`);
            } else {
                const msg =
                    `${checked} DIDs checked.\n` +
                    `${invalid} invalid DIDs found.\n` +
                    `${deleted} deleted DIDs found.\n\n` +
                    `Would you like to fix these?`;
                setCheckResultMessage(msg);
                setShowFixModal(true);
            }
        } catch (error: any) {
            setError(error);
        }
        setCheckingWallet(false);
    }

    async function handleFixWalletConfirm() {
        setShowFixModal(false);
        setCheckResultMessage("");
        if (!keymaster) {
            return;
        }
        try {
            const { idsRemoved, ownedRemoved, heldRemoved, aliasesRemoved } =
                await keymaster.fixWallet();
            setSuccess(
                `${idsRemoved} IDs removed\n${ownedRemoved} owned DIDs removed\n${heldRemoved} held DIDs removed\n${aliasesRemoved} aliases removed`
            );
        } catch (error: any) {
            setError(error);
        }
    }

    async function recoverWallet() {
        if (!keymaster) {
            return;
        }
        await keymaster.recoverWallet();
        await initialiseWallet();
    }

    const handleConfirm = async () => {
        try {
            if (pendingRecover) {
                await recoverWallet();
            } else if (pendingMnemonic) {
                await initialiseWallet();
            } else if (pendingWallet) {
                await handleWalletUploadFile(pendingWallet);
            } else {
                await createNewWallet();
            }
        } catch (error: any) {
            setError(error);
        }

        setOpen(false);
        setPendingRecover(false);
    };

    async function showMnemonic() {
        if (!keymaster) {
            return;
        }
        try {
            const response = await keymaster.decryptMnemonic();
            setMnemonicString(response);
        } catch (error: any) {
            setError(error);
        }
    }

    async function hideMnemonic() {
        setMnemonicString("");
    }

    async function handleUploadClick() {
        try {
            if (Capacitor.isNativePlatform()) {
                // Native file picker on Android
                const result = await FilePicker.pickFiles({
                    types: ["application/json"],
                    readData: true,
                });
                const file = result.files[0];
                if (!file?.data) {
                    return;
                }
                const text = atob(file.data);
                try {
                    const wallet = JSON.parse(text);
                    setPendingWallet(wallet);
                    setOpen(true);
                } catch {
                    setError("Invalid JSON file.");
                }
            } else {
                // Fallback for desktop browsers
                const fileInput = document.createElement("input");
                fileInput.type = "file";
                fileInput.accept = ".json,application/json";
                fileInput.onchange = async (event: any) => {
                    try {
                        const f = event.target.files?.[0];
                        if (!f) return;
                        const text = await f.text();
                        const wallet = JSON.parse(text);
                        setPendingWallet(wallet);
                        setOpen(true);
                    } catch {
                        setError("Invalid JSON file.");
                    }
                };
                fileInput.click();
            }
        } catch (error: any) {
            setError(error);
        }
    }

    async function downloadWallet() {
        if (!keymaster) {
            return;
        }
        try {
            const wallet = await keymaster.exportEncryptedWallet();
            const walletJSON = JSON.stringify(wallet, null, 4);

            if (Capacitor.isNativePlatform()) {
                const result = await Filesystem.writeFile({
                    path: 'archon-wallet.json',
                    data: walletJSON,
                    directory: Directory.Cache,
                    encoding: Encoding.UTF8,
                });
                await Share.share({
                    title: 'Archon Wallet Backup',
                    url: result.uri,
                    dialogTitle: 'Save wallet backup',
                });
            } else {
                // Fallback for desktop browsers
                const blob = new Blob([walletJSON], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = 'archon-wallet.json';
                link.click();
                URL.revokeObjectURL(url);
            }
        } catch (error: any) {
            setError(error);
        }
    }

    async function handleRecoverWallet() {
        setPendingRecover(true);
        setOpen(true);
    }

    async function importWallet() {
        setShowMnemonicModal(true);
    }

    function handleMnemonicSubmit(mnemonic: string) {
        setShowMnemonicModal(false);
        setPendingMnemonic(mnemonic);
        setOpen(true);
    }

    function handleMnemonicModalClose() {
        setShowMnemonicModal(false);
        setPendingMnemonic("");
    }

    async function backupWallet() {
        if (!keymaster) {
            return;
        }
        try {
            await keymaster.backupWallet();
            setSuccess("Wallet backup successful");
        } catch (error: any) {
            setError(error);
        }
    }

    async function handleChangePassphrase(newPassphrase: string) {
        if (!keymaster) {
            return;
        }
        try {
            await keymaster.changePassphrase(newPassphrase);
            setSessionPassphrase(newPassphrase);
            setShowChangePassphrase(false);
            setChangePassError("");
            setSuccess("Passphrase changed");
        } catch (error: any) {
            setChangePassError(error?.message || "Failed to change passphrase");
        }
    }

    return (
        <Box sx={{ overflowX: "hidden" }}>
            <WarningModal
                title="Overwrite wallet"
                warningText="Are you sure you want to overwrite your existing wallet?"
                isOpen={open}
                onClose={handleClose}
                onSubmit={handleConfirm}
            />

            <WarningModal
                title="Fix Wallet?"
                warningText={checkResultMessage}
                isOpen={showFixModal}
                onClose={handleCloseFixModal}
                onSubmit={handleFixWalletConfirm}
            />

            <MnemonicModal
                isOpen={showMnemonicModal}
                onSubmit={handleMnemonicSubmit}
                onClose={handleMnemonicModalClose}
            />

            <PassphraseModal
                isOpen={showChangePassphrase}
                title="Change Passphrase"
                errorText={changePassError}
                onSubmit={handleChangePassphrase}
                onClose={() => { setShowChangePassphrase(false); setChangePassError(""); }}
                encrypt={true}
                showCancel={true}
            />

            <Box
                sx={{
                    position: "sticky",
                    top: 0,
                    zIndex: (t) => t.zIndex.appBar,
                    bgcolor: "background.paper",
                    pb: 1,
                    left: 0,
                    right: 0,
                }}
            >
                <PageHeader
                    title="Wallet"
                    description="Back up, restore and secure the wallet holding your identities."
                    actions={
                        <ActionMenu
                            items={[
                                { label: "Import wallet", onClick: importWallet },
                                { label: "New wallet", onClick: handleClickOpen, destructive: true },
                            ]}
                        />
                    }
                />

                <Section
                    title="Backup and restore"
                    description="Keep a copy of this wallet somewhere safe, or restore one you already have."
                >
                    <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
                        <Button variant="contained" onClick={backupWallet}>Backup</Button>
                        <Button variant="outlined" onClick={handleRecoverWallet}>Recover</Button>
                        <Button variant="outlined" onClick={downloadWallet}>Download</Button>
                        <Button variant="outlined" onClick={handleUploadClick}>Upload</Button>
                    </Box>
                </Section>

                <Section
                    title="Security"
                    description="Your recovery phrase reconstructs this wallet. Only reveal it somewhere private."
                >
                    <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
                        <Button variant="contained" onClick={() => setShowChangePassphrase(true)}>
                            Change Passphrase
                        </Button>
                        {mnemonicString ? (
                            <Button variant="outlined" onClick={hideMnemonic}>Hide Mnemonic</Button>
                        ) : (
                            <Button variant="outlined" onClick={showMnemonic}>Show Mnemonic</Button>
                        )}
                    </Box>
                </Section>

                <Section
                    title="Maintenance"
                    description="Check the wallet for inconsistencies and repair them."
                >
                    <Button variant="outlined" onClick={checkWallet} disabled={checkingWallet}>Check</Button>
                </Section>

                {mnemonicString && (
                    <Box
                        component="pre"
                        sx={{
                            m: 0,
                            px: 2,
                            whiteSpace: "pre-wrap",
                            fontFamily: "inherit",
                        }}
                    >
                        {mnemonicString}
                    </Box>
                )}
            </Box>
        </Box>
    );
};

export default WalletTab;
