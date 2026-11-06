import { ComponentProps, ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
    Alert,
    Autocomplete,
    Box,
    Button,
    Chip,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogContentText,
    DialogTitle,
    MenuItem,
    Tab,
    Tabs,
    TextField,
    Typography,
} from "@mui/material";
import { Toll } from "@mui/icons-material";
import { QRCodeSVG } from "qrcode.react";
import type {
    CashuAcceptResult,
    CashuBalance,
    CashuMeltResult,
    CashuMessage,
    CashuMintInfo,
    CashuMintQuote,
    CashuQuoteRecord,
    CashuSendRecord,
    CashuSendResult,
    CashuSendToResult,
    DecodedLightningInvoice,
    KeymasterInterface,
} from "@didcid/clients/keymaster-types";
import PageHeader from "./layout/PageHeader";
import EmptyState from "./layout/EmptyState";

export type CashuKeymaster = Pick<KeymasterInterface,
    | "addCashu" | "removeCashu" | "addCashuMint" | "removeCashuMint" | "listCashuMints"
    | "publishCashu" | "unpublishCashu" | "getCashuBalance"
    | "createCashuMintQuote" | "claimCashuMintQuote" | "listCashuQuotes"
    | "meltCashu" | "sendCashu" | "receiveCashu" | "checkCashu" | "restoreCashu"
    | "listCashuSends" | "reclaimCashu" | "sendCashuTo" | "listCashuMessages" | "receiveCashuMessages"
    | "getLightningBalance" | "payLightningInvoice" | "decodeLightningInvoice" | "resolveDID"
>;

type Props = {
    keymaster: CashuKeymaster;
    // The identity shown. Hosts key this component by it, so nothing held here,
    // such as a token, outlives a change of identity.
    identity: string;
    // Whether this node runs a mint, which only offers it as a one-step choice.
    hasNodeMint: boolean;
    hasDidComm: boolean;
    recipients: string[];
    notify: {
        error: (error: unknown) => void;
        success: (message: string) => void;
        warning: (message: string) => void;
    };
};

type Section = "wallet" | "mint" | "pay" | "send" | "receive" | "sends" | "didcomm";

// A QR code in its lowest error-correction level carries 2953 bytes, and the
// component throws beyond that, which would take the page down with it.
const QR_LIMIT = 2900;
const CLAIM_ATTEMPTS = 15;
const CLAIM_DELAY_MS = 2000;
const HOUR_SECONDS = 3600;

function sats(amount: number): string {
    return `${amount.toLocaleString()} ${amount === 1 ? "sat" : "sats"}`;
}

function when(seconds: number): string {
    return new Date(seconds * 1000).toLocaleString();
}

// An error is a class in-process and a JSON body over REST, and carries its type
// in the text either way.
function isError(error: any, type: string): boolean {
    return [error?.type, error?.error, error?.message, error].some(part => typeof part === "string" && part.includes(type));
}

