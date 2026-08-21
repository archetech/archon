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
import { useSnackbar } from "@didcid/wallet-ui";
import { useAuthContext } from "./AuthContext";
import { useVariablesContext } from "@didcid/wallet-ui";
import { useWalletData } from "@didcid/wallet-ui";
import { useThemeContext } from "./ContextProviders";
import WalletChrome from "@didcid/keymaster/wallet/chrome";

const REFRESH_INTERVAL_STORAGE_KEY = 'ARCHON_REFRESH_INTERVAL_SECONDS';
const DEFAULT_REFRESH_INTERVAL_SECONDS = 30;

export enum RefreshMode {
    NONE = 'NONE',
    WALLET = 'WALLET',
    THEME = 'THEME',
}

interface UIContextValue {
    selectedTab: string;
    setSelectedTab: (value: string) => Promise<void>;
    selectedMessageTab: string;
    setSelectedMessageTab: (value: string) => Promise<void>;
    openBrowser: openBrowserValues | undefined;
    setOpenBrowser: Dispatch<SetStateAction<openBrowserValues | undefined>> | undefined;
    openBrowserWindow: (options: openBrowserValues) => void;
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
    title?: string;
    did?: string;
    tab?: string;
    subTab?: string;
    contents?: any;
    clearState?: boolean;
}

const UIContext = createContext<UIContextValue | null>(null);

async function loadRefreshIntervalSeconds() {
    const result = await chrome.storage.sync.get([REFRESH_INTERVAL_STORAGE_KEY]);
    const saved = result[REFRESH_INTERVAL_STORAGE_KEY];
    const parsed = Number(saved);

    if (saved === undefined || !Number.isFinite(parsed) || parsed < 0) {
        return DEFAULT_REFRESH_INTERVAL_SECONDS;
    }

    return Math.floor(parsed);
}

