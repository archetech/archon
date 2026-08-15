import { ReactNode } from "react";
import { Box, Paper, Typography } from "@mui/material";

// The unit that replaces flat <Box> stacks. Related controls live inside a
// bordered panel with a name, so a screen reads as a few labelled groups rather
// than one undifferentiated column of inputs and buttons.
//
// `dense` drops the inner padding for content that brings its own -- tables and
// the JSON viewer, which look wrong inset twice.

export default function Section(
    {
        title,
        description,
        actions,
        dense,
        children,
    }: {
        title?: string;
        description?: string;
        actions?: ReactNode;
        dense?: boolean;
        children: ReactNode;
    }) {
    const hasHeader = Boolean(title || actions);

    return (
        <Paper variant="outlined" sx={{ overflow: "hidden", mb: 2 }}>
            {hasHeader && (
                <Box
                    sx={{
                        display: "flex",
                        alignItems: "flex-start",
                        justifyContent: "space-between",
                        gap: 2,
                        flexWrap: "wrap",
                        px: 2,
                        py: 1.5,
                        borderBottom: 1,
                        borderColor: "divider",
                    }}
                >
                    <Box sx={{ minWidth: 0 }}>
                        {/* Visual size h6, document level h2: sections sit
                            directly beneath the page title. */}
                        {title && <Typography variant="h6" component="h2">{title}</Typography>}
                        {description && (
                            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
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
            )}

            <Box sx={{ p: dense ? 0 : 2 }}>{children}</Box>
        </Paper>
    );
}
