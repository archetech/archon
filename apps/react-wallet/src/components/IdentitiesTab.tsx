import { useCallback, useEffect, useState } from "react";
import JsonView from "@uiw/react-json-view";
import { useWalletContext } from "../contexts/WalletProvider";
import { Box, Button, MenuItem, Paper, Select, Tab, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tabs, TextField, Typography } from "@mui/material";
import { Badge, Login, PermIdentity } from "@mui/icons-material";
import { useUIContext } from "../contexts/UIContext";
import { useSnackbar } from "../contexts/SnackbarProvider";
import WarningModal from "../modals/WarningModal";
import TextInputModal from "../modals/TextInputModal";
import SelectInputModal from "../modals/SelectInputModal";
import { useThemeContext } from "../contexts/ContextProviders";
import { useVariablesContext } from "../contexts/VariablesProvider";
import type { AddressCheckResult, AddressInfo, NostrKeys, ResolvedAddressInfo } from "@didcid/keymaster/types";

function parseAddressDomain(address: string): string {
    const trimmed = address.trim().toLowerCase();
    const at = trimmed.lastIndexOf("@");
    return at < 0 ? trimmed : trimmed.slice(at + 1);
}

function parseAddressName(address: string): string {
    const trimmed = address.trim().toLowerCase();
    const at = trimmed.lastIndexOf("@");
    return at < 0 ? trimmed : trimmed.slice(0, at);
}

function composeAddress(name: string, domain: string): string {
    const normalizedName = parseAddressName(name);
    const normalizedDomain = parseAddressDomain(domain);
    if (!normalizedName || !normalizedDomain) {
        return "";
    }
    return `${normalizedName}@${normalizedDomain}`;
}

