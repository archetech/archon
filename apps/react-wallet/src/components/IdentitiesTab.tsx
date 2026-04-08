import { ChangeEvent, useCallback, useEffect, useState } from "react";
import JsonView from "@uiw/react-json-view";
import { useWalletContext } from "../contexts/WalletProvider";
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, FormControl, FormControlLabel, FormLabel, MenuItem, Paper, Radio, RadioGroup, Select, Tab, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tabs, TextField, Typography } from "@mui/material";
import { Badge, Image, Login, PermIdentity } from "@mui/icons-material";
import { useUIContext } from "../contexts/UIContext";
import { useSnackbar } from "../contexts/SnackbarProvider";
import WarningModal from "../modals/WarningModal";
import TextInputModal from "../modals/TextInputModal";
import SelectInputModal from "../modals/SelectInputModal";
import { useVariablesContext } from "../contexts/VariablesProvider";
import type { AddressCheckResult, AddressInfo, FileAsset, ImageAsset, NostrKeys } from "@didcid/keymaster/types";
import GatekeeperClient from "@didcid/gatekeeper/client";
import {
    DEFAULT_GATEKEEPER_URL,
    GATEKEEPER_KEY
} from "../constants";

const gatekeeper = new GatekeeperClient();

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

function formatAddedDate(value: string): string {
    return typeof value === "string" ? value.slice(0, 10) : "";
}

