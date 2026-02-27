import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Button, Checkbox, FormControlLabel, Typography, CircularProgress } from "@mui/material";
import { useWalletContext } from "../contexts/WalletProvider";
import { useVariablesContext } from "../contexts/VariablesProvider";

interface NostrApprovalProps {
    requestId: string;
    autoApprove?: boolean;
}

export default function NostrApproval({ requestId, autoApprove }: NostrApprovalProps) {
    const { keymaster } = useWalletContext();
    const { currentDID } = useVariablesContext();
    const [method, setMethod] = useState<string>("");
    const [params, setParams] = useState<any>(null);
    const [origin, setOrigin] = useState<string>("");
    const [loading, setLoading] = useState<boolean>(true);
    const [processing, setProcessing] = useState<boolean>(false);
    const [alwaysApprove, setAlwaysApprove] = useState<boolean>(false);
    const autoApproved = useRef(false);

    useEffect(() => {
        document.documentElement.style.overflow = "hidden";
        document.body.style.overflow = "hidden";
    }, []);

    useEffect(() => {
        chrome.runtime.sendMessage(
            { action: "GET_NOSTR_REQUEST", id: requestId },
            (response) => {
                if (response && !response.error) {
                    setMethod(response.method);
                    setParams(response.params);
                    setOrigin(response.origin || "unknown");
                }
                setLoading(false);
            }
        );
    }, [requestId]);

    const handleApprove = useCallback(async () => {
        if (!keymaster) {
            sendError("Wallet not initialized");
            return;
        }
        setProcessing(true);
        try {
            if (alwaysApprove) {
                chrome.runtime.sendMessage({ action: "APPROVE_NOSTR_ORIGIN", origin });
            }
            let result: any;
            if (method === "getPublicKey") {
                const doc = await keymaster.resolveDID(currentDID);
                const data = doc.didDocumentData as Record<string, any>;
                if (!data?.nostr?.pubkey) {
                    sendError("No Nostr keys found. Add Nostr keys first.");
                    return;
                }
                result = data.nostr.pubkey;
            } else if (method === "signEvent") {
                const signed = await keymaster.signNostrEvent(params);
                result = signed;
            } else {
                sendError(`Unsupported method: ${method}`);
                return;
            }
            chrome.runtime.sendMessage({
                action: "NOSTR_RESPONSE",
                id: requestId,
                result,
            }, () => window.close());
        } catch (error: any) {
            sendError(error?.message || String(error));
        }
    }, [keymaster, method, params, currentDID, requestId, alwaysApprove, origin]);

    // Auto-approve when ready (getPublicKey or remembered origin)
    useEffect(() => {
        if (autoApprove && !loading && method && keymaster && !autoApproved.current) {
            autoApproved.current = true;
            handleApprove();
        }
    }, [autoApprove, loading, method, keymaster, handleApprove]);

    function sendError(error: string) {
        setProcessing(false);
        chrome.runtime.sendMessage({
            action: "NOSTR_RESPONSE",
            id: requestId,
            error,
        }, () => window.close());
    }

    function handleDeny() {
        sendError("User denied the request");
    }

    // Don't render UI for auto-approved requests
    if (autoApprove) {
        return (
            <Box display="flex" justifyContent="center" alignItems="center" height="100%">
                <CircularProgress />
            </Box>
        );
    }

    if (loading) {
        return (
            <Box display="flex" justifyContent="center" alignItems="center" height="100%">
                <CircularProgress />
            </Box>
        );
    }

    return (
        <Box sx={{ p: 2.5 }}>
            <Typography variant="h6" gutterBottom>
                Nostr Request
            </Typography>
            <Typography variant="body2" color="text.secondary" gutterBottom>
                Origin: {origin}
            </Typography>
            <Typography variant="body1" sx={{ mt: 2, mb: 1 }}>
                <strong>{method === "getPublicKey" ? "Get Public Key" : "Sign Event"}</strong>
            </Typography>
            {method === "signEvent" && params && (
                <Box sx={{ mt: 1, mb: 2, p: 1.5, bgcolor: "action.hover", borderRadius: 1, maxHeight: 160, overflow: "auto" }}>
                    <Typography variant="caption" sx={{ fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                        Kind: {params.kind}{"\n"}
                        Content: {params.content?.substring(0, 200)}{params.content?.length > 200 ? "..." : ""}
                    </Typography>
                </Box>
            )}
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                {method === "getPublicKey"
                    ? "This site wants to know your Nostr public key."
                    : "This site wants to sign a Nostr event with your key."}
            </Typography>
            <FormControlLabel
                control={
                    <Checkbox
                        checked={alwaysApprove}
                        onChange={(e) => setAlwaysApprove(e.target.checked)}
                        size="small"
                    />
                }
                label={<Typography variant="body2">Always approve for this site</Typography>}
                sx={{ mt: 0.5, mb: 1 }}
            />
            <Box display="flex" gap={1} justifyContent="flex-end">
                <Button
                    variant="outlined"
                    onClick={handleDeny}
                    disabled={processing}
                >
                    Deny
                </Button>
                <Button
                    variant="contained"
                    color="primary"
                    onClick={handleApprove}
                    disabled={processing || !keymaster}
                >
                    {processing ? <CircularProgress size={20} /> : "Approve"}
                </Button>
            </Box>
        </Box>
    );
}
