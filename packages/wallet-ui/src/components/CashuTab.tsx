import { useWalletContext } from "../contexts/WalletProvider";
import { useVariablesContext } from "../contexts/VariablesProvider";
import { useSnackbar } from "../contexts/SnackbarProvider";
import CashuView from "./CashuView";

export default function CashuTab() {
    const { keymaster, hasCashu, hasDidComm } = useWalletContext();
    const { currentId, agentList } = useVariablesContext();
    const { setError, setSuccess, setWarning } = useSnackbar();

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
            notify={{ error: setError, success: setSuccess, warning: setWarning }}
        />
    );
}