function IdentitiesTab() {
    const [identityTab, setIdentityTab] = useState<"details" | "addresses" | "avatar" | "nostr">("details");
    const [name, setName] = useState<string>("");
    const [warningModal, setWarningModal] = useState<boolean>(false);
    const [removeCalled, setRemoveCalled] = useState<boolean>(false);
    const [renameModalOpen, setRenameModalOpen] = useState<boolean>(false);
    const [recoverModalOpen, setRecoverModalOpen] = useState<boolean>(false);
    const [nostrKeys, setNostrKeys] = useState<NostrKeys | null>(null);
    const [removeNostrModal, setRemoveNostrModal] = useState<boolean>(false);
    const [migrateOpen, setMigrateOpen] = useState<boolean>(false);
    const [createModalOpen, setCreateModalOpen] = useState<boolean>(false);
    const [nsecValue, setNsecValue] = useState<string | null>(null);
    const [currentIdDocs, setCurrentIdDocs] = useState<Record<string, unknown> | null>(null);
    const [addressList, setAddressList] = useState<Record<string, AddressInfo>>({});
    const [addressName, setAddressName] = useState<string>("");
    const [addressDomain, setAddressDomain] = useState<string>("");
    const [selectedAddress, setSelectedAddress] = useState<string>("");
    const [addressDetails, setAddressDetails] = useState<string>("");
    const [addressBusy, setAddressBusy] = useState<boolean>(false);
    const [avatarMode, setAvatarMode] = useState<"alias" | "did" | "upload">("alias");
    const [avatarAlias, setAvatarAlias] = useState<string>("");
    const [avatarInputDid, setAvatarInputDid] = useState<string>("");
    const [avatarDid, setAvatarDid] = useState<string>("");
    const [avatarPreviewUrl, setAvatarPreviewUrl] = useState<string>("");
    const [avatarLoading, setAvatarLoading] = useState<boolean>(false);
    const [avatarError, setAvatarError] = useState<string>("");
    const [avatarCandidateDid, setAvatarCandidateDid] = useState<string>("");
    const [avatarCandidateAlias, setAvatarCandidateAlias] = useState<string>("");
    const [avatarCandidatePreviewUrl, setAvatarCandidatePreviewUrl] = useState<string>("");
    const [avatarCandidateLoading, setAvatarCandidateLoading] = useState<boolean>(false);
    const [avatarCandidateError, setAvatarCandidateError] = useState<string>("");
    const { keymaster } = useWalletContext();
    const { setError, setSuccess } = useSnackbar();
    const {
        refreshAll,
        resetCurrentID,
    } = useUIContext();
    const {
        currentId,
        currentDID,
        imageList,
        aliasList,
        registry,
        setRegistry,
        registries,
    } = useVariablesContext();
    useEffect(() => {
        const init = async () => {
            const gatekeeperUrl = localStorage.getItem(GATEKEEPER_KEY);
            await gatekeeper.connect({ url: gatekeeperUrl || DEFAULT_GATEKEEPER_URL });
        };
        init();
    }, []);

    function findAliasByDid(did: string, allowedAliases?: string[]): string {
        if (!did) {
            return "";
        }

        const allowed = allowedAliases ? new Set(allowedAliases) : null;

        for (const [name, aliasDid] of Object.entries(aliasList)) {
            if (aliasDid === did && (!allowed || allowed.has(name))) {
                return name;
            }
        }

        return "";
    }

    async function getImagePreviewDataUrl(doc: Record<string, unknown>): Promise<string> {
        const docAsset = doc as { file?: FileAsset; image?: ImageAsset };

        if (!docAsset.file?.cid || !docAsset.file?.type || !docAsset.image) {
            return "";
        }

        const raw = await gatekeeper.getData(docAsset.file.cid);
        if (!raw) {
            return "";
        }

        return `data:${docAsset.file.type};base64,${raw.toString("base64")}`;
    }

    function clearAvatarCandidate() {
        setAvatarCandidateDid("");
        setAvatarCandidateAlias("");
        setAvatarCandidatePreviewUrl("");
        setAvatarCandidateLoading(false);
        setAvatarCandidateError("");
    }

    function handleAvatarModeChange(event: ChangeEvent<HTMLInputElement>) {
        setAvatarMode(event.target.value as "alias" | "did" | "upload");
        clearAvatarCandidate();
    }

    async function previewAvatarCandidate(input: string, options: { alias?: string } = {}) {
        if (!keymaster) {
            return;
        }

        const value = input.trim();
        const preferredAlias = options.alias || "";

        if (!value) {
            setError("Choose an image alias or enter a DID");
            return;
        }

        setAvatarCandidateLoading(true);
        setAvatarCandidateError("");

        try {
            const doc = await keymaster.resolveDID(value);
            const did = doc.didDocument?.id || "";
            const previewUrl = await getImagePreviewDataUrl(doc.didDocumentData as Record<string, unknown>);

            if (!did) {
                setError("Unable to resolve avatar DID");
                clearAvatarCandidate();
                return;
            }

            if (!previewUrl) {
                setAvatarCandidateDid(did);
                setAvatarCandidateAlias(preferredAlias || findAliasByDid(did, imageList));
                setAvatarCandidatePreviewUrl("");
                setAvatarCandidateError("Avatar must resolve to an image asset DID");
                return;
            }

            setAvatarCandidateDid(did);
            setAvatarCandidateAlias(preferredAlias || findAliasByDid(did, imageList));
            setAvatarCandidatePreviewUrl(previewUrl);
            setAvatarCandidateError("");
        } catch (error: any) {
            clearAvatarCandidate();
            setAvatarCandidateError(error.error || error.message || String(error));
        } finally {
            setAvatarCandidateLoading(false);
        }
    }

    const loadAvatar = useCallback(async () => {
        if (!keymaster || !currentDID) {
            setAvatarAlias("");
            setAvatarInputDid("");
            setAvatarDid("");
            setAvatarPreviewUrl("");
            setAvatarError("");
            clearAvatarCandidate();
            setAvatarLoading(false);
            return;
        }

        setAvatarLoading(true);
        setAvatarError("");

        try {
            const identityDoc = await keymaster.resolveDID(currentDID);
            const data = identityDoc.didDocumentData as Record<string, unknown>;
            const rawAvatar = data.avatar;
            const nextDid = typeof rawAvatar === "string" ? rawAvatar.trim() : "";

            if (!nextDid) {
                setAvatarAlias("");
                setAvatarInputDid("");
                setAvatarDid("");
                setAvatarPreviewUrl("");
                return;
            }

            setAvatarDid(nextDid);
            setAvatarInputDid(nextDid);
            setAvatarAlias(findAliasByDid(nextDid, imageList));

            try {
                const avatarDoc = await keymaster.resolveDID(nextDid);
                const previewUrl = await getImagePreviewDataUrl(avatarDoc.didDocumentData as Record<string, unknown>);

                if (previewUrl) {
                    setAvatarPreviewUrl(previewUrl);
                } else {
                    setAvatarPreviewUrl("");
                    setAvatarError("The current avatar does not resolve to an image asset.");
                }
            } catch (error: any) {
                setAvatarPreviewUrl("");
                setAvatarError(error.error || error.message || String(error));
            }
        } catch (error: any) {
            setAvatarPreviewUrl("");
            setAvatarDid("");
            setAvatarAlias("");
            setAvatarInputDid("");
            setAvatarError(error.error || error.message || String(error));
        } finally {
            setAvatarLoading(false);
        }
    }, [currentDID, imageList, keymaster, aliasList]);

    useEffect(() => {
        loadAvatar();
    }, [loadAvatar]);

    async function applyAvatarCandidate() {
        if (!keymaster) {
            return;
        }
        if (!avatarCandidateDid || !avatarCandidatePreviewUrl) {
            setError("Preview an image avatar before setting it");
            return;
        }

        try {
            await keymaster.mergeData(currentId, { avatar: avatarCandidateDid });
            setAvatarDid(avatarCandidateDid);
            setAvatarInputDid(avatarCandidateDid);
            setAvatarAlias(avatarCandidateAlias || findAliasByDid(avatarCandidateDid, imageList));
            setAvatarPreviewUrl(avatarCandidatePreviewUrl);
            setAvatarError("");
            clearAvatarCandidate();
            await refreshCurrentIdDocs();
            await loadAvatar();
            window.dispatchEvent(new Event("archon:avatar-changed"));
            setSuccess("Avatar updated");
        } catch (error: any) {
            setError(error);
        }
    }

    async function removeAvatarProperty() {
        if (!keymaster) {
            return;
        }

        try {
            await keymaster.mergeData(currentId, { avatar: null });
            setAvatarAlias("");
            setAvatarInputDid("");
            setAvatarDid("");
            setAvatarPreviewUrl("");
            setAvatarError("");
            clearAvatarCandidate();
            await refreshCurrentIdDocs();
            window.dispatchEvent(new Event("archon:avatar-changed"));
            setSuccess("Avatar removed");
        } catch (error: any) {
            setError(error);
        }
    }

    async function uploadAvatarImage(event: ChangeEvent<HTMLInputElement>) {
        if (!keymaster) {
            return;
        }

        try {
            const fileInput = event.target;
            if (!fileInput.files || fileInput.files.length === 0) {
                return;
            }

            const file = fileInput.files[0];
            fileInput.value = "";

            const reader = new FileReader();

            reader.onload = async (e) => {
                try {
                    if (!e.target?.result || !(e.target.result instanceof ArrayBuffer)) {
                        setError("Unexpected file reader result");
                        return;
                    }

                    const did = await keymaster.createImage(Buffer.from(e.target.result), { registry });
                    const names = await keymaster.listAliases();
                    let alias = file.name.slice(0, 26);
                    let count = 1;

                    while (alias in names) {
                        alias = `${file.name.slice(0, 26)} (${count++})`;
                    }

                    await keymaster.addAlias(alias, did);
                    await refreshAll();
                    setAvatarMode("upload");
                    await previewAvatarCandidate(did, { alias });
                    setSuccess(`Avatar image uploaded successfully: ${alias}. Review the preview, then set the avatar.`);
                } catch (error: any) {
                    setError(`Error processing avatar image: ${error}`);
                }
            };

            reader.onerror = (error) => {
                setError(`Error reading file: ${error}`);
            };

            reader.readAsArrayBuffer(file);
        } catch (error: any) {
            setError(`Error uploading avatar image: ${error}`);
        }
    }

    const isAvatarPreviewMode = !!(avatarCandidateDid || avatarCandidatePreviewUrl || avatarCandidateError || avatarCandidateLoading);
    const displayedAvatarPreviewUrl = isAvatarPreviewMode ? avatarCandidatePreviewUrl : avatarPreviewUrl;
    const displayedAvatarDid = isAvatarPreviewMode ? avatarCandidateDid : avatarDid;
    const displayedAvatarError = isAvatarPreviewMode ? avatarCandidateError : avatarError;
    const displayedAvatarLoading = isAvatarPreviewMode ? avatarCandidateLoading : avatarLoading;
    const displayedAvatarTitle = isAvatarPreviewMode ? "Avatar Preview" : "Current Avatar";
    const displayedAvatarDidLabel = isAvatarPreviewMode ? "Preview Avatar DID" : "Current Avatar DID";
    const displayedAvatarEmptyText = displayedAvatarLoading
        ? (isAvatarPreviewMode ? "Loading preview..." : "Loading avatar...")
        : displayedAvatarError
            ? (isAvatarPreviewMode ? "Preview unavailable" : "Avatar preview unavailable")
            : "No avatar set";

    const handleCreateId = async () => {
        if (!keymaster) {
            return false;
        }
        if (!name.trim()) {
            return false;
        }
        try {
            await keymaster.createId(name.trim(), { registry });
            await resetCurrentID();
            setName("");
            return true;
        } catch (error: any) {
            setError(error);
            return false;
        }
    };

    function openCreateModal() {
        setCreateModalOpen(true);
    }

    function closeCreateModal() {
        setCreateModalOpen(false);
    }

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
            await refreshAddresses();
            const importedAddresses = Object.keys(imported);
            setAddressDomain(normalizedDomain);
            setAddressDetails(JSON.stringify(imported, null, 4));
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
        <Box sx={{ width: '100%' }}>
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

            <Dialog open={createModalOpen} onClose={closeCreateModal} fullWidth maxWidth="sm">
                <DialogTitle>Create Identity</DialogTitle>
                <DialogContent>
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
                        <TextField
                            label="Name"
                            variant="outlined"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
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
                        >
                            {registries.map((r) => (
                                <MenuItem key={r} value={r}>
                                    {r}
                                </MenuItem>
                            ))}
                        </Select>
                    </Box>
                </DialogContent>
                <DialogActions>
                    <Button onClick={closeCreateModal}>Cancel</Button>
                    <Button
                        variant="contained"
                        onClick={async () => {
                            const ok = await handleCreateId();
                            if (ok) {
                                closeCreateModal();
                            }
                        }}
                        disabled={!name.trim() || !registry}
                    >
                        Create
                    </Button>
                </DialogActions>
            </Dialog>

            <Box sx={{ mt: 2, display: 'flex', flexDirection: 'column', gap: 0, width: '100%' }}>
                <Box sx={{ mt: currentId ? 2 : 0, display: 'flex', alignItems: 'center', width: '100%', flexWrap: 'wrap', flexDirection: 'row', gap: 1 }}>
                    <Button variant="contained" onClick={openCreateModal}>
                        Create ID
                    </Button>
                    {currentId && (
                        <>
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
                        </>
                    )}
                </Box>
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
                            <Tab value="avatar" label="Avatar" icon={<Image />} iconPosition="top" />
                            <Tab value="nostr" label="Nostr" icon={<Login />} iconPosition="top" />
                        </Tabs>
                        {identityTab === "details" && (
                            <Box sx={{ mt: 2, width: '100%' }}>
                                <Paper variant="outlined" sx={{ p: 2, overflowX: "auto", width: '100%' }}>
                                    {currentIdDocs ? (
                                        <Box sx={{ width: '100%' }}>
                                            <JsonView value={currentIdDocs} displayDataTypes={false} />
                                        </Box>
                                    ) : (
                                        <Typography variant="body2" color="text.secondary">
                                        No DID document available for the current identity.
                                        </Typography>
                                    )}
                                </Paper>
                            </Box>
                        )}
                        {identityTab === "addresses" && (
                            <Box sx={{ mt: 2, width: '100%' }}>
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
                                                    <TableCell sx={{ fontFamily: 'monospace' }}>{formatAddedDate(info.added)}</TableCell>
                                                    <TableCell><Button variant="contained" size="small" onClick={() => selectAddress(address)} disabled={addressBusy}>Select</Button></TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                </TableContainer>
                                <TextField multiline minRows={8} fullWidth value={addressDetails} InputProps={{ readOnly: true }} />
                            </Box>
                        )}
                        {identityTab === "avatar" && (
                            <Box sx={{ mt: 2, width: "100%" }}>
                                <Box sx={{ display: "flex", gap: 3, flexWrap: "wrap", alignItems: "flex-start", mb: 3 }}>
                                    <Box sx={{ width: 220 }}>
                                        <Typography variant="subtitle1" sx={{ mb: 1 }}>{displayedAvatarTitle}</Typography>
                                        <Paper variant="outlined" sx={{ width: 220, height: 220, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", bgcolor: "grey.50" }}>
                                            {displayedAvatarPreviewUrl ? (
                                                <img src={displayedAvatarPreviewUrl} alt={`${currentId} avatar`} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
                                            ) : (
                                                <Typography color="text.secondary" sx={{ textAlign: "center", px: 2 }}>
                                                    {displayedAvatarEmptyText}
                                                </Typography>
                                            )}
                                        </Paper>
                                    </Box>
                                    <Box sx={{ flex: 1, minWidth: 280 }}>
                                        <Typography variant="body2" sx={{ mb: 1 }}>
                                            {isAvatarPreviewMode
                                                ? "Review the preview below, then apply it to the selected identity."
                                                : "The selected identity stores its avatar as the `avatar` property."}
                                        </Typography>
                                        <TextField
                                            label={displayedAvatarDidLabel}
                                            value={displayedAvatarDid}
                                            fullWidth
                                            size="small"
                                            margin="normal"
                                            InputProps={{ readOnly: true }}
                                        />
                                        {displayedAvatarError && (
                                            <Alert severity="warning" sx={{ mt: 1 }}>
                                                {displayedAvatarError}
                                            </Alert>
                                        )}
                                        <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", mt: 2 }}>
                                            {isAvatarPreviewMode ? (
                                                <>
                                                    <Button
                                                        variant="contained"
                                                        onClick={applyAvatarCandidate}
                                                        disabled={!avatarCandidateDid || !avatarCandidatePreviewUrl}
                                                    >
                                                        Set Avatar
                                                    </Button>
                                                    <Button
                                                        variant="outlined"
                                                        onClick={clearAvatarCandidate}
                                                        disabled={!avatarCandidateDid && !avatarCandidatePreviewUrl && !avatarCandidateError}
                                                    >
                                                        Clear Preview
                                                    </Button>
                                                </>
                                            ) : (
                                                <Button variant="contained" color="error" onClick={removeAvatarProperty} disabled={!avatarDid}>
                                                    Remove Avatar
                                                </Button>
                                            )}
                                        </Box>
                                    </Box>
                                </Box>

                                <FormControl sx={{ mb: 2 }}>
                                    <FormLabel>Set Avatar From</FormLabel>
                                    <RadioGroup row value={avatarMode} onChange={handleAvatarModeChange}>
                                        <FormControlLabel value="alias" control={<Radio />} label="Image Alias" />
                                        <FormControlLabel value="did" control={<Radio />} label="DID" />
                                        <FormControlLabel value="upload" control={<Radio />} label="Upload Image" />
                                    </RadioGroup>
                                </FormControl>

                                {avatarMode === "alias" && (
                                    <Box sx={{ display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap" }}>
                                        <Select
                                            value={avatarAlias}
                                            displayEmpty
                                            size="small"
                                            sx={{ minWidth: 280 }}
                                            onChange={(event) => setAvatarAlias(event.target.value)}
                                        >
                                            <MenuItem value="" disabled>Select image alias</MenuItem>
                                            {imageList.map((name) => (
                                                <MenuItem key={name} value={name}>{name}</MenuItem>
                                            ))}
                                        </Select>
                                        <Button
                                            variant="contained"
                                            onClick={() => previewAvatarCandidate(avatarAlias, { alias: avatarAlias })}
                                            disabled={!avatarAlias}
                                        >
                                            Preview
                                        </Button>
                                    </Box>
                                )}

                                {avatarMode === "did" && (
                                    <Box sx={{ display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap" }}>
                                        <TextField
                                            label="Avatar DID"
                                            value={avatarInputDid}
                                            onChange={(e) => setAvatarInputDid(e.target.value)}
                                            size="small"
                                            sx={{ minWidth: 420, flex: 1 }}
                                        />
                                        <Button
                                            variant="contained"
                                            onClick={() => previewAvatarCandidate(avatarInputDid)}
                                            disabled={!avatarInputDid.trim()}
                                        >
                                            Preview
                                        </Button>
                                    </Box>
                                )}

                                {avatarMode === "upload" && (
                                    <Box sx={{ display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap" }}>
                                        <Select
                                            value={registries.includes(registry) ? registry : ""}
                                            onChange={(e) => setRegistry(e.target.value)}
                                            size="small"
                                            sx={{ minWidth: 220 }}
                                        >
                                            {registries.map((r) => (
                                                <MenuItem key={r} value={r}>{r}</MenuItem>
                                            ))}
                                        </Select>
                                        <Button
                                            variant="contained"
                                            onClick={() => document.getElementById("avatarUpload")?.click()}
                                            disabled={!registry}
                                        >
                                            Upload Image...
                                        </Button>
                                        <input
                                            type="file"
                                            id="avatarUpload"
                                            accept="image/*"
                                            style={{ display: "none" }}
                                            onChange={uploadAvatarImage}
                                        />
                                    </Box>
                                )}
                            </Box>
                        )}
                        {identityTab === "nostr" && (
                            <Box sx={{ mt: 2, width: '100%' }}>
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
