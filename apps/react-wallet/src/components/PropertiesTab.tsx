import { useEffect, useMemo, useState } from "react";
import {
    Box,
    Button,
    IconButton,
    MenuItem,
    Select,
    TextField,
    Tooltip,
    Typography,
} from "@mui/material";
import { Add, Delete, Edit, Save, Close } from "@mui/icons-material";
import { useWalletContext } from "../contexts/WalletProvider";
import { useVariablesContext } from "../contexts/VariablesProvider";
import { useSnackbar } from "../contexts/SnackbarProvider";
import WarningModal from "../modals/WarningModal";

function PropertiesTab() {
    const { keymaster } = useWalletContext();
    const { agentList, aliasList, currentId } = useVariablesContext();
    const { setError, setSuccess } = useSnackbar();

    const [selectedName, setSelectedName] = useState<string>("");
    const [properties, setProperties] = useState<Record<string, unknown>>({});
    const [isOwned, setIsOwned] = useState<boolean>(false);
    const [loading, setLoading] = useState<boolean>(false);

    // Add property form
    const [newKey, setNewKey] = useState<string>("");
    const [newValue, setNewValue] = useState<string>("");

    // Inline editing
    const [editingKey, setEditingKey] = useState<string | null>(null);
    const [editValue, setEditValue] = useState<string>("");

    // Delete confirmation
    const [deleteOpen, setDeleteOpen] = useState<boolean>(false);
    const [deleteKey, setDeleteKey] = useState<string>("");

    // Build sorted list: agent identities + all aliases (deduplicated)
    const nameEntries = useMemo(() => {
        const seen = new Set<string>();
        const entries: string[] = [];

        // Add agent identity names first
        for (const name of agentList || []) {
            if (!seen.has(name)) {
                seen.add(name);
                entries.push(name);
            }
        }

        // Add all aliases
        for (const name of Object.keys(aliasList || {})) {
            if (!seen.has(name)) {
                seen.add(name);
                entries.push(name);
            }
        }

        return entries.sort((a, b) => a.localeCompare(b));
    }, [agentList, aliasList]);

    // Auto-select current ID name if available
    useEffect(() => {
        if (!selectedName && currentId && nameEntries.includes(currentId)) {
            setSelectedName(currentId);
        }
    }, [currentId, nameEntries, selectedName]);

    // Load properties when selection changes
    useEffect(() => {
        if (selectedName) {
            loadProperties();
        } else {
            setProperties({});
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedName]);

    async function loadProperties() {
        if (!keymaster || !selectedName) return;
        setLoading(true);
        try {
            const doc = await keymaster.resolveDID(selectedName);
            setProperties((doc.didDocumentData as Record<string, unknown>) || {});
            setIsOwned(!!(doc.didDocumentMetadata as any)?.isOwned);
        } catch (error: any) {
            setError(error);
            setProperties({});
            setIsOwned(false);
        } finally {
            setLoading(false);
        }
    }

    async function addProperty() {
        if (!keymaster || !selectedName || !newKey.trim()) return;
        try {
            let parsed: unknown;
            try {
                parsed = JSON.parse(newValue);
            } catch {
                parsed = newValue;
            }
            await keymaster.mergeData(selectedName, { [newKey.trim()]: parsed });
            setNewKey("");
            setNewValue("");
            setSuccess("Property added");
            await loadProperties();
        } catch (error: any) {
            setError(error);
        }
    }

    async function saveEdit(key: string) {
        if (!keymaster || !selectedName) return;
        try {
            let parsed: unknown;
            try {
                parsed = JSON.parse(editValue);
            } catch {
                parsed = editValue;
            }
            await keymaster.mergeData(selectedName, { [key]: parsed });
            setEditingKey(null);
            setSuccess("Property updated");
            await loadProperties();
        } catch (error: any) {
            setError(error);
        }
    }

    async function confirmDelete() {
        if (!keymaster || !selectedName || !deleteKey) return;
        try {
            await keymaster.mergeData(selectedName, { [deleteKey]: null });
            setSuccess("Property removed");
            await loadProperties();
        } catch (error: any) {
            setError(error);
        }
        setDeleteOpen(false);
        setDeleteKey("");
    }

    function startEdit(key: string, value: unknown) {
        setEditingKey(key);
        setEditValue(
            typeof value === "string" ? value : JSON.stringify(value, null, 2)
        );
    }

    function formatValue(value: unknown): string {
        if (typeof value === "string") return value;
        return JSON.stringify(value);
    }

    const propertyEntries = Object.entries(properties).sort(([a], [b]) =>
        a.localeCompare(b)
    );

    return (
        <Box>
            <WarningModal
                title="Remove Property"
                warningText={`Are you sure you want to remove '${deleteKey}'?`}
                isOpen={deleteOpen}
                onClose={() => setDeleteOpen(false)}
                onSubmit={confirmDelete}
            />

            {/* DID Selector */}
            <Box sx={{ mt: 1, mb: 2 }}>
                <Select
                    value={selectedName}
                    onChange={(e) => setSelectedName(e.target.value)}
                    displayEmpty
                    size="small"
                    fullWidth
                >
                    <MenuItem value="" disabled>
                        Select a DID...
                    </MenuItem>
                    {nameEntries.map((name) => (
                        <MenuItem key={name} value={name}>
                            {name}
                        </MenuItem>
                    ))}
                </Select>
            </Box>

            {selectedName && (
                <>
                    {/* Add Property (owned DIDs only) */}
                    {isOwned && (
                        <Box className="flex-box" sx={{ mb: 2, gap: 1 }}>
                            <TextField
                                label="Key"
                                variant="outlined"
                                value={newKey}
                                onChange={(e) => setNewKey(e.target.value)}
                                size="small"
                                sx={{ flex: "0 0 150px" }}
                            />
                            <TextField
                                label="Value"
                                variant="outlined"
                                value={newValue}
                                onChange={(e) => setNewValue(e.target.value)}
                                size="small"
                                sx={{ flex: 1 }}
                            />
                            <Button
                                variant="contained"
                                onClick={addProperty}
                                disabled={!newKey.trim()}
                                startIcon={<Add />}
                                sx={{ whiteSpace: "nowrap" }}
                            >
                                Add
                            </Button>
                        </Box>
                    )}

                    {/* Properties List */}
                    {loading ? (
                        <Typography color="text.secondary" sx={{ mt: 2 }}>
                            Loading...
                        </Typography>
                    ) : propertyEntries.length === 0 ? (
                        <Typography color="text.secondary" sx={{ mt: 2 }}>
                            No properties set
                        </Typography>
                    ) : (
                        propertyEntries.map(([key, value]) => (
                            <Box
                                key={key}
                                sx={{
                                    display: "flex",
                                    alignItems: "flex-start",
                                    mb: 1,
                                    gap: 1,
                                }}
                            >
                                <Typography
                                    sx={{
                                        flex: "0 0 150px",
                                        fontWeight: "bold",
                                        pt: editingKey === key ? 1 : 0.5,
                                        wordBreak: "break-all",
                                    }}
                                >
                                    {key}
                                </Typography>

                                {editingKey === key ? (
                                    <Box
                                        sx={{
                                            flex: 1,
                                            display: "flex",
                                            gap: 0.5,
                                            alignItems: "flex-start",
                                        }}
                                    >
                                        <TextField
                                            value={editValue}
                                            onChange={(e) =>
                                                setEditValue(e.target.value)
                                            }
                                            size="small"
                                            fullWidth
                                            multiline
                                            maxRows={6}
                                        />
                                        <Tooltip title="Save">
                                            <IconButton
                                                size="small"
                                                onClick={() => saveEdit(key)}
                                                color="primary"
                                            >
                                                <Save />
                                            </IconButton>
                                        </Tooltip>
                                        <Tooltip title="Cancel">
                                            <IconButton
                                                size="small"
                                                onClick={() =>
                                                    setEditingKey(null)
                                                }
                                            >
                                                <Close />
                                            </IconButton>
                                        </Tooltip>
                                    </Box>
                                ) : (
                                    <Box
                                        sx={{
                                            flex: 1,
                                            display: "flex",
                                            alignItems: "center",
                                            gap: 0.5,
                                            minWidth: 0,
                                        }}
                                    >
                                        <Typography
                                            sx={{
                                                flex: 1,
                                                wordBreak: "break-word",
                                                fontFamily:
                                                    typeof value !== "string"
                                                        ? "monospace"
                                                        : "inherit",
                                                fontSize:
                                                    typeof value !== "string"
                                                        ? "0.85rem"
                                                        : "inherit",
                                            }}
                                        >
                                            {formatValue(value)}
                                        </Typography>
                                        {isOwned && (
                                            <>
                                                <Tooltip title="Edit">
                                                    <IconButton
                                                        size="small"
                                                        onClick={() =>
                                                            startEdit(key, value)
                                                        }
                                                    >
                                                        <Edit />
                                                    </IconButton>
                                                </Tooltip>
                                                <Tooltip title="Delete">
                                                    <IconButton
                                                        size="small"
                                                        onClick={() => {
                                                            setDeleteKey(key);
                                                            setDeleteOpen(true);
                                                        }}
                                                    >
                                                        <Delete />
                                                    </IconButton>
                                                </Tooltip>
                                            </>
                                        )}
                                    </Box>
                                )}
                            </Box>
                        ))
                    )}

                    {/* Refresh button */}
                    <Box sx={{ mt: 2 }}>
                        <Button
                            variant="outlined"
                            onClick={loadProperties}
                            size="small"
                        >
                            Refresh
                        </Button>
                    </Box>
                </>
            )}
        </Box>
    );
}

export default PropertiesTab;
