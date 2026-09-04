import { createContext, Dispatch, ReactNode, SetStateAction, useContext, useState } from "react";
import { useIsMounted } from "../hooks/useIsMounted";
import { DmailItem } from "@didcid/keymaster/types";

interface VariablesContextValue {
    currentId: string;
    setCurrentId: (value: string) => Promise<void>;
    validId: boolean;
    setValidId: Dispatch<SetStateAction<boolean>>;
    currentDID: string;
    setCurrentDID: Dispatch<SetStateAction<string>>;
    registry: string;
    setRegistry: (value: string) => Promise<void>;
    registries: string[];
    setRegistries: Dispatch<SetStateAction<string[]>>;
    idList: string[];
    setIdList: Dispatch<SetStateAction<string[]>>;
    unresolvedIdList: string[];
    setUnresolvedIdList: Dispatch<SetStateAction<string[]>>;
    manifest: Record<string, unknown> | undefined;
    setManifest: Dispatch<SetStateAction<Record<string, unknown> | undefined>>;
    heldDID: string;
    setHeldDID: (value: string) => Promise<void>;
    heldList: string[];
    setHeldList: Dispatch<SetStateAction<string[]>>;
    credentialDID: string;
    setCredentialDID: Dispatch<SetStateAction<string>>;
    credentialSubject: string;
    setCredentialSubject: Dispatch<SetStateAction<string>>;
    credentialSchema: string;
    setCredentialSchema: Dispatch<SetStateAction<string>>;
    credentialString: string;
    setCredentialString: Dispatch<SetStateAction<string>>;
    schemaList: string[];
    setSchemaList: Dispatch<SetStateAction<string[]>>;
    vaultList: string[];
    setVaultList: Dispatch<SetStateAction<string[]>>;
    groupList: string[];
    setGroupList: Dispatch<SetStateAction<string[]>>;
    imageList: string[];
    setImageList: Dispatch<SetStateAction<string[]>>;
    fileList: string[];
    setFileList: Dispatch<SetStateAction<string[]>>;
    issuedList: string[];
    setIssuedList: Dispatch<SetStateAction<string[]>>;
    issuedString: string;
    setIssuedString: Dispatch<SetStateAction<string>>;
    issuedStringOriginal: string;
    setIssuedStringOriginal: Dispatch<SetStateAction<string>>;
    issuedEdit: boolean;
    setIssuedEdit: Dispatch<SetStateAction<boolean>>;
    selectedIssued: string;
    setSelectedIssued: Dispatch<SetStateAction<string>>;
    dmailList: Record<string, DmailItem>;
    setDmailList: Dispatch<SetStateAction<Record<string, DmailItem>>>;
    alias: string;
    setAlias: (value: string) => Promise<void>;
    aliasDID: string;
    setAliasDID: (value: string) => Promise<void>;
    aliasList: Record<string, string>;
    setAliasList: Dispatch<SetStateAction<Record<string, string>>>;
    aliasRegistry: Record<string, string>;
    setAliasRegistry: Dispatch<SetStateAction<Record<string, string>>>;
    unresolvedList: Record<string, string>;
    setUnresolvedList: Dispatch<SetStateAction<Record<string, string>>>;
    agentList: string[];
    setAgentList: Dispatch<SetStateAction<string[]>>;
    pollList: string[];
    setPollList: Dispatch<SetStateAction<string[]>>;
    resetCredentialState: () => void;
    refreshCredentialsStored: (state: Record<string, any>) => Promise<void>;
    refreshRegistryStored: (state: Record<string, any>) => Promise<void>;
    storeState: (key: string, value: string | boolean) => Promise<void>;
}

const VariablesContext = createContext<VariablesContextValue | null>(null);

// Persisting this state is a platform capability, not a feature of the state
// itself. The extension's popup is destroyed every time it closes, so it writes
// through to chrome storage and reads back on open; react-wallet keeps a live
// page and persists nothing. Supplying `store` opts in -- omit it and every
// setter below is a plain state update.
export type VariablesStore = (key: string, value: string | boolean) => Promise<void>;

