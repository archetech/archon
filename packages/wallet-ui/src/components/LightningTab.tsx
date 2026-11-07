import React, { useCallback, useEffect, useRef, useState } from "react";
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
import { Bolt } from "@mui/icons-material";
import PageHeader from "./layout/PageHeader";
import EmptyState from "./layout/EmptyState";

const LIGHTNING_PAYMENT_STATUS_CHECKS = 3;
const LIGHTNING_PAYMENT_STATUS_DELAY_MS = 1000;

type ReviewedInvoice = { invoice: string; info: DecodedLightningInvoice };

// LightningTab keys this view by the identity it shows, so nothing held here, such as
// an invoice, outlives a change of identity. Keying does not stop a call under way, so
// each call names this identity rather than whichever is current when it runs.
const LightningView: React.FC<{ identity: string }> = ({ identity }) => {
    const { keymaster } = useWalletContext();
    const { agentList } = useVariablesContext();
    const { setError, setSuccess, setWarning } = useSnackbar();

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
    const [decoded, setDecoded] = useState<ReviewedInvoice | null>(null);
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

    // Only the invoice on screen counts as reviewed: a slow decode must not put another
    // invoice's amount beside it, or enable paying it.
    const reviewed = decoded?.invoice === bolt11Input.trim() ? decoded : null;

    // A read that a newer one has overtaken must not put older figures back.
    const latestBalance = useRef(0);
    const latestPayments = useRef(0);

    const fetchBalance = useCallback(async () => {
        if (!keymaster) return;
        const read = ++latestBalance.current;
        setLoadingBalance(true);
        setWalletError(null);
        try {
            const result = await keymaster.getLightningBalance(identity);
            if (read !== latestBalance.current) return;
            setBalance(result.balance);
            setIsConfigured(true);
            // Check publish state
            try {
                const doc = await keymaster.resolveDID(identity);
                if (read !== latestBalance.current) return;
                const services = doc?.didDocument?.service || [];
                setIsPublished(services.some((s: any) => s.id?.endsWith('#lightning')));
            } catch { /* ignore resolve errors */ }
        } catch (err: any) {
            if (read !== latestBalance.current) return;
            if (err instanceof LightningNotConfiguredError) {
                setIsConfigured(false);
            } else {
                setIsConfigured(true);
                setWalletError(err.message || err.error || JSON.stringify(err));
            }
        } finally {
            if (read === latestBalance.current) {
                setLoadingBalance(false);
            }
        }
    }, [keymaster, identity]);

    const fetchPayments = useCallback(async () => {
        if (!keymaster) return;
        const read = ++latestPayments.current;
        setLoadingPayments(true);
        try {
            const result = await keymaster.getLightningPayments(identity);
            if (read === latestPayments.current) {
                setPayments(result);
            }
        } catch (err: any) {
            setError(err);
        } finally {
            if (read === latestPayments.current) {
                setLoadingPayments(false);
            }
        }
    }, [keymaster, identity, setError]);

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
            await keymaster.addLightning(identity);
            setSuccess("Lightning wallet set up successfully");
            await fetchBalance();
        } catch (err: any) {
            setError(err);
        }
    }

    async function handleDisconnectLightning() {
        if (!keymaster) return;
        try {
            await keymaster.removeLightning(identity);
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
            const result = await keymaster.createLightningInvoice(amount, receiveMemo, identity);
            setInvoice(result.paymentRequest);
        } catch (err: any) {
            setError(err);
        } finally {
            setLoadingInvoice(false);
        }
    }

    async function handleDecode() {
        if (!keymaster || !bolt11Input.trim()) return;
        const reading = bolt11Input.trim();
        setLoadingDecode(true);
        setDecoded(null);
        try {
            setDecoded({ invoice: reading, info: await keymaster.decodeLightningInvoice(reading) });
        } catch (err: any) {
            setError(err);
        } finally {
            setLoadingDecode(false);
        }
    }

    async function checkLightningPaymentWithRetry(paymentHash: string) {
        let status = await keymaster!.checkLightningPayment(paymentHash, identity);

        for (let attempt = 1; attempt < LIGHTNING_PAYMENT_STATUS_CHECKS && !status.paid; attempt++) {
            await new Promise(resolve => setTimeout(resolve, LIGHTNING_PAYMENT_STATUS_DELAY_MS));
            status = await keymaster!.checkLightningPayment(paymentHash, identity);
        }

        return status;
    }

    async function handlePay({ invoice: paying, info }: ReviewedInvoice) {
        if (!keymaster) return;
        setLoadingPay(true);
        setPaymentResult(null);
        try {
            const payment = await keymaster.payLightningInvoice(paying, identity);
            const status = await keymaster.checkLightningPayment(payment.paymentHash, identity);
            setPaymentResult(status);
            setSuccess("Payment sent successfully");
            setBolt11Input(current => (current.trim() === paying ? "" : current));
            setDecoded(current => (current?.invoice === paying ? null : current));
        } catch (err: any) {
            if (info.payment_hash) {
                try {
                    const status = await keymaster.checkLightningPayment(info.payment_hash, identity);
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
                await keymaster.unpublishLightning(identity);
                setIsPublished(false);
                setSuccess("Lightning unpublished — your DID is no longer zappable");
            } else {
                await keymaster.publishLightning(identity);
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
                zapMemo.trim() || undefined,
                identity
            );
            const status = await checkLightningPaymentWithRetry(payment.paymentHash);
            setZapResult(status);
            if (status.paid) {
                setSuccess("Zap sent successfully");
            } else if (status.status === 'failed') {
                setError("Zap failed");
            } else {
                setWarning("Zap submitted, but settlement is still pending");
            }
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
            <PageHeader
                title="Lightning"
                description="Receive, send and zap sats from this identity's Lightning wallet."
            />
            <Tabs
                value={activeTab}
                onChange={(_, v) => setActiveTab(v)}
                sx={{ borderBottom: 1, borderColor: "divider", mb: 2, minHeight: 40 }}
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
                        <EmptyState
                            icon={<Bolt />}
                            title="No Lightning wallet"
                            description="Set one up to receive and send sats from this identity."
                            action={
                                <Button variant="contained" onClick={handleSetupLightning}>
                                Set Up Lightning
                                </Button>
                            }
                        />
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
                                slotProps={{
                                    input: { readOnly: true },
                                    htmlInput: { onClick: (e: React.MouseEvent<HTMLTextAreaElement>) => e.currentTarget.select() },
                                }}
                                size="small"
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
                        {reviewed && (
                            <Button
                                variant="contained"
                                onClick={() => handlePay(reviewed)}
                                disabled={loadingPay}
                            >
                                {loadingPay ? <CircularProgress size={20} /> : "Pay"}
                            </Button>
                        )}
                    </Box>

                    {reviewed && (
                        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
                            {reviewed.info.amount !== undefined && (
                                <Typography variant="body2">
                                    <strong>Amount:</strong> {reviewed.info.amount}
                                </Typography>
                            )}
                            {reviewed.info.description && (
                                <Typography variant="body2">
                                    <strong>Description:</strong> {reviewed.info.description}
                                </Typography>
                            )}
                            {reviewed.info.network && (
                                <Typography variant="body2">
                                    <strong>Network:</strong> {reviewed.info.network}
                                </Typography>
                            )}
                            {reviewed.info.created && (
                                <Typography variant="body2">
                                    <strong>Created:</strong> {reviewed.info.created}
                                </Typography>
                            )}
                            {reviewed.info.expires && (
                                <Typography variant="body2">
                                    <strong>Expires:</strong> {reviewed.info.expires}
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
                                <strong>Status:</strong> {zapResult.paid ? "Settled" : zapResult.status === 'failed' ? "Failed" : "Pending"}
                            </Typography>
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

const LightningTab: React.FC = () => {
    const { currentId } = useVariablesContext();

    if (!currentId) {
        return null;
    }
    return <LightningView key={currentId} identity={currentId} />;
};

export default LightningTab;