function parseAmount(value: string): number | null {
    const amount = Number(value);
    return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

function sameMints(published: string[], mints: CashuMintInfo[]): boolean {
    const urls = new Set(mints.map(mint => mint.url));
    return published.length === urls.size && published.every(url => urls.has(url));
}

function Stack({ children }: { children: ReactNode }) {
    return <Box sx={{ p: 1, display: "flex", flexDirection: "column", gap: 2, maxWidth: 640 }}>{children}</Box>;
}

function Row({ children }: { children: ReactNode }) {
    return <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", alignItems: "center" }}>{children}</Box>;
}

function ActionButton({ busy, label, ...props }: { busy?: boolean; label: string } & ComponentProps<typeof Button>) {
    return (
        <Button variant="outlined" {...props} disabled={busy || props.disabled}>
            {busy ? <CircularProgress size={20} /> : label}
        </Button>
    );
}

function CopyAndQr({ label, value, onCopy, onCopyFailed }: {
    label: string;
    value: string;
    onCopy: () => void;
    onCopyFailed: (error: unknown) => void;
}) {
    return (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <TextField
                label={label}
                value={value}
                multiline
                rows={3}
                size="small"
                slotProps={{ input: { readOnly: true } }}
                onClick={event => (event.target as HTMLInputElement).select()}
            />
            <Box>
                <Button size="small" variant="outlined"
                    onClick={() => { navigator.clipboard.writeText(value).then(onCopy, onCopyFailed); }}>
                    Copy
                </Button>
            </Box>
            {value.length <= QR_LIMIT ? (
                // White plate: a dark page behind the code breaks scanning.
                <Box sx={{ p: 2, backgroundColor: "#fff", alignSelf: "flex-start" }}>
                    <QRCodeSVG value={value} size={220} />
                </Box>
            ) : (
                <Typography variant="body2" color="text.secondary">
                    Too long for a QR code. Copy it instead.
                </Typography>
            )}
        </Box>
    );
}

// Shared by the wallets and the standalone clients. Every decision about value stays
// in Keymaster: this view asks it and shows the answer.
export default function CashuView({ keymaster, identity, hasNodeMint, hasDidComm, recipients, notify: hostNotify }: Props) {
    // Hosts build these afresh on each render, and showing one renders the host, so
    // nothing here may depend on their identity.
    const notifyRef = useRef(hostNotify);
    notifyRef.current = hostNotify;
    const notify = useRef({
        error: (error: unknown) => notifyRef.current.error(error),
        success: (message: string) => notifyRef.current.success(message),
        warning: (message: string) => notifyRef.current.warning(message),
    }).current;

    const [section, setSection] = useState<Section>("wallet");
    const [busy, setBusy] = useState<Record<string, boolean>>({});
    const [loadError, setLoadError] = useState("");

    const [mints, setMints] = useState<CashuMintInfo[] | null>(null);
    const [balance, setBalance] = useState<CashuBalance | null>(null);
    const [published, setPublished] = useState<string[] | null>(null);
    const [quotes, setQuotes] = useState<CashuQuoteRecord[]>([]);
    const [sends, setSends] = useState<CashuSendRecord[]>([]);
    const [chosenMint, setChosenMint] = useState("");
    const [newMint, setNewMint] = useState("");
    const [confirmRemoval, setConfirmRemoval] = useState<{ url?: string } | null>(null);

    const [mintAmount, setMintAmount] = useState("");
    const [quote, setQuote] = useState<(CashuMintQuote & { mint?: string }) | null>(null);
    const [lightningBalance, setLightningBalance] = useState<number | null>(null);

    const [invoice, setInvoice] = useState("");
    const [decoded, setDecoded] = useState<DecodedLightningInvoice | null>(null);
    const [melted, setMelted] = useState<CashuMeltResult | null>(null);

    const [sendAmount, setSendAmount] = useState("");
    const [sent, setSent] = useState<CashuSendResult | null>(null);
    const [token, setToken] = useState("");

    const [recipient, setRecipient] = useState("");
    const [lockedAmount, setLockedAmount] = useState("");
    const [memo, setMemo] = useState("");
    const [lockHours, setLockHours] = useState("");
    const [delivery, setDelivery] = useState<CashuSendToResult | null>(null);
    const [messages, setMessages] = useState<CashuMessage[] | null>(null);
    const [accepted, setAccepted] = useState<CashuAcceptResult | null>(null);

    const nodeMint = mints?.find(item => item.isNodeMint)?.url;
    const mint = mints?.some(item => item.url === chosenMint) ? chosenMint : nodeMint ?? mints?.[0]?.url;

    const reload = useCallback(async () => {
        setLoadError("");
        try {
            const list = await keymaster.listCashuMints();
            setMints(list);
            if (list.length === 0) {
                setBalance(null);
                setQuotes([]);
                setSends([]);
                setPublished(null);
                return;
            }
            const [totals, open, outstanding, document] = await Promise.all([
                keymaster.getCashuBalance(),
                keymaster.listCashuQuotes(),
                keymaster.listCashuSends(),
                keymaster.resolveDID(identity),
            ]);
            setBalance(totals);
            setQuotes(open);
            setSends(outstanding);
            const service = document?.didDocument?.service?.find((item: { id?: string }) => item.id?.endsWith("#cashu"));
            const endpoint = service?.serviceEndpoint as unknown;
            setPublished(service ? (Array.isArray(endpoint) ? endpoint as string[] : [String(endpoint)]) : null);
        } catch (error: any) {
            setLoadError(error?.error || error?.message || String(error));
        }
    }, [keymaster, identity]);

    const reloadMessages = useCallback(async () => {
        try {
            setMessages(await keymaster.listCashuMessages());
        } catch (error) {
            notify.error(error);
        }
    }, [keymaster, notify]);

    useEffect(() => { reload(); }, [reload]);

    useEffect(() => {
        if (section === "didcomm") {
            reloadMessages();
        }
        if (section === "mint") {
            // Offered only to an identity that has a Lightning wallet to pay from.
            keymaster.getLightningBalance()
                .then(result => setLightningBalance(result.balance))
                .catch(() => setLightningBalance(null));
        }
    }, [section, keymaster, reloadMessages]);

    // One action at a time per button, not per view: a melt has no timeout and can
    // stay in flight for days, and the rest of the wallet must stay usable meanwhile.
    async function run(name: string, action: () => Promise<void>) {
        setBusy(current => ({ ...current, [name]: true }));
        try {
            await action();
        } catch (error) {
            notify.error(error);
        } finally {
            setBusy(current => ({ ...current, [name]: false }));
            await reload();
        }
    }

    function copied(what: string) {
        return () => notify.success(`${what} copied to clipboard`);
    }

    async function removeMint(url?: string, force = false) {
        try {
            if (url) {
                await keymaster.removeCashuMint(url, force);
            } else {
                await keymaster.removeCashu(force);
            }
            notify.success(url ? "Mint removed" : "Cashu removed from this identity");
        } catch (error: any) {
            if (!force && isError(error, "Cashu state present")) {
                setConfirmRemoval({ url });
                return;
            }
            throw error;
        }
    }

    function handleAddMint() {
        const url = newMint.trim();
        run("addMint", async () => {
            const added = await keymaster.addCashuMint(url);
            setNewMint("");
            notify.success(`Added ${added.name || added.url}`);
        });
    }

    function handleAddNodeMint() {
        run("addNode", async () => {
            const added = await keymaster.addCashu();
            notify.success(`Added ${added.name || added.url}`);
        });
    }

    function handleCheck() {
        run("check", async () => {
            const total = { settled: 0, open: 0, dropped: 0, rotated: 0 };
            for (const item of mints ?? []) {
                const result = await keymaster.checkCashu(item.url);
                total.settled += result.settled;
                total.open += result.open;
                total.dropped += result.dropped ?? 0;
                total.rotated += result.rotated ?? 0;
            }
            const parts = [`${total.settled} settled`, `${total.open} still open`];
            if (total.dropped) {
                parts.push(`${sats(total.dropped)} found spent elsewhere`);
            }
            if (total.rotated) {
                parts.push(`${sats(total.rotated)} moved to the mint's new keyset`);
            }
            notify.success(parts.join(", "));
        });
    }

    function handleRestore() {
        run("restore", async () => {
            let amount = 0;
            for (const item of mints ?? []) {
                amount += (await keymaster.restoreCashu(item.url)).amount;
            }
            notify.success(amount ? `Recovered ${sats(amount)}` : "Nothing further to recover");
        });
    }

    function handlePublish() {
        run("publish", async () => {
            await keymaster.publishCashu();
            notify.success("Your mints are published in your DID document");
        });
    }

    function handleUnpublish() {
        run("publish", async () => {
            await keymaster.unpublishCashu();
            notify.success("Your mints are no longer published");
        });
    }

    function handleQuote() {
        const amount = parseAmount(mintAmount);
        if (!amount) {
            notify.error("Enter a valid amount in satoshis");
            return;
        }
        run("quote", async () => {
            setQuote(null);
            setQuote({ ...await keymaster.createCashuMintQuote(amount, mint), mint });
        });
    }

    async function claim(quoteId: string, quoteMint?: string) {
        const claimed = await keymaster.claimCashuMintQuote(quoteId, quoteMint);
        notify.success(`Minted ${sats(claimed.amount)}`);
        setQuote(current => (current?.quote === quoteId ? null : current));
    }

    function handleClaim(quoteId: string, quoteMint?: string) {
        run(`claim:${quoteId}`, async () => {
            try {
                await claim(quoteId, quoteMint);
            } catch (error) {
                if (!isError(error, "Cashu quote not paid")) {
                    throw error;
                }
                notify.warning("The mint has not seen that payment yet");
            }
        });
    }

    function handlePayQuote(open: CashuMintQuote & { mint?: string }) {
        run("payQuote", async () => {
            await keymaster.payLightningInvoice(open.request);
            // The mint hears of the payment shortly after it completes.
            for (let attempt = 1; ; attempt++) {
                try {
                    await claim(open.quote, open.mint);
                    return;
                } catch (error) {
                    if (!isError(error, "Cashu quote not paid") || attempt >= CLAIM_ATTEMPTS) {
                        throw error;
                    }
                }
                await new Promise(resolve => setTimeout(resolve, CLAIM_DELAY_MS));
            }
        });
    }

    function handleDecode() {
        run("decode", async () => {
            setDecoded(await keymaster.decodeLightningInvoice(invoice.trim()));
        });
    }

    function handleMelt() {
        run("melt", async () => {
            const result = await keymaster.meltCashu(invoice.trim(), mint);
            setMelted(result);
            if (result.paid) {
                notify.success(`Paid, with a fee of ${sats(result.fee ?? 0)}`);
                setInvoice("");
                setDecoded(null);
            } else if (result.pending) {
                notify.warning("The payment is still in flight. Use Check on the Wallet tab to settle it.");
            } else {
                notify.error("The mint did not pay that invoice, and your ecash is unspent");
            }
        });
    }

    function handleSend() {
        const amount = parseAmount(sendAmount);
        if (!amount) {
            notify.error("Enter a valid amount in satoshis");
            return;
        }
        run("send", async () => {
            setSent(null);
            setSent(await keymaster.sendCashu(amount, mint));
            setSendAmount("");
        });
    }

    function handleReceive() {
        run("receive", async () => {
            const received = await keymaster.receiveCashu(token.trim());
            setToken("");
            if (received.spent) {
                notify.warning(`Received ${sats(received.amount)}. Someone had already spent another ${sats(received.spent)} of that token.`);
            } else {
                notify.success(`Received ${sats(received.amount)}`);
            }
        });
    }

    function handleReclaim(operationId: string) {
        run(`reclaim:${operationId}`, async () => {
            const result = await keymaster.reclaimCashu(operationId);
            const parts = [`Reclaimed ${sats(result.amount)}`];
            if (result.redeemed) {
                parts.push(`the recipient had taken ${sats(result.redeemed)}`);
            }
            if (result.pending) {
                parts.push(`${sats(result.pending)} is not spendable yet`);
            }
            notify.success(parts.join("; "));
        });
    }

    function handleSendTo() {
        const amount = parseAmount(lockedAmount);
        if (!amount) {
            notify.error("Enter a valid amount in satoshis");
            return;
        }
        const hours = lockHours.trim() ? Number(lockHours) : undefined;
        if (hours !== undefined && (!Number.isFinite(hours) || hours <= 0)) {
            notify.error("Enter how many hours until you can reclaim it, or leave it empty");
            return;
        }
        run("sendTo", async () => {
            setDelivery(null);
            const result = await keymaster.sendCashuTo(recipient.trim(), amount, {
                ...(memo.trim() && { memo: memo.trim() }),
                ...(hours !== undefined && { locktime: Math.round(hours * HOUR_SECONDS) }),
                ...(mint && { mint }),
            });
            setDelivery(result);
            if (result.delivered) {
                notify.success(`Sent ${sats(result.amount)} to ${recipient.trim()}`);
                setLockedAmount("");
                setMemo("");
            } else {
                const reason = result.error ? `: ${result.error}` : "";
                notify.warning(`Not delivered yet${reason}. Check on the Wallet tab sends it again.`);
            }
        });
    }

    function handleAccept() {
        run("accept", async () => {
            const result = await keymaster.receiveCashuMessages();
            setAccepted(result);
            const total = result.redeemed.reduce((sum, item) => sum + item.amount, 0);
            if (result.redeemed.length > 0) {
                notify.success(`Redeemed ${sats(total)}`);
            }
            if (result.failed.length > 0) {
                notify.warning(`${result.failed.length} could not be redeemed`);
            }
            await reloadMessages();
        });
    }

    const header = (
        <PageHeader
            title="Cashu"
            description="Ecash this identity holds at the mints it trusts, spent over Lightning or passed to others. Experimental: keep amounts small."
        />
    );

    if (mints === null) {
        return (
            <Box>
                {header}
                {loadError
                    ? <Alert severity="error">{loadError}</Alert>
                    : <CircularProgress size={24} />}
            </Box>
        );
    }

    const addMintForm = (
        <Row>
            <TextField
                label="Mint URL"
                placeholder="https://mint.example.com"
                value={newMint}
                onChange={event => setNewMint(event.target.value)}
                size="small"
                sx={{ flexGrow: 1, minWidth: 240 }}
            />
            <ActionButton label="Add Mint" busy={busy.addMint} disabled={!newMint.trim()} onClick={handleAddMint} />
        </Row>
    );
    const nodeMintButton = hasNodeMint && !nodeMint && (
        <ActionButton label="Use This Node's Mint" variant="contained" busy={busy.addNode} onClick={handleAddNodeMint} />
    );

    if (mints.length === 0) {
        return (
            <Box>
                {header}
                {loadError && <Alert severity="error" sx={{ mb: 2 }}>{loadError}</Alert>}
                <EmptyState
                    icon={<Toll />}
                    title="No mints yet"
                    description={hasNodeMint
                        ? "Use this node's mint, or add another one you trust. A mint holds the funds behind its ecash."
                        : "Add a mint you trust. A mint holds the funds behind its ecash."}
                    action={nodeMintButton || undefined}
                />
                <Stack>{addMintForm}</Stack>
            </Box>
        );
    }

    const perMint = (url: string) =>
        balance?.mints?.[url] ?? (mints.length === 1 ? balance : null);

    const mintChoice = mints.length > 1 && section !== "wallet" && section !== "receive" && section !== "sends" && (
        <TextField
            select
            label="Mint"
            value={mint ?? ""}
            onChange={event => setChosenMint(event.target.value)}
            size="small"
        >
            {mints.map(item => <MenuItem key={item.url} value={item.url}>{item.name || item.url}</MenuItem>)}
        </TextField>
    );

    return (
        <Box>
            {header}
            {loadError && <Alert severity="error" sx={{ mb: 2 }}>{loadError}</Alert>}
            <Tabs
                value={section}
                onChange={(_, value) => setSection(value)}
                variant="scrollable"
                allowScrollButtonsMobile
                sx={{ borderBottom: 1, borderColor: "divider", mb: 2, minHeight: 40 }}
            >
                <Tab label="Wallet" value="wallet" />
                <Tab label="Mint" value="mint" />
                <Tab label="Pay" value="pay" />
                <Tab label="Send" value="send" />
                <Tab label="Receive" value="receive" />
                <Tab label="Outstanding" value="sends" />
                {hasDidComm && <Tab label="DIDComm" value="didcomm" />}
            </Tabs>

            {section === "wallet" && (
                <Stack>
                    <Box>
                        <Typography variant="h6">Balance: {sats(balance?.spendable ?? 0)}</Typography>
                        {!!balance?.inFlight && (
                            <Typography variant="body2" color="text.secondary">
                                {sats(balance.inFlight)} in flight. It returns or is spent once its payment settles.
                            </Typography>
                        )}
                        {!!balance?.outstanding && (
                            <Typography variant="body2" color="text.secondary">
                                {sats(balance.outstanding)} sent and not yet redeemed.
                            </Typography>
                        )}
                    </Box>
                    <Row>
                        <ActionButton label="Refresh" onClick={() => run("refresh", async () => undefined)} busy={busy.refresh} />
                        <ActionButton label="Check" onClick={handleCheck} busy={busy.check} />
                        <ActionButton label="Restore From Seed" onClick={handleRestore} busy={busy.restore} />
                        {published
                            ? <ActionButton label="Unpublish Cashu" color="warning" onClick={handleUnpublish} busy={busy.publish} />
                            : <ActionButton label="Publish Cashu" color="success" onClick={handlePublish} busy={busy.publish} />}
                        {published && !sameMints(published, mints) && (
                            <ActionButton label="Update Published Mints" color="success" onClick={handlePublish} busy={busy.publish} />
                        )}
                        <ActionButton label="Remove Cashu" color="error" onClick={() => run("remove", () => removeMint())} busy={busy.remove} />
                    </Row>
                    <Typography variant="subtitle1">Mints</Typography>
                    {mints.map(item => {
                        const totals = perMint(item.url);
                        return (
                            <Box key={item.url} sx={{ display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap" }}>
                                <Box sx={{ flexGrow: 1, minWidth: 200 }}>
                                    <Typography variant="body2" sx={{ wordBreak: "break-all" }}>
                                        {item.name ? `${item.name} (${item.url})` : item.url}
                                        {item.isNodeMint && <Chip label="this node" size="small" sx={{ ml: 1 }} />}
                                    </Typography>
                                    {item.keysets.length === 0 && (
                                        <Typography variant="body2" color="warning.main">Not answering right now</Typography>
                                    )}
                                    {totals && (
                                        <Typography variant="body2" color="text.secondary">{sats(totals.spendable)}</Typography>
                                    )}
                                </Box>
                                <ActionButton label="Remove" size="small" color="error"
                                    onClick={() => run(`remove:${item.url}`, () => removeMint(item.url))}
                                    busy={busy[`remove:${item.url}`]} />
                            </Box>
                        );
                    })}
                    {nodeMintButton && <Box>{nodeMintButton}</Box>}
                    {addMintForm}
                </Stack>
            )}

            {section === "mint" && (
                <Stack>
                    {mintChoice}
                    <TextField label="Amount (sats)" type="number" value={mintAmount}
                        onChange={event => setMintAmount(event.target.value)}
                        slotProps={{ htmlInput: { min: 1 } }} size="small" />
                    <Box>
                        <ActionButton label="Create Invoice" variant="contained" busy={busy.quote} onClick={handleQuote} />
                    </Box>
                    {quote && (
                        <>
                            <CopyAndQr label="Invoice to pay" value={quote.request} onCopy={copied("Invoice")} onCopyFailed={notify.error} />
                            <Row>
                                {lightningBalance !== null && (
                                    <ActionButton
                                        label={`Pay From Lightning (${sats(lightningBalance)})`}
                                        variant="contained"
                                        busy={busy.payQuote}
                                        onClick={() => handlePayQuote(quote)}
                                    />
                                )}
                                <ActionButton label="Claim Once Paid" busy={busy[`claim:${quote.quote}`]}
                                    onClick={() => handleClaim(quote.quote, quote.mint)} />
                            </Row>
                        </>
                    )}
                    <OpenQuotes quotes={quotes} busy={busy} onClaim={handleClaim} onShow={item => setQuote({
                        quote: item.quote,
                        request: item.request ?? "",
                        amount: item.amount ?? 0,
                        state: "UNPAID",
                        expiry: item.expiry,
                        mint: item.mint,
                    })} />
                </Stack>
            )}

            {section === "pay" && (
                <Stack>
                    {mintChoice}
                    <TextField label="BOLT11 Invoice" value={invoice} multiline rows={3} size="small"
                        onChange={event => {
                            setInvoice(event.target.value);
                            setDecoded(null);
                            setMelted(null);
                        }} />
                    <Row>
                        <ActionButton label="Decode" busy={busy.decode} disabled={!invoice.trim()} onClick={handleDecode} />
                        {decoded && (
                            <ActionButton label="Pay" variant="contained" busy={busy.melt} onClick={handleMelt} />
                        )}
                    </Row>
                    {decoded && (
                        <Box>
                            {decoded.amount !== undefined && <Typography variant="body2"><strong>Amount:</strong> {decoded.amount}</Typography>}
                            {decoded.description && <Typography variant="body2"><strong>Description:</strong> {decoded.description}</Typography>}
                            {decoded.network && <Typography variant="body2"><strong>Network:</strong> {decoded.network}</Typography>}
                            {decoded.expires && <Typography variant="body2"><strong>Expires:</strong> {decoded.expires}</Typography>}
                        </Box>
                    )}
                    {melted?.paid && (
                        <Box>
                            <Typography variant="body2"><strong>Fee:</strong> {sats(melted.fee ?? 0)}</Typography>
                            <Typography variant="body2"><strong>Change:</strong> {sats(melted.change)}</Typography>
                            {melted.preimage && (
                                <Typography variant="body2" sx={{ wordBreak: "break-all" }}>
                                    <strong>Preimage (Proof):</strong> {melted.preimage}
                                </Typography>
                            )}
                        </Box>
                    )}
                </Stack>
            )}

            {section === "send" && (
                <Stack>
                    {mintChoice}
                    <TextField label="Amount (sats)" type="number" value={sendAmount}
                        onChange={event => setSendAmount(event.target.value)}
                        slotProps={{ htmlInput: { min: 1 } }} size="small" />
                    <Box>
                        <ActionButton label="Create Token" variant="contained" busy={busy.send} onClick={handleSend} />
                    </Box>
                    {sent && (
                        <>
                            <Alert severity="info">
                                This token is cash: whoever has it first can spend it. You can reclaim it from Outstanding until they do.
                                {sent.fee > 0 && ` It includes a fee of ${sats(sent.fee)} for the recipient's redemption.`}
                            </Alert>
                            <CopyAndQr label={`Token for ${sats(sent.amount)}`} value={sent.token} onCopy={copied("Token")} onCopyFailed={notify.error} />
                        </>
                    )}
                </Stack>
            )}

            {section === "receive" && (
                <Stack>
                    <TextField label="Token" placeholder="cashuB..." value={token} multiline rows={4} size="small"
                        onChange={event => setToken(event.target.value)} />
                    <Box>
                        <ActionButton label="Receive" variant="contained" busy={busy.receive} disabled={!token.trim()} onClick={handleReceive} />
                    </Box>
                </Stack>
            )}

            {section === "sends" && (
                <Stack>
                    {sends.length === 0 && <Typography>Nothing outstanding.</Typography>}
                    {sends.map(item => {
                        const unlocks = item.locktime !== undefined && item.locktime * 1000 > Date.now();
                        return (
                            <Box key={item.operationId} sx={{ display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap" }}>
                                <Box sx={{ flexGrow: 1, minWidth: 200 }}>
                                    <Typography variant="body2">
                                        <strong>{sats(item.amount)}</strong>
                                        {item.recipient && ` to ${item.recipient}`}
                                    </Typography>
                                    <Typography variant="body2" color="text.secondary" sx={{ wordBreak: "break-all" }}>
                                        {new Date(item.created).toLocaleString()} at {item.mint}
                                    </Typography>
                                    {item.memo && <Typography variant="body2" color="text.secondary">{item.memo}</Typography>}
                                    {item.delivered === false && (
                                        <Typography variant="body2" color="warning.main">Not delivered yet. Check on the Wallet tab sends it again.</Typography>
                                    )}
                                    {unlocks && (
                                        <Typography variant="body2" color="text.secondary">Can be reclaimed after {when(item.locktime!)}</Typography>
                                    )}
                                </Box>
                                <ActionButton label="Reclaim" size="small" disabled={unlocks}
                                    busy={busy[`reclaim:${item.operationId}`]}
                                    onClick={() => handleReclaim(item.operationId)} />
                            </Box>
                        );
                    })}
                </Stack>
            )}

            {section === "didcomm" && (
                <Stack>
                    <Typography variant="subtitle1">Send to a DID</Typography>
                    {mintChoice}
                    <Autocomplete
                        freeSolo
                        options={recipients}
                        value={recipient}
                        onChange={(_, value) => setRecipient(value || "")}
                        onInputChange={(_, value) => setRecipient(value)}
                        renderInput={params => <TextField {...params} label="Recipient" placeholder="DID or alias" size="small" />}
                    />
                    <TextField label="Amount (sats)" type="number" value={lockedAmount}
                        onChange={event => setLockedAmount(event.target.value)}
                        slotProps={{ htmlInput: { min: 1 } }} size="small" />
                    <TextField label="Memo (optional)" value={memo} onChange={event => setMemo(event.target.value)} size="small" />
                    <TextField label="Hours until you can reclaim it (optional)" type="number" value={lockHours}
                        helperText="Three days if empty. Seven days at most."
                        onChange={event => setLockHours(event.target.value)}
                        slotProps={{ htmlInput: { min: 1 } }} size="small" />
                    <Box>
                        <ActionButton label="Send" variant="contained" busy={busy.sendTo}
                            disabled={!recipient.trim() || !lockedAmount.trim()} onClick={handleSendTo} />
                    </Box>
                    {delivery?.delivered && (
                        <Typography variant="body2">
                            Locked to the recipient. You can reclaim it after {when(delivery.locktime)} if they have not redeemed it.
                        </Typography>
                    )}

                    <Typography variant="subtitle1">Incoming</Typography>
                    {messages === null && <CircularProgress size={24} />}
                    {messages?.length === 0 && <Typography>No token messages waiting.</Typography>}
                    {messages?.map(item => (
                        <Box key={item.id}>
                            <Typography variant="body2">
                                <strong>{item.amount !== undefined ? sats(item.amount) : "Unknown amount"}</strong>
                                {` from ${item.sender ?? "an unverified sender"}`}
                            </Typography>
                            {item.mint && <Typography variant="body2" color="text.secondary" sx={{ wordBreak: "break-all" }}>{item.mint}</Typography>}
                            {item.memo && <Typography variant="body2" color="text.secondary">{item.memo}</Typography>}
                            {!item.redeemable && <Typography variant="body2" color="warning.main">{item.reason}</Typography>}
                        </Box>
                    ))}
                    <Row>
                        <ActionButton label="Refresh" onClick={reloadMessages} />
                        <ActionButton label="Claim All" variant="contained" busy={busy.accept}
                            disabled={!messages?.some(item => item.redeemable)} onClick={handleAccept} />
                    </Row>
                    {accepted?.failed.map(item => (
                        <Typography key={item.id} variant="body2" color="warning.main">{item.reason}</Typography>
                    ))}
                </Stack>
            )}

            <Dialog open={!!confirmRemoval} onClose={() => setConfirmRemoval(null)}>
                <DialogTitle>Discard ecash?</DialogTitle>
                <DialogContent>
                    <DialogContentText>
                        {confirmRemoval?.url ? "This mint holds" : "This identity holds"} ecash or open operations.
                        Ecash is the funds themselves: removing this discards it, along with any paid quotes and
                        the means to reclaim tokens you have sent.
                    </DialogContentText>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setConfirmRemoval(null)}>Keep It</Button>
                    <Button color="error" onClick={() => {
                        const target = confirmRemoval;
                        setConfirmRemoval(null);
                        run("remove", () => removeMint(target?.url, true));
                    }}>
                        Discard
                    </Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}

function OpenQuotes({ quotes, busy, onClaim, onShow }: {
    quotes: CashuQuoteRecord[];
    busy: Record<string, boolean>;
    onClaim: (quoteId: string, mint?: string) => void;
    onShow: (quote: CashuQuoteRecord) => void;
}) {
    if (quotes.length === 0) {
        return null;
    }
    return (
        <>
            <Typography variant="subtitle1">Open</Typography>
            {quotes.map(item => (
                <Box key={item.operationId} sx={{ display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap" }}>
                    <Box sx={{ flexGrow: 1, minWidth: 200 }}>
                        <Typography variant="body2">
                            {item.kind === "mint" ? "Minting" : "Paying"} {item.amount !== undefined ? sats(item.amount) : ""}
                        </Typography>
                        {item.expiry !== undefined && item.kind === "mint" && (
                            <Typography variant="body2" color="text.secondary">Invoice expires {when(item.expiry)}</Typography>
                        )}
                        {item.kind === "melt" && (
                            <Typography variant="body2" color="text.secondary">In flight. Check on the Wallet tab settles it once the mint answers.</Typography>
                        )}
                    </Box>
                    {item.kind === "mint" && item.request && (
                        <ActionButton label="Show Invoice" size="small" onClick={() => onShow(item)} />
                    )}
                    {item.kind === "mint" && (
                        <ActionButton label="Claim" size="small" busy={busy[`claim:${item.quote}`]}
                            onClick={() => onClaim(item.quote, item.mint)} />
                    )}
                </Box>
            ))}
        </>
    );
}
