import { useEffect, useRef, useState } from "react";
import {
    Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle,
    Divider, MenuItem, Paper, Select, TextField, IconButton, InputAdornment, Tooltip, Typography
} from "@mui/material";
import { CameraAlt, CheckCircle, Login, Warning } from "@mui/icons-material";
import axios from "axios";
import { useWalletContext } from "../contexts/WalletProvider";
import { useSnackbar } from "../contexts/SnackbarProvider";
import { useUIContext } from "../contexts/UIContext";
import { useVariablesContext } from "../contexts/VariablesProvider";
import { scanQrCode } from "../utils/utils";

interface AutoLoginState {
    responseDID: string;
    callbackUrl: string;
    fulfilled: number;
    requested: number;
    match: boolean;
    credentials: { vc: string; vp: string }[];
}

function AuthTab() {
    const [authDID, setAuthDID] = useState<string>("");
    const [callback, setCallback] = useState<string>("");
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
    const {
        setOpenBrowser,
        pendingChallenge,
        setPendingChallenge
    } = useUIContext();
    const {
        setError,
        setSuccess,
    } = useSnackbar();
    const { schemaList, agentList } = useVariablesContext();

    useEffect(() => {
        if (pendingChallenge && pendingChallenge !== challenge) {
            setChallenge(pendingChallenge);
            setPendingChallenge(null);
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

    async function handleAutoResponse(challengeDID: string) {
        if (!keymaster) return;

        setAutoLoginLoading(true);
        setAutoLogin(null);
        setAutoLoginSent(false);

        try {
            const asset = await keymaster.resolveAsset(challengeDID);
            const challengeData = (asset as { challenge: { callback?: string; credentials?: { schema: string; issuers?: string[] }[] } }).challenge;
            const callbackUrl = challengeData?.callback || "";

            const responseDID = await keymaster.createResponse(challengeDID, { retries: 10 });
            setResponse(responseDID);

            const decrypted = await keymaster.decryptJSON(responseDID) as {
                response: { challenge: string; credentials: { vc: string; vp: string }[]; requested: number; fulfilled: number; match: boolean }
            };
            const responseData = decrypted.response;

            setAutoLogin({
                responseDID,
                callbackUrl,
                fulfilled: responseData.fulfilled,
                requested: responseData.requested,
                match: responseData.match,
                credentials: responseData.credentials,
            });

            setCallback(callbackUrl);
            setDisableSendResponse(!callbackUrl);
        } catch (error: any) {
            setError(error);
        } finally {
            setAutoLoginLoading(false);
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
            setOpenBrowser({
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
            const response = await keymaster.createResponse(challenge, {
                retries: 10,
            });
            await setResponse(response);

            const asset = await keymaster.resolveAsset(challenge);
            const callback = (asset as { challenge: { callback: string } }).challenge.callback;

            await setCallback(callback);

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
            setOpenBrowser({
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
        const qr = await scanQrCode();
        if (!qr) {
            setError("Failed to scan QR code");
            return;
        }

        setChallenge(qr);
    }

    return (
        <Box>
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
                                    endAdornment: (
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
                                    ),
                                }
                            }}
                        />
                    </Box>

                    <Box className="flex-box">
                        <Button
                            variant="contained"
                            color="primary"
                            onClick={openChallengeDialog}
                            className="button large bottom"
                        >
                            New...
                        </Button>

                        <Button
                            variant="contained"
                            color="primary"
                            onClick={() => resolveChallenge(challenge)}
                            className="button large bottom"
                            disabled={!challenge || challenge === authDID}
                        >
                            Resolve
                        </Button>

                        <Button
                            variant="contained"
                            color="primary"
                            onClick={createResponse}
                            className="button large bottom"
                            disabled={!challenge}
                        >
                            Respond
                        </Button>

                        <Button
                            variant="contained"
                            color="primary"
                            onClick={clearChallenge}
                            className="button large bottom"
                            disabled={!challenge}
                        >
                            Clear
                        </Button>
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

                    <Box className="flex-box">
                        <Button
                            variant="contained"
                            color="primary"
                            onClick={() => decryptResponse(response)}
                            className="button large bottom"
                            disabled={!response || response === authDID}
                        >
                            Decrypt
                        </Button>

                        <Button
                            variant="contained"
                            color="primary"
                            onClick={verifyResponse}
                            className="button large bottom"
                            disabled={!response}
                        >
                            Verify
                        </Button>

                        <Button
                            variant="contained"
                            color="primary"
                            onClick={sendResponse}
                            className="button large bottom"
                            disabled={disableSendResponse}
                        >
                            Send
                        </Button>

                        <Button
                            variant="contained"
                            color="primary"
                            onClick={clearResponse}
                            className="button large bottom"
                            disabled={!response}
                        >
                            Clear
                        </Button>
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

export default AuthTab;
