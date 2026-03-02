import React, { useCallback, useEffect, useState } from "react";
import {
    Box,
    Button,
    CircularProgress,
    Tab,
    Tabs,
    TextField,
    Typography,
} from "@mui/material";
import { QRCodeSVG } from "qrcode.react";
import { LightningNotConfiguredError } from "@didcid/common/errors";
import { DecodedLightningInvoice } from "@didcid/keymaster/types";
import { useWalletContext } from "../contexts/WalletProvider";
import { useSnackbar } from "../contexts/SnackbarProvider";

const LightningTab: React.FC = () => {
    const { keymaster } = useWalletContext();
    const { setError, setSuccess } = useSnackbar();

    const [activeTab, setActiveTab] = useState<"wallet" | "receive" | "send">("wallet");

    // Wallet sub-tab
    const [balance, setBalance] = useState<number | null>(null);
    const [loadingBalance, setLoadingBalance] = useState<boolean>(false);
    const [isConfigured, setIsConfigured] = useState<boolean | null>(null);

    // Receive sub-tab
    const [receiveAmount, setReceiveAmount] = useState<string>("");
    const [receiveMemo, setReceiveMemo] = useState<string>("");
    const [invoice, setInvoice] = useState<string>("");
    const [loadingInvoice, setLoadingInvoice] = useState<boolean>(false);

    // Send sub-tab
    const [bolt11Input, setBolt11Input] = useState<string>("");
    const [decoded, setDecoded] = useState<DecodedLightningInvoice | null>(null);
    const [loadingDecode, setLoadingDecode] = useState<boolean>(false);
    const [loadingPay, setLoadingPay] = useState<boolean>(false);

    const fetchBalance = useCallback(async () => {
        if (!keymaster) return;
        setLoadingBalance(true);
        try {
            const result = await keymaster.getLightningBalance();
            setBalance(result.balance);
            setIsConfigured(true);
        } catch (err: any) {
            if (err instanceof LightningNotConfiguredError) {
                setIsConfigured(false);
            } else {
                setError(err);
            }
        } finally {
            setLoadingBalance(false);
        }
    }, [keymaster, setError]);

    useEffect(() => {
        if (activeTab === "wallet") {
            fetchBalance();
        }
    }, [activeTab, fetchBalance]);

    async function handleSetupLightning() {
        if (!keymaster) return;
        try {
            await keymaster.addLightning();
            setSuccess("Lightning wallet set up successfully");
            await fetchBalance();
        } catch (err: any) {
            setError(err);
        }
    }

    async function handleCreateInvoice() {
        if (!keymaster) return;
        const amount = parseInt(receiveAmount, 10);
        if (!amount || amount <= 0) {
            setError("Enter a valid amount in satoshis");
            return;
        }
        setLoadingInvoice(true);
        setInvoice("");
        try {
            const result = await keymaster.createLightningInvoice(amount, receiveMemo);
            setInvoice(result.paymentRequest);
        } catch (err: any) {
            setError(err);
        } finally {
            setLoadingInvoice(false);
        }
    }

    async function handleDecode() {
        if (!keymaster || !bolt11Input.trim()) return;
        setLoadingDecode(true);
        setDecoded(null);
        try {
            const result = await keymaster.decodeLightningInvoice(bolt11Input.trim());
            setDecoded(result);
        } catch (err: any) {
            setError(err);
        } finally {
            setLoadingDecode(false);
        }
    }

    async function handlePay() {
        if (!keymaster || !bolt11Input.trim()) return;
        setLoadingPay(true);
        try {
            await keymaster.payLightningInvoice(bolt11Input.trim());
            setSuccess("Payment sent successfully");
            setBolt11Input("");
            setDecoded(null);
        } catch (err: any) {
            setError(err);
        } finally {
            setLoadingPay(false);
        }
    }

    return (
        <Box>
            <Tabs
                value={activeTab}
                onChange={(_, v) => setActiveTab(v)}
                sx={{ borderBottom: 1, borderColor: "divider", mb: 2 }}
            >
                <Tab label="Wallet" value="wallet" />
                <Tab label="Receive" value="receive" />
                <Tab label="Send" value="send" />
            </Tabs>

            {activeTab === "wallet" && (
                <Box sx={{ p: 1 }}>
                    {loadingBalance && <CircularProgress size={24} />}

                    {!loadingBalance && isConfigured === false && (
                        <Box>
                            <Typography sx={{ mb: 2 }}>
                                No Lightning wallet configured for this identity.
                            </Typography>
                            <Button variant="contained" onClick={handleSetupLightning}>
                                Set Up Lightning
                            </Button>
                        </Box>
                    )}

                    {!loadingBalance && isConfigured === true && balance !== null && (
                        <Box>
                            <Typography variant="h6" sx={{ mb: 1 }}>
                                Balance: {balance.toLocaleString()} sats
                            </Typography>
                            <Button variant="outlined" onClick={fetchBalance}>
                                Refresh
                            </Button>
                        </Box>
                    )}
                </Box>
            )}

            {activeTab === "receive" && (
                <Box sx={{ p: 1, display: "flex", flexDirection: "column", gap: 2 }}>
                    <TextField
                        label="Amount (sats)"
                        type="number"
                        value={receiveAmount}
                        onChange={(e) => setReceiveAmount(e.target.value)}
                        slotProps={{ htmlInput: { min: 1 } }}
                        size="small"
                    />
                    <TextField
                        label="Memo (optional)"
                        value={receiveMemo}
                        onChange={(e) => setReceiveMemo(e.target.value)}
                        size="small"
                    />
                    <Box>
                        <Button
                            variant="contained"
                            onClick={handleCreateInvoice}
                            disabled={loadingInvoice}
                        >
                            {loadingInvoice ? <CircularProgress size={20} /> : "Create Invoice"}
                        </Button>
                    </Box>

                    {invoice && (
                        <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
                            <TextField
                                label="BOLT11 Invoice"
                                value={invoice}
                                multiline
                                rows={3}
                                slotProps={{ input: { readOnly: true } }}
                                size="small"
                                onClick={(e) => (e.target as HTMLInputElement).select()}
                            />
                            <Button
                                variant="outlined"
                                size="small"
                                onClick={() => {
                                    navigator.clipboard.writeText(invoice);
                                    setSuccess("Invoice copied to clipboard");
                                }}
                            >
                                Copy
                            </Button>
                            <Box sx={{ mt: 1 }}>
                                <QRCodeSVG value={invoice} size={200} />
                            </Box>
                        </Box>
                    )}
                </Box>
            )}

            {activeTab === "send" && (
                <Box sx={{ p: 1, display: "flex", flexDirection: "column", gap: 2 }}>
                    <TextField
                        label="BOLT11 Invoice"
                        value={bolt11Input}
                        onChange={(e) => {
                            setBolt11Input(e.target.value);
                            setDecoded(null);
                        }}
                        multiline
                        rows={3}
                        size="small"
                    />
                    <Box sx={{ display: "flex", gap: 1 }}>
                        <Button
                            variant="outlined"
                            onClick={handleDecode}
                            disabled={loadingDecode || !bolt11Input.trim()}
                        >
                            {loadingDecode ? <CircularProgress size={20} /> : "Decode"}
                        </Button>
                        {decoded && (
                            <Button
                                variant="contained"
                                onClick={handlePay}
                                disabled={loadingPay}
                            >
                                {loadingPay ? <CircularProgress size={20} /> : "Pay"}
                            </Button>
                        )}
                    </Box>

                    {decoded && (
                        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
                            {decoded.amount !== undefined && (
                                <Typography variant="body2">
                                    <strong>Amount:</strong> {decoded.amount}
                                </Typography>
                            )}
                            {decoded.description && (
                                <Typography variant="body2">
                                    <strong>Description:</strong> {decoded.description}
                                </Typography>
                            )}
                            {decoded.network && (
                                <Typography variant="body2">
                                    <strong>Network:</strong> {decoded.network}
                                </Typography>
                            )}
                            {decoded.created && (
                                <Typography variant="body2">
                                    <strong>Created:</strong> {decoded.created}
                                </Typography>
                            )}
                            {decoded.expires && (
                                <Typography variant="body2">
                                    <strong>Expires:</strong> {decoded.expires}
                                </Typography>
                            )}
                        </Box>
                    )}
                </Box>
            )}
        </Box>
    );
};

export default LightningTab;
