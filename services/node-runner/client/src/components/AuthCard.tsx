import { Box, Paper, Typography } from '@mui/material';
import type { FormEvent, ReactNode } from 'react';

interface Props {
    eyebrow: string;
    title: string;
    children: ReactNode;
    onSubmit: (event: FormEvent) => void;
}

export default function AuthCard({ eyebrow, title, children, onSubmit }: Props) {
    return (
        <Box sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', p: 2 }}>
            <Paper
                component="form"
                onSubmit={onSubmit}
                variant="outlined"
                sx={{ width: '100%', maxWidth: 420, p: 4, display: 'flex', flexDirection: 'column', gap: 2.5 }}
            >
                <Box>
                    <Typography variant="overline" color="text.secondary">{eyebrow}</Typography>
                    <Typography variant="h2" component="h1">{title}</Typography>
                </Box>
                {children}
            </Paper>
        </Box>
    );
}
