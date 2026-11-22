import { useEffect, useRef, useState } from "react";
import {
    Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle,
    Divider, MenuItem, Paper, Select, Tab, Tabs, TextField, IconButton, InputAdornment, Tooltip, Typography
} from "@mui/material";
import { CameraAlt, CheckCircle, Login, Warning } from "@mui/icons-material";
import axios from "axios";
import { useWalletContext } from "../contexts/WalletProvider";
import { useSnackbar } from "../contexts/SnackbarProvider";
import { useWalletNavigation } from "../contexts/WalletNavigation";
import { useVariablesContext } from "../contexts/VariablesProvider";
import { usePlatformCapabilities } from "../contexts/PlatformCapabilities";
import PageHeader from "./layout/PageHeader";
import GrantsTab from "./GrantsTab";
import { grantRequestIn } from "@didcid/keymaster/grant";
import ActionMenu from "./layout/ActionMenu";

// What the challenge's issuer says a response grants, such as connecting an
// agent to an account. It is shown with the destination so the person
// answering can tell a sign-in from an authorization someone sent them.
function challengeDescription(challenge: { description?: unknown } | undefined): string {
    const text = challenge?.description;
    return typeof text === 'string' ? text.slice(0, 500) : '';
}

interface AutoLoginState {
    responseDID: string;
    callbackUrl: string;
    description: string;
    fulfilled: number;
    requested: number;
    match: boolean;
    credentials: { vc: string; vp: string }[];
}

// What is said of a DID that came as a challenge and holds a grant request.
const NOT_A_CHALLENGE = "This is a grant request, not a challenge. A grant request's link is archon://auth?grant= followed by its DID: open that, or paste it under Grants.";

