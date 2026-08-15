import { ReactNode } from "react";
import { Box, Typography } from "@mui/material";

// Every screen in this app used to open straight into a row of buttons, with no
// title and nothing to say what the screen was for. A header gives each screen a
// name, one line of orientation, and exactly one primary action -- which is what
// lets every other action be demoted instead of competing.

export default function PageHeader(
    {
        title,
        description,
        actions,
    }: {
        title: string;
        description?: string;
        actions?: ReactNode;
    }) {
    return (
        <Box
            sx={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: 2,
                flexWrap: "wrap",
                pb: 2.5,
                mb: 3,
                borderBottom: 1,
                borderColor: "divider",
            }}
        >
            <Box sx={{ minWidth: 0 }}>
                <Typography variant="h3" sx={{ mb: description ? 0.5 : 0 }}>
                    {title}
                </Typography>
                {description && (
                    <Typography variant="body2" color="text.secondary">
                        {description}
                    </Typography>
                )}
            </Box>

            {actions && (
                <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexShrink: 0 }}>
                    {actions}
                </Box>
            )}
        </Box>
    );
}
