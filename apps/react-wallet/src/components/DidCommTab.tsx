import { useCallback, useEffect, useRef, useState } from "react";
import {
    Box, Button, Checkbox, Chip, CircularProgress, Divider, FormControlLabel, MenuItem,
    Tab, Tabs, TextField, Typography
} from "@mui/material";
import { Forum, Inbox } from "@mui/icons-material";
import {
    BASIC_MESSAGE_TYPE, TRUST_PING_TYPE, basicMessage, trustPing, trustPingResponse
} from "@didcid/keymaster/didcomm-protocols";
import type { DidCommReceivedMessage } from "@didcid/keymaster/types";
import { useWalletContext } from "../contexts/WalletProvider";
import { useVariablesContext } from "../contexts/VariablesProvider";
import { useSnackbar } from "../contexts/SnackbarProvider";
import { loadRefreshIntervalSeconds } from "../contexts/UIContext";
import PageHeader from "./layout/PageHeader";
import Section from "./layout/Section";
import EmptyState from "./layout/EmptyState";
import ActionMenu from "./layout/ActionMenu";

// What publishDidComm writes into the DID document, read back so the screen can
// say what the identity currently advertises. Two states are both "published":
// with an endpoint (others can deliver to a mailbox) and key-only (others can
// encrypt to this identity but have nowhere to deliver).
interface DidCommStatus {
    keyAgreement: boolean;
    endpoint?: string;
    routingKeys: string[];
}

interface DidCommPlaintext {
    id?: string;
    type?: string;
    from?: string;
    thid?: string;
    created_time?: number;
    body?: Record<string, unknown>;
}

function readStatus(
    service: { id: string; type: string; serviceEndpoint: string | { uri: string; accept?: string[]; routingKeys?: string[] } } | undefined,
    keyAgreement: boolean,
): DidCommStatus {
    if (!service) {
        return { keyAgreement, routingKeys: [] };
    }

    // The plain string form carries no routing keys; the object form is what
    // publishDidComm writes when the identity sits behind a mediator.
    if (typeof service.serviceEndpoint === "string") {
        return { keyAgreement, endpoint: service.serviceEndpoint, routingKeys: [] };
    }

    return {
        keyAgreement,
        endpoint: service.serviceEndpoint.uri,
        routingKeys: service.serviceEndpoint.routingKeys ?? [],
    };
}

function messageLabel(type?: string): string {
    if (type === BASIC_MESSAGE_TYPE) {
        return "Message";
    }
    if (type === TRUST_PING_TYPE) {
        return "Trust ping";
    }
    return type || "Unknown";
}

function formatTime(created?: number): string {
    // DIDComm created_time is seconds since the epoch, not milliseconds.
    return created ? new Date(created * 1000).toLocaleString() : "";
}

