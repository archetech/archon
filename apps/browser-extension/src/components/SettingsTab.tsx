import React, { useState, useEffect } from "react";
import { Box, Button, TextField, Typography } from "@mui/material";
import SaveIcon from "@mui/icons-material/Save";
import { useWalletContext } from "../contexts/WalletProvider";
import { useSnackbar } from "../contexts/SnackbarProvider";
import packageJson from "../../package.json";

const REFRESH_INTERVAL_STORAGE_KEY = 'ARCHON_REFRESH_INTERVAL_SECONDS';
const DEFAULT_REFRESH_INTERVAL_SECONDS = 10;

const SettingsTab = () => {
    const [gatekeeperUrl, setGatekeeperUrl] = useState<string>("");
    const [refreshIntervalSeconds, setRefreshIntervalSeconds] = useState<string>(String(DEFAULT_REFRESH_INTERVAL_SECONDS));
    const [serverVersion, setServerVersion] = useState<string>("");
    const {
        initialiseServices,
        initialiseWallet
    } = useWalletContext();
    const { setSuccess } = useSnackbar();

    const fetchServerVersion = (url: string) => {
        fetch(`${url}/api/v1/version`)
            .then(r => r.json())
            .then(data => setServerVersion(`${data.version} (${data.commit})`))
            .catch(() => {});
    };

    useEffect(() => {
        const init = async () => {
            try {
                const result = await chrome.storage.sync.get(["gatekeeperUrl", REFRESH_INTERVAL_STORAGE_KEY]);
                const url = result.gatekeeperUrl as string;
                const savedRefreshInterval = result[REFRESH_INTERVAL_STORAGE_KEY];
                const parsedRefreshInterval = Number(savedRefreshInterval);
                setGatekeeperUrl(url);
                if (savedRefreshInterval === undefined || !Number.isFinite(parsedRefreshInterval) || parsedRefreshInterval < 0) {
                    setRefreshIntervalSeconds(String(DEFAULT_REFRESH_INTERVAL_SECONDS));
                } else {
                    setRefreshIntervalSeconds(String(Math.floor(parsedRefreshInterval)));
                }

                if (url) {
                    fetchServerVersion(url);
                }
            } catch (error: any) {
                console.error("Error retrieving gatekeeperUrl:", error);
            }
        };
        init();
    }, []);

    const handleSave = async () => {
        try {
            const parsedRefreshInterval = Number(refreshIntervalSeconds);
            if (!Number.isFinite(parsedRefreshInterval) || parsedRefreshInterval < 0) {
                throw new Error("Auto-refresh interval must be 0 or greater");
            }

            await chrome.storage.sync.set({
                gatekeeperUrl,
                [REFRESH_INTERVAL_STORAGE_KEY]: Math.floor(parsedRefreshInterval),
            });
            await initialiseServices();
            await initialiseWallet();
            fetchServerVersion(gatekeeperUrl);
            setSuccess("Services updated");
        } catch (error: any) {
            console.error("Error saving URLs:", error);
        }
    };

    return (
        <Box
            sx={{ display: "flex", flexDirection: "column", maxWidth: "400px" }}
        >
            <TextField
                label="Node URL"
                variant="outlined"
                value={gatekeeperUrl}
                onChange={(e) => setGatekeeperUrl(e.target.value)}
                sx={{ mb: 2 }}
                className="text-field"
            />

            <TextField
                label="Auto-refresh interval (seconds)"
                variant="outlined"
                type="number"
                value={refreshIntervalSeconds}
                onChange={(e) => setRefreshIntervalSeconds(e.target.value)}
                sx={{ mb: 2 }}
                className="text-field"
                inputProps={{ min: 0, step: 1 }}
                helperText="Set to 0 to disable automatic DMail and poll refresh."
            />

            <Button
                variant="contained"
                color="primary"
                onClick={handleSave}
                startIcon={<SaveIcon />}
                sx={{ alignSelf: "start" }}
            >
                Save
            </Button>

            <Box sx={{ mt: 3, opacity: 0.6 }}>
                <Typography variant="caption" display="block">
                    Client v{packageJson.version} | Server v{serverVersion || "..."}
                </Typography>
            </Box>
        </Box>
    );
};

export default SettingsTab;
