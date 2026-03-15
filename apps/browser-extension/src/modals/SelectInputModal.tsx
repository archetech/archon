import React, { useState, useEffect } from "react";
import {
    Dialog,
    DialogTitle,
    DialogContent,
    DialogActions,
    Button,
    DialogContentText,
    FormControl,
    InputLabel,
    MenuItem,
    Select,
} from "@mui/material";

interface SelectInputModalProps {
    isOpen: boolean;
    title: string;
    description?: string;
    label?: string;
    confirmText?: string;
    options: string[];
    onSubmit: (value: string) => void;
    onClose: () => void;
}

const SelectInputModal: React.FC<SelectInputModalProps> = ({
    isOpen,
    title,
    description,
    label = "Registry",
    confirmText = "Confirm",
    options,
    onSubmit,
    onClose,
}) => {
    const [value, setValue] = useState(options[0] || "");

    useEffect(() => {
        if (isOpen) {
            setValue(options[0] || "");
        }
    }, [isOpen, options]);

    const handleConfirm = () => {
        if (value) {
            onSubmit(value);
        }
    };

    return (
        <Dialog open={isOpen} onClose={onClose}>
            <DialogTitle>{title}</DialogTitle>
            <DialogContent>
                {description && (
                    <DialogContentText>{description}</DialogContentText>
                )}
                <FormControl fullWidth margin="dense">
                    <InputLabel>{label}</InputLabel>
                    <Select
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        label={label}
                    >
                        {options.map((o) => (
                            <MenuItem key={o} value={o}>
                                {o}
                            </MenuItem>
                        ))}
                    </Select>
                </FormControl>
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose}>Cancel</Button>
                <Button
                    variant="contained"
                    onClick={handleConfirm}
                    disabled={!value}
                >
                    {confirmText}
                </Button>
            </DialogActions>
        </Dialog>
    );
};

export default SelectInputModal;
