import React, { useCallback, useEffect, useState } from "react";
import {
    Autocomplete,
    Box,
    Button,
    Checkbox,
    CircularProgress,
    FormControlLabel,
    Tab,
    Tabs,
    TextField,
    Typography,
} from "@mui/material";
import { QRCodeSVG } from "qrcode.react";
import { LightningNotConfiguredError } from "@didcid/common/errors";
import { DecodedLightningInvoice, LightningPaymentRecord, LightningPaymentStatus } from "@didcid/keymaster/types";
import { useWalletContext } from "../contexts/WalletProvider";
import { useVariablesContext } from "../contexts/VariablesProvider";
import { useSnackbar } from "../contexts/SnackbarProvider";

const LightningTab: React.FC = () => {
    const { keymaster } = useWalletContext();
    const { currentDID, agentList } = useVariablesContext();
    const { setError, setSuccess } = useSnackbar();

    const [activeTab, setActiveTab] = useState<"wallet" | "payments" | "receive" | "send" | "zap">("wallet");

    // Wallet sub-tab
    const [balance, setBalance] = useState<number | null>(null);
    const [loadingBalance, setLoadingBalance] = useState<boolean>(false);
    const [isConfigured, setIsConfigured] = useState<boolean | null>(null);
    const [walletError, setWalletError] = useState<string | null>(null);

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
    const [paymentResult, setPaymentResult] = useState<LightningPaymentStatus | null>(null);

    // Zap sub-tab
    const [zapDid, setZapDid] = useState<string>("");
    const [zapAmount, setZapAmount] = useState<string>("");
    const [zapMemo, setZapMemo] = useState<string>("");
    const [loadingZap, setLoadingZap] = useState<boolean>(false);
    const [zapResult, setZapResult] = useState<LightningPaymentStatus | null>(null);

    // Payments sub-tab
    const [payments, setPayments] = useState<LightningPaymentRecord[]>([]);
    const [loadingPayments, setLoadingPayments] = useState<boolean>(false);
    const [statusFilter, setStatusFilter] = useState({ settled: true, pending: true, failed: true, expired: true });

    // Publish state
    const [isPublished, setIsPublished] = useState<boolean>(false);
    const [loadingPublishToggle, setLoadingPublishToggle] = useState<boolean>(false);

    const fetchBalance = useCallback(async () => {
        if (!keymaster) return;
        setLoadingBalance(true);
        setWalletError(null);
        try {
            const result = await keymaster.getLightningBalance();
            setBalance(result.balance);
            setIsConfigured(true);
            // Check publish state
            if (currentDID) {
                try {
                    const doc = await keymaster.resolveDID(currentDID);
                    const services = doc?.didDocument?.service || [];
                    setIsPublished(services.some((s: any) => s.id?.endsWith('#lightning')));
                } catch { /* ignore resolve errors */ }
            }
        } catch (err: any) {
            if (err instanceof LightningNotConfiguredError) {
                setIsConfigured(false);
            } else {
                setIsConfigured(true);
                setWalletError(err.message || err.error || JSON.stringify(err));
            }
        } finally {
            setLoadingBalance(false);
        }
    }, [keymaster, currentDID]);

    const fetchPayments = useCallback(async () => {
        if (!keymaster) return;
        setLoadingPayments(true);
        try {
            const result = await keymaster.getLightningPayments();
            setPayments(result);
        } catch (err: any) {
            setError(err);
        } finally {
            setLoadingPayments(false);
        }
    }, [keymaster, setError]);

    useEffect(() => {
        if (activeTab === "wallet") {
            fetchBalance();
        } else if (activeTab === "payments") {
            fetchPayments();
        }
    }, [activeTab, fetchBalance, fetchPayments]);

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

    async function handleDisconnectLightning() {
        if (!keymaster) return;
        try {
            await keymaster.removeLightning();
            setBalance(null);
            setIsConfigured(false);
            setSuccess("Lightning wallet disconnected");
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
        setPaymentResult(null);
        try {
            const payment = await keymaster.payLightningInvoice(bolt11Input.trim());
            const status = await keymaster.checkLightningPayment(payment.paymentHash);
            setPaymentResult(status);
            setSuccess("Payment sent successfully");
            setBolt11Input("");
            setDecoded(null);
        } catch (err: any) {
            if (decoded?.payment_hash) {
                try {
                    const status = await keymaster.checkLightningPayment(decoded.payment_hash);
                    if (status.paid) {
                        setPaymentResult(status);
                        setSuccess("Invoice was already paid");
                        return;
                    }
                } catch { /* fall through to original error */ }
            }
            setError(err);
        } finally {
            setLoadingPay(false);
        }
    }

    async function handleTogglePublish() {
        if (!keymaster) return;
        setLoadingPublishToggle(true);
        try {
            if (isPublished) {
                await keymaster.unpublishLightning();
                setIsPublished(false);
                setSuccess("Lightning unpublished — your DID is no longer zappable");
            } else {
                await keymaster.publishLightning();
                setIsPublished(true);
                setSuccess("Lightning published — your DID is now zappable");
            }
        } catch (err: any) {
            setError(err);
        } finally {
            setLoadingPublishToggle(false);
        }
    }

    async function handleZap() {
        if (!keymaster) return;
        if (!zapDid.trim()) {
            setError("Enter a recipient");
            return;
        }
        const amount = parseInt(zapAmount, 10);
        if (!amount || amount <= 0) {
            setError("Enter a valid amount in satoshis");
            return;
        }
        setLoadingZap(true);
        setZapResult(null);
        try {
            const payment = await keymaster.zapLightning(
                zapDid.trim(),
                amount,
                zapMemo.trim() || undefined
            );
            const status = await keymaster.checkLightningPayment(payment.paymentHash);
            setZapResult(status);
            setSuccess("Zap sent successfully");
            setZapDid("");
            setZapAmount("");
            setZapMemo("");
        } catch (err: any) {
            setError(err);
        } finally {
            setLoadingZap(false);
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
                <Tab label="Payments" value="payments" />
                <Tab label="Receive" value="receive" />
                <Tab label="Send" value="send" />
                <Tab label="Zap" value="zap" />
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

                    {!loadingBalance && isConfigured === true && (
                        <Box>
                            {walletError ? (
                                <Typography color="error" sx={{ mb: 1 }}>
                                    {walletError}
                                </Typography>
                            ) : (
                                <Typography variant="h6" sx={{ mb: 1 }}>
                                    Balance: {(balance ?? 0).toLocaleString()} sats
                                </Typography>
                            )}
                            <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
                                <Button variant="outlined" onClick={fetchBalance}>
                                    Refresh
                                </Button>
                                <Button
                                    variant="outlined"
                                    color={isPublished ? "warning" : "success"}
                                    onClick={handleTogglePublish}
                                    disabled={loadingPublishToggle}
                                >
                                    {loadingPublishToggle
                                        ? <CircularProgress size={20} />
                                        : isPublished ? "Unpublish Lightning" : "Publish Lightning"}
                                </Button>
                                <Button
                                    variant="outlined"
                                    color="error"
                                    onClick={handleDisconnectLightning}
                                >
                                    Disconnect Wallet
                                </Button>
                            </Box>
                        </Box>
                    )}
                </Box>
            )}

            {activeTab === "payments" && (
                <Box sx={{ p: 1 }}>
                    <Box sx={{ display: "flex", alignItems: "center", gap: 2, mb: 2, flexWrap: "wrap" }}>
                        <Button variant="outlined" onClick={fetchPayments} disabled={loadingPayments}>
                            Refresh
                        </Button>
                        {(['settled', 'pending', 'failed', 'expired'] as const).map(s => (
                            <FormControlLabel key={s} label={s} sx={{ mr: 0 }}
                                control={<Checkbox size="small" checked={statusFilter[s]}
                                    onChange={e => setStatusFilter(f => ({ ...f, [s]: e.target.checked }))} />} />
                        ))}
                    </Box>
                    {loadingPayments && <CircularProgress size={24} />}
                    {!loadingPayments && payments.length === 0 && (
                        <Typography>No payments found.</Typography>
                    )}
                    {!loadingPayments && payments.length > 0 && (
                        <Box component="table" sx={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed", "& th, & td": { p: 0.75, borderBottom: "1px solid", borderColor: "divider", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, "& th": { fontWeight: "bold", textAlign: "left" }, "& td.num": { textAlign: "right" } }}>
                            <colgroup>
                                <col style={{ width: "190px" }} />
                                <col style={{ width: "120px" }} />
                                <col style={{ width: "60px" }} />
                                <col style={{ width: "80px" }} />
                                <col />
                            </colgroup>
                            <thead>
                                <tr>
                                    <th>Date</th>
                                    <th style={{ textAlign: "right" }}>Amount (sats)</th>
                                    <th style={{ textAlign: "right" }}>Fee</th>
                                    <th>Status</th>
                                    <th>Memo</th>
                                </tr>
                            </thead>
                            <tbody>
                                {payments.map((p, i) => {
                                    const d = p.time ? new Date(p.time) : null;
                                    const date = d ? `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}` : "—";
                                    const displayStatus: 'settled' | 'pending' | 'failed' | 'expired' = p.status === 'success' ? 'settled'
                                        : p.status === 'failed' ? 'failed'
                                            : (p.expiry && new Date(p.expiry) < new Date()) ? 'expired'
                                                : 'pending';
                                    if (!statusFilter[displayStatus]) return null;
                                    const statusColor = displayStatus === 'settled' ? 'inherit'
                                        : displayStatus === 'failed' ? 'error.main'
                                            : 'text.secondary';
                                    return (
                                        <tr key={i}>
                                            <td>{date}</td>
                                            <td className="num">{p.amount}</td>
                                            <td className="num">{p.fee > 0 ? p.fee : ""}</td>
                                            <td><Box component="span" sx={{ color: statusColor }}>{displayStatus}</Box></td>
                                            <td>{p.memo || "—"}</td>
                                        </tr>
                                    );
                                })}
                            </tbody>
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
                            setPaymentResult(null);
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

                    {paymentResult && (
                        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5, mt: 1 }}>
                            <Typography variant="body2">
                                <strong>Payment Hash:</strong> {paymentResult.paymentHash}
                            </Typography>
                            {paymentResult.preimage && (
                                <Typography variant="body2">
                                    <strong>Preimage (Proof):</strong> {paymentResult.preimage}
                                </Typography>
                            )}
                        </Box>
                    )}
                </Box>
            )}

            {activeTab === "zap" && (
                <Box sx={{ p: 1, display: "flex", flexDirection: "column", gap: 2 }}>
                    <Autocomplete
                        freeSolo
                        options={agentList || []}
                        value={zapDid}
                        onChange={(_, newValue) => {
                            setZapDid(newValue || "");
                            setZapResult(null);
                        }}
                        onInputChange={(_, newInputValue) => {
                            setZapDid(newInputValue);
                            setZapResult(null);
                        }}
                        renderInput={(params) => (
                            <TextField
                                {...params}
                                label="Recipient"
                                size="small"
                                placeholder="DID, alias, or Lightning Address"
                            />
                        )}
                    />
                    <TextField
                        label="Amount (sats)"
                        type="number"
                        value={zapAmount}
                        onChange={(e) => setZapAmount(e.target.value)}
                        slotProps={{ htmlInput: { min: 1 } }}
                        size="small"
                    />
                    <TextField
                        label="Memo (optional)"
                        value={zapMemo}
                        onChange={(e) => setZapMemo(e.target.value)}
                        size="small"
                    />
                    <Box>
                        <Button
                            variant="contained"
                            onClick={handleZap}
                            disabled={loadingZap || !zapDid.trim() || !zapAmount.trim()}
                        >
                            {loadingZap ? <CircularProgress size={20} /> : "Zap"}
                        </Button>
                    </Box>

                    {zapResult && (
                        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5, mt: 1 }}>
                            <Typography variant="body2">
                                <strong>Payment Hash:</strong> {zapResult.paymentHash}
                            </Typography>
                            {zapResult.preimage && (
                                <Typography variant="body2">
                                    <strong>Preimage (Proof):</strong> {zapResult.preimage}
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