export function UIProvider(
    {
        children,
        pendingAuth,
        pendingCredential,
        pendingAlias,
        openBrowser,
        setOpenBrowser,
        browserRefresh,
        setBrowserRefresh,
    }: {
        children: ReactNode,
        pendingAuth?: string,
        pendingCredential?: string,
        pendingAlias?: { alias: string; did: string },
        openBrowser?: openBrowserValues,
        setOpenBrowser?: Dispatch<SetStateAction<openBrowserValues | undefined>>,
        browserRefresh?: RefreshMode,
        setBrowserRefresh?: Dispatch<SetStateAction<RefreshMode>>,
    }) {
    const [pendingTab, setPendingTab] = useState<string | null>(null);
    const [pendingMessageTab, setPendingMessageTab] = useState<string | null>(null);
    const [selectedTab, setSelectedTabState] = useState<string>("identities");
    const [selectedMessageTab, setSelectedMessageTabState] = useState<string>("receive");
    const [pendingUsed, setPendingUsed] = useState<boolean>(false);

    const {
        isBrowser,
        keymaster,
        refreshFlag,
        reloadBrowserWallet,
    } = useWalletContext();
    const { setError } = useSnackbar();
    const {
        setResponse,
        setCallback,
        setChallenge,
        setDisableSendResponse,
        setPendingAutoResponse,
        refreshAuthStored,
    } = useAuthContext();
    const {
        currentId,
        storeState,
        setRegistries,
        refreshRegistryStored,
        setHeldDID,
        setAliasList,
        setPollList,
        refreshCredentialsStored,
        setDmailList,
        setAlias,
        setAliasDID,
    } = useVariablesContext();

    // The wallet-data layer, shared with the other wallet: these were identical
    // (or near enough) in both UIContexts. What stays here is the UI model.
    const {
        refreshAliases,
        refreshCurrentID,
        refreshCurrentIDInternal,
        refreshHeld,
        updateManifest,
        arraysEqual,
        getVaultItemIcon,
        handleCopyDID,
    } = useWalletData();

    const { updateThemeFromStorage } = useThemeContext();

    const walletChrome = new WalletChrome();
    const [refreshIntervalSeconds, setRefreshIntervalSeconds] = useState<number>(DEFAULT_REFRESH_INTERVAL_SECONDS);


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

        const walletAliases = await keymaster.listAliases();
        const names = Object.keys(walletAliases);
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

            setAliasList(prevAliases => {
                const extraAliases: Record<string, string> = {};
                for (const name of polls) {
                    if (!(name in prevAliases)) {
                        extraAliases[name] = walletAliases[name];
                    }
                }
                return Object.keys(extraAliases).length ? { ...prevAliases, ...extraAliases } : prevAliases;
            });

            return polls;
        });

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [keymaster]);

    useEffect(() => {
        const initRefreshInterval = async () => {
            setRefreshIntervalSeconds(await loadRefreshIntervalSeconds());
        };

        initRefreshInterval();

        const handleStorageChange = (
            changes: { [key: string]: chrome.storage.StorageChange },
            areaName: string
        ) => {
            if (areaName !== 'sync' || !changes[REFRESH_INTERVAL_STORAGE_KEY]) {
                return;
            }

            const newValue = changes[REFRESH_INTERVAL_STORAGE_KEY].newValue;
            const parsed = Number(newValue);
            if (newValue === undefined || !Number.isFinite(parsed) || parsed < 0) {
                setRefreshIntervalSeconds(DEFAULT_REFRESH_INTERVAL_SECONDS);
                return;
            }
            setRefreshIntervalSeconds(Math.floor(parsed));
        };

        chrome.storage.onChanged.addListener(handleStorageChange);
        return () => chrome.storage.onChanged.removeListener(handleStorageChange);
    }, []);

    useEffect(() => {
        if (!keymaster) {
            return;
        }

        const refresh = async () => {
            const data = await walletChrome.loadWallet();
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
        if (!setBrowserRefresh || browserRefresh === RefreshMode.NONE) {
            return;
        }

        const refresh = async () => {
            if (browserRefresh === RefreshMode.WALLET) {
                await reloadBrowserWallet();
            } else if (browserRefresh === RefreshMode.THEME) {
                updateThemeFromStorage();
            }
            setBrowserRefresh(RefreshMode.NONE);
        };
        refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [browserRefresh]);

    useEffect(() => {
        if (!currentId) {
            return;
        }
        if (pendingAuth && !pendingUsed) {
            (async () => {
                await setSelectedTab("auth");
                await setChallenge(pendingAuth);
                await setResponse("");
                await setCallback("");
                await setDisableSendResponse(true);
                setPendingAutoResponse(true);
            })();

            // Prevent challenge repopulating after clear on ID change
            setPendingUsed(true);
        } else if (pendingCredential && !pendingUsed) {
            (async () => {
                await setSelectedTab("credentials");
                await setHeldDID(pendingCredential);
            })();

            // Prevent credential repopulating after clear on ID change
            setPendingUsed(true);
        } else if (pendingAlias && !pendingUsed) {
            (async () => {
                await setAlias(pendingAlias.alias);
                await setAliasDID(pendingAlias.did);
                openBrowserWindow({ tab: "aliases" });
            })();
            setPendingUsed(true);
        } else if (pendingTab) {
            (async () => {
                await setSelectedTab(pendingTab);
                setPendingTab(null);
            })();
        }
        if (pendingMessageTab) {
            (async () => {
                await setSelectedMessageTab(pendingMessageTab);
                setPendingMessageTab(null);
            })();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentId, pendingAuth, pendingCredential, pendingAlias, pendingTab, pendingMessageTab]);

    function openBrowserWindow(options: openBrowserValues) {
        const tab = options.tab ?? "viewer";

        const payload = {
            ...options,
            tab
        };

        if (isBrowser && setOpenBrowser) {
            setOpenBrowser(payload);
            return;
        }

        chrome.runtime.sendMessage({ type: "OPEN_BROWSER_WINDOW", options });
    }

    async function setSelectedTab(value: string) {
        setSelectedTabState(value);
        await storeState("selectedTab", value);
    }

    async function setSelectedMessageTab(value: string) {
        setSelectedMessageTabState(value);
        await storeState("selectedMessageTab", value);
    }




    async function resetCurrentID() {
        await chrome.runtime.sendMessage({
            action: "CLEAR_STATE",
            key: "currentId",
        });
        if (setOpenBrowser) {
            setOpenBrowser({
                clearState: true
            });
        }
        await refreshCurrentID();
    }






    async function refreshStored() {
        if (isBrowser || !keymaster) {
            return;
        }

        const { extensionState } = await chrome.runtime.sendMessage({
            action: "GET_ALL_STATE",
        });

        // Tab always present if store used
        if (!extensionState.selectedTab) {
            return false;
        }

        if (extensionState.currentId) {
            // If ID not in wallet assume new wallet created externally
            const wallet = await keymaster.loadWallet();
            if (!Object.keys(wallet.ids).includes(extensionState.currentId)) {
                await chrome.runtime.sendMessage({ action: "CLEAR_ALL_STATE" });
                return false;
            }
            await refreshCurrentIDInternal(extensionState.currentId);
        } else {
            // We switched user in the browser so no currentId stored
            const cid = await keymaster.getCurrentId();
            if (cid) {
                await refreshCurrentIDInternal(cid);
            }
        }

        return true;
    }

    useEffect(() => {
        (async () => {
            try {
                const { extensionState } = await chrome.runtime.sendMessage({
                    action: "GET_ALL_STATE",
                });

                if (extensionState?.selectedTab) {
                    setPendingTab(extensionState.selectedTab);
                }
                if (extensionState?.selectedMessageTab) {
                    setPendingMessageTab(extensionState.selectedMessageTab);
                }

                await refreshAuthStored(extensionState);
                await refreshRegistryStored(extensionState);
                await refreshCredentialsStored(extensionState);
            } catch { }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

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
            const usedStored = await refreshStored();
            if (!usedStored) {
                await refreshCurrentID();
            }
        } catch (error: any) {
            setError(error);
        }
    }




    const value: UIContextValue = {
        selectedTab,
        setSelectedTab,
        selectedMessageTab,
        setSelectedMessageTab,
        openBrowserWindow,
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
