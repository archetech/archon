import React, { ChangeEvent, useEffect, useState } from "react";
import { Box, Button, IconButton, MenuItem, Select, Tooltip } from "@mui/material";
import { Edit } from "@mui/icons-material";
import { useWalletContext } from "../contexts/WalletProvider";
import { useUIContext } from "../contexts/UIContext";
import { useVariablesContext } from "../contexts/VariablesProvider";
import { useSnackbar } from "../contexts/SnackbarProvider";
import { FileAsset } from "@didcid/keymaster/types";
import { DidCidDocument } from "@didcid/gatekeeper/types";
import VersionNavigator from "./VersionNavigator";
import TextInputModal from "../modals/TextInputModal";
import CopyResolveDID from "./CopyResolveDID";

const FileTab = () => {
    const { keymaster } = useWalletContext();
    const { setError, setSuccess } = useSnackbar();
    const { refreshAliases } = useUIContext();
    const {
        fileList,
        aliasList,
        registries,
    } = useVariablesContext();
    const [registry, setRegistry] = useState<string>("hyperswarm");
    const [selectedFileName, setSelectedFileName] = useState<string>("");
    const [selectedFile, setSelectedFile] = useState<FileAsset | null>(null);
    const [selectedFileDocs, setSelectedFileDocs] = useState<DidCidDocument | null>(null);
    const [fileVersion, setFileVersion] = useState<number>(1);
    const [fileVersionMax, setFileVersionMax] = useState<number>(1);
    const [renameOpen, setRenameOpen] = useState<boolean>(false);
    const [renameOldName, setRenameOldName] = useState<string>("");

    useEffect(() => {
        if (selectedFileName) {
            setFileVersionMax(1);
            refreshFile(selectedFileName);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedFileName]);

    async function refreshFile(fileName: string, version?: number) {
        if (!keymaster) {
            return;
        }
        try {
            const docs = await keymaster.resolveDID(fileName, version ? { versionSequence: version } : {});
            setSelectedFileDocs(docs);

            const currentVersion = docs.didDocumentMetadata?.version ?? 1;
            setFileVersion(currentVersion);
            if (version === undefined) {
                setFileVersionMax(currentVersion);
            }

            const fileAsset = docs.didDocumentData as { file?: FileAsset };
            if (!fileAsset.file || !fileAsset.file.cid) {
                setError(`No file data found in version ${currentVersion}`);
                return;
            }
            setSelectedFile(fileAsset.file);
        } catch (error: any) {
            setError(error);
        }
    }

    async function streamFileToGatekeeper(file: File): Promise<string> {
        const { gatekeeperUrl } = await chrome.storage.sync.get(["gatekeeperUrl"]);
        const response = await fetch(`${gatekeeperUrl}/api/v1/ipfs/stream`, {
            method: 'POST',
            body: file,
            headers: { 'Content-Type': 'application/octet-stream' },
        });
        if (!response.ok) {
            throw new Error(`Upload failed: ${await response.text()}`);
        }
        return response.text();
    }

    async function uploadFile(event: ChangeEvent<HTMLInputElement>) {
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

            const cid = await streamFileToGatekeeper(file);
            const fileAsset: FileAsset = {
                cid,
                filename: file.name,
                type: file.type || 'application/octet-stream',
                bytes: file.size,
            };

            const did = await keymaster.createAsset({ file: fileAsset }, { registry });

            const aliasList = await keymaster.listAliases();
            let alias = file.name.slice(0, 26);
            let count = 1;

            while (alias in aliasList) {
                alias = `${file.name.slice(0, 26)} (${count++})`;
            }

            await keymaster.addAlias(alias, did);
            setSuccess(`File uploaded successfully: ${alias}`);

            await refreshAliases();
            setSelectedFileName(alias);
        } catch (error: any) {
            setError(`Error uploading file: ${error}`);
        }
    }

    async function updateFile(event: ChangeEvent<HTMLInputElement>) {
        if (!keymaster || !selectedFileName) {
            return;
        }
        try {
            const fileInput = event.target;
            if (!fileInput.files || fileInput.files.length === 0) {
                return;
            }

            const file = fileInput.files[0];
            fileInput.value = "";

            const cid = await streamFileToGatekeeper(file);
            const fileAsset: FileAsset = {
                cid,
                filename: file.name,
                type: file.type || 'application/octet-stream',
                bytes: file.size,
            };
            const did = aliasList[selectedFileName];
            await keymaster.mergeData(did, { file: fileAsset });

            setSuccess(`File updated successfully`);
            await refreshFile(selectedFileName);
        } catch (error: any) {
            setError(`Error uploading file: ${error}`);
        }
    }

    async function downloadFile() {
        if (!selectedFile || !selectedFile.cid) {
            return;
        }

        const { gatekeeperUrl } = await chrome.storage.sync.get(["gatekeeperUrl"]);
        const filename = encodeURIComponent(selectedFile.filename || 'download.bin');
        const type = encodeURIComponent(selectedFile.type || 'application/octet-stream');
        const url = `${gatekeeperUrl}/api/v1/ipfs/stream/${selectedFile.cid}?filename=${filename}&type=${type}`;
        const link = document.createElement("a");
        link.href = url;
        link.download = selectedFile.filename || "download.bin";
        link.click();
    }

    function handleVersionChange(newVer: number) {
        refreshFile(selectedFileName, newVer);
    }

    function openRenameModal() {
        setRenameOldName(selectedFileName);
        setRenameOpen(true);
    }

    async function handleRenameSubmit(newName: string) {
        setRenameOpen(false);
        if (!keymaster || !newName || newName === selectedFileName) {
            return;
        }
        try {
            const did = aliasList[selectedFileName];
            await keymaster.addAlias(newName, did);
            await keymaster.removeAlias(selectedFileName);
            await refreshAliases();
            setSelectedFileName(newName);
            await refreshFile(newName);
            setSuccess("File renamed");
        } catch (error: any) {
            setError(error);
        }
    }

    return (
        <Box>
            <TextInputModal
                isOpen={renameOpen}
                title="Rename File"
                description={`Rename '${renameOldName}'`}
                label="New Name"
                confirmText="Rename"
                defaultValue={renameOldName}
                onSubmit={handleRenameSubmit}
                onClose={() => setRenameOpen(false)}
            />

            <Box className="flex-box mt-2">
                <Select
                    value={registries.includes(registry) ? registry : ""}
                    onChange={(e) => setRegistry(e.target.value)}
                    size="small"
                    variant="outlined"
                    className="select-small-left"
                    sx={{ width: 300 }}
                    displayEmpty
                >
                    {registries.map((r) => (
                        <MenuItem key={r} value={r}>
                            {r}
                        </MenuItem>
                    ))}
                </Select>

                <Button
                    variant="contained"
                    onClick={() => document.getElementById("fileUpload")!.click()}
                    size="small"
                    className="button-right"
                    disabled={!registry}
                >
                    Upload File
                </Button>
                <input
                    type="file"
                    id="fileUpload"
                    accept=".pdf,.doc,.docx,.txt,video/*"
                    style={{ display: "none" }}
                    onChange={uploadFile}
                />
            </Box>

            {fileList && (
                <Box>
                    <Box className="flex-box mt-2">
                        <Select
                            value={selectedFileName}
                            onChange={(event) => setSelectedFileName(event.target.value)}
                            size="small"
                            variant="outlined"
                            className="select-small-left"
                            sx={{ width: 300 }}
                            displayEmpty
                        >
                            <MenuItem value="" disabled>
                                Select file
                            </MenuItem>
                            {fileList.map((alias, index) => (
                                <MenuItem value={alias} key={index}>
                                    {alias}
                                </MenuItem>
                            ))}
                        </Select>
                        <Button
                            variant="contained"
                            onClick={() => document.getElementById("fileUpdate")!.click()}
                            size="small"
                            className="button-center"
                            disabled={!selectedFileName}
                        >
                            Update
                        </Button>
                        <input
                            type="file"
                            id="fileUpdate"
                            accept=".pdf,.doc,.docx,.txt,video/*"
                            style={{ display: "none" }}
                            onChange={updateFile}
                        />
                        <Button
                            variant="contained"
                            size="small"
                            onClick={downloadFile}
                            className="button-right"
                            disabled={!selectedFile}
                        >
                            Download
                        </Button>
                        <Tooltip title="Rename File">
                            <span>
                                <IconButton size="small" onClick={openRenameModal} disabled={!selectedFileName} sx={{ ml: 1 }}>
                                    <Edit fontSize="small" />
                                </IconButton>
                            </span>
                        </Tooltip>

                        <CopyResolveDID did={aliasList[selectedFileName]} />
                    </Box>
                    {selectedFile && selectedFileDocs && (
                        <Box sx={{ mt: 2 }}>
                            <VersionNavigator
                                version={fileVersion}
                                maxVersion={fileVersionMax}
                                onVersionChange={handleVersionChange}
                            />

                            <Box sx={{ mt: 2, display: "flex", flexDirection: "column", gap: 2 }}>
                                <Box>
                                    <strong>DID:</strong> {selectedFileDocs.didDocument!.id}
                                </Box>
                                <Box>
                                    <strong>CID:</strong> {selectedFile.cid}
                                </Box>
                                <Box>
                                    <strong>Filename:</strong> {selectedFile.filename}
                                </Box>
                                <Box>
                                    <strong>Created:</strong>{" "}
                                    {selectedFileDocs.didDocumentMetadata!.created}
                                </Box>
                                <Box>
                                    <strong>Updated:</strong>{" "}
                                    {selectedFileDocs.didDocumentMetadata!.updated ||
                                        selectedFileDocs.didDocumentMetadata!.created}
                                </Box>
                                <Box>
                                    <strong>Version:</strong>{" "}
                                    {selectedFileDocs.didDocumentMetadata!.version}
                                </Box>
                                <Box>
                                    <strong>File size:</strong> {selectedFile.bytes} bytes
                                </Box>
                                <Box>
                                    <strong>File type:</strong> {selectedFile.type}
                                </Box>
                            </Box>
                        </Box>
                    )}
                </Box>
            )}
        </Box>
    );
};

export default FileTab;
