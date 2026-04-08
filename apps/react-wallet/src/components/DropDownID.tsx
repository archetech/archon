import React, { useEffect, useState } from "react";
import {
    Box,
    Button,
    Menu,
    MenuItem,
} from "@mui/material";
import { ArrowDropDown } from "@mui/icons-material";
import { useWalletContext } from "../contexts/WalletProvider";
import { useUIContext } from "../contexts/UIContext";
import { useSnackbar } from "../contexts/SnackbarProvider";
import { useVariablesContext } from "../contexts/VariablesProvider";
import CopyDID from "./CopyDID";
import GatekeeperClient from "@didcid/gatekeeper/client";
import type { FileAsset, ImageAsset } from "@didcid/keymaster/types";
import {
    DEFAULT_GATEKEEPER_URL,
    GATEKEEPER_KEY
} from "../constants";

const gatekeeper = new GatekeeperClient();

const DropDownID = () => {
    const { keymaster } = useWalletContext();
    const {
        currentDID,
        currentId,
        idList,
        unresolvedIdList,
    } = useVariablesContext();
    const { setError } = useSnackbar();
    const { resetCurrentID } = useUIContext();

    const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
    const [avatarPreviewUrl, setAvatarPreviewUrl] = useState<string>("");

    const truncatedId =
        currentId?.length > 10 ? currentId.slice(0, 10) + "..." : currentId;

    useEffect(() => {
        const init = async () => {
            const gatekeeperUrl = localStorage.getItem(GATEKEEPER_KEY);
            await gatekeeper.connect({ url: gatekeeperUrl || DEFAULT_GATEKEEPER_URL });
        };
        init();
    }, []);

    useEffect(() => {
        const loadAvatar = async () => {
            if (!keymaster || !currentDID) {
                setAvatarPreviewUrl("");
                return;
            }

            try {
                const identityDoc = await keymaster.resolveDID(currentDID);
                const identityData = identityDoc.didDocumentData as Record<string, unknown>;
                const avatarDid = typeof identityData.avatar === "string" ? identityData.avatar.trim() : "";

                if (!avatarDid) {
                    setAvatarPreviewUrl("");
                    return;
                }

                const avatarDoc = await keymaster.resolveDID(avatarDid);
                const asset = avatarDoc.didDocumentData as { file?: FileAsset; image?: ImageAsset };

                if (!asset.file?.cid || !asset.file?.type || !asset.image) {
                    setAvatarPreviewUrl("");
                    return;
                }

                const raw = await gatekeeper.getData(asset.file.cid);
                if (!raw) {
                    setAvatarPreviewUrl("");
                    return;
                }

                setAvatarPreviewUrl(`data:${asset.file.type};base64,${raw.toString("base64")}`);
            } catch {
                setAvatarPreviewUrl("");
            }
        };

        loadAvatar();
        window.addEventListener("archon:avatar-changed", loadAvatar);
        return () => window.removeEventListener("archon:avatar-changed", loadAvatar);
    }, [currentDID, currentId, keymaster]);

    async function selectId(id: string) {
        if (!keymaster) {
            return;
        }
        try {
            await keymaster.setCurrentId(id);

            await resetCurrentID();
        } catch (error: any) {
            setError(error);
        }
    }

    const handleOpenMenu = (event: React.MouseEvent<HTMLElement>) => {
        setAnchorEl(event.currentTarget);
    };

    const handleCloseMenu = () => {
        setAnchorEl(null);
    };

    async function handleSelectID(id: string) {
        handleCloseMenu();
        await selectId(id);
    }

    const combinedList = [
        ...idList.map(id => ({ id, unresolved: false })),
        ...unresolvedIdList
            .filter(id => !idList.includes(id))
            .map(id => ({ id, unresolved: true })),
    ].sort((a, b) => a.id.localeCompare(b.id));

    const multipleIds = combinedList && combinedList.length > 1;

    return (
        currentId && (
            <Box display="flex" alignItems="center" gap={0}>
                {multipleIds ? (
                    <>
                        <Button
                            className="drop-down-id-button"
                            onClick={handleOpenMenu}
                            endIcon={<ArrowDropDown />}
                            sx={{
                                textTransform: "none",
                                fontSize: "1.25rem",
                                fontWeight: 600,
                                lineHeight: 1.2,
                                px: 1.5,
                                py: 0.75,
                            }}
                            size="medium"
                            variant="outlined"
                        >
                            {truncatedId}
                        </Button>

                        <Menu
                            anchorEl={anchorEl}
                            open={Boolean(anchorEl)}
                            onClose={handleCloseMenu}
                            anchorOrigin={{
                                vertical: "bottom",
                                horizontal: "right",
                            }}
                            transformOrigin={{
                                vertical: "top",
                                horizontal: "right",
                            }}
                        >
                            {combinedList.map(({ id, unresolved }) => (
                                <MenuItem
                                    key={id}
                                    onClick={() => handleSelectID(id)}
                                    sx={unresolved ? { color: 'red' } : {}}
                                >
                                    {id}
                                </MenuItem>
                            ))}
                        </Menu>
                    </>
                ) : (
                    <Box className="drop-down-id-box" sx={{ fontSize: "1.25rem", fontWeight: 600, lineHeight: 1.2 }}>
                        {truncatedId}
                    </Box>
                )}
                <CopyDID did={currentDID} />
                {avatarPreviewUrl && (
                    <Box
                        component="img"
                        src={avatarPreviewUrl}
                        alt={`${currentId} avatar`}
                        sx={{
                            width: 32,
                            height: 32,
                            objectFit: "cover",
                            borderRadius: "50%",
                            border: "1px solid",
                            borderColor: "divider",
                            ml: 1,
                        }}
                    />
                )}
            </Box>
        )
    );
};

export default DropDownID;
