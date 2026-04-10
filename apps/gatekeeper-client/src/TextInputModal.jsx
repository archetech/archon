import React, { useState, useEffect } from "react";
import {
    Dialog,
    DialogTitle,
    DialogContent,
    DialogActions,
    Button,
    DialogContentText,
    TextField,
    IconButton,
    InputAdornment,
} from "@mui/material";
import { Visibility, VisibilityOff } from "@mui/icons-material";

const TextInputModal = (
    {
        isOpen,
        title,
        description,
        label = "Name",
        confirmText = "Confirm",
        defaultValue = "",
        inputType = "text",
        allowReveal = false,
        onSubmit,
        onClose,
    }) => {
    const [value, setValue] = useState(defaultValue);
    const [revealed, setRevealed] = useState(false);

    useEffect(() => {
        if (isOpen) {
            setValue(defaultValue);
            setRevealed(false);
        }
    }, [isOpen, defaultValue]);

    const handleConfirm = (e) => {
        e.preventDefault();
        onSubmit(value.trim());
    };

    return (
        <Dialog open={isOpen} onClose={onClose}>
            <form onSubmit={handleConfirm}>
                <DialogTitle>{title}</DialogTitle>
                <DialogContent>
                    {description && (
                        <DialogContentText>{description}</DialogContentText>
                    )}
                    <TextField
                        autoFocus
                        margin="dense"
                        label={label}
                        type={allowReveal && inputType === "password" && revealed ? "text" : inputType}
                        fullWidth
                        variant="outlined"
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        InputProps={allowReveal && inputType === "password" ? {
                            endAdornment: (
                                <InputAdornment position="end">
                                    <IconButton
                                        edge="end"
                                        onClick={() => setRevealed((value) => !value)}
                                        aria-label={revealed ? "Hide value" : "Show value"}
                                    >
                                        {revealed ? <VisibilityOff /> : <Visibility />}
                                    </IconButton>
                                </InputAdornment>
                            ),
                        } : undefined}
                    />
                </DialogContent>
                <DialogActions>
                    <Button onClick={onClose} color="primary">
                        Cancel
                    </Button>
                    <Button type="submit" variant="contained" color="primary">
                        {confirmText}
                    </Button>
                </DialogActions>
            </form>
        </Dialog>
    );
};

export default TextInputModal;
