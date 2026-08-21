import {
    Box,
    IconButton,
    Tooltip
} from "@mui/material";
import {
    ManageSearch
} from "@mui/icons-material";
import { useWalletNavigation } from "../contexts/WalletNavigation";
import CopyDID from "./CopyDID";

const CopyResolveDID = ({ did } : { did: string}) => {
    const { openView } = useWalletNavigation();

    return (
        <Box display="flex" flexDirection="row">
            <CopyDID did={did} />

            <Tooltip title="Resolve">
                <span>
                    <IconButton size="small"
                        onClick={() => openView({ did, tab: "viewer" })}
                        disabled={!did}
                    >
                        <ManageSearch fontSize="small" />
                    </IconButton>
                </span>
            </Tooltip>
        </Box>
    );
}

export default CopyResolveDID;
