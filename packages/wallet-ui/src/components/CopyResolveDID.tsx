import {
    Box,
    IconButton,
    Tooltip
} from "@mui/material";
import {
    ManageSearch
} from "@mui/icons-material";
import { useViewerNavigation } from "../contexts/ViewerNavigation";
import CopyDID from "./CopyDID";

const CopyResolveDID = ({ did } : { did: string}) => {
    const { openDidViewer } = useViewerNavigation();

    return (
        <Box display="flex" flexDirection="row">
            <CopyDID did={did} />

            <Tooltip title="Resolve">
                <span>
                    <IconButton size="small"
                        onClick={() => openDidViewer(did)}
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
