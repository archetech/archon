import { useState, useEffect } from "react";
import {Box, Button, Switch, TextField, Typography} from "@mui/material";
import { DarkMode, LightMode, Save } from "@mui/icons-material";
import { useThemeContext } from "../contexts/ContextProviders";
import { useWalletContext } from "@didcid/wallet-ui";
import { useSnackbar } from "@didcid/wallet-ui";
import {
    DEFAULT_GATEKEEPER_URL,
    GATEKEEPER_KEY,
} from "../constants";
import packageJson from "../../package.json";
import PageHeader from "./layout/PageHeader";
import Section from "./layout/Section";

const REFRESH_INTERVAL_STORAGE_KEY = 'ARCHON_REFRESH_INTERVAL_SECONDS';
const DEFAULT_REFRESH_INTERVAL_SECONDS = 30;

function loadRefreshIntervalSeconds() {
    const saved = localStorage.getItem(REFRESH_INTERVAL_STORAGE_KEY);
    const parsed = Number(saved);

    if (!saved || !Number.isFinite(parsed) || parsed < 0) {
        return DEFAULT_REFRESH_INTERVAL_SECONDS;
    }

    return Math.floor(parsed);
}

const SettingsTab = () => {
    const [gatekeeperUrl, setGatekeeperUrl] = useState<string>(DEFAULT_GATEKEEPER_URL);
    const [refreshIntervalSeconds, setRefreshIntervalSeconds] = useState<string>(String(DEFAULT_REFRESH_INTERVAL_SECONDS));
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
                setRefreshIntervalSeconds(String(loadRefreshIntervalSeconds()));
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
            const parsedRefreshInterval = Number(refreshIntervalSeconds);
            if (!Number.isFinite(parsedRefreshInterval) || parsedRefreshInterval < 0) {
                throw new Error("Auto-refresh interval must be 0 or greater");
            }

            localStorage.setItem(GATEKEEPER_KEY, gatekeeperUrl);
            localStorage.setItem(REFRESH_INTERVAL_STORAGE_KEY, String(Math.floor(parsedRefreshInterval)));
            window.dispatchEvent(new Event('archon:refresh-interval-change'));
            await initialiseServices();
            await initialiseWallet();
            fetchServerVersion(gatekeeperUrl);
            setSuccess("Services updated");
        } catch (error: any) {
            console.error("Error saving URLs:", error);
        }
    };

    return (
        <Box sx={{ maxWidth: 560 }}>
            <PageHeader
                title="Settings"
                description="Appearance, the node this wallet talks to, and how often it refreshes."
            />

            <Section title="Appearance">
                <Box sx={{ display: "flex", flexDirection: "row", alignItems: "center" }}>
                    <Typography sx={{ flex: 1 }}>Theme</Typography>
                    <LightMode fontSize="small" sx={{ mr: 1, color: "text.secondary" }} />

                    <Switch
                        checked={darkMode}
                        onChange={handleDarkModeToggle}
                        color="default"
                    />

                    <DarkMode fontSize="small" sx={{ ml: 1, color: "text.secondary" }} />
                </Box>
            </Section>

            <Section title="Connection" description="The Archon node this wallet reads from and writes to.">
                <TextField
                    fullWidth
                    label="Node URL"
                    variant="outlined"
                    value={gatekeeperUrl}
                    onChange={(e) => setGatekeeperUrl(e.target.value)}
                    sx={{ mb: 2 }}
                    className="text-field"
                />

                <TextField
                    fullWidth
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
                    startIcon={<Save />}
                    sx={{ alignSelf: "start" }}
                >
                Save
                </Button>
            </Section>

            <Box sx={{ mt: 1 }}>
                <Typography variant="caption" color="text.secondary" display="block">
                    Client v{packageJson.version} &nbsp;·&nbsp; Server v{serverVersion || "..."}
                </Typography>
            </Box>
        </Box>
    );
};

export default SettingsTab;
