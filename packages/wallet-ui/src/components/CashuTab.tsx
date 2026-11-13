import { useWalletContext } from "../contexts/WalletProvider";
import { useVariablesContext } from "../contexts/VariablesProvider";
import { useSnackbar } from "../contexts/SnackbarProvider";
import { usePlatformCapabilities } from "../contexts/PlatformCapabilities";
import CashuView from "./CashuView";

export default function CashuTab() {
    const { keymaster, hasCashu, hasDidComm } = useWalletContext();
    const { currentId, agentList } = useVariablesContext();
    const { setError, setSuccess, setWarning } = useSnackbar();
    const { scanQrFrames } = usePlatformCapabilities();

    if (!keymaster || !currentId) {
        return null;
    }
    return (
        <CashuView
            key={currentId}
            keymaster={keymaster}
            identity={currentId}
            hasNodeMint={hasCashu}
            hasDidComm={hasDidComm}
            recipients={agentList ?? []}
            scanQrFrames={scanQrFrames}
            notify={{ error: setError, success: setSuccess, warning: setWarning }}
        />
    );
}
