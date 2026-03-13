import { useState, useEffect } from "react";
import {Box, Button, Switch, TextField, Typography} from "@mui/material";
import { DarkMode, LightMode, Save } from "@mui/icons-material";
import { useThemeContext } from "../contexts/ContextProviders";
import { useWalletContext } from "../contexts/WalletProvider";
import { useSnackbar } from "../contexts/SnackbarProvider";
import {
    DEFAULT_GATEKEEPER_URL,
    GATEKEEPER_KEY,
} from "../constants";
import packageJson from "../../package.json";

const SettingsTab = () => {
    const [gatekeeperUrl, setGatekeeperUrl] = useState<string>(DEFAULT_GATEKEEPER_URL);
    const [serverVersion, setServerVersion] = useState<string>("");
    const {
        darkMode,
        handleDarkModeToggle,
    } = useThemeContext();
    const {
        initialiseServices,
        initialiseWallet
    } = useWalletContext();
    const { setSuccess } = useSnackbar();

    useEffect(() => {
        const init = async () => {
            try {
                const gatekeeperUrl = localStorage.getItem(GATEKEEPER_KEY);
                if (gatekeeperUrl) {
                    setGatekeeperUrl(gatekeeperUrl);
                }
            } catch (error: any) {
                console.error("Error retrieving gatekeeperUrl:", error);
            }
        };
        init();
    }, []);

    const fetchServerVersion = (url: string) => {
        fetch(`${url}/api/v1/version`)
            .then(r => r.json())
            .then(data => setServerVersion(`${data.version} (${data.commit})`))
            .catch(() => {});
    };

    useEffect(() => {
        const url = localStorage.getItem(GATEKEEPER_KEY) || DEFAULT_GATEKEEPER_URL;
        fetchServerVersion(url);
    }, []);

    const handleSave = async () => {
        try {
            localStorage.setItem(GATEKEEPER_KEY, gatekeeperUrl);
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
            sx={{ display: "flex", flexDirection: "column", maxWidth: "400px", mt: 1 }}
        >
            <Box sx={{ display: "flex", flexDirection: "row", alignItems: "center", mb: 2 }}>
                <Typography>Theme</Typography>
                <LightMode sx={{ ml: 2, mr: 1 }} />

                <Switch
                    checked={darkMode}
                    onChange={handleDarkModeToggle}
                    color="default"
                />

                <DarkMode sx={{ ml: 1 }} />
            </Box>

            <TextField
                label="Gatekeeper URL"
                variant="outlined"
                value={gatekeeperUrl}
                onChange={(e) => setGatekeeperUrl(e.target.value)}
                sx={{ mb: 2 }}
                className="text-field"
            />

            <Button
                variant="contained"
                color="primary"
                onClick={handleSave}
                startIcon={<Save />}
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
