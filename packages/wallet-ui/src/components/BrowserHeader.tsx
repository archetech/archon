import { ReactNode } from "react";
import { Box, IconButton, Typography } from "@mui/material";
import { Menu } from "@mui/icons-material";
import DropDownID from "./DropDownID";

const BrowserHeader = (
    {
        menuOpen,
        toggleMenuOpen,
        actions,
    }: {
        menuOpen: boolean,
        toggleMenuOpen?: () => void,
        // Whatever this host puts in its header besides the identity picker.
        // The extension's full-page view keeps its light/dark switch here, since
        // that is the only place it has one -- its Settings has no theme control.
        actions?: ReactNode,
    }) => {
    return (
        <Box
            sx={{
                width: menuOpen ? 928 : 780,
                maxWidth: "100%",
                transition: 'width 0.2s ease',
                display: "flex",
                alignItems: "center",
                height: 48,
                px: 1,
            }}
        >
            {toggleMenuOpen &&
                <IconButton
                    onClick={toggleMenuOpen}
                    size="small"
                    sx={{ ml: 0.25 }}
                >
                    <Menu />
                </IconButton>
            }

            <Typography variant="h6" component="h6" sx={{ ml: 2 }}>
                Archon
            </Typography>

            <Box
                component="img"
                src="/icon_inverted.png"
                alt="Archon"
                sx={{ width: 32, height: 32, mr: 4 }}
            />

            <Box sx={{ flexGrow: 1 }} />

            <Box sx={{ mr: 2, display: "flex", alignItems: "center" }}>
                <DropDownID />
                {actions}
            </Box>
        </Box>
    );
};

export default BrowserHeader;
