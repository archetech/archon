import {
    AttachFile,
    Email,
    Image,
    Login,
    PictureAsPdf,
    Token,
} from '@mui/icons-material';
import { useWalletContext } from "../contexts/WalletProvider";
import { useVariablesContext } from "../contexts/VariablesProvider";
import { useSnackbar } from "../contexts/SnackbarProvider";
import { useWalletNavigation } from "../contexts/WalletNavigation";
import { usePlatformCapabilities } from "../contexts/PlatformCapabilities";

// The half of each wallet's UIContext that is about wallet *data* rather than
// about the UI it drives: reading identities, aliases, credentials and vaults
// out of the keymaster and into the shared variables context.
//
// The UIContexts themselves are not shared and probably should not be. They
// model two different UIs -- the extension coordinates a popup with a full-page
// view (RefreshMode, openBrowserWindow, chrome.tabs) and carries an auth
// context; react-wallet has a single window and its own deep-link pendings.
// Merging those would produce a provider mostly made of questions about which
// host it is running in. This layer underneath them was identical either way:
// ten of these thirteen functions were byte-identical between the two copies,
// including the 105-line refreshAliases.
//
// refreshAll and resetCurrentID deliberately stay app-local. Both reach into
// the host -- restoring stored state, clearing it, poking the browser view --
// and both are short enough to compose from what this returns.
export function useWalletData() {
    const { keymaster } = useWalletContext();
    const { setError } = useSnackbar();
    const { resetView } = useWalletNavigation();
    const { restoreSession } = usePlatformCapabilities();
    const {
        currentId,
        setCurrentId,
        setValidId,
        setCurrentDID,
        setManifest,
        setIdList,
        setUnresolvedIdList,
        setUnresolvedList,
        setHeldList,
        setAgentList,
        setAliasList,
        setAliasRegistry,
        setGroupList,
        setImageList,
        setFileList,
        setSchemaList,
        setVaultList,
        setPollList,
        setIssuedList,
        setIssuedString,
        setIssuedStringOriginal,
        setIssuedEdit,
        setSelectedIssued,
        setCredentialDID,
        credentialSubject,
        setCredentialSubject,
        credentialSchema,
        setCredentialSchema,
        setCredentialString,
        resetCredentialState,
        storeState,
        setRegistries,
        setDmailList,
    } = useVariablesContext();

    async function getValidIds() {
        const valid: string[] = [];
        const invalid: string[] = [];

        if (!keymaster) {
            return { valid, invalid };
        }

        const allIds = await keymaster.listIds();
        for (const alias of allIds) {
            try {
                await keymaster.resolveDID(alias);
                valid.push(alias);
            } catch {
                invalid.push(alias);
            }
        }

        return { valid, invalid };
    }

    async function refreshAliases(cid?: string) {
        if (!keymaster) {
            return;
        }

        let aliasList: Record<string, string> = {};
        let unresolvedList: Record<string, string> = {};
        const registryMap: Record<string, string> = {};

        const allNames = await keymaster.listAliases();
        const allNamesSorted = Object.fromEntries(
            Object.entries(allNames).sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
        );

        const { valid: agentList, invalid } = await getValidIds();

        setIdList([...agentList]);
        setUnresolvedIdList(invalid);
        setValidId(agentList.includes(cid ?? currentId));

        const schemaList = [];
        const imageList = [];
        const groupList = [];
        const vaultList = [];
        const pollList = [];
        const fileList = [];

        for (const [name, did] of Object.entries(allNamesSorted)) {
            try {
                const doc = await keymaster.resolveDID(name);
                aliasList[name] = did;

                const reg = doc.didDocumentRegistration?.registry;
                if (reg) {
                    registryMap[name] = reg;
                }

                const data = doc.didDocumentData as Record<string, unknown>;

                if (doc.didDocumentRegistration?.type === 'agent') {
                    agentList.push(name);
                    continue;
                }

                if (data.group) {
                    groupList.push(name);
                    continue;
                }

                if (data.schema) {
                    schemaList.push(name);
                    continue;
                }

                if (data.image) {
                    imageList.push(name);
                    continue;
                }

                if (data.file) {
                    fileList.push(name);
                    continue;
                }

                if (data.vault) {
                    const isPoll = await keymaster.testPoll(name);
                    if (isPoll) {
                        pollList.push(name);
                    } else {
                        vaultList.push(name);
                    }
                    continue;
                }
            }
            catch {
                unresolvedList[name] = did;
            }
        }

        setAliasList(aliasList);
        setUnresolvedList(unresolvedList);
        setAliasRegistry(registryMap);

        const uniqueSortedAgents = [...new Set(agentList)]
            .sort((a, b) => a.localeCompare(b));
        setAgentList(uniqueSortedAgents);

        if (!agentList.includes(credentialSubject)) {
            setCredentialSubject("");
            setCredentialString("");
        }

        setGroupList(groupList);
        setSchemaList(schemaList);

        if (!schemaList.includes(credentialSchema)) {
            setCredentialSchema("");
            setCredentialString("");
        }

        setImageList(imageList);
        setFileList(fileList);
        setVaultList(vaultList);
        setPollList(pollList);
    }

    async function refreshCurrentDID(cid: string) {
        if (!keymaster) {
            return;
        }
        try {
            const docs = await keymaster.resolveDID(cid);
            if (!docs.didDocument || !docs.didDocument.id) {
                setError("Failed to set current DID and manifest");
                return;
            }
            setCurrentDID(docs.didDocument.id);

            const docData = docs.didDocumentData as { manifest?: Record<string, unknown> };
            setManifest(docData.manifest);
        } catch (error: any) {
            setError(error);
        }
    }

    async function refreshCurrentID() {
        if (!keymaster) {
            return;
        }
        try {
            const cid = await keymaster.getCurrentId();
            if (cid) {
                await refreshCurrentIDInternal(cid);
            } else {
                wipeUserState();
            }

            wipeState()
        } catch (error: any) {
            setError(error);
            return false;
        }

        return true;
    }

    async function refreshCurrentIDInternal(cid: string) {
        if (!keymaster) {
            return;
        }
        await setCurrentId(cid);
        await refreshHeld();
        await refreshCurrentDID(cid);
        await refreshAliases(cid);
        await refreshIssued();
    }

    async function refreshHeld() {
        if (!keymaster) {
            return;
        }
        try {
            const heldList = await keymaster.listCredentials();
            setHeldList(heldList);
        } catch (error: any) {
            setError(error);
        }
    }

    async function refreshIssued() {
        if (!keymaster) {
            return;
        }
        try {
            const issuedList = await keymaster.listIssued();
            setIssuedList(issuedList);
            setIssuedString("");
        } catch (error: any) {
            setError(error);
        }
    }

    async function updateManifest() {
        if (!keymaster) {
            return;
        }

        try {
            const id = await keymaster.fetchIdInfo();
            const docs = await keymaster.resolveDID(id.did);
            setManifest((docs.didDocumentData as { manifest?: Record<string, unknown> }).manifest);
        } catch (error: any) {
            setError(error);
        }
    }

    function arraysEqual(a: string[], b: string[]): boolean {
        return a.length === b.length && a.every((v, i) => v === b[i]);
    }

    function getVaultItemIcon(name: string, item: any) {
        const iconStyle = { verticalAlign: 'middle', marginRight: 4 };

        if (!item || !item.type) {
            return <AttachFile style={iconStyle} />;
        }

        if (item.type.startsWith('image/')) {
            return <Image style={iconStyle} />;
        }

        if (item.type === 'application/pdf') {
            return <PictureAsPdf style={iconStyle} />;
        }

        if (item.type === 'application/json') {
            if (name.startsWith('login:')) {
                return <Login style={iconStyle} />;
            }

            if (name === 'dmail') {
                return <Email style={iconStyle} />;
            }

            return <Token style={iconStyle} />;
        }

        // Add more types as needed, e.g. images, PDF, etc.
        return <AttachFile style={iconStyle} />;
    }

    function handleCopyDID(did: string) {
        navigator.clipboard.writeText(did).catch((err) => {
            setError(err.message || String(err));
        });
    }

    function wipeState() {
        setCredentialDID("");
        setCredentialString("");
        setCredentialSubject("");
        setCredentialSchema("");
        setIssuedString("");
        setSelectedIssued("");
        setIssuedStringOriginal("");
        setIssuedEdit(false);
    }

    function wipeUserState() {
        // resetCredentialState, not the individual setters: it also clears
        // heldDID and puts registry back to its default, which is what the
        // extension's copy of this function did and what a wipe should mean --
        // carrying the previous identity's registry into a wiped state is a bug
        // either way. It also uses the raw state setters, so wiping does not
        // fire a burst of concurrent writes at a store whose handler is
        // read-modify-write.
        resetCredentialState();
        setCurrentDID("");
        setManifest({});
        setAliasList({});
        setSchemaList([]);
        setAgentList([]);
        setHeldList([]);
        setIssuedList([]);
        setIssuedString("");
        setVaultList([]);
        setPollList([]);
    }
    async function refreshAll() {
        if (!keymaster) {
            return;
        }

        try {
            const regs = await keymaster.listRegistries();
            setRegistries(regs);
        } catch (error: any) {
            setError(error);
        }

        try {
            // A host that kept the user's last view restores it instead; only fall
            // back to reading the current id when it had nothing, or has no such
            // notion at all.
            const restored = restoreSession ? await restoreSession() : false;
            if (!restored) {
                await refreshCurrentID();
            }
        } catch (error: any) {
            setError(error);
        }
    }

    async function refreshInbox() {
        if (!keymaster) {
            return;
        }
        try {
            const msgs = await keymaster.listDmail();
            setDmailList(prev =>
                JSON.stringify(prev) === JSON.stringify(msgs) ? prev : msgs
            );
        } catch (err: any) {
            setError(err);
        }
    }

    // Was app-local while the hosts differed on how to clear the view and the
    // stored id. Both are capabilities now: storeState is inert without a store,
    // and resetView does nothing in a host with no second view.
    async function resetCurrentID() {
        await storeState("currentId", "");
        resetView?.();
        await refreshCurrentID();
    }

    return {
        getValidIds,
        resetCurrentID,
        refreshAll,
        refreshInbox,
        refreshAliases,
        refreshCurrentDID,
        refreshCurrentID,
        refreshCurrentIDInternal,
        refreshHeld,
        refreshIssued,
        updateManifest,
        arraysEqual,
        getVaultItemIcon,
        handleCopyDID,
        wipeState,
        wipeUserState,
    };
}