function DidCommTab() {
    const [activeTab, setActiveTab] = useState<string>("inbox");
    const [status, setStatus] = useState<DidCommStatus | null>(null);
    const [loading, setLoading] = useState<boolean>(true);
    const [busy, setBusy] = useState<boolean>(false);
    const [endpoint, setEndpoint] = useState<string>("");
    const [routingKeys, setRoutingKeys] = useState<string>("");
    const [messages, setMessages] = useState<DidCommReceivedMessage[]>([]);
    const [inboxLoading, setInboxLoading] = useState<boolean>(true);
    const [refreshIntervalSeconds, setRefreshIntervalSeconds] = useState<number>(() => loadRefreshIntervalSeconds());
    const [composeTo, setComposeTo] = useState<string>("");
    const [composeKind, setComposeKind] = useState<string>("message");
    const [composeContent, setComposeContent] = useState<string>("");
    const [composeAnoncrypt, setComposeAnoncrypt] = useState<boolean>(false);
    const pollingRef = useRef<boolean>(false);
    const { keymaster } = useWalletContext();
    const { currentId, currentDID } = useVariablesContext();
    const { setError, setSuccess } = useSnackbar();

    const refreshStatus = useCallback(async () => {
        if (!keymaster || !currentDID) {
            setStatus(null);
            setLoading(false);
            return;
        }

        try {
            const docs = await keymaster.resolveDID(currentDID);
            const didDocument = docs.didDocument;
            const service = didDocument?.service?.find(entry => entry.type === "DIDCommMessaging");
            const keyAgreement = Boolean(didDocument?.keyAgreement?.length);
            setStatus(service || keyAgreement ? readStatus(service, keyAgreement) : null);
        } catch (error: any) {
            setError(error);
            setStatus(null);
        } finally {
            setLoading(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [keymaster, currentDID]);

    // Reading with ack: false leaves everything on the server, so each poll returns
    // the whole mailbox. The list is therefore replaced, not accumulated -- what is
    // on screen is exactly what is still in the mailbox. Messages that fail to
    // unpack stay on the server and never appear here.
    const refreshInbox = useCallback(async (options: { quiet?: boolean } = {}) => {
        if (!keymaster || !currentId) {
            setMessages([]);
            setInboxLoading(false);
            return;
        }

        // A slow fetch must not overlap with the next tick of the poll.
        if (pollingRef.current) {
            return;
        }
        pollingRef.current = true;

        try {
            const received = await keymaster.receiveDidComm({ name: currentId, ack: false });
            setMessages(received);
        } catch (error: any) {
            // A quiet (polled) failure is usually a node that is briefly
            // unreachable; only an explicit refresh should raise a snackbar.
            if (!options.quiet) {
                setError(error);
            }
        } finally {
            pollingRef.current = false;
            setInboxLoading(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [keymaster, currentId]);

    useEffect(() => {
        setLoading(true);
        refreshStatus();
    }, [refreshStatus]);

    useEffect(() => {
        setInboxLoading(true);
        refreshInbox({ quiet: true });
    }, [refreshInbox]);

    useEffect(() => {
        // Poll only while this screen is mounted, at the interval the user set in
        // Settings. Zero means "manual refresh only", matching the wallet's own
        // background refresh.
        if (refreshIntervalSeconds === 0) {
            return;
        }

        const interval = setInterval(() => {
            refreshInbox({ quiet: true });
        }, refreshIntervalSeconds * 1000);

        return () => clearInterval(interval);
    }, [refreshInbox, refreshIntervalSeconds]);

    useEffect(() => {
        const handleIntervalChange = () => setRefreshIntervalSeconds(loadRefreshIntervalSeconds());
        window.addEventListener('archon:refresh-interval-change', handleIntervalChange);
        return () => window.removeEventListener('archon:refresh-interval-change', handleIntervalChange);
    }, []);

    async function publish() {
        if (!keymaster) return;

        setBusy(true);
        try {
            const keys = routingKeys
                .split(",")
                .map(key => key.trim())
                .filter(Boolean);

            // An empty endpoint is not "no endpoint" -- it asks the node to
            // supply its own relay, which is the path most identities want.
            await keymaster.publishDidComm(endpoint.trim() || undefined, currentId, keys.length ? keys : undefined);
            setSuccess("DIDComm endpoint published");
            setEndpoint("");
            setRoutingKeys("");
            await refreshStatus();
        } catch (error: any) {
            setError(error);
        } finally {
            setBusy(false);
        }
    }

    async function unpublish() {
        if (!keymaster) return;

        setBusy(true);
        try {
            await keymaster.unpublishDidComm(currentId);
            setSuccess("DIDComm endpoint unpublished");
            await refreshStatus();
        } catch (error: any) {
            setError(error);
        } finally {
            setBusy(false);
        }
    }

    async function send() {
        if (!keymaster) return;

        const recipient = composeTo.trim();

        if (!recipient) {
            setError("Enter a recipient DID or alias");
            return;
        }

        if (composeKind === "message" && !composeContent.trim()) {
            setError("Enter a message to send");
            return;
        }

        setBusy(true);
        try {
            // Resolve first: an alias must not travel in the envelope, which
            // addresses recipients by DID. This also turns an unknown name into a
            // clear error before any crypto happens.
            const docs = await keymaster.resolveDID(recipient);
            const recipientDid = docs.didDocument?.id;

            if (!recipientDid) {
                setError(`Could not resolve ${recipient}`);
                return;
            }

            const message = composeKind === "ping"
                ? trustPing()
                : basicMessage(composeContent);

            await keymaster.sendDidComm(message as unknown as Record<string, unknown>, recipientDid, {
                name: currentId,
                anoncrypt: composeAnoncrypt,
            });

            setSuccess(composeKind === "ping" ? "Ping sent" : "Message sent");
            setComposeContent("");
        } catch (error: any) {
            setError(error);
        } finally {
            setBusy(false);
        }
    }

    function replyTo(sender: string) {
        setComposeTo(sender);
        setComposeKind("message");
        setActiveTab("compose");
    }

    async function dismiss(ids: string[]) {
        if (!keymaster || !ids.length) return;

        setBusy(true);
        try {
            const removed = await keymaster.ackDidComm(ids, { name: currentId });
            setSuccess(removed === 1 ? "Message dismissed" : `${removed} messages dismissed`);
            await refreshInbox();
        } catch (error: any) {
            setError(error);
        } finally {
            setBusy(false);
        }
    }

    async function respondToPing(received: DidCommReceivedMessage) {
        if (!keymaster) return;

        const message = received.message as DidCommPlaintext;
        const sender = message.from;

        if (!sender || !message.id) {
            setError("This ping carries no sender to respond to");
            return;
        }

        setBusy(true);
        try {
            await keymaster.sendDidComm(trustPingResponse(message.id) as unknown as Record<string, unknown>, sender, { name: currentId });
            setSuccess("Ping response sent");
        } catch (error: any) {
            setError(error);
        } finally {
            setBusy(false);
        }
    }

    function renderMessage(received: DidCommReceivedMessage) {
        const message = received.message as DidCommPlaintext;
        const sender = message.from || received.metadata.sender;
        const time = formatTime(message.created_time);

        return (
            <Box key={received.id} sx={{ mb: 2 }}>
                <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap", mb: 0.5 }}>
                    <Chip label={messageLabel(message.type)} size="small" />
                    {/* Anoncrypt hides the sender entirely, so "who sent this" and
                        "is that claim verified" are two different questions. */}
                    <Chip
                        label={received.metadata.authenticated ? "Authenticated" : "Anonymous"}
                        size="small"
                        color={received.metadata.authenticated ? "success" : "default"}
                        variant="outlined"
                    />
                    {time && (
                        <Typography variant="caption" color="text.secondary">
                            {time}
                        </Typography>
                    )}
                    <Box sx={{ ml: "auto", display: "flex", gap: 1 }}>
                        {message.type === TRUST_PING_TYPE && (
                            <Button size="small" onClick={() => respondToPing(received)} disabled={busy}>
                                Respond
                            </Button>
                        )}
                        {message.type === BASIC_MESSAGE_TYPE && sender && (
                            <Button size="small" onClick={() => replyTo(sender)} disabled={busy}>
                                Reply
                            </Button>
                        )}
                        <Button size="small" color="error" onClick={() => dismiss([received.id])} disabled={busy}>
                            Dismiss
                        </Button>
                    </Box>
                </Box>

                <Typography variant="body2" color="text.secondary" sx={{ wordBreak: "break-all" }}>
                    From: {sender || "unknown"}
                </Typography>

                {message.type === BASIC_MESSAGE_TYPE ? (
                    <Typography variant="body1" sx={{ mt: 1, whiteSpace: "pre-wrap" }}>
                        {String(message.body?.content ?? "")}
                    </Typography>
                ) : (
                    <Box
                        component="pre"
                        sx={{
                            mt: 1,
                            p: 1,
                            borderRadius: 1,
                            bgcolor: "action.hover",
                            fontSize: "0.75rem",
                            overflowX: "auto",
                            m: 0,
                        }}
                    >
                        {JSON.stringify(message.body ?? {}, null, 2)}
                    </Box>
                )}

                <Divider sx={{ mt: 2 }} />
            </Box>
        );
    }

    if (loading) {
        return (
            <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
                <CircularProgress />
            </Box>
        );
    }

    return (
        <Box>
            <PageHeader
                title="DIDComm"
                description="Read encrypted DIDComm messages sent to this identity, and publish the endpoint others deliver them to."
            />

            <Tabs
                value={activeTab}
                onChange={(_, value) => setActiveTab(value)}
                sx={{ borderBottom: 1, borderColor: "divider", mb: 2, minHeight: 40 }}
            >
                <Tab label="Inbox" value="inbox" />
                <Tab label="Compose" value="compose" />
                <Tab label="Endpoint" value="endpoint" />
            </Tabs>

            {activeTab === "inbox" && (
                <Section
                    title="Mailbox"
                    description="Messages stay on the node until dismissed."
                    actions={
                        <>
                            <Button variant="outlined" onClick={() => refreshInbox()} disabled={busy}>
                                Refresh
                            </Button>
                            {messages.length > 0 && (
                                <ActionMenu
                                    items={[{
                                        label: "Dismiss all",
                                        onClick: () => dismiss(messages.map(message => message.id)),
                                        disabled: busy,
                                        destructive: true,
                                    }]}
                                />
                            )}
                        </>
                    }
                >
                    {inboxLoading && messages.length === 0 ? (
                        <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
                            <CircularProgress size={24} />
                        </Box>
                    ) : messages.length === 0 ? (
                        <EmptyState
                            icon={<Inbox />}
                            title="No messages"
                            description={status?.endpoint
                                ? "Nothing in the mailbox for this identity."
                                : "Publish an endpoint so others have somewhere to deliver messages."}
                        />
                    ) : (
                        messages.map(renderMessage)
                    )}
                </Section>
            )}

            {activeTab === "compose" && (
                <Section
                    title="New message"
                    description="Send a DIDComm message to any agent that publishes a messaging endpoint."
                    actions={
                        <Button variant="contained" onClick={send} disabled={busy}>
                            Send
                        </Button>
                    }
                >
                    <TextField
                        fullWidth
                        label="To (DID or alias)"
                        value={composeTo}
                        onChange={event => setComposeTo(event.target.value)}
                        disabled={busy}
                        placeholder="did:cid:... or a wallet alias"
                        sx={{ mb: 2 }}
                    />

                    <TextField
                        select
                        fullWidth
                        label="Type"
                        value={composeKind}
                        onChange={event => setComposeKind(event.target.value)}
                        disabled={busy}
                        sx={{ mb: 2 }}
                    >
                        <MenuItem value="message">Message</MenuItem>
                        <MenuItem value="ping">Trust ping</MenuItem>
                    </TextField>

                    {composeKind === "message" && (
                        <TextField
                            fullWidth
                            multiline
                            minRows={4}
                            label="Message"
                            value={composeContent}
                            onChange={event => setComposeContent(event.target.value)}
                            disabled={busy}
                            sx={{ mb: 1 }}
                        />
                    )}

                    <FormControlLabel
                        control={
                            <Checkbox
                                checked={composeAnoncrypt}
                                onChange={event => setComposeAnoncrypt(event.target.checked)}
                                disabled={busy}
                            />
                        }
                        label="Send anonymously"
                    />
                    <Typography variant="body2" color="text.secondary">
                        {composeAnoncrypt
                            ? "The recipient cannot tell who sent this, and cannot reply to it."
                            : "The recipient can verify this came from the current identity."}
                    </Typography>
                </Section>
            )}

            {activeTab === "endpoint" && (
                <>
                    {status ? (
                        <Section
                            title="Published"
                            description="What this identity's DID document currently advertises."
                            actions={
                                <ActionMenu
                                    items={[{
                                        label: "Unpublish",
                                        onClick: unpublish,
                                        disabled: busy,
                                        destructive: true,
                                    }]}
                                />
                            }
                        >
                            <Box sx={{ mb: 2 }}>
                                <Typography variant="body2" color="text.secondary">
                                    Endpoint
                                </Typography>
                                {status.endpoint ? (
                                    <Typography variant="body1" sx={{ wordBreak: "break-all" }}>
                                        {status.endpoint}
                                    </Typography>
                                ) : (
                                    <Box sx={{ display: "flex", alignItems: "center", gap: 1, mt: 0.5 }}>
                                        <Chip label="Key only" size="small" color="warning" />
                                        <Typography variant="body2" color="text.secondary">
                                            Others can encrypt to this identity but have nowhere to deliver.
                                        </Typography>
                                    </Box>
                                )}
                            </Box>

                            {status.routingKeys.length > 0 && (
                                <Box sx={{ mb: 2 }}>
                                    <Typography variant="body2" color="text.secondary">
                                        Routing keys
                                    </Typography>
                                    {status.routingKeys.map(key => (
                                        <Typography
                                            key={key}
                                            variant="body2"
                                            sx={{ wordBreak: "break-all", fontFamily: "monospace", fontSize: "0.75rem" }}
                                        >
                                            {key}
                                        </Typography>
                                    ))}
                                </Box>
                            )}

                            <Box>
                                <Typography variant="body2" color="text.secondary">
                                    Key agreement
                                </Typography>
                                <Chip
                                    label={status.keyAgreement ? "Published" : "Missing"}
                                    size="small"
                                    color={status.keyAgreement ? "success" : "warning"}
                                    sx={{ mt: 0.5 }}
                                />
                            </Box>
                        </Section>
                    ) : (
                        <Section dense>
                            <EmptyState
                                icon={<Forum />}
                                title="No DIDComm endpoint published"
                                description="Publish to add a key agreement key and a messaging endpoint to this identity's DID document."
                            />
                        </Section>
                    )}

                    <Section
                        title="Endpoint"
                        description="Leave blank to use this node's own relay. Set one explicitly to publish a mediator or an endpoint the node cannot discover."
                        actions={
                            <Button variant="contained" onClick={publish} disabled={busy}>
                                {status ? "Update" : "Publish"}
                            </Button>
                        }
                    >
                        <TextField
                            fullWidth
                            label="Endpoint URL (optional)"
                            value={endpoint}
                            onChange={event => setEndpoint(event.target.value)}
                            disabled={busy}
                            placeholder="https://relay.example/didcomm"
                            sx={{ mb: 2 }}
                        />
                        <TextField
                            fullWidth
                            label="Routing keys (optional, comma separated)"
                            value={routingKeys}
                            onChange={event => setRoutingKeys(event.target.value)}
                            disabled={busy}
                            placeholder="did:cid:mediator#key-agreement-1"
                            helperText="Set these when delivery goes through a mediator; senders then wrap messages in a Forward."
                        />
                    </Section>
                </>
            )}
        </Box>
    );
}

export default DidCommTab;