function IdentitiesTab() {
    const [identityTab, setIdentityTab] = useState<"details" | "addresses" | "nostr">("details");
    const [name, setName] = useState<string>("");
    const [warningModal, setWarningModal] = useState<boolean>(false);
    const [removeCalled, setRemoveCalled] = useState<boolean>(false);
    const [renameModalOpen, setRenameModalOpen] = useState<boolean>(false);
    const [recoverModalOpen, setRecoverModalOpen] = useState<boolean>(false);
    const [nostrKeys, setNostrKeys] = useState<NostrKeys | null>(null);
    const [removeNostrModal, setRemoveNostrModal] = useState<boolean>(false);
    const [migrateOpen, setMigrateOpen] = useState<boolean>(false);
    const [nsecValue, setNsecValue] = useState<string | null>(null);
    const [currentIdDocs, setCurrentIdDocs] = useState<Record<string, unknown> | null>(null);
    const [addressList, setAddressList] = useState<Record<string, AddressInfo>>({});
    const [addressName, setAddressName] = useState<string>("");
    const [addressDomain, setAddressDomain] = useState<string>("");
    const [selectedAddress, setSelectedAddress] = useState<string>("");
    const [addressDetails, setAddressDetails] = useState<string>("");
    const [addressBusy, setAddressBusy] = useState<boolean>(false);
    const { keymaster } = useWalletContext();
    const { setError, setSuccess } = useSnackbar();
    const {
        refreshAll,
        resetCurrentID,
    } = useUIContext();
    const {
        currentId,
        currentDID,
        registry,
        setRegistry,
        registries,
    } = useVariablesContext();
    const { isTabletUp } = useThemeContext();

    const handleCreateId = async () => {
        if (!keymaster) {
            return;
        }
        if (!name.trim()) {
            return;
        }
        try {
            await keymaster.createId(name.trim(), { registry });
            await resetCurrentID();
            setName("");
        } catch (error: any) {
            setError(error);
        }
    };

    function handleRenameId() {
        setRenameModalOpen(true);
    }

    async function renameId(newName: string) {
        if (!keymaster) {
            return;
        }
        setRenameModalOpen(false);
        const name = newName.trim();
        if (!name) {
            setError("Name cannot be empty");
            return;
        }

        try {
            await keymaster.renameId(currentId, name);
            await refreshAll();
        } catch (error: any) {
            setError(error);
        }
    }

    async function rotateKeys() {
        if (!keymaster) {
            return;
        }
        try {
            await keymaster.rotateKeys();
            await refreshAll();
        } catch (error) {
            setError(error);
        }
    }

    const handleCloseWarningModal = () => {
        setWarningModal(false);
    };

    function handleRemoveId() {
        setWarningModal(true);
        setRemoveCalled(false);
    }

    async function removeId() {
        if (!keymaster) {
            return;
        }
        setWarningModal(false);
        // Prevents multiple removals if confirm button spammed
        if (removeCalled) {
            return;
        }
        setRemoveCalled(true);
        try {
            await keymaster.removeId(currentId);
            await refreshAll();
        } catch (error: any) {
            setError(error);
        }
    }

    async function backupId() {
        if (!keymaster) {
            return;
        }
        try {
            const ok = await keymaster.backupId(currentId);

            if (ok) {
                setSuccess(`${currentId} backup succeeded`);
            } else {
                setError(`${currentId} backup failed`);
            }
        } catch (error: any) {
            setError(error);
        }
    }

    async function handleRecoverId() {
        setRecoverModalOpen(true);
    }

    async function recoverId(did: string) {
        setRecoverModalOpen(false);
        if (!did || !keymaster) {
            return;
        }

        try {
            const response = await keymaster.recoverId(did);
            await refreshAll();
            setSuccess(response + " recovered");
        } catch (error: any) {
            setError(error);
        }
    }

    async function migrateId(registry: string) {
        if (!keymaster) {
            return;
        }
        setMigrateOpen(false);
        try {
            await keymaster.changeRegistry(currentId, registry);
            await refreshAll();
            setSuccess(`${currentId} migrated to ${registry}`);
        } catch (error: any) {
            setError(error);
        }
    }

    const refreshNostr = useCallback(async () => {
        if (!keymaster || !currentDID) {
            setNostrKeys(null);
            return;
        }
        try {
            const docs = await keymaster.resolveDID(currentDID);
            const data = docs.didDocumentData as Record<string, unknown>;
            setNostrKeys((data.nostr as NostrKeys) || null);
        } catch {
            setNostrKeys(null);
        }
    }, [keymaster, currentDID]);

    useEffect(() => {
        refreshNostr();
    }, [refreshNostr]);

    const refreshCurrentIdDocs = useCallback(async () => {
        if (!keymaster || !currentDID) {
            setCurrentIdDocs(null);
            return;
        }
        try {
            const docs = await keymaster.resolveDID(currentDID);
            setCurrentIdDocs(docs as Record<string, unknown>);
        } catch {
            setCurrentIdDocs(null);
        }
    }, [keymaster, currentDID]);

    useEffect(() => {
        refreshCurrentIdDocs();
    }, [refreshCurrentIdDocs]);

    const refreshAddresses = useCallback(async () => {
        if (!keymaster || !currentId) {
            setAddressList({});
            setAddressName("");
            setAddressDomain("");
            setSelectedAddress("");
            setAddressDetails("");
            return;
        }
        try {
            const addresses = await keymaster.listAddresses();
            setAddressList(addresses);
            setAddressName("");
            setAddressDomain("");
            setSelectedAddress("");
            setAddressDetails("");
        } catch (error: any) {
            setError(error);
        }
    }, [keymaster, currentId, setError]);

    useEffect(() => {
        refreshAddresses();
    }, [refreshAddresses]);

    async function addNostr() {
        if (!keymaster) {
            return;
        }
        try {
            const nostr = await keymaster.addNostr();
            setNostrKeys(nostr);
            setSuccess("Nostr keys added");
        } catch (error: any) {
            setError(error);
        }
    }

    async function removeNostr() {
        if (!keymaster) {
            return;
        }
        setRemoveNostrModal(false);
        try {
            await keymaster.removeNostr();
            setNostrKeys(null);
            setNsecValue(null);
            setSuccess("Nostr keys removed");
        } catch (error: any) {
            setError(error);
        }
    }

    async function showNsec() {
        if (!keymaster) {
            return;
        }
        try {
            const nsec = await keymaster.exportNsec();
            setNsecValue(nsec);
        } catch (error: any) {
            setError(error);
        }
    }

    function hideNsec() {
        setNsecValue(null);
    }

    function clearAddressFields() {
        setAddressName("");
        setAddressDomain("");
        setSelectedAddress("");
        setAddressDetails("");
    }

    async function resolveStoredAddress(domain: string) {
        if (!keymaster) {
            return;
        }
        setAddressBusy(true);
        try {
            const normalizedDomain = parseAddressDomain(domain);
            if (!normalizedDomain) {
                setError("Enter a domain");
                return;
            }
            const info = await keymaster.getAddress(normalizedDomain);
            setAddressDomain(normalizedDomain);
            if (info) {
                setSelectedAddress(info.address);
                setAddressName(info.name);
                setAddressDetails(JSON.stringify(info, null, 4));
            } else {
                setSelectedAddress("");
                setAddressDetails(JSON.stringify(null, null, 4));
                setError(`No address stored for ${normalizedDomain}`);
            }
        } catch (error: any) {
            setError(error);
        } finally {
            setAddressBusy(false);
        }
    }

    async function selectAddress(address: string) {
        const normalizedAddress = address.trim().toLowerCase();
        setSelectedAddress(normalizedAddress);
        setAddressName(parseAddressName(normalizedAddress));
        setAddressDomain(parseAddressDomain(normalizedAddress));
        await resolveStoredAddress(normalizedAddress);
    }

    async function checkAddressValue() {
        if (!keymaster) {
            return;
        }
        setAddressBusy(true);
        try {
            const normalizedAddress = composeAddress(addressName, addressDomain);
            if (!normalizedAddress) {
                setError("Enter a name and domain");
                return;
            }
            const result: AddressCheckResult = await keymaster.checkAddress(normalizedAddress);
            setAddressName(parseAddressName(normalizedAddress));
            setAddressDomain(parseAddressDomain(normalizedAddress));
            setAddressDetails(JSON.stringify(result, null, 4));
        } catch (error: any) {
            setError(error);
        } finally {
            setAddressBusy(false);
        }
    }

    async function importAddressDomain() {
        if (!keymaster) {
            return;
        }
        setAddressBusy(true);
        try {
            const normalizedDomain = parseAddressDomain(addressDomain);
            if (!normalizedDomain) {
                setError("Enter a domain");
                return;
            }
            const imported = await keymaster.importAddress(normalizedDomain);
            setAddressDomain(normalizedDomain);
            setAddressDetails(JSON.stringify(imported, null, 4));
            await refreshAddresses();
            const importedAddresses = Object.keys(imported);
            if (importedAddresses.length > 0) {
                const importedAddress = importedAddresses[0];
                setSelectedAddress(importedAddress);
                setAddressName(parseAddressName(importedAddress));
                setSuccess(`Imported ${importedAddresses.length} address(es) from ${normalizedDomain}`);
            } else {
                setError(`No addresses imported from ${normalizedDomain}`);
            }
        } catch (error: any) {
            setError(error);
        } finally {
            setAddressBusy(false);
        }
    }

    async function addAddressValue() {
        if (!keymaster) {
            return;
        }
        setAddressBusy(true);
        try {
            const normalizedAddress = composeAddress(addressName, addressDomain);
            if (!normalizedAddress) {
                setError("Enter a name and domain");
                return;
            }
            await keymaster.addAddress(normalizedAddress);
            setAddressName(parseAddressName(normalizedAddress));
            setAddressDomain(parseAddressDomain(normalizedAddress));
            await refreshAddresses();
            await resolveStoredAddress(normalizedAddress);
            setSuccess(`${normalizedAddress} added`);
        } catch (error: any) {
            setError(error);
        } finally {
            setAddressBusy(false);
        }
    }

    async function removeAddressValue(address = selectedAddress || composeAddress(addressName, addressDomain)) {
        if (!keymaster) {
            return;
        }
        setAddressBusy(true);
        try {
            const normalizedAddress = address.trim().toLowerCase();
            if (!normalizedAddress) {
                setError("Select an address or enter a name and domain");
                return;
            }
            await keymaster.removeAddress(normalizedAddress);
            setAddressName("");
            setAddressDomain(parseAddressDomain(normalizedAddress));
            setSelectedAddress("");
            setAddressDetails("");
            await refreshAddresses();
            setSuccess(`${normalizedAddress} removed`);
        } catch (error: any) {
            setError(error);
        } finally {
            setAddressBusy(false);
        }
    }

    return (
        <Box>
            <WarningModal
                title="Remove Nostr Keys"
                warningText="Are you sure you want to remove Nostr keys from this identity?"
                isOpen={removeNostrModal}
                onClose={() => setRemoveNostrModal(false)}
                onSubmit={removeNostr}
            />

            <WarningModal
                title="Remove Identity"
                warningText={`Are you sure you want to remove ${currentId}?`}
                isOpen={warningModal}
                onClose={handleCloseWarningModal}
                onSubmit={removeId}
            />

            <TextInputModal
                isOpen={renameModalOpen}
                title="Rename Identity"
                description={`Rename ${currentId} to`}
                label="New Name"
                confirmText="Rename"
                onSubmit={renameId}
                onClose={() => setRenameModalOpen(false)}
            />

            <TextInputModal
                isOpen={recoverModalOpen}
                title="Recover Identity"
                description="Please enter the DID"
                label="DID"
                confirmText="Recover"
                onSubmit={recoverId}
                onClose={() => setRecoverModalOpen(false)}
            />

            <SelectInputModal
                isOpen={migrateOpen}
                title="Migrate Identity"
                description={`Select registry for ${currentId}`}
                label="Registry"
                confirmText="Migrate"
                options={registries}
                onSubmit={migrateId}
                onClose={() => setMigrateOpen(false)}
            />

            <Box sx={{ mt: 2, display: 'flex', flexDirection: 'column', gap: 0, width: isTabletUp ? '80%' : '100%' }}>
                <Box sx={{ display: 'flex', gap: 0, width: '100%', flexWrap: 'nowrap', flexDirection: 'row' }}>
                    <TextField
                        label="Create ID"
                        variant="outlined"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        size="small"
                        className="text-field name"
                        slotProps={{
                            htmlInput: {
                                maxLength: 30,
                            },
                        }}
                    />

                    <Select
                        value={registries.includes(registry) ? registry : ""}
                        onChange={(e) => setRegistry(e.target.value)}
                        size="small"
                        variant="outlined"
                        className="select-small"
                    >
                        {registries.map((r) => (
                            <MenuItem key={r} value={r}>
                                {r}
                            </MenuItem>
                        ))}
                    </Select>

                    <Button
                        variant="contained"
                        onClick={handleCreateId}
                        size="small"
                        className="button-right"
                    >
                        Create
                    </Button>
                </Box>
                {currentId && (
                    <Box sx={{ mt: 2, display: 'flex', alignItems: 'center', width: '100%', flexWrap: 'wrap', flexDirection: 'row', gap: 1 }}>
                        <Button
                            variant="contained"
                            color="primary"
                            onClick={handleRenameId}
                        >
                            Rename
                        </Button>

                        <Button
                            variant="contained"
                            color="primary"
                            onClick={handleRemoveId}
                        >
                            Remove
                        </Button>

                        <Button
                            variant="contained"
                            color="primary"
                            onClick={backupId}
                        >
                            Backup
                        </Button>

                        <Button
                            variant="contained"
                            color="primary"
                            onClick={handleRecoverId}
                        >
                            Recover
                        </Button>

                        <Button
                            variant="contained"
                            color="primary"
                            onClick={rotateKeys}
                        >
                            Rotate
                        </Button>

                        <Button
                            variant="contained"
                            color="primary"
                            onClick={() => setMigrateOpen(true)}
                        >
                            Migrate...
                        </Button>

                    </Box>
                )}
                {currentId && (
                <Box sx={{ mt: 2, width: '100%' }}>
                    <Tabs
                        value={identityTab}
                            onChange={(_event, newValue) => setIdentityTab(newValue)}
                            variant="scrollable"
                            scrollButtons="auto"
                    >
                        <Tab value="details" label="Details" icon={<PermIdentity />} iconPosition="top" />
                        <Tab value="addresses" label="Addresses" icon={<Badge />} iconPosition="top" />
                        <Tab value="nostr" label="Nostr" icon={<Login />} iconPosition="top" />
                    </Tabs>
                    {identityTab === "details" && (
                        <Box sx={{ mt: 2, width: '100%', maxWidth: isTabletUp ? '80%' : '100%' }}>
                            <Paper variant="outlined" sx={{ p: 2, overflowX: "auto" }}>
                                {currentIdDocs ? (
                                    <JsonView value={currentIdDocs} displayDataTypes={false} />
                                ) : (
                                    <Typography variant="body2" color="text.secondary">
                                        No DID document available for the current identity.
                                    </Typography>
                                )}
                            </Paper>
                        </Box>
                    )}
                    {identityTab === "addresses" && (
                            <Box sx={{ mt: 2, width: '100%', maxWidth: isTabletUp ? '80%' : '100%' }}>
                                <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 1 }}>
                                    <TextField label="Name" size="small" value={addressName} onChange={(e) => setAddressName(e.target.value)} />
                                    <TextField label="Domain" size="small" value={addressDomain} onChange={(e) => setAddressDomain(e.target.value)} />
                                </Box>
                                <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 1 }}>
                                    <Button variant="contained" size="small" onClick={checkAddressValue} disabled={addressBusy || !addressName.trim() || !addressDomain.trim()}>Check</Button>
                                    <Button variant="contained" size="small" onClick={addAddressValue} disabled={addressBusy || !addressName.trim() || !addressDomain.trim()}>Add</Button>
                                    <Button variant="contained" size="small" onClick={() => resolveStoredAddress(addressDomain)} disabled={addressBusy || !addressDomain.trim()}>Get</Button>
                                    <Button variant="contained" size="small" onClick={importAddressDomain} disabled={addressBusy || !addressDomain.trim()}>Import</Button>
                                    <Button variant="contained" size="small" onClick={() => removeAddressValue()} disabled={addressBusy || (!selectedAddress && (!addressName.trim() || !addressDomain.trim()))}>Remove</Button>
                                    <Button variant="contained" size="small" onClick={clearAddressFields} disabled={addressBusy || (!addressName && !addressDomain && !selectedAddress && !addressDetails)}>Clear</Button>
                                </Box>
                                <TableContainer component={Paper} sx={{ mb: 1 }}>
                                    <Table size="small">
                                        <TableHead>
                                            <TableRow>
                                                <TableCell>Address</TableCell>
                                                <TableCell>Added</TableCell>
                                                <TableCell>Actions</TableCell>
                                            </TableRow>
                                        </TableHead>
                                        <TableBody>
                                            {Object.entries(addressList).sort(([a], [b]) => a.localeCompare(b)).map(([address, info]) => (
                                                <TableRow key={address} selected={address === selectedAddress}>
                                                    <TableCell sx={{ fontFamily: 'monospace' }}>{address}</TableCell>
                                                    <TableCell sx={{ fontFamily: 'monospace' }}>{info.added}</TableCell>
                                                    <TableCell><Button variant="contained" size="small" onClick={() => selectAddress(address)} disabled={addressBusy}>Select</Button></TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                </TableContainer>
                                <TextField multiline minRows={8} fullWidth value={addressDetails} InputProps={{ readOnly: true }} />
                            </Box>
                        )}
                        {identityTab === "nostr" && (
                            <Box sx={{ mt: 2, width: '100%', maxWidth: isTabletUp ? '80%' : '100%' }}>
                                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 1 }}>
                                    {nostrKeys ? (
                                        <Button variant="contained" color="error" onClick={() => setRemoveNostrModal(true)} sx={{ whiteSpace: 'nowrap' }}>
                                            Remove Nostr
                                        </Button>
                                    ) : (
                                        <Button variant="contained" color="primary" onClick={addNostr} sx={{ whiteSpace: 'nowrap' }}>
                                            Add Nostr
                                        </Button>
                                    )}
                                    {nostrKeys && (
                                        nsecValue ? (
                                            <Button variant="contained" color="warning" onClick={hideNsec} sx={{ whiteSpace: 'nowrap' }}>
                                                Hide nsec
                                            </Button>
                                        ) : (
                                            <Button variant="contained" color="warning" onClick={showNsec} sx={{ whiteSpace: 'nowrap' }}>
                                                Show nsec
                                            </Button>
                                        )
                                    )}
                                </Box>
                                {nostrKeys ? (
                                    <Box>
                                        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
                                            npub: {nostrKeys.npub}
                                        </Typography>
                                        <br />
                                        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
                                            pubkey: {nostrKeys.pubkey}
                                        </Typography>
                                        {nsecValue && (
                                            <>
                                                <br />
                                                <Typography variant="caption" color="error" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
                                                    nsec: {nsecValue}
                                                </Typography>
                                            </>
                                        )}
                                    </Box>
                                ) : (
                                    <Typography variant="body2" color="text.secondary">
                                        No Nostr keys are configured for this identity yet.
                                    </Typography>
                                )}
                            </Box>
                        )}
                    </Box>
                )}
            </Box>
        </Box>
    );
}

export default IdentitiesTab;
