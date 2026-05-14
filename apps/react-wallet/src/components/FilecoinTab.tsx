import { useCallback, useEffect, useRef, useState } from "react";
import {
    Box,
    Button,
    Chip,
    CircularProgress,
    Divider,
    FormControlLabel,
    Link,
    Switch,
    Tooltip,
    Typography,
} from "@mui/material";
import { OpenInNew, Refresh } from "@mui/icons-material";
import { useWalletContext, FilecoinPinRecord } from "../contexts/WalletProvider";
import { useVariablesContext } from "../contexts/VariablesProvider";
import { useSnackbar } from "../contexts/SnackbarProvider";

function explorerUrl(opCid: string): string {
    return `https://explore.ipld.io/#/explore/${opCid}`;
}

function statusColor(status: FilecoinPinRecord["status"]): "default" | "info" | "success" | "error" | "warning" {
    switch (status) {
        case "pinned": return "success";
        case "pinning": return "info";
        case "queued": return "warning";
        case "failed": return "error";
        default: return "default";
    }
}

function PinRow({ pin }: { pin: FilecoinPinRecord }) {
    const pieceCid = pin.filecoin?.pieceCid;
    return (
        <Box sx={{ py: 1, display: "flex", flexDirection: "column", gap: 0.5 }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
                <Chip label={pin.status} color={statusColor(pin.status)} size="small" />
                <Typography variant="caption" sx={{ fontFamily: "monospace", wordBreak: "break-all" }}>
                    op: {pin.pin.cid}
                </Typography>
            </Box>
            {pieceCid && (
                <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                    <Typography variant="caption" sx={{ fontFamily: "monospace", wordBreak: "break-all" }}>
                        piece: {pieceCid}
                    </Typography>
                    <Tooltip title="Inspect op on IPLD Explorer">
                        <Link
                            href={explorerUrl(pin.pin.cid)}
                            target="_blank"
                            rel="noopener noreferrer"
                            sx={{ display: "flex", alignItems: "center" }}
                        >
                            <OpenInNew fontSize="inherit" />
                        </Link>
                    </Tooltip>
                </Box>
            )}
            {pin.error && (
                <Typography variant="caption" color="error">{pin.error}</Typography>
            )}
            <Typography variant="caption" color="text.secondary">
                {new Date(pin.created).toLocaleString()} · {pin.pin.did}
            </Typography>
        </Box>
    );
}

function FilecoinTab() {
    const { keymaster, pinToFilecoin, listFilecoinPins } = useWalletContext();
    const { currentId, currentDID } = useVariablesContext();
    const { setError, setSuccess } = useSnackbar();

    const [filecoinEnabled, setFilecoinEnabled] = useState<boolean>(false);
    const [pins, setPins] = useState<FilecoinPinRecord[]>([]);
    const [loadingFlag, setLoadingFlag] = useState<boolean>(false);
    const [pinning, setPinning] = useState<boolean>(false);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const loadPins = useCallback(async () => {
        try {
            const results = await listFilecoinPins();
            setPins(results.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime()));
        } catch (err: any) {
            console.error("Failed to load pins:", err);
        }
    }, [listFilecoinPins]);

    // Poll while any pin is in-flight
    useEffect(() => {
        const hasActive = pins.some(p => p.status === "queued" || p.status === "pinning");
        if (hasActive && !pollRef.current) {
            pollRef.current = setInterval(loadPins, 5000);
        } else if (!hasActive && pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
        }
        return () => {
            if (pollRef.current) {
                clearInterval(pollRef.current);
                pollRef.current = null;
            }
        };
    }, [pins, loadPins]);

    // Load DID's filecoin flag and auto-pin latest op if not already pinned
    useEffect(() => {
        if (!keymaster || !currentId) return;

        setLoadingFlag(true);
        (async () => {
            try {
                const doc = await keymaster.resolveDID(currentId);
                const data = (doc.didDocumentData as Record<string, unknown>) || {};
                const enabled = data.filecoin === true;
                setFilecoinEnabled(enabled);

                if (enabled) {
                    const opCid = (doc.didDocumentMetadata as any)?.versionId as string | undefined;
                    const did = doc.didDocument?.id as string ?? currentId;
                    if (opCid && did) {
                        const existing = await listFilecoinPins();
                        const alreadyPinned = existing.some(p => p.pin.cid === opCid);
                        if (!alreadyPinned) {
                            await pinToFilecoin(opCid, did);
                        }
                        setPins(existing.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime()));
                    }
                }
            } catch {
                setFilecoinEnabled(false);
            } finally {
                setLoadingFlag(false);
            }
        })();

        loadPins();
    }, [keymaster, currentId, listFilecoinPins, pinToFilecoin, loadPins]);

    async function handleToggle(enabled: boolean) {
        if (!keymaster || !currentId) return;
        setPinning(true);
        try {
            // Resolve current data, set or remove the filecoin flag
            const doc = await keymaster.resolveDID(currentId);
            const data = (doc.didDocumentData as Record<string, unknown>) || {};

            if (enabled) {
                await keymaster.mergeData(currentId, { filecoin: true });
            } else {
                await keymaster.mergeData(currentId, { filecoin: null });
                setFilecoinEnabled(false);
                return;
            }

            // Resolve again to get the new versionId (operation CID)
            const updated = await keymaster.resolveDID(currentId);
            const opCid = (updated.didDocumentMetadata as any)?.versionId as string | undefined;

            if (!opCid) {
                throw new Error("Could not determine operation CID from DID metadata");
            }

            const did = updated.didDocument?.id as string ?? currentId;
            await pinToFilecoin(opCid, did);
            setFilecoinEnabled(true);
            setSuccess(`Pinning op ${opCid.slice(0, 12)}… to Filecoin`);
            await loadPins();
        } catch (err: any) {
            setError(err);
            setFilecoinEnabled(!enabled);
        } finally {
            setPinning(false);
        }
    }

    const currentPins = pins.filter(p => p.pin.did === currentDID);

    return (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 2, mt: 1 }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <Typography variant="subtitle1" fontWeight="bold">
                    Filecoin Storage
                </Typography>
                {(loadingFlag || pinning) && <CircularProgress size={16} />}
            </Box>

            {currentId ? (
                <>
                    <FormControlLabel
                        control={
                            <Switch
                                checked={filecoinEnabled}
                                disabled={loadingFlag || pinning}
                                onChange={(e) => handleToggle(e.target.checked)}
                            />
                        }
                        label={
                            <Box>
                                <Typography variant="body2">Pin operations to Filecoin</Typography>
                                <Typography variant="caption" color="text.secondary">
                                    Flags <code>{currentId}</code> — each DID update is pinned on toggle
                                </Typography>
                            </Box>
                        }
                    />

                    <Divider />

                    <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <Typography variant="subtitle2">
                            Pins for this identity ({currentPins.length})
                        </Typography>
                        <Button size="small" startIcon={<Refresh />} onClick={loadPins}>
                            Refresh
                        </Button>
                    </Box>

                    {currentPins.length === 0 ? (
                        <Typography variant="body2" color="text.secondary">
                            No pins yet. Enable the toggle above to pin this identity's operations to Filecoin.
                        </Typography>
                    ) : (
                        <Box>
                            {currentPins.map((pin, i) => (
                                <Box key={pin.requestid}>
                                    <PinRow pin={pin} />
                                    {i < currentPins.length - 1 && <Divider />}
                                </Box>
                            ))}
                        </Box>
                    )}

                    {pins.length > currentPins.length && (
                        <>
                            <Divider />
                            <Typography variant="subtitle2">
                                All pins ({pins.length})
                            </Typography>
                            {pins.map((pin, i) => (
                                <Box key={pin.requestid}>
                                    <PinRow pin={pin} />
                                    {i < pins.length - 1 && <Divider />}
                                </Box>
                            ))}
                        </>
                    )}
                </>
            ) : (
                <Typography variant="body2" color="text.secondary">
                    Select an identity to manage Filecoin pinning.
                </Typography>
            )}
        </Box>
    );
}

export default FilecoinTab;
