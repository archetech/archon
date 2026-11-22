import { useWalletContext } from "../contexts/WalletProvider";
import { useVariablesContext } from "../contexts/VariablesProvider";
import { useSnackbar } from "../contexts/SnackbarProvider";
import GrantsView from "./GrantsView";

// `request` is a grant request that arrived by a link or a scan, to be shown
// for review.
export default function GrantsTab({ request, onRequestTaken }: { request?: string; onRequestTaken?: () => void } = {}) {
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
            request={request}
            onRequestTaken={onRequestTaken}
            notify={{ error: setError, success: setSuccess }}
        />
    );
}
