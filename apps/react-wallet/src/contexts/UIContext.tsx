import React, {
    createContext,
    Dispatch,
    ReactNode,
    SetStateAction,
    useCallback,
    useContext,
    useEffect,
    useState
} from "react";
import { useWalletContext } from "@didcid/wallet-ui";
import { useVariablesContext } from "@didcid/wallet-ui";
import { useWalletData } from "@didcid/wallet-ui";
import { useSnackbar } from "@didcid/wallet-ui";
import WalletWeb from "@didcid/keymaster/wallet/web";

const REFRESH_INTERVAL_STORAGE_KEY = 'ARCHON_REFRESH_INTERVAL_SECONDS';
const DEFAULT_REFRESH_INTERVAL_SECONDS = 30;

// Exported so a screen that polls only while it is open (the DIDComm inbox) can
// honour the same interval the background refresh uses.
export function loadRefreshIntervalSeconds() {
    const saved = localStorage.getItem(REFRESH_INTERVAL_STORAGE_KEY);
    const parsed = Number(saved);

    if (!saved || !Number.isFinite(parsed) || parsed < 0) {
        return DEFAULT_REFRESH_INTERVAL_SECONDS;
    }

    return Math.floor(parsed);
}

interface UIContextValue {
    selectedTab: string;
    setSelectedTab: Dispatch<SetStateAction<string>>;
    pendingChallenge: string | null;
    setPendingChallenge: Dispatch<SetStateAction<string | null>>;
    pendingSubTab: string | null;
    setPendingSubTab: Dispatch<SetStateAction<string | null>>;
    pendingHeldDID: string | null;
    setPendingHeldDID: Dispatch<SetStateAction<string | null>>;
    openBrowser: openBrowserValues | undefined;
    setOpenBrowser: Dispatch<SetStateAction<openBrowserValues | undefined>>;
    handleCopyDID: (did: string) => void;
    getVaultItemIcon: (name: string, item: any) => React.ReactNode;
    updateManifest: () => Promise<void>;
    refreshAll: () => Promise<void>;
    resetCurrentID: () => Promise<void>;
    refreshHeld: () => Promise<void>;
    refreshAliases: () => Promise<void>;
    refreshInbox: () => Promise<void>;
}

export interface openBrowserValues {
    did?: string;
    tab?: string;
    subTab?: string;
    contents?: any;
    clearState?: boolean;
}

const UIContext = createContext<UIContextValue | null>(null);

