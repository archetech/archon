import { useEffect, useState } from "react";
import { Box, Button, IconButton, InputAdornment, TextField, Tooltip } from "@mui/material";
import { CameraAlt } from "@mui/icons-material";
import { WarningModal } from "@didcid/wallet-ui";
import { useWalletContext } from "@didcid/wallet-ui";
import { useVariablesContext } from "@didcid/wallet-ui";
import { useUIContext } from "../contexts/UIContext";
import { useSnackbar } from "@didcid/wallet-ui";
import JsonViewer from "./JsonViewer";
import { DisplayDID } from "@didcid/wallet-ui";
import {scanQrCode} from "../utils/utils";
import { Badge } from "@mui/icons-material";
import { Section } from "@didcid/wallet-ui";
import { EmptyState } from "@didcid/wallet-ui";
import { ActionMenu } from "@didcid/wallet-ui";

function HeldTab() {
    const [open, setOpen] = useState<boolean>(false);
    const [loading, setLoading] = useState<boolean>(false);
    const [removeDID, setRemoveDID] = useState<string>("");
    const [heldDID, setHeldDID] = useState<string>("");
    const { keymaster } = useWalletContext();
    const { setError, setWarning } = useSnackbar();
    const {
        heldList,
        manifest,
    } = useVariablesContext();
    const {
        updateManifest,
        pendingHeldDID,
        setPendingHeldDID,
        setOpenBrowser,
        refreshHeld,
    } = useUIContext();

    useEffect(() => {
        if (pendingHeldDID) {
            setHeldDID(pendingHeldDID);
            setPendingHeldDID(null);
        }
    }, [pendingHeldDID, setHeldDID, setPendingHeldDID]);

    async function acceptCredential() {
        if (!keymaster) {
            return;
        }
        try {
            const ok = await keymaster.acceptCredential(heldDID);
            if (ok) {
                await refreshHeld();
                setHeldDID("");
            } else {
                setWarning("Credential not accepted");
            }
        } catch (error: any) {
            setError(error);
        }
    }

    async function decryptCredential(did: string) {
        if (!keymaster) {
            return;
        }
        try {
            const doc = await keymaster.getCredential(did);
            displayJson(did, doc);
        } catch (error: any) {
            setError(error);
        }
    }

    async function publishCredential(did: string) {
        if (!keymaster) {
            return;
        }
        try {
            await keymaster.publishCredential(did, { reveal: false });
            await updateManifest();
            await decryptCredential(did);
        } catch (error: any) {
            setError(error);
        }
    }

    async function revealCredential(did: string) {
        if (!keymaster) {
            return;
        }
        try {
            await keymaster.publishCredential(did, { reveal: true });
            await updateManifest();
            await decryptCredential(did);
        } catch (error: any) {
            setError(error);
        }
    }

    async function unpublishCredential(did: string) {
        if (!keymaster) {
            return;
        }
        try {
            await keymaster.unpublishCredential(did);
            await updateManifest();
            await decryptCredential(did);
        } catch (error: any) {
            setError(error);
        }
    }

    const handleRemoveOpen = () => {
        if (!loading) {
            setOpen(true);
        }
    };

    const handleRemoveClose = () => {
        setOpen(false);
    };

    const handleRemoveConfirm = async () => {
        if (!keymaster) {
            return;
        }
        setLoading(true);
        try {
            await keymaster.removeCredential(removeDID);
            await refreshHeld();
        } catch (error: any) {
            setError(error);
        } finally {
            setOpen(false);
            setLoading(false);
            setRemoveDID("");
        }
    };

    function credentialPublished(did: string) {
        if (!manifest) {
            return false;
        }

        if (!manifest[did]) {
            return false;
        }

        const castManifest = manifest[did] as { credential?: string };

        return castManifest.credential === null;
    }

    function credentialRevealed(did: string) {
        if (!manifest) {
            return false;
        }

        if (!manifest[did]) {
            return false;
        }

        const castManifest = manifest[did] as { credential?: string };

        return castManifest.credential !== null;
    }

    function credentialUnpublished(did: string) {
        if (!manifest) {
            return true;
        }

        return !manifest[did];
    }

    async function clearHeldDID() {
        setHeldDID("");
    }

    function displayJson(did: string, contents?: any) {
        setOpenBrowser({
            did,
            contents,
            tab: "credentials",
            subTab: "held",
        });
    }

    async function scanCredentialQR() {
        const qr = await scanQrCode();
        if (!qr) {
            setError("Failed to scan QR code");
            return;
        }

        setHeldDID(qr);
    }

    return (
        <Box>
            <WarningModal
                title="Remove Credential"
                warningText="Are you sure you want to remove the credential?"
                isOpen={open}
                onClose={handleRemoveClose}
                onSubmit={handleRemoveConfirm}
            />

            <Box className="flex-box">
                <TextField
                    label="Accept Credential DID"
                    variant="outlined"
                    value={heldDID}
                    onChange={(e) => setHeldDID(e.target.value)}
                    size="small"
                    className="text-field top"
                    slotProps={{
                        htmlInput: {
                            maxLength: 80,
                        },
                        input: {
                            endAdornment: (
                                <InputAdornment position="end">
                                    <Tooltip title="Scan QR" placement="top">
                                        <span>
                                            <IconButton
                                                edge="end"
                                                onClick={scanCredentialQR}
                                            >
                                                <CameraAlt />
                                            </IconButton>
                                        </span>
                                    </Tooltip>
                                </InputAdornment>
                            ),
                        }
                    }}
                />
            </Box>

            <Box className="flex-box">
                <Button
                    variant="contained"
                    color="primary"
                    onClick={() => displayJson(heldDID)}
                    className="button large bottom"
                    disabled={!heldDID}
                >
                    Resolve
                </Button>

                <Button
                    variant="contained"
                    color="primary"
                    onClick={() => decryptCredential(heldDID)}
                    className="button large bottom"
                    disabled={!heldDID}
                >
                    Decrypt
                </Button>

                <Button
                    variant="contained"
                    color="primary"
                    onClick={acceptCredential}
                    className="button large bottom"
                    disabled={!heldDID}
                >
                    Accept
                </Button>

                <Button
                    variant="contained"
                    color="primary"
                    onClick={clearHeldDID}
                    className="button large bottom"
                    disabled={!heldDID}
                >
                    Clear
                </Button>
            </Box>

            <Box className="overflow-box">
                {heldList.length === 0 ? (
                    <Section>
                        <EmptyState
                            icon={<Badge />}
                            title="No credentials held"
                            description="Credentials issued to your identities will appear here once accepted."
                        />
                    </Section>
                ) : heldList.map((did) => (
                    <Section key={did}>
                        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 2, flexWrap: "wrap" }}>
                            <Box sx={{ minWidth: 0, flex: 1 }}>
                                <DisplayDID did={did} />
                            </Box>

                            <Box sx={{ display: "flex", gap: 1, flexShrink: 0 }}>
                                <Button variant="outlined" onClick={() => displayJson(did)}>
                                    Resolve
                                </Button>
                                <ActionMenu
                                    items={[
                                        { label: "Decrypt", onClick: () => decryptCredential(did) },
                                        { label: "Publish", onClick: () => publishCredential(did), disabled: credentialPublished(did) },
                                        { label: "Reveal", onClick: () => revealCredential(did), disabled: credentialRevealed(did) },
                                        { label: "Unpublish", onClick: () => unpublishCredential(did), disabled: credentialUnpublished(did) },
                                        {
                                            label: "Remove",
                                            onClick: () => { handleRemoveOpen(); setRemoveDID(did); },
                                            disabled: !credentialUnpublished(did),
                                            destructive: true,
                                        },
                                    ]}
                                />
                            </Box>
                        </Box>
                    </Section>
                ))}
            </Box>
            <JsonViewer browserTab="credentials" browserSubTab="held" />
        </Box>
    );
}

export default HeldTab;
