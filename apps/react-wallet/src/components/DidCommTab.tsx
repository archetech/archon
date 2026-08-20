import { useCallback, useEffect, useState } from "react";
import { Box, Button, Chip, CircularProgress, TextField, Typography } from "@mui/material";
import { Forum } from "@mui/icons-material";
import { useWalletContext } from "../contexts/WalletProvider";
import { useVariablesContext } from "../contexts/VariablesProvider";
import { useSnackbar } from "../contexts/SnackbarProvider";
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

function DidCommTab() {
    const [status, setStatus] = useState<DidCommStatus | null>(null);
    const [loading, setLoading] = useState<boolean>(true);
    const [busy, setBusy] = useState<boolean>(false);
    const [endpoint, setEndpoint] = useState<string>("");
    const [routingKeys, setRoutingKeys] = useState<string>("");
    const { keymaster } = useWalletContext();
    const { currentId, currentDID } = useVariablesContext();
    const { setError, setSuccess } = useSnackbar();

    const refresh = useCallback(async () => {
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

    useEffect(() => {
        setLoading(true);
        refresh();
    }, [refresh]);

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
            await refresh();
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
            await refresh();
        } catch (error: any) {
            setError(error);
        } finally {
            setBusy(false);
        }
    }

    if (loading) {
        return (
            <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
                <CircularProgress />
            </Box>
        );
    }

    return (
        <Box sx={{ p: 2 }}>
            <PageHeader
                title="DIDComm"
                description="Publish a messaging endpoint so other agents can send encrypted DIDComm messages to this identity."
                actions={
                    <>
                        <Button variant="contained" onClick={publish} disabled={busy}>
                            {status ? "Update" : "Publish"}
                        </Button>
                        {status && (
                            <ActionMenu
                                items={[{
                                    label: "Unpublish",
                                    onClick: unpublish,
                                    disabled: busy,
                                    destructive: true,
                                }]}
                            />
                        )}
                    </>
                }
            />

            {status ? (
                <Section
                    title="Published"
                    description="What this identity's DID document currently advertises."
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
        </Box>
    );
}

export default DidCommTab;
