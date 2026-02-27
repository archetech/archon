import React, { useCallback, useEffect, useState } from "react";
import { useWalletContext } from "../contexts/WalletProvider";
import { useSnackbar } from "../contexts/SnackbarProvider";
import { Box, Button, MenuItem, Select, TextField, Typography } from "@mui/material";
import { useUIContext } from "../contexts/UIContext";
import { useVariablesContext } from "../contexts/VariablesProvider";
import { requestBrowserRefresh } from "../utils/utils";
import WarningModal from "../modals/WarningModal";
import TextInputModal from "../modals/TextInputModal";
import type { NostrKeys } from "@didcid/keymaster/types";

function IdentitiesTab() {
    const [name, setName] = useState<string>("");
    const [warningModal, setWarningModal] = useState<boolean>(false);
    const [removeCalled, setRemoveCalled] = useState<boolean>(false);
    const [renameModalOpen, setRenameModalOpen] = useState<boolean>(false);
    const [recoverModalOpen, setRecoverModalOpen] = useState<boolean>(false);
    const [nostrKeys, setNostrKeys] = useState<NostrKeys | null>(null);
    const [removeNostrModal, setRemoveNostrModal] = useState<boolean>(false);
    const [nsecValue, setNsecValue] = useState<string | null>(null);
    const {
        isBrowser,
        keymaster,
    } = useWalletContext();
    const {
        currentId,
        currentDID,
        registry,
        setRegistry,
        registries,
    } = useVariablesContext();
    const {
        refreshAll,
        resetCurrentID,
    } = useUIContext();
    const {
        setError,
        setSuccess,
    } = useSnackbar();

    const handleCreateId = async () => {
        if (!keymaster) {
            return;
        }
        if (!name.trim()) {
            return;
        }
        try {
            await keymaster.createId(name.trim(), { registry });
            await resetCurrentID();
            setName("");
            requestBrowserRefresh(isBrowser);
        } catch (error: any) {
            setError(error);
        }
    };

    function handleRenameId() {
        setRenameModalOpen(true);
    }

    async function renameId(newName: string) {
        if (!keymaster) {
            return;
        }
        setRenameModalOpen(false);
        const name = newName.trim();
        if (!name) {
            setError("Name cannot be empty");
            return;
        }

        try {
            await keymaster.renameId(currentId, name);
            await refreshAll();
        } catch (error: any) {
            setError(error);
        }
    }

    async function rotateKeys() {
        if (!keymaster) {
            return;
        }
        try {
            await keymaster.rotateKeys();
            await refreshAll();
        } catch (error) {
            setError(error);
        }
    }

    const handleCloseWarningModal = () => {
        setWarningModal(false);
    };

    function handleRemoveId() {
        setWarningModal(true);
        setRemoveCalled(false);
    }

    async function removeId() {
        if (!keymaster) {
            return;
        }
        setWarningModal(false);
        // Prevents multiple removals if confirm button spammed
        if (removeCalled) {
            return;
        }
        setRemoveCalled(true);
        try {
            await keymaster.removeId(currentId);
            await refreshAll();
        } catch (error: any) {
            setError(error);
        }
    }

    async function backupId() {
        if (!keymaster) {
            return;
        }
        try {
            const ok = await keymaster.backupId(currentId);

            if (ok) {
                setSuccess(`${currentId} backup succeeded`);
            } else {
                setError(`${currentId} backup failed`);
            }
        } catch (error: any) {
            setError(error);
        }
    }

    async function handleRecoverId() {
        setRecoverModalOpen(true);
    }

    async function recoverId(did: string) {
        setRecoverModalOpen(false);
        if (!did || !keymaster) {
            return;
        }

        try {
            const response = await keymaster.recoverId(did);
            await refreshAll();
            setSuccess(response + " recovered");
        } catch (error: any) {
            setError(error);
        }
    }

    const refreshNostr = useCallback(async () => {
        if (!keymaster || !currentDID) {
            setNostrKeys(null);
            return;
        }
        try {
            const docs = await keymaster.resolveDID(currentDID);
            const data = docs.didDocumentData as Record<string, unknown>;
            setNostrKeys((data.nostr as NostrKeys) || null);
        } catch {
            setNostrKeys(null);
        }
    }, [keymaster, currentDID]);

    useEffect(() => {
        refreshNostr();
    }, [refreshNostr]);

    async function addNostr() {
        if (!keymaster) {
            return;
        }
        try {
            const nostr = await keymaster.addNostr();
            setNostrKeys(nostr);
            setSuccess("Nostr keys added");
        } catch (error: any) {
            setError(error);
        }
    }

    async function removeNostr() {
        if (!keymaster) {
            return;
        }
        setRemoveNostrModal(false);
        try {
            await keymaster.removeNostr();
            setNostrKeys(null);
            setNsecValue(null);
            setSuccess("Nostr keys removed");
        } catch (error: any) {
            setError(error);
        }
    }

    async function showNsec() {
        if (!keymaster) {
            return;
        }
        try {
            const nsec = await keymaster.exportNsec();
            setNsecValue(nsec);
        } catch (error: any) {
            setError(error);
        }
    }

    function hideNsec() {
        setNsecValue(null);
    }

    return (
        <Box>
            <WarningModal
                title="Remove Nostr Keys"
                warningText="Are you sure you want to remove Nostr keys from this identity?"
                isOpen={removeNostrModal}
                onClose={() => setRemoveNostrModal(false)}
                onSubmit={removeNostr}
            />

            <WarningModal
                title="Remove Identity"
                warningText={`Are you sure you want to remove ${currentId}?`}
                isOpen={warningModal}
                onClose={handleCloseWarningModal}
                onSubmit={removeId}
            />

            <TextInputModal
                isOpen={renameModalOpen}
                title="Rename Identity"
                description={`Rename ${currentId} to`}
                label="New Name"
                confirmText="Rename"
                onSubmit={renameId}
                onClose={() => setRenameModalOpen(false)}
            />

            <TextInputModal
                isOpen={recoverModalOpen}
                title="Recover Identity"
                description="Please enter the DID"
                label="DID"
                confirmText="Recover"
                onSubmit={recoverId}
                onClose={() => setRecoverModalOpen(false)}
            />

            <Box className="flex-box mt-2">
                <TextField
                    label="Create ID"
                    variant="outlined"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    size="small"
                    className="text-field name"
                    slotProps={{
                        htmlInput: {
                            maxLength: 30,
                        },
                    }}
                />

                <Select
                    value={registries.includes(registry) ? registry : ""}
                    onChange={(e) => setRegistry(e.target.value)}
                    size="small"
                    variant="outlined"
                    className="select-small"
                >
                    {registries.map((r) => (
                        <MenuItem key={r} value={r}>
                            {r}
                        </MenuItem>
                    ))}
                </Select>

                <Button
                    variant="contained"
                    onClick={handleCreateId}
                    size="small"
                    className="button-right"
                >
                    Create
                </Button>
            </Box>
            {currentId && (
                <Box display="flex" flexDirection="row" sx={{ gap: 1, mt: 2, flexWrap: 'wrap' }}>
                    <Button
                        variant="contained"
                        color="primary"
                        onClick={handleRenameId}
                    >
                        Rename
                    </Button>

                    <Button
                        variant="contained"
                        color="primary"
                        onClick={handleRemoveId}
                    >
                        Remove
                    </Button>

                    <Button
                        variant="contained"
                        color="primary"
                        onClick={backupId}
                    >
                        Backup
                    </Button>

                    <Button
                        variant="contained"
                        color="primary"
                        onClick={handleRecoverId}
                    >
                        Recover
                    </Button>

                    <Button
                        variant="contained"
                        color="primary"
                        onClick={rotateKeys}
                    >
                        Rotate
                    </Button>

                    {nostrKeys ? (
                        <Button
                            variant="contained"
                            color="error"
                            onClick={() => setRemoveNostrModal(true)}
                            sx={{ whiteSpace: 'nowrap' }}
                        >
                            Remove Nostr
                        </Button>
                    ) : (
                        <Button
                            variant="contained"
                            color="primary"
                            onClick={addNostr}
                            sx={{ whiteSpace: 'nowrap' }}
                        >
                            Add Nostr
                        </Button>
                    )}
                    {nostrKeys && (
                        nsecValue ? (
                            <Button
                                variant="contained"
                                color="warning"
                                onClick={hideNsec}
                                sx={{ whiteSpace: 'nowrap' }}
                            >
                                Hide nsec
                            </Button>
                        ) : (
                            <Button
                                variant="contained"
                                color="warning"
                                onClick={showNsec}
                                sx={{ whiteSpace: 'nowrap' }}
                            >
                                Show nsec
                            </Button>
                        )
                    )}
                </Box>
            )}
            {currentId && nostrKeys && (
                <Box sx={{ mt: 1 }}>
                    <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
                        npub: {nostrKeys.npub}
                    </Typography>
                    <br />
                    <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
                        pubkey: {nostrKeys.pubkey}
                    </Typography>
                    {nsecValue && (
                        <>
                            <br />
                            <Typography variant="caption" color="error" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
                                nsec: {nsecValue}
                            </Typography>
                        </>
                    )}
                </Box>
            )}
        </Box>
    );
}

export default IdentitiesTab;
