import React, { useState, useEffect } from "react";
import { Box, Button, TextField } from "@mui/material";
import SaveIcon from "@mui/icons-material/Save";
import { useWalletContext } from "../contexts/WalletProvider";
import { useSnackbar } from "../contexts/SnackbarProvider";

const SettingsTab = () => {
    const [gatekeeperUrl, setGatekeeperUrl] = useState<string>("");
    const {
        initialiseServices,
        initialiseWallet
    } = useWalletContext();
    const { setSuccess } = useSnackbar();

    useEffect(() => {
        const init = async () => {
            try {
                const result = await chrome.storage.sync.get(["gatekeeperUrl"]);
                setGatekeeperUrl(result.gatekeeperUrl as string);
            } catch (error: any) {
                console.error("Error retrieving gatekeeperUrl:", error);
            }
        };
        init();
    }, []);

    const handleSave = async () => {
        try {
            await chrome.storage.sync.set({ gatekeeperUrl });
            await initialiseServices();
            await initialiseWallet();
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
                startIcon={<SaveIcon />}
                sx={{ alignSelf: "start" }}
            >
                Save
            </Button>
        </Box>
    );
};

export default SettingsTab;
