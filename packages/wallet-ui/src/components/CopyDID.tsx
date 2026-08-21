import {
    Box,
    IconButton,
    Tooltip
} from "@mui/material";
import {
    ContentCopy,
} from "@mui/icons-material";
import { useWalletData } from "../hooks/useWalletData";

const CopyDID = ({ did } : { did: string}) => {
    // handleCopyDID comes from the shared data hook rather than a UIContext:
    // the two wallets keep their own UIContexts, but both re-export this same
    // function from here, so the component needs neither of them.
    const { handleCopyDID } = useWalletData();

    return (
        <Box>
            <Tooltip title="Copy">
                <span>
                    <IconButton size="small"
                        onClick={() => handleCopyDID(did)}
                        disabled={!did}
                    >
                        <ContentCopy fontSize="small" />
                    </IconButton>
                </span>
            </Tooltip>

        </Box>
    );
}

export default CopyDID;