// Signing in: answering a challenge, and making one and checking its answer.
//
// A challenge and a grant request are both a DID a service made, and a link
// says which it names. What the DID holds is checked all the same, before
// anything is answered: nothing is made of a grant request by its arriving as a
// challenge.
function SignIn() {
    const [authDID, setAuthDID] = useState<string>("");
    const [callback, setCallback] = useState<string>("");
    const [description, setDescription] = useState<string>("");
    const [challenge, setChallenge] = useState<string>("");
    const [response, setResponse] = useState<string>("");
    const [disableSendResponse, setDisableSendResponse] = useState<boolean>(true);
    const [showChallengeDialog, setShowChallengeDialog] = useState<boolean>(false);
    const [challengeCredentials, setChallengeCredentials] = useState<{ schema: string; issuer: string }[]>([]);
    const [challengeSchemaSelection, setChallengeSchemaSelection] = useState<string>("");
    const [challengeIssuerSelection, setChallengeIssuerSelection] = useState<string>("");
    const [autoLogin, setAutoLogin] = useState<AutoLoginState | null>(null);
    const [autoLoginLoading, setAutoLoginLoading] = useState(false);
    const [autoLoginSent, setAutoLoginSent] = useState(false);
    const pendingAutoRef = useRef<string | null>(null);
    const { keymaster } = useWalletContext();
    const { pendingChallenge, setPendingChallenge, dispatchDeepLink } = useWalletNavigation();
    const { openView } = useWalletNavigation();
    const {
        setError,
        setSuccess,
    } = useSnackbar();
    const { scanQr } = usePlatformCapabilities();
    const { schemaList, agentList } = useVariablesContext();

    useEffect(() => {
        if (pendingChallenge && pendingChallenge !== challenge) {
            setChallenge(pendingChallenge);
            setPendingChallenge?.(null);
            if (keymaster) {
                handleAutoResponse(pendingChallenge);
            } else {
                pendingAutoRef.current = pendingChallenge;
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pendingChallenge]);

    useEffect(() => {
        if (keymaster && pendingAutoRef.current) {
            const did = pendingAutoRef.current;
            pendingAutoRef.current = null;
            handleAutoResponse(did);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [keymaster]);

    // Each arrival is numbered, so that an answer to one that another has
    // since replaced is dropped.
    const arrivals = useRef(0);

    async function handleAutoResponse(challengeDID: string) {
        if (!keymaster) return;

        const arrival = arrivals.current += 1;

        setAutoLoginLoading(true);
        setAutoLogin(null);
        setAutoLoginSent(false);

        try {
            const asset = await keymaster.resolveAsset(challengeDID);

            if (arrival !== arrivals.current) {
                return;
            }
            if (grantRequestIn(asset)) {
                setChallenge("");
                setError(NOT_A_CHALLENGE);
                return;
            }

            const challengeData = (asset as { challenge: { callback?: string; description?: string; credentials?: { schema: string; issuers?: string[] }[] } }).challenge;
            const callbackUrl = challengeData?.callback || "";

            const responseDID = await keymaster.createResponse(challengeDID, { retries: 10 });

            if (arrival !== arrivals.current) {
                return;
            }
            setResponse(responseDID);

            const decrypted = await keymaster.decryptJSON(responseDID) as {
                response: { challenge: string; credentials: { vc: string; vp: string }[]; requested: number; fulfilled: number; match: boolean }
            };
            const responseData = decrypted.response;

            setAutoLogin({
                responseDID,
                callbackUrl,
                description: challengeDescription(challengeData),
                fulfilled: responseData.fulfilled,
                requested: responseData.requested,
                match: responseData.match,
                credentials: responseData.credentials,
            });

            setCallback(callbackUrl);
            setDisableSendResponse(!callbackUrl);
        } catch (error: any) {
            if (arrival === arrivals.current) {
                setError(error);
            }
        } finally {
            if (arrival === arrivals.current) {
                setAutoLoginLoading(false);
            }
        }
    }

    async function autoLoginSend() {
        if (!autoLogin?.callbackUrl || !autoLogin.responseDID) return;
        try {
            setDisableSendResponse(true);
            await axios.post(autoLogin.callbackUrl, { response: autoLogin.responseDID });
            setAutoLoginSent(true);
            setSuccess("Response sent successfully");
            setCallback("");
        } catch (error: any) {
            setDisableSendResponse(false);
            setError(error);
        }
    }

    function dismissAutoLogin() {
        setAutoLogin(null);
        setAutoLoginLoading(false);
        setAutoLoginSent(false);
    }

    function openChallengeDialog() {
        setChallengeCredentials([]);
        setChallengeSchemaSelection("");
        setChallengeIssuerSelection("");
        setShowChallengeDialog(true);
    }

    function closeChallengeDialog() {
        setShowChallengeDialog(false);
    }

    function addChallengeCredential() {
        if (challengeSchemaSelection) {
            setChallengeCredentials([...challengeCredentials, {
                schema: challengeSchemaSelection,
                issuer: challengeIssuerSelection || "",
            }]);
            setChallengeSchemaSelection("");
            setChallengeIssuerSelection("");
        }
    }

    function removeChallengeCredential(index: number) {
        setChallengeCredentials(challengeCredentials.filter((_, i) => i !== index));
    }

    async function newChallenge() {
        if (!keymaster) {
            return;
        }
        try {
            const spec: { credentials?: { schema: string; issuers?: string[] }[] } = {};
            if (challengeCredentials.length > 0) {
                const credentials: { schema: string; issuers?: string[] }[] = [];
                for (const cred of challengeCredentials) {
                    const schemaDid = await keymaster.lookupDID(cred.schema);
                    const entry: { schema: string; issuers?: string[] } = { schema: schemaDid };
                    if (cred.issuer) {
                        const issuerDid = await keymaster.lookupDID(cred.issuer);
                        entry.issuers = [issuerDid];
                    }
                    credentials.push(entry);
                }
                spec.credentials = credentials;
            }
            const did = await keymaster.createChallenge(spec);
            closeChallengeDialog();
            await setChallenge(did);
            await resolveChallenge(did);
        } catch (error: any) {
            setError(error);
        }
    }

    async function resolveChallenge(did: string) {
        if (!keymaster) {
            return;
        }
        try {
            const contents = await keymaster.resolveAsset(did);
            await setAuthDID(did);
            openView({
                did,
                tab: "viewer",
                contents
            });
        } catch (error: any) {
            setError(error);
        }
    }

    async function createResponse() {
        if (!keymaster) {
            return;
        }
        try {
            await clearResponse();

            // A challenge this node does not have yet is left to createResponse,
            // which waits for it.
            const held = await keymaster.resolveAsset(challenge).catch(() => undefined);

            if (grantRequestIn(held)) {
                setChallenge("");
                setError(NOT_A_CHALLENGE);
                return;
            }

            const response = await keymaster.createResponse(challenge, {
                retries: 10,
            });
            await setResponse(response);

            const asset = await keymaster.resolveAsset(challenge);
            const challengeData = (asset as { challenge: { callback: string; description?: string } }).challenge;
            const callback = challengeData.callback;

            await setCallback(callback);
            setDescription(challengeDescription(challengeData));

            if (callback) {
                await setDisableSendResponse(false);
            }
        } catch (error: any) {
            setError(error);
        }
    }

    async function clearChallenge() {
        await setChallenge("");
    }

    async function decryptResponse(did: string) {
        if (!keymaster) {
            return;
        }
        try {
            const contents = await keymaster.decryptJSON(did);
            await setAuthDID(did);
            openView({
                did,
                tab: "viewer",
                contents
            });
        } catch (error: any) {
            setError(error);
        }
    }

    async function verifyResponse() {
        if (!keymaster) {
            return;
        }
        try {
            const verify = await keymaster.verifyResponse(response);

            if (verify.match) {
                setSuccess("Response is VALID");
            } else {
                setError("Response is NOT VALID");
            }
        } catch (error: any) {
            setError(error);
        }
    }

    async function clearResponse() {
        await setResponse("");
    }

    async function sendResponse() {
        try {
            await setDisableSendResponse(true);
            await axios.post(callback, { response });
            await setCallback("");
        } catch (error: any) {
            setError(error);
        }
    }

    async function scanChallengeQR() {
        const qr = await scanQr?.();
        if (!qr) {
            setError("Failed to scan QR code");
            return;
        }

        dispatchDeepLink?.(qr);
    }

    return (
        <Box>
            <PageHeader
                title="Authentication"
                description="Respond to login challenges and verify responses from others."
            />
            {autoLoginLoading && (
                <Paper elevation={2} sx={{ p: 3, m: 2, textAlign: 'center' }}>
                    <CircularProgress size={40} />
                    <Typography sx={{ mt: 2 }}>Processing challenge...</Typography>
                </Paper>
            )}

            {autoLogin && !autoLoginLoading && (
                <Paper elevation={2} sx={{ p: 3, m: 2 }}>
                    <Typography variant="h6" sx={{ mb: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Login /> Login Request
                    </Typography>

                    <Divider sx={{ mb: 2 }} />

                    {autoLogin.description && (
                        <Alert severity="info" sx={{ mb: 2 }}>
                            {autoLogin.description}
                        </Alert>
                    )}

                    {autoLogin.callbackUrl && (
                        <Box sx={{ mb: 2 }}>
                            <Typography variant="body2" color="text.secondary">
                                Destination
                            </Typography>
                            <Typography variant="body1" sx={{ wordBreak: 'break-all' }}>
                                {autoLogin.callbackUrl}
                            </Typography>
                        </Box>
                    )}

                    <Box sx={{ mb: 2 }}>
                        <Typography variant="body2" color="text.secondary">
                            Credentials
                        </Typography>
                        {autoLogin.requested === 0 ? (
                            <Typography variant="body1">
                                Identity verification only (no credentials requested)
                            </Typography>
                        ) : (
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5 }}>
                                {autoLogin.match ? (
                                    <Chip
                                        icon={<CheckCircle />}
                                        label={`${autoLogin.fulfilled} of ${autoLogin.requested} credential(s) matched`}
                                        color="success"
                                        size="small"
                                    />
                                ) : (
                                    <Chip
                                        icon={<Warning />}
                                        label={`${autoLogin.fulfilled} of ${autoLogin.requested} credential(s) matched`}
                                        color="warning"
                                        size="small"
                                    />
                                )}
                            </Box>
                        )}
                    </Box>

                    <Box sx={{ mb: 2 }}>
                        <Typography variant="body2" color="text.secondary">
                            Response
                        </Typography>
                        <Typography variant="body2" sx={{ wordBreak: 'break-all', fontFamily: 'monospace', fontSize: '0.75rem' }}>
                            {autoLogin.responseDID}
                        </Typography>
                    </Box>

                    <Divider sx={{ mb: 2 }} />

                    {autoLoginSent ? (
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                            <CheckCircle color="success" />
                            <Typography color="success.main">Response sent</Typography>
                            <Button
                                variant="outlined"
                                onClick={dismissAutoLogin}
                                sx={{ ml: 'auto' }}
                            >
                                Done
                            </Button>
                        </Box>
                    ) : (
                        <Box sx={{ display: 'flex', gap: 1 }}>
                            {autoLogin.callbackUrl && (
                                <Button
                                    variant="contained"
                                    color="primary"
                                    onClick={autoLoginSend}
                                    disabled={disableSendResponse}
                                    startIcon={<Login />}
                                    size="large"
                                >
                                    Login
                                </Button>
                            )}
                            <Button
                                variant="outlined"
                                onClick={dismissAutoLogin}
                            >
                                Cancel
                            </Button>
                        </Box>
                    )}
                </Paper>
            )}

            {!autoLogin && !autoLoginLoading && (
                <>
                    <Box className="flex-box mt-2">
                        <TextField
                            label="Challenge"
                            variant="outlined"
                            value={challenge}
                            onChange={(e) => setChallenge(e.target.value.trim())}
                            size="small"
                            className="text-field top"
                            slotProps={{
                                htmlInput: {
                                    maxLength: 80,
                                },
                                input: {
                                    // Only offered where there is a camera. In a host
                                    // without one this control could do nothing but
                                    // report a failed scan.
                                    endAdornment: scanQr ? (
                                        <InputAdornment position="end">
                                            <Tooltip title="Scan QR" placement="top">
                                                <span>
                                                    <IconButton
                                                        edge="end"
                                                        onClick={scanChallengeQR}
                                                    >
                                                        <CameraAlt />
                                                    </IconButton>
                                                </span>
                                            </Tooltip>
                                        </InputAdornment>
                                    ) : undefined,
                                }
                            }}
                        />
                    </Box>

                    <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", mt: 1 }}>
                        <Button
                            variant="contained"
                            onClick={createResponse}
                            disabled={!challenge}
                        >
                            Respond
                        </Button>

                        <Button variant="outlined" onClick={openChallengeDialog}>
                            New challenge
                        </Button>

                        <ActionMenu
                            label="More"
                            items={[
                                { label: "Resolve challenge", onClick: () => resolveChallenge(challenge), disabled: !challenge || challenge === authDID },
                                { label: "Clear", onClick: clearChallenge, disabled: !challenge },
                            ]}
                        />
                    </Box>

                    <Box className="flex-box mt-2">
                        <TextField
                            label="Response"
                            variant="outlined"
                            value={response}
                            onChange={(e) => setResponse(e.target.value.trim())}
                            size="small"
                            className="text-field top"
                        />
                    </Box>

                    {description && callback && (
                        <Alert severity="info" sx={{ mt: 1 }}>
                            {description}
                        </Alert>
                    )}

                    <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", mt: 1 }}>
                        <Button
                            variant="contained"
                            onClick={sendResponse}
                            disabled={disableSendResponse}
                        >
                            Send
                        </Button>

                        <Button
                            variant="outlined"
                            onClick={verifyResponse}
                            disabled={!response}
                        >
                            Verify
                        </Button>

                        <ActionMenu
                            label="More"
                            items={[
                                { label: "Decrypt response", onClick: () => decryptResponse(response), disabled: !response || response === authDID },
                                { label: "Clear", onClick: clearResponse, disabled: !response },
                            ]}
                        />
                    </Box>

                    <Dialog open={showChallengeDialog} onClose={closeChallengeDialog}>
                        <DialogTitle>New Challenge</DialogTitle>
                        <DialogContent>
                            <Typography variant="body2" sx={{ mb: 2 }}>
                                Add credential requirements. Leave empty for an open challenge.
                            </Typography>
                            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mb: 2 }}>
                                <Select
                                    value={challengeSchemaSelection}
                                    onChange={(e) => setChallengeSchemaSelection(e.target.value)}
                                    displayEmpty
                                    size="small"
                                    sx={{ minWidth: 180 }}
                                >
                                    <MenuItem value="" disabled>Schema</MenuItem>
                                    {schemaList.map((s: string) => (
                                        <MenuItem key={s} value={s}>{s}</MenuItem>
                                    ))}
                                </Select>
                                <Select
                                    value={challengeIssuerSelection}
                                    onChange={(e) => setChallengeIssuerSelection(e.target.value)}
                                    displayEmpty
                                    size="small"
                                    sx={{ minWidth: 180 }}
                                >
                                    <MenuItem value="">Any issuer</MenuItem>
                                    {agentList.map((s: string) => (
                                        <MenuItem key={s} value={s}>{s}</MenuItem>
                                    ))}
                                </Select>
                                <Button variant="contained" size="small" onClick={addChallengeCredential} disabled={!challengeSchemaSelection}>
                                    Add
                                </Button>
                            </Box>
                            {challengeCredentials.length > 0 &&
                                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                                    {challengeCredentials.map((cred, i) => (
                                        <Chip
                                            key={i}
                                            label={cred.issuer ? `${cred.schema} (${cred.issuer})` : cred.schema}
                                            onDelete={() => removeChallengeCredential(i)}
                                        />
                                    ))}
                                </Box>
                            }
                        </DialogContent>
                        <DialogActions>
                            <Button onClick={closeChallengeDialog}>Cancel</Button>
                            <Button variant="contained" onClick={newChallenge}>
                                Create
                            </Button>
                        </DialogActions>
                    </Dialog>
                </>
            )}
        </Box>
    );
}

type Section = "sign-in" | "grants";

// What a service asks of an identity: to prove who it is, which is signing in,
// and to let a client act in its name, which is a grant. Both begin with a DID
// the service made and shows the wallet.
//
// Signing in stays mounted while grants are shown, since it is what takes a
// challenge that arrives by a link or a scan, and one that arrives brings it to
// the front. A grant request that arrives is shown for review under Grants.
function AuthTab() {
    const [section, setSection] = useState<Section>("sign-in");
    const [asked, setAsked] = useState<string | null>(null);
    const { pendingChallenge, pendingGrant, setPendingGrant } = useWalletNavigation();

    useEffect(() => {
        if (pendingChallenge) {
            setSection("sign-in");
        }
    }, [pendingChallenge]);

    useEffect(() => {
        if (pendingGrant) {
            setAsked(pendingGrant);
            setSection("grants");
            setPendingGrant?.(null);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pendingGrant]);

    return (
        <Box>
            <Tabs
                value={section}
                onChange={(_event, value: Section) => setSection(value)}
                aria-label="Authentication and grants"
                sx={{ borderBottom: 1, borderColor: "divider", mb: 1 }}
            >
                <Tab label="Sign in" value="sign-in" id="auth-tab-sign-in" aria-controls="auth-panel-sign-in" />
                <Tab label="Grants" value="grants" id="auth-tab-grants" aria-controls="auth-panel-grants" />
            </Tabs>
            <Box role="tabpanel" id="auth-panel-sign-in" aria-labelledby="auth-tab-sign-in" hidden={section !== "sign-in"}>
                <SignIn />
            </Box>
            <Box role="tabpanel" id="auth-panel-grants" aria-labelledby="auth-tab-grants" hidden={section !== "grants"}>
                {section === "grants" && <GrantsTab request={asked ?? undefined} onRequestTaken={() => setAsked(null)} />}
            </Box>
        </Box>
    );
}

export default AuthTab;
