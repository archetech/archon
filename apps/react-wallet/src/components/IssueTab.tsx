import { useEffect, useState } from "react";
import { useWalletContext } from "../contexts/WalletProvider";
import { useVariablesContext } from "../contexts/VariablesProvider";
import { useSnackbar } from "../contexts/SnackbarProvider";
import CredentialForm from "./CredentialForm";
import {
    Autocomplete,
    Box,
    Button,
    Select,
    MenuItem,
    FormControl,
    TextField,
} from "@mui/material";
import DisplayDID from "./DisplayDID";
import { useThemeContext } from "../contexts/ContextProviders";

function IssueTab() {
    const { keymaster } = useWalletContext();
    const { setError } = useSnackbar();
    const {
        registries,
        registry,
        setRegistry,
        agentList,
        credentialDID,
        credentialSchema,
        credentialString,
        credentialSubject,
        schemaList,
        setCredentialDID,
        setCredentialSchema,
        setCredentialString,
        setCredentialSubject,
        setIssuedList,
    } = useVariablesContext();
    const { isTabletUp } = useThemeContext();

    const [schemaObject, setSchemaObject] = useState<any>(null);
    const [isFormValid, setIsFormValid] = useState<boolean>(false);

    async function editCredential() {
        if (!keymaster) {
            return;
        }
        try {
            const credentialBound = await keymaster.bindCredential(
                credentialSubject,
                { schema: credentialSchema },
            );
            setCredentialString(JSON.stringify(credentialBound, null, 4));
            setCredentialDID("");
        } catch (error: any) {
            setError(error);
        }
    }

    async function issueCredential() {
        if (!keymaster) {
            return;
        }
        try {
            const did = await keymaster.issueCredential(
                JSON.parse(credentialString),
                { registry },
            );
            setCredentialDID(did);
            setIssuedList((prevIssuedList) => [...prevIssuedList, did]);
        } catch (error: any) {
            setError(error);
        }
    }

    useEffect(() => {
        async function getSchema() {
            if (!keymaster) {
                return;
            }
            try {
                const credentialObject = JSON.parse(credentialString);
                if (!credentialObject.credentialSchema?.id) {
                    setError("Invalid credential object");
                    return;
                }
                const schemaDID = credentialObject.credentialSchema.id;
                const schemaObject = await keymaster.getSchema(schemaDID);
                setSchemaObject(schemaObject);
            } catch (error: any) {
                setError(error);
            }
        }

        if (credentialString) {
            getSchema();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [credentialString]);

    return (
        <Box sx={{ width: isTabletUp ? '70%' : '100%' }}>
            <Box display="flex" flexDirection="column" sx={{ mb: 2 }}>
                <Autocomplete
                    freeSolo
                    options={agentList || []}
                    value={credentialSubject}
                    onInputChange={(_e, value) => setCredentialSubject(value.trim())}
                    renderInput={(params) => (
                        <TextField
                            {...params}
                            label="Subject (name, DID, or URI)"
                            size="small"
                            variant="outlined"
                            className="select-small-top"
                        />
                    )}
                />
                <Select
                    value={credentialSchema}
                    onChange={(event) =>
                        setCredentialSchema(event.target.value)
                    }
                    size="small"
                    displayEmpty
                    variant="outlined"
                    className="select-small-middle"
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
                <Button
                    variant="contained"
                    color="primary"
                    onClick={editCredential}
                    disabled={!credentialSubject || !credentialSchema}
                    className="button-bottom"
                >
                    Edit Credential
                </Button>
            </Box>
            {credentialString && schemaObject && (
                <>
                    <CredentialForm
                        schemaObject={schemaObject}
                        baseCredential={credentialString}
                        onChange={(credString, valid) => {
                            setCredentialString(credString);
                            setIsFormValid(valid);
                        }}
                    />
                    <Box
                        display="flex"
                        flexDirection="row"
                        alignItems="stretch"
                        sx={{ gap: 0, my: 2, width: "100%" }}
                    >
                        <Button
                            variant="contained"
                            color="primary"
                            onClick={issueCredential}
                            className="button-left"
                            disabled={!isFormValid}
                            fullWidth
                        >
                            Issue
                        </Button>
                        <FormControl fullWidth>
                            <Select
                                value={registry}
                                className="select-small-right"
                                onChange={(event) =>
                                    setRegistry(event.target.value)
                                }
                            >
                                {registries.map((registry, index) => (
                                    <MenuItem value={registry} key={index}>
                                        {registry}
                                    </MenuItem>
                                ))}
                            </Select>
                        </FormControl>
                    </Box>
                    {credentialDID &&
                        <DisplayDID did={credentialDID} />
                    }
                </>
            )}
        </Box>
    );
}

export default IssueTab;
