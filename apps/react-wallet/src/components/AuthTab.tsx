import { useEffect, useState } from "react";
import {
    Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle,
    MenuItem, Select, TextField, IconButton, InputAdornment, Tooltip, Typography
} from "@mui/material";
import { CameraAlt } from "@mui/icons-material";
import axios from "axios";
import { useWalletContext } from "../contexts/WalletProvider";
import { useSnackbar } from "../contexts/SnackbarProvider";
import { useUIContext } from "../contexts/UIContext";
import { useVariablesContext } from "../contexts/VariablesProvider";
import { scanQrCode } from "../utils/utils";

function AuthTab() {
    const [authDID, setAuthDID] = useState<string>("");
    const [callback, setCallback] = useState<string>("");
    const [challenge, setChallenge] = useState<string>("");
    const [response, setResponse] = useState<string>("");
    const [disableSendResponse, setDisableSendResponse] = useState<boolean>(true);
    const [showChallengeDialog, setShowChallengeDialog] = useState<boolean>(false);
    const [challengeSchemas, setChallengeSchemas] = useState<string[]>([]);
    const [challengeSchemaSelection, setChallengeSchemaSelection] = useState<string>("");
    const { keymaster } = useWalletContext();
    const {
        setOpenBrowser,
        pendingChallenge,
        setPendingChallenge
    } = useUIContext();
    const {
        setError,
        setWarning,
    } = useSnackbar();
    const { schemaList } = useVariablesContext();

    useEffect(() => {
        if (pendingChallenge && pendingChallenge !== challenge) {
            setChallenge(pendingChallenge);
            setPendingChallenge(null);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pendingChallenge]);

    function openChallengeDialog() {
        setChallengeSchemas([]);
        setChallengeSchemaSelection("");
        setShowChallengeDialog(true);
    }

    function closeChallengeDialog() {
        setShowChallengeDialog(false);
    }

    function addChallengeSchema() {
        if (challengeSchemaSelection && !challengeSchemas.includes(challengeSchemaSelection)) {
            setChallengeSchemas([...challengeSchemas, challengeSchemaSelection]);
            setChallengeSchemaSelection("");
        }
    }

    function removeChallengeSchema(schema: string) {
        setChallengeSchemas(challengeSchemas.filter(s => s !== schema));
    }

    async function newChallenge() {
        if (!keymaster) {
            return;
        }
        try {
            closeChallengeDialog();
            const spec: { credentials?: { schema: string }[] } = {};
            if (challengeSchemas.length > 0) {
                const credentials: { schema: string }[] = [];
                for (const name of challengeSchemas) {
                    const did = await keymaster.lookupDID(name);
                    credentials.push({ schema: did });
                }
                spec.credentials = credentials;
            }
            const did = await keymaster.createChallenge(spec);
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
                setWarning("Response is VALID");
            } else {
                setWarning("Response is NOT VALID");
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
                        Add schemas to request specific credentials. Leave empty for an open challenge.
                    </Typography>
                    <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mb: 2 }}>
                        <Select
                            value={challengeSchemaSelection}
                            onChange={(e) => setChallengeSchemaSelection(e.target.value)}
                            displayEmpty
                            size="small"
                            sx={{ minWidth: 200 }}
                        >
                            <MenuItem value="" disabled>Select schema</MenuItem>
                            {schemaList
                                .filter((s: string) => !challengeSchemas.includes(s))
                                .map((s: string) => (
                                    <MenuItem key={s} value={s}>{s}</MenuItem>
                                ))
                            }
                        </Select>
                        <Button variant="contained" size="small" onClick={addChallengeSchema} disabled={!challengeSchemaSelection}>
                            Add
                        </Button>
                    </Box>
                    {challengeSchemas.length > 0 &&
                        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                            {challengeSchemas.map((s) => (
                                <Chip key={s} label={s} onDelete={() => removeChallengeSchema(s)} />
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
        </Box>
    );
}

export default AuthTab;
