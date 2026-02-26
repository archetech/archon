import React, { useState } from "react";
import {
    Dialog,
    DialogTitle,
    DialogContent,
    DialogActions,
    TextField,
    Button,
    Typography,
    Box,
    CircularProgress,
} from "@mui/material";

const LoginModal = ({ isOpen, errorText, onSubmit }) => {
    const [passphrase, setPassphrase] = useState("");
    const [submitting, setSubmitting] = useState(false);

    if (!isOpen) {
        return null;
    }

    async function handleSubmit(e) {
        e.preventDefault();
        if (submitting) {
            return;
        }

        setSubmitting(true);
        try {
            await onSubmit(passphrase);
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <Dialog open={isOpen}>
            <DialogTitle>Enter Passphrase</DialogTitle>
            <DialogContent>
                {errorText && (
                    <Box mb={2}>
                        <Typography color="error">{errorText}</Typography>
                    </Box>
                )}
                <form onSubmit={handleSubmit} id="login-form">
                    <TextField
                        label="Passphrase"
                        type="password"
                        value={passphrase}
                        onChange={(e) => setPassphrase(e.target.value)}
                        required
                        autoFocus
                        fullWidth
                        variant="outlined"
                        margin="dense"
                        disabled={submitting}
                    />
                </form>
            </DialogContent>
            <DialogActions>
                <Button
                    type="submit"
                    form="login-form"
                    variant="contained"
                    color="primary"
                    disabled={submitting || !passphrase}
                    startIcon={submitting ? <CircularProgress size={18} /> : null}
                >
                    {submitting ? "Working" : "Submit"}
                </Button>
            </DialogActions>
        </Dialog>
    );
};

export default LoginModal;