export function VariablesProvider(
    { children, store }: { children: ReactNode; store?: VariablesStore }
) {
    const isMounted = useIsMounted();
    const [currentId, setCurrentIdState] = useState<string>("");
    const [validId, setValidId] = useState<boolean>(false);
    const [currentDID, setCurrentDID] = useState<string>("");
    const [idList, setIdList] = useState<string[]>([]);
    const [unresolvedIdList, setUnresolvedIdList] = useState<string[]>([]);
    const [manifest, setManifest] = useState<Record<string, unknown> | undefined>(undefined);
    const [registry, setRegistryState] = useState<string>("hyperswarm");
    const [registries, setRegistries] = useState<string[]>([]);
    const [heldList, setHeldList] = useState<string[]>([]);
    const [heldDID, setHeldDIDState] = useState<string>("");
    const [aliasList, setAliasList] = useState<Record<string, string>>({});
    const [aliasRegistry, setAliasRegistry] = useState<Record<string, string>>({});
    const [unresolvedList, setUnresolvedList] = useState<Record<string, string>>({});
    const [agentList, setAgentList] = useState<string[]>([]);
    const [pollList, setPollList] = useState<string[]>([]);
    const [groupList, setGroupList] = useState<string[]>([]);
    const [imageList, setImageList] = useState<string[]>([]);
    const [fileList, setFileList] = useState<string[]>([]);
    const [schemaList, setSchemaList] = useState<string[]>([]);
    const [vaultList, setVaultList] = useState<string[]>([]);
    const [issuedList, setIssuedList] = useState<string[]>([]);
    const [issuedString, setIssuedString] = useState<string>("");
    const [issuedEdit, setIssuedEdit] = useState<boolean>(false);
    const [issuedStringOriginal, setIssuedStringOriginal] = useState<string>("");
    const [selectedIssued, setSelectedIssued] = useState<string>("");
    const [credentialDID, setCredentialDID] = useState<string>("");
    const [credentialSubject, setCredentialSubject] = useState<string>("");
    const [credentialSchema, setCredentialSchema] = useState<string>("");
    const [credentialString, setCredentialString] = useState<string>("");
    const [alias, setAliasState] = useState<string>("");
    const [aliasDID, setAliasDIDState] = useState<string>("");
    const [dmailList, setDmailList] = useState<Record<string, DmailItem>>({});
    async function setHeldDID(value: string) {
        setHeldDIDState(value);
        await storeState("heldDID", value);
    }

    async function setAlias(value: string) {
        setAliasState(value);
        await storeState("aliasName", value);
    }

    async function setAliasDID(value: string) {
        setAliasDIDState(value);
        await storeState("aliasDID", value);
    }

    async function setCurrentId(value: string) {
        setCurrentIdState(value);
        await storeState("currentId", value);
    }

    async function setRegistry(value: string) {
        setRegistryState(value);
        await storeState("registry", value);
    }

    function resetCredentialState() {
        setAliasState("");
        setAliasDIDState("");
        setHeldDIDState("");
        setCurrentIdState("");
        setRegistryState("hyperswarm");
    }

    async function refreshCredentialsStored(state: Record<string, any>) {
        if (state.heldDID) {
            setHeldDIDState(state.heldDID);
        }

        if (state.aliasName) {
            setAliasState(state.aliasName);
        }

        if (state.aliasDID) {
            setAliasDIDState(state.aliasDID);
        }
    }

    async function refreshRegistryStored(state: Record<string, any>) {
        if (state.registry) {
            setRegistryState(state.registry);
        }
    }

    async function storeState(key: string, value: string | boolean) {
        await store?.(key, value);
    }

    // Every set* here is called from refresh work that awaits the network, so any
    // of them can fire after the component has gone. Guarding at this boundary
    // covers all thirty-odd rather than each useState in turn.
    function whileMounted<T extends (...args: never[]) => unknown>(setter: T): T {
        return ((...args: Parameters<T>) => {
            if (isMounted()) {
                return setter(...args);
            }
        }) as T;
    }

    const value: VariablesContextValue = {
        currentId,
        setCurrentId: whileMounted(setCurrentId),
        validId,
        setValidId: whileMounted(setValidId),
        currentDID,
        setCurrentDID: whileMounted(setCurrentDID),
        registry,
        setRegistry: whileMounted(setRegistry),
        registries,
        setRegistries: whileMounted(setRegistries),
        idList,
        setIdList: whileMounted(setIdList),
        unresolvedIdList,
        setUnresolvedIdList: whileMounted(setUnresolvedIdList),
        manifest,
        setManifest: whileMounted(setManifest),
        heldDID,
        setHeldDID: whileMounted(setHeldDID),
        heldList,
        setHeldList: whileMounted(setHeldList),
        groupList,
        setGroupList: whileMounted(setGroupList),
        imageList,
        setImageList: whileMounted(setImageList),
        fileList,
        setFileList: whileMounted(setFileList),
        schemaList,
        setSchemaList: whileMounted(setSchemaList),
        vaultList,
        setVaultList: whileMounted(setVaultList),
        issuedList,
        setIssuedList: whileMounted(setIssuedList),
        issuedString,
        setIssuedString: whileMounted(setIssuedString),
        issuedStringOriginal,
        setIssuedStringOriginal: whileMounted(setIssuedStringOriginal),
        issuedEdit,
        setIssuedEdit: whileMounted(setIssuedEdit),
        selectedIssued,
        setSelectedIssued: whileMounted(setSelectedIssued),
        credentialDID,
        setCredentialDID: whileMounted(setCredentialDID),
        credentialSubject,
        setCredentialSubject: whileMounted(setCredentialSubject),
        credentialSchema,
        setCredentialSchema: whileMounted(setCredentialSchema),
        credentialString,
        setCredentialString: whileMounted(setCredentialString),
        alias,
        setAlias: whileMounted(setAlias),
        aliasDID,
        setAliasDID: whileMounted(setAliasDID),
        aliasList,
        setAliasList: whileMounted(setAliasList),
        aliasRegistry,
        setAliasRegistry: whileMounted(setAliasRegistry),
        unresolvedList,
        setUnresolvedList: whileMounted(setUnresolvedList),
        agentList,
        setAgentList: whileMounted(setAgentList),
        pollList,
        setPollList: whileMounted(setPollList),
        dmailList,
        setDmailList: whileMounted(setDmailList),
        storeState,
        resetCredentialState,
        refreshCredentialsStored,
        refreshRegistryStored,
    }

    return (
        <VariablesContext.Provider value={value}>
            {children}
        </VariablesContext.Provider>
    );
}

export function useVariablesContext() {
    const ctx = useContext(VariablesContext);
    if (!ctx) {
        throw new Error('useVariablesContext must be used within VariablesProvider');
    }
    return ctx;
}
