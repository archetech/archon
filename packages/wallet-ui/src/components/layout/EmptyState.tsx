import { ReactNode } from "react";
import { Box, Typography } from "@mui/material";

// "No DID document available for the current identity." was previously a bare
// line of grey text sitting where content would be. An empty state is a
// deliberate composition instead: a mark, a sentence, and the one action that
// resolves it.

export default function EmptyState(
    {
        icon,
        title,
        description,
        action,
    }: {
        icon?: ReactNode;
        title: string;
        description?: string;
        action?: ReactNode;
    }) {
    return (
        <Box
            sx={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                textAlign: "center",
                gap: 1,
                px: 3,
                py: 6,
            }}
        >
            {icon && (
                <Box
                    sx={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 40,
                        height: 40,
                        mb: 0.5,
                        borderRadius: 2,
                        border: 1,
                        borderColor: "divider",
                        color: "text.secondary",
                        "& svg": { fontSize: 20 },
                    }}
                >
                    {icon}
                </Box>
            )}

            <Typography variant="body1" sx={{ fontWeight: 500 }}>
                {title}
            </Typography>

            {description && (
                <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 360 }}>
                    {description}
                </Typography>
            )}

            {action && <Box sx={{ mt: 1.5 }}>{action}</Box>}
        </Box>
    );
}