export function UIProvider(
    {
        children
    }: {
        children: ReactNode
    }) {
    const [pendingTab, setPendingTab] = useState<string | null>(null);
    const [pendingChallenge, setPendingChallenge] = useState<string | null>(null);
    const [pendingSubTab, setPendingSubTab] = useState<string | null>(null);
    const [pendingHeldDID, setPendingHeldDID] = useState<string | null>(null);
    const [selectedTab, setSelectedTab] = useState<string>("identities");
    const [openBrowser, setOpenBrowser] = useState<openBrowserValues | undefined>(undefined);

    const {
        keymaster,
        refreshFlag,
    } = useWalletContext();
    const { setError } = useSnackbar();
    const {
        currentId,
        setRegistries,
        setAliasList,
        setPollList,
        setAlias,
        setDmailList,
        setAliasDID,
    } = useVariablesContext();

    // The wallet-data layer, shared with the other wallet: these were identical
    // (or near enough) in both UIContexts. What stays here is the UI model.
    const {
        refreshAliases,
        refreshCurrentID,
        refreshHeld,
        updateManifest,
        arraysEqual,
        getVaultItemIcon,
        handleCopyDID,
    } = useWalletData();


    const walletWeb = new WalletWeb();
    const [refreshIntervalSeconds, setRefreshIntervalSeconds] = useState(() => loadRefreshIntervalSeconds());

    useEffect(() => {
        const refresh = async () => {
            await refreshAll();
        };
        refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (!refreshFlag) {
            return;
        }
        const refresh = async () => {
            await refreshAll();
        };
        refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [refreshFlag]);


    useEffect(() => {
        const refresh = async () => {
            await refreshAll();
        };
        refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const refreshInbox = useCallback(async () => {
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

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [keymaster]);

    const refreshPoll = useCallback(async () => {
        if (!keymaster) {
            return;
        }

        const walletNames = await keymaster.listAliases();
        const names = Object.keys(walletNames);
        names.sort((a, b) => a.localeCompare(b));
        const polls: string[] = [];

        for (const name of names) {
            try {
                const doc = await keymaster.resolveDID(name);
                const data = doc.didDocumentData as Record<string, unknown>;

                if (data.vault) {
                    const isPoll = await keymaster.testPoll(name);
                    if (isPoll) {
                        polls.push(name);
                    }
                }
            }
            catch { }
        }

        setPollList(prevPolls => {
            if (arraysEqual(prevPolls, polls)) {
                return prevPolls;
            }

            setAliasList(prevNames => {
                const extraNames: Record<string, string> = {};
                for (const name of polls) {
                    if (!(name in prevNames)) {
                        extraNames[name] = walletNames[name];
                    }
                }
                return Object.keys(extraNames).length ? { ...prevNames, ...extraNames } : prevNames;
            });

            return polls;
        });

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [keymaster]);

    useEffect(() => {
        if (!keymaster) {
            return;
        }

        const refresh = async () => {
            const data = await walletWeb.loadWallet();
            if (!data) {
                return;
            }
            try {
                await keymaster.refreshNotices();
                await refreshPoll();
                await refreshInbox();
            } catch { }
        }

        refresh();

        if (refreshIntervalSeconds === 0) {
            return;
        }

        const interval = setInterval(async () => {
            if (!keymaster) {
                return;
            }
            await refresh();
        }, refreshIntervalSeconds * 1000);

        return () => clearInterval(interval);

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [keymaster, refreshIntervalSeconds]);

    useEffect(() => {
        const handleRefreshIntervalChange = () => {
            setRefreshIntervalSeconds(loadRefreshIntervalSeconds());
        };

        window.addEventListener('archon:refresh-interval-change', handleRefreshIntervalChange);
        return () => window.removeEventListener('archon:refresh-interval-change', handleRefreshIntervalChange);
    }, []);


    useEffect(() => {
        const onOpenAuth = (e: Event) => {
            const ce = e as CustomEvent<{ did?: string }>;
            const did = ce.detail?.did;
            setPendingTab('auth');
            if (typeof did === 'string' && did.startsWith('did:')) {
                setPendingChallenge(did);
            }
        };
        window.addEventListener('archon:openAuth', onOpenAuth as EventListener);
        return () => window.removeEventListener('archon:openAuth', onOpenAuth as EventListener);
    }, []);

    useEffect(() => {
        const onOpenAccept = (e: Event) => {
            const ce = e as CustomEvent<{ did?: string }>;
            const did = ce.detail?.did;
            setPendingTab('credentials');
            setPendingSubTab('held');
            if (typeof did === 'string' && did.startsWith('did:')) {
                setPendingHeldDID(did);
            }
        };
        window.addEventListener('archon:openAccept', onOpenAccept as EventListener);
        return () => window.removeEventListener('archon:openAccept', onOpenAccept as EventListener);
    }, []);

    useEffect(() => {
        const onOpenAlias = (e: Event) => {
            const ce = e as CustomEvent<{ did?: string; alias?: string }>;
            const did = ce.detail?.did;
            const alias = ce.detail?.alias;
            setPendingTab('aliases');
            if (typeof alias === 'string') {
                setAlias(alias);
            }
            if (typeof did === 'string' && did.startsWith('did:')) {
                setAliasDID(did);
            }
        };
        window.addEventListener('archon:openAlias', onOpenAlias as EventListener);
        return () => window.removeEventListener('archon:openAlias', onOpenAlias as EventListener);
    }, [setAlias, setAliasDID]);

    useEffect(() => {
        if (!currentId) {
            return;
        }
        if (pendingTab) {
            (async () => {
                await setSelectedTab(pendingTab);
                setPendingTab(null);
            })();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentId, pendingTab]);




    async function resetCurrentID() {
        setOpenBrowser({
            clearState: true
        });
        await refreshCurrentID();
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
            await refreshCurrentID();
        } catch (error: any) {
            setError(error);
        }
    }




    const value: UIContextValue = {
        selectedTab,
        setSelectedTab,
        pendingChallenge,
        setPendingChallenge,
        pendingSubTab,
        setPendingSubTab,
        pendingHeldDID,
        setPendingHeldDID,
        openBrowser,
        setOpenBrowser,
        handleCopyDID,
        getVaultItemIcon,
        updateManifest,
        refreshAll,
        resetCurrentID,
        refreshHeld,
        refreshAliases,
        refreshInbox,
    }

    return (
        <UIContext.Provider value={value}>
            {children}
        </UIContext.Provider>
    );
}

export function useUIContext() {
    const ctx = useContext(UIContext);
    if (!ctx) {
        throw new Error('useUIContext must be used within UIProvider');
    }
    return ctx;
}
