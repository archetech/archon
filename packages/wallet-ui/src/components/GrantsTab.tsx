import { useWalletContext } from "../contexts/WalletProvider";
import { useVariablesContext } from "../contexts/VariablesProvider";
import { useSnackbar } from "../contexts/SnackbarProvider";
import GrantsView from "./GrantsView";

export default function GrantsTab() {
    const { keymaster } = useWalletContext();
    const { currentId, currentDID, registries } = useVariablesContext();
    const { setError, setSuccess } = useSnackbar();

    if (!keymaster || !currentId) {
        return null;
    }
    return (
        <GrantsView
            key={`${currentId} ${currentDID}`}
            keymaster={keymaster}
            identity={currentId}
            sessionKey={currentDID || currentId}
            registries={registries ?? []}
            notify={{ error: setError, success: setSuccess }}
        />
    );
}
