import React, { ChangeEvent, useEffect, useState } from "react";
import { Box, Button, IconButton, MenuItem, Select, Tooltip } from "@mui/material";
import { Edit } from "@mui/icons-material";
import { useWalletContext } from "../contexts/WalletProvider";
import { useUIContext } from "../contexts/UIContext";
import { useVariablesContext } from "../contexts/VariablesProvider";
import { useSnackbar } from "../contexts/SnackbarProvider";
import { FileAsset } from "@didcid/keymaster/types";
import { DidCidDocument } from "@didcid/gatekeeper/types";
import GatekeeperClient from "@didcid/gatekeeper/client";
import VersionNavigator from "./VersionNavigator";
import TextInputModal from "../modals/TextInputModal";
import CopyResolveDID from "./CopyResolveDID";

const gatekeeper = new GatekeeperClient();

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
    const [selectedFileDataUrl, setSelectedFileDataUrl] = useState<string>("");
    const [fileVersion, setFileVersion] = useState<number>(1);
    const [fileVersionMax, setFileVersionMax] = useState<number>(1);
    const [renameOpen, setRenameOpen] = useState<boolean>(false);
    const [renameOldName, setRenameOldName] = useState<string>("");

    useEffect(() => {
        const init = async () => {
            const { gatekeeperUrl } = await chrome.storage.sync.get(["gatekeeperUrl"]);
            await gatekeeper.connect({ url: gatekeeperUrl as string });
        };
        init();
    }, []);

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

            const raw = await gatekeeper.getData(fileAsset.file.cid);
            if (!raw) {
                setError(`Could not fetch data for CID: ${fileAsset.file.cid}`);
                return;
            }

            const base64 = raw.toString("base64");
            const dataUrl = `data:${fileAsset.file.type};base64,${base64}`;
            setSelectedFileDataUrl(dataUrl);
        } catch (error: any) {
            setError(error);
        }
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

            const reader = new FileReader();
            reader.onload = async (e) => {
                try {
                    if (!e.target || !e.target.result) {
                        setError("Unexpected file reader result");
                        return;
                    }
                    const arrayBuffer = e.target.result;
                    let buffer: Buffer;
                    if (arrayBuffer instanceof ArrayBuffer) {
                        buffer = Buffer.from(arrayBuffer);
                    } else {
                        setError("Unexpected file reader result type");
                        return;
                    }

                    const did = await keymaster.createFile(buffer, {
                        registry,
                        filename: file.name,
                    });

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
                    setError(`Error processing file: ${error}`);
                }
            };

            reader.onerror = (error) => {
                setError(`Error reading file: ${error}`);
            };

            reader.readAsArrayBuffer(file);
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

            const reader = new FileReader();
            reader.onload = async (e) => {
                try {
                    if (!e.target || !e.target.result) {
                        setError("Unexpected file reader result");
                        return;
                    }
                    const arrayBuffer = e.target.result;
                    let buffer: Buffer;
                    if (arrayBuffer instanceof ArrayBuffer) {
                        buffer = Buffer.from(arrayBuffer);
                    } else {
                        setError("Unexpected file reader result type");
                        return;
                    }

                    await keymaster.updateFile(selectedFileName, buffer, {
                        filename: file.name,
                    });

                    setSuccess(`File updated successfully`);
                    await refreshFile(selectedFileName);
                } catch (error: any) {
                    setError(`Error updating file: ${error}`);
                }
            };

            reader.onerror = (error) => {
                setError(`Error reading file: ${error}`);
            };

            reader.readAsArrayBuffer(file);
        } catch (error: any) {
            setError(`Error uploading file: ${error}`);
        }
    }

    function downloadFile() {
        if (!selectedFile || !selectedFileDataUrl) {
            return;
        }

        const link = document.createElement("a");
        link.href = selectedFileDataUrl;
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
                    accept=".pdf,.doc,.docx,.txt"
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
                            accept=".pdf,.doc,.docx,.txt"
                            style={{ display: "none" }}
                            onChange={updateFile}
                        />
                        <Button
                            variant="contained"
                            size="small"
                            onClick={downloadFile}
                            className="button-right"
                            disabled={!selectedFile || !selectedFileDataUrl}
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
                    {selectedFile && selectedFileDocs && selectedFileDataUrl && (
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
