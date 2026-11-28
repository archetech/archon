import { useRef, useState } from "react";
import {Box, Button, FormControl, IconButton, MenuItem, Select, TextField, Tooltip} from "@mui/material";
import { useWalletContext } from "../contexts/WalletProvider";
import { useSnackbar } from "../contexts/SnackbarProvider";
import { useWalletData } from "../hooks/useWalletData";
import { useVariablesContext } from "../contexts/VariablesProvider";
import { Edit } from "@mui/icons-material";
import TextInputModal from "./TextInputModal";
import CopyResolveDID from "./CopyResolveDID";
import { useIsTabletUp } from "../hooks/useIsTabletUp";

// A schema is a JSON object; other text cannot be saved as one.
function isJsonObject(text: string): boolean {
    try {
        const value = JSON.parse(text);
        return typeof value === "object" && value !== null && !Array.isArray(value);
    } catch {
        return false;
    }
}

const SchemaTab = ()=> {
    const { keymaster } = useWalletContext();
    const {
        setError,
        setSuccess,
    } = useSnackbar();
    const { refreshAliases } = useWalletData();
    const {
        registries,
        aliasList,
        schemaList,
    } = useVariablesContext();
    const isTabletUp = useIsTabletUp();
    const [registry, setRegistry] = useState<string>('hyperswarm');
    const [schemaName, setSchemaName] = useState<string>('');
    const [selectedSchemaName, setSelectedSchemaName] = useState<string>('');
    const [schemaString, setSchemaString] = useState<string>('');
    const [schemaEdit, setSchemaEdit] = useState<boolean>(false);
    const [renameOpen, setRenameOpen] = useState<boolean>(false);
    const [renameOldName, setRenameOldName] = useState<string>("");
    // Each schema read gets a number; an earlier read that finishes late is ignored.
    const schemaRead = useRef<number>(0);
    // The schema whose text the editor holds, or '' when it holds none.
    const shownSchema = useRef<string>('');

    const saveSchema = async () => {
        if (!keymaster) {
            return;
        }
        try {
            await keymaster.setSchema(selectedSchemaName, JSON.parse(schemaString));
            await editSchema(selectedSchemaName);
            setSuccess("Schema saved");
        } catch (error: any) {
            setError(error);
        }
    };

    const editSchema = async (name: string) => {
        if (!keymaster || !name) {
            return;
        }
        const read = ++schemaRead.current;
        // Another schema's text is not left in the editor while this one is
        // read, or if it cannot be. The same schema read again, as after a
        // save, keeps its editor.
        if (shownSchema.current !== name) {
            shownSchema.current = '';
            setSchemaEdit(false);
            setSchemaString('');
        }
        try {
            const schema = (await keymaster.getSchema(name)) as unknown as object;
            if (schemaRead.current !== read) {
                return;
            }
            shownSchema.current = name;
            setSchemaString(JSON.stringify(schema, null, 4));
            setSchemaEdit(true);
        } catch (error: any) {
            if (schemaRead.current !== read) {
                return;
            }
            setError(error);
        }
    };

    async function createSchema() {
        if (!keymaster) {
            return;
        }

        const name = schemaName.trim();
        if (name in aliasList) {
            setError(`${name} already in use`);
            return;
        }

        setSchemaName('');

        try {
            const schemaDID = await keymaster.createSchema(null, { registry });
            await keymaster.addAlias(name, schemaDID);

            await refreshAliases();
            setSelectedSchemaName(name);
            await editSchema(name);
        } catch (error: any) {
            setError(error);
        }
    }

    const openRenameModal = () => {
        setRenameOldName(selectedSchemaName);
        setRenameOpen(true);
    };

    const handleRenameSubmit = async (newName: string) => {
        setRenameOpen(false);
        if (!newName || newName === selectedSchemaName || !keymaster) {
            return;
        }

        const name = newName.trim();
        if (name in aliasList) {
            setError(`${name} already in use`);
            return;
        }

        try {
            await keymaster.addAlias(name, aliasList[selectedSchemaName]);
            await keymaster.removeAlias(selectedSchemaName);
            await refreshAliases();
            if (shownSchema.current === selectedSchemaName) {
                shownSchema.current = name;
            }
            setSelectedSchemaName(name);
            setRenameOldName("");
            setSuccess("Schema renamed");
        } catch (error: any) {
            setError(error);
        }
    };

    return (
        <Box display="flex" flexDirection="column"  sx={{ mt: 1 }}>
            <TextInputModal
                isOpen={renameOpen}
                title="Rename Schema"
                description={`Rename '${renameOldName}' to:`}
                label="New Name"
                confirmText="Rename"
                defaultValue={renameOldName}
                onSubmit={handleRenameSubmit}
                onClose={() => setRenameOpen(false)}
            />

            <Box display="flex" flexDirection="column" sx={{ mb: 2, gap: 0, width: isTabletUp ? '70%' : '100%' }}>
                <TextField
                    label="Schema Name"
                    size="small"
                    sx={{
                        borderBottomLeftRadius: 0,
                        borderBottomRightRadius: 0,
                    }}
                    value={schemaName}
                    onChange={(e) => setSchemaName(e.target.value)}
                    slotProps={{
                        htmlInput: {
                            maxLength: 32,
                        },
                    }}
                />
                <Box display="flex" flexDirection="row" sx={{ gap: 0, width: "100%" }}>
                    <FormControl fullWidth>
                        <Select
                            value={registry}
                            size="small"
                            variant="outlined"
                            sx={{
                                borderTopLeftRadius: 0,
                                borderTopRightRadius: 0,
                                borderBottomRightRadius: 0,
                            }}
                            onChange={(event) => setRegistry(event.target.value)}
                        >
                            {registries.map((registry, index) => (
                                <MenuItem value={registry} key={index}>
                                    {registry}
                                </MenuItem>
                            ))}
                        </Select>
                    </FormControl>

                    <Button
                        variant="contained"
                        color="primary"
                        size="small"
                        fullWidth
                        sx={{
                            borderTopLeftRadius: 0,
                            borderTopRightRadius: 0,
                            borderBottomLeftRadius: 0,
                        }}
                        onClick={createSchema}
                        disabled={!schemaName.trim() || !registries.includes(registry)}
                    >
                        Create
                    </Button>
                </Box>
            </Box>

            {schemaList &&
                <Box sx={{ display: "flex", alignItems: "center", width: isTabletUp ? '70%' : '100%', flexWrap: "nowrap" }}>
                    <FormControl sx={{ flex: 1, minWidth: 0 }}>
                        <Select
                            value={selectedSchemaName}
                            displayEmpty
                            variant="outlined"
                            size="small"
                            onChange={async (event) => {
                                const name = event.target.value;
                                setSelectedSchemaName(name);
                                await editSchema(name);
                            }}
                        >
                            <MenuItem value="" disabled>
                                Select schema
                            </MenuItem>
                            {schemaList.map((name, index) => (
                                <MenuItem value={name} key={index}>
                                    {name}
                                </MenuItem>
                            ))}
                        </Select>
                    </FormControl>

                    <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexShrink: 0, whiteSpace: "nowrap" }}>
                        <Tooltip title="Rename">
                            <span>
                                <IconButton
                                    size="small"
                                    onClick={openRenameModal}
                                    disabled={!selectedSchemaName}
                                >
                                    <Edit fontSize="small" />
                                </IconButton>
                            </span>
                        </Tooltip>

                        <CopyResolveDID did={aliasList[selectedSchemaName] ?? ""} />
                    </Box>
                </Box>
            }
            {schemaEdit &&
                <Box display="flex" flexDirection="column">
                    <TextField
                        value={schemaString}
                        onChange={(e) => setSchemaString(e.target.value)}
                        multiline
                        rows={20}
                        fullWidth
                        variant="outlined"
                        sx={{ my: 2 }}
                        slotProps={{
                            input: {
                                style: {
                                    fontSize: "1em",
                                    fontFamily: "Courier, monospace",
                                },
                            }
                        }}
                    />
                    <Button
                        variant="contained"
                        color="primary"
                        onClick={saveSchema}
                        disabled={!isJsonObject(schemaString)}
                        sx={{ width: 150 }}
                    >
                        Save Schema
                    </Button>
                </Box>
            }
        </Box>
    );
}

export default SchemaTab;
