import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import {
    Accordion,
    AccordionDetails,
    AccordionSummary,
    Alert,
    Autocomplete,
    Box,
    Button,
    Checkbox,
    Chip,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    FormControl,
    FormControlLabel,
    FormLabel,
    Grid,
    IconButton,
    MenuItem,
    Paper,
    Radio,
    RadioGroup,
    Select,
    Snackbar,
    Tab,
    Tabs,
    TableContainer,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableRow,
    TableSortLabel,
    LinearProgress,
    TextField,
    Tooltip,
    Typography,
} from '@mui/material';
import {
    AddCircleOutline,
    AccountBalanceWallet,
    AllInbox,
    Archive,
    Article,
    AttachFile,
    Badge,
    BarChart,
    Block,
    Bolt,
    Clear,
    Create,
    Groups,
    Delete,
    Download,
    Drafts,
    Edit,
    Email,
    ExpandMore,
    Forward,
    HowToVote,
    Image,
    Inbox,
    Key,
    LibraryAdd,
    LibraryAddCheck,
    LibraryBooks,
    List,
    Lock,
    Login,
    MarkEmailRead,
    MarkEmailUnread,
    Outbox,
    PermIdentity,
    PersonAdd,
    PictureAsPdf,
    Poll,
    Refresh,
    Reply,
    ReplyAll,
    RestoreFromTrash,
    Schema,
    Search,
    Token,
    Tune,
    Save,
    Settings,
    Unarchive,
} from "@mui/icons-material";
import axios from 'axios';
import { Buffer } from 'buffer';
import { QRCodeSVG } from 'qrcode.react';
import './App.css';
import PollResultsModal from "./PollResultsModal";
import TextInputModal from "./TextInputModal";
import WarningModal from "./WarningModal";
import packageJson from "../package.json";

// TBD figure out how to import an enum from keymaster package
const DmailTags = {
    DMAIL: 'dmail',
    INBOX: 'inbox',
    DRAFT: 'draft',
    SENT: 'sent',
    ARCHIVED: 'archived',
    DELETED: 'deleted',
    UNREAD: 'unread',
};

const REFRESH_INTERVAL_STORAGE_KEY = 'ARCHON_REFRESH_INTERVAL_SECONDS';
const DEFAULT_REFRESH_INTERVAL_SECONDS = 30;

function loadRefreshIntervalSeconds() {
    const saved = localStorage.getItem(REFRESH_INTERVAL_STORAGE_KEY);
    const parsed = Number(saved);

    if (!saved || !Number.isFinite(parsed) || parsed < 0) {
        return DEFAULT_REFRESH_INTERVAL_SECONDS;
    }

    return Math.floor(parsed);
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function parseAddressDomain(address) {
    if (!address || typeof address !== 'string') {
        return '';
    }

    const trimmed = address.trim().toLowerCase();
    const at = trimmed.lastIndexOf('@');

    if (at < 0) {
        return trimmed;
    }

    return trimmed.slice(at + 1);
}

function parseAddressName(address) {
    if (!address || typeof address !== 'string') {
        return '';
    }

    const trimmed = address.trim().toLowerCase();
    const at = trimmed.lastIndexOf('@');

    if (at < 0) {
        return trimmed;
    }

    return trimmed.slice(0, at);
}

function composeAddress(name, domain) {
    const normalizedName = parseAddressName(name);
    const normalizedDomain = parseAddressDomain(domain);

    if (!normalizedName || !normalizedDomain) {
        return '';
    }

    return `${normalizedName}@${normalizedDomain}`;
}

function formatAddedDate(value) {
    if (typeof value !== 'string') {
        return '';
    }

    return value.slice(0, 10);
}

function KeymasterUI({ keymaster, title, challengeDID, onWalletUpload, hasLightning, serverUrl, onServerUrlChange }) {
    const [tab, setTab] = useState(null);
    const [currentId, setCurrentId] = useState('');
    const [saveId, setSaveId] = useState('');
    const [currentDID, setCurrentDID] = useState('');
    const [identityTab, setIdentityTab] = useState('details');
    const [selectedId, setSelectedId] = useState('');
    const [docsString, setDocsString] = useState(null);
    const [docsVersion, setDocsVersion] = useState(1);
    const [docsVersionMax, setDocsVersionMax] = useState(1);
    const [idList, setIdList] = useState(null);
    const [challenge, setChallenge] = useState(null);
    const [callback, setCallback] = useState(null);
    const [widget, setWidget] = useState(false);
    const [response, setResponse] = useState(null);
    const [accessGranted, setAccessGranted] = useState(false);
    const [newName, setNewName] = useState('');
    const [registry, setRegistry] = useState('');
    const [aliasList, setAliasList] = useState(null);
    const [alias, setAlias] = useState('');
    const [aliasDID, setAliasDID] = useState('');
    const [selectedName, setSelectedName] = useState('');
    const [aliasIsOwned, setAliasIsOwned] = useState(false);
    const [aliasDocs, setAliasDocs] = useState('');
    const [aliasDocsVersion, setAliasDocsVersion] = useState(1);
    const [aliasDocsVersionMax, setAliasDocsVersionMax] = useState(1);
    const [addressList, setAddressList] = useState({});
    const [addressInput, setAddressInput] = useState('');
    const [addressDomain, setAddressDomain] = useState('');
    const [selectedAddress, setSelectedAddress] = useState('');
    const [addressDocs, setAddressDocs] = useState('');
    const [addressBusy, setAddressBusy] = useState(false);
    const [registries, setRegistries] = useState(null);
    const [groupList, setGroupList] = useState(null);
    const [groupName, setGroupName] = useState('');
    const [selectedGroupName, setSelectedGroupName] = useState('');
    const [selectedGroup, setSelectedGroup] = useState('');
    const [selectedGroupOwned, setSelectedGroupOwned] = useState(false);
    const [groupMember, setGroupMember] = useState('');
    const [groupMemberDocs, setGroupMemberDocs] = useState('');
    const [schemaList, setSchemaList] = useState(null);
    const [schemaName, setSchemaName] = useState('');
    const [schemaString, setSchemaString] = useState('');
    const [selectedSchemaOwned, setSelectedSchemaOwned] = useState(false);
    const [selectedSchemaName, setSelectedSchemaName] = useState('');
    const [selectedSchema, setSelectedSchema] = useState('');
    const [schemaPackDID, setSchemaPackDID] = useState('');
    const [agentList, setAgentList] = useState(null);
    const [credentialTab, setCredentialTab] = useState('');
    const [credentialDID, setCredentialDID] = useState('');
    const [credentialSubject, setCredentialSubject] = useState('');
    const [credentialSchema, setCredentialSchema] = useState('');
    const [credentialString, setCredentialString] = useState('');
    const [credentialSent, setCredentialSent] = useState(false);
    const [heldList, setHeldList] = useState(null);
    const [heldDID, setHeldDID] = useState('');
    const [heldString, setHeldString] = useState('');
    const [selectedHeld, setSelectedHeld] = useState('');
    const [issuedList, setIssuedList] = useState(null);
    const [selectedIssued, setSelectedIssued] = useState('');
    const [issuedStringOriginal, setIssuedStringOriginal] = useState('');
    const [issuedString, setIssuedString] = useState('');
    const [issuedEdit, setIssuedEdit] = useState(false);
    const [mnemonicString, setMnemonicString] = useState('');
    const [walletString, setWalletString] = useState('');
    const [manifest, setManifest] = useState(null);
    const [checkingWallet, setCheckingWallet] = useState(false);
    const [disableSendResponse, setDisableSendResponse] = useState(true);
    const [authDID, setAuthDID] = useState('');
    const [authString, setAuthString] = useState('');
    const [dmailTab, setDmailTab] = useState('');
    const [dmailList, setDmailList] = useState([]);
    const [selectedDmailDID, setSelectedDmailDID] = useState('');
    const [selectedDmail, setSelectedDmail] = useState(null);
    const [dmailSubject, setDmailSubject] = useState('');
    const [dmailBody, setDmailBody] = useState('');
    const [dmailTo, setDmailTo] = useState('');
    const [dmailCc, setDmailCc] = useState('');
    const [dmailToList, setDmailToList] = useState([]);
    const [dmailCcList, setDmailCcList] = useState([]);
    const [dmailEphemeral, setDmailEphemeral] = useState(false);
    const [dmailValidUntil, setDmailValidUntil] = useState('');
    const [dmailReference, setDmailReference] = useState('');
    const [dmailDID, setDmailDID] = useState('');
    const [dmailAttachments, setDmailAttachments] = useState({});
    const [dmailSortBy, setDmailSortBy] = useState('date');
    const [dmailSortOrder, setDmailSortOrder] = useState('desc');
    const [dmailForwarding, setDmailForwarding] = useState('');
    const [dmailSearchQuery, setDmailSearchQuery] = useState('');
    const [dmailSearchResults, setDmailSearchResults] = useState({});
    const [assetsTab, setAssetsTab] = useState('');
    const [imageList, setImageList] = useState(null);
    const [selectedImageName, setSelectedImageName] = useState('');
    const [selectedImage, setSelectedImage] = useState('');
    const [selectedImageOwned, setSelectedImageOwned] = useState(false);
    const [selectedImageDocs, setSelectedImageDocs] = useState('');
    const [selectedImageURL, setSelectedImageURL] = useState('');
    const [imageVersion, setImageVersion] = useState(1);
    const [imageVersionMax, setImageVersionMax] = useState(1);
    const [fileList, setFileList] = useState(null);
    const [selectedFileName, setSelectedFileName] = useState('');
    const [selectedFile, setSelectedFile] = useState('');
    const [selectedFileOwned, setSelectedFileOwned] = useState(false);
    const [selectedFileDocs, setSelectedFileDocs] = useState('');
    const [selectedFileURL, setSelectedFileURL] = useState('');
    const [fileVersion, setFileVersion] = useState(1);
    const [fileVersionMax, setFileVersionMax] = useState(1);
    const [uploadProgress, setUploadProgress] = useState(null);
    const [vaultList, setVaultList] = useState(null);
    const [vaultName, setVaultName] = useState('');
    const [selectedVaultName, setSelectedVaultName] = useState('');
    const [selectedVault, setSelectedVault] = useState('');
    const [selectedVaultOwned, setSelectedVaultOwned] = useState(false);
    const [vaultMember, setVaultMember] = useState('');
    const [docList, setDocList] = useState({});
    const [editLoginOpen, setEditLoginOpen] = useState(false);
    const [revealLoginOpen, setRevealLoginOpen] = useState(false);
    const [revealLogin, setRevealLogin] = useState(null);
    const [revealDmailOpen, setRevealDmailOpen] = useState(false);
    const [revealDmail, setRevealDmail] = useState(null);
    const [pollName, setPollName] = useState("");
    const [description, setDescription] = useState("");
    const [optionsStr, setOptionsStr] = useState("yes, no, abstain");
    const [deadline, setDeadline] = useState("");
    const [createdPollDid, setCreatedPollDid] = useState("");
    const [voterInput, setVoterInput] = useState("");
    const [voters, setVoters] = useState({});
    const [selectedPollName, setSelectedPollName] = useState("");
    const [selectedPollDesc, setSelectedPollDesc] = useState("");
    const [pollOptions, setPollOptions] = useState([]);
    const [selectedOptionIdx, setSelectedOptionIdx] = useState(0);
    const [spoil, setSpoil] = useState(false);
    const [pollDeadline, setPollDeadline] = useState(null);
    const [pollPublished, setPollPublished] = useState(false);
    const [pollController, setPollController] = useState("");
    const [lastBallotDid, setLastBallotDid] = useState("");
    const [hasVoted, setHasVoted] = useState(false);
    const [pollResults, setPollResults] = useState(null);
    const [pollResultsOpen, setPollResultsOpen] = useState(false);
    const [activeTab, setActiveTab] = useState("create");
    const [ballotSent, setBallotSent] = useState(false);
    const [pollNoticeSent, setPollNoticeSent] = useState(false);
    const [renamePollOpen, setRenamePollOpen] = useState(false);
    const [renameOldPollName, setRenameOldPollName] = useState("");
    const [removePollOpen, setRemovePollOpen] = useState(false);
    const [removePollName, setRemovePollName] = useState("");
    const [nostrKeys, setNostrKeys] = useState(null);
    const [nsecString, setNsecString] = useState('');
    const [pollList, setPollList] = useState([]);
    const [canVote, setCanVote] = useState(false);
    const [eligiblePolls, setEligiblePolls] = useState({});
    const [migrateTarget, setMigrateTarget] = useState('');
    const [showMigrateDialog, setShowMigrateDialog] = useState(false);
    const [showCreateDialog, setShowCreateDialog] = useState(false);
    const [nameSearch, setNameSearch] = useState('');
    const [nameTypeFilter, setNameTypeFilter] = useState('all');
    const [serverVersion, setServerVersion] = useState('');
    const [settingsUrl, setSettingsUrl] = useState(serverUrl || '');
    const [showCloneDialog, setShowCloneDialog] = useState(false);
    const [cloneName, setCloneName] = useState('');
    const [showChallengeDialog, setShowChallengeDialog] = useState(false);
    const [challengeCredentials, setChallengeCredentials] = useState([]);
    const [challengeSchemaSelection, setChallengeSchemaSelection] = useState('');
    const [challengeIssuerSelection, setChallengeIssuerSelection] = useState('');
    const confirmResolve = useRef(null);
    const [confirmDialog, setConfirmDialog] = useState({ open: false, message: '' });
    const promptResolve = useRef(null);
    const [promptDialog, setPromptDialog] = useState({ open: false, message: '', value: '' });
    const [snackbar, setSnackbar] = useState({
        open: false,
        message: "",
        severity: "warning",
    });
    // Properties tab
    const [propsSelectedName, setPropsSelectedName] = useState('');
    const [propsData, setPropsData] = useState({});
    const [propsIsOwned, setPropsIsOwned] = useState(false);
    const [propsLoading, setPropsLoading] = useState(false);
    const [propsNewKey, setPropsNewKey] = useState('');
    const [propsNewValue, setPropsNewValue] = useState('');
    const [propsEditingKey, setPropsEditingKey] = useState(null);
    const [propsEditValue, setPropsEditValue] = useState('');
    const [propsDeleteOpen, setPropsDeleteOpen] = useState(false);
    const [propsDeleteKey, setPropsDeleteKey] = useState('');

    const [lightningTab, setLightningTab] = useState('wallet');
    const [lightningBalance, setLightningBalance] = useState(null);
    const [lightningIsConfigured, setLightningIsConfigured] = useState(null);
    const [lightningWalletError, setLightningWalletError] = useState(null);
    const [lightningReceiveAmount, setLightningReceiveAmount] = useState('');
    const [lightningReceiveMemo, setLightningReceiveMemo] = useState('');
    const [lightningInvoice, setLightningInvoice] = useState('');
    const [bolt11Input, setBolt11Input] = useState('');
    const [decodedInvoice, setDecodedInvoice] = useState(null);
    const [lightningPaymentResult, setLightningPaymentResult] = useState(null);
    const [zapDid, setZapDid] = useState('');
    const [zapAmount, setZapAmount] = useState('');
    const [zapMemo, setZapMemo] = useState('');
    const [loadingZap, setLoadingZap] = useState(false);
    const [zapResult, setZapResult] = useState(null);
    const [lightningPayments, setLightningPayments] = useState([]);
    const [loadingPayments, setLoadingPayments] = useState(false);
    const [lightningStatusFilter, setLightningStatusFilter] = useState({ settled: true, pending: true, failed: true, expired: true });
    const [isPublished, setIsPublished] = useState(false);
    const [loadingPublishToggle, setLoadingPublishToggle] = useState(false);
    const [refreshIntervalSeconds, setRefreshIntervalSeconds] = useState(() => loadRefreshIntervalSeconds());
    const [settingsRefreshIntervalSeconds, setSettingsRefreshIntervalSeconds] = useState(() => loadRefreshIntervalSeconds());

    const pollExpired = pollDeadline ? Date.now() > pollDeadline.getTime() : false;
    const selectedPollDid = selectedPollName ? aliasList[selectedPollName] ?? "" : "";

    const handleSnackbarClose = () => {
        setSnackbar((prev) => ({ ...prev, open: false }));
    };

    useEffect(() => {
        checkForChallenge();
        refreshAll();

        if (keymaster.getVersion) {
            keymaster.getVersion()
                .then(data => setServerVersion(`${data.version} (${data.commit})`))
                .catch(() => {});
        } else if (serverUrl) {
            fetch(`${serverUrl}/api/v1/version`)
                .then(r => r.json())
                .then(data => setServerVersion(`${data.version} (${data.commit})`))
                .catch(() => {});
        }
        // eslint-disable-next-line
    }, []);

    useEffect(() => {
        if (tab === 'lightning' && lightningTab === 'wallet') {
            fetchLightningBalance();
        }
        // eslint-disable-next-line
    }, [tab]);

    function showAlert(warning) {
        setSnackbar({
            open: true,
            message: warning,
            severity: "warning",
        });
    }

    function showError(error) {
        const errorMessage = error.error || error.message || String(error);
        setSnackbar({
            open: true,
            message: errorMessage,
            severity: "error",
        });
    }

    function showSuccess(message) {
        setSnackbar({
            open: true,
            message: message,
            severity: "success",
        });
    }

    async function fetchLightningBalance() {
        setLightningWalletError(null);
        try {
            const result = await keymaster.getLightningBalance();
            setLightningBalance(result.balance);
            setLightningIsConfigured(true);
            // Check publish state
            if (currentDID) {
                try {
                    const doc = await keymaster.resolveDID(currentDID);
                    const services = doc?.didDocument?.service || [];
                    setIsPublished(services.some(s => s.id?.endsWith('#lightning')));
                } catch { /* ignore resolve errors */ }
            }
        } catch (error) {
            if (error?.type === 'Lightning not configured' || error?.message?.includes('not configured')) {
                setLightningIsConfigured(false);
            } else {
                setLightningIsConfigured(true);
                setLightningWalletError(error.error || error.message || String(error));
            }
        }
    }

    async function fetchLightningPayments() {
        setLoadingPayments(true);
        try {
            const result = await keymaster.getLightningPayments();
            setLightningPayments(result);
        } catch (error) {
            showError(error);
        } finally {
            setLoadingPayments(false);
        }
    }

    async function setupLightning() {
        try {
            await keymaster.addLightning();
            showSuccess('Lightning wallet set up successfully');
            await fetchLightningBalance();
        } catch (error) {
            showError(error);
        }
    }

    async function disconnectLightning() {
        try {
            await keymaster.removeLightning();
            setLightningBalance(null);
            setLightningIsConfigured(false);
            showSuccess('Lightning wallet disconnected');
        } catch (error) {
            showError(error);
        }
    }

    async function createLightningInvoice() {
        const amount = parseInt(lightningReceiveAmount, 10);
        if (!amount || amount <= 0) {
            showAlert('Enter a valid amount in satoshis');
            return;
        }
        try {
            const result = await keymaster.createLightningInvoice(amount, lightningReceiveMemo);
            setLightningInvoice(result.paymentRequest);
        } catch (error) {
            showError(error);
        }
    }

    async function decodeLightningInvoice() {
        if (!bolt11Input.trim()) return;
        try {
            const result = await keymaster.decodeLightningInvoice(bolt11Input.trim());
            setDecodedInvoice(result);
        } catch (error) {
            showError(error);
        }
    }

    async function checkLightningPaymentWithRetry(paymentHash) {
        let status = await keymaster.checkLightningPayment(paymentHash);

        for (let attempt = 1; attempt < 3 && !status.paid; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            status = await keymaster.checkLightningPayment(paymentHash);
        }

        return status;
    }

    async function payLightningInvoice() {
        if (!bolt11Input.trim()) return;
        setLightningPaymentResult(null);
        try {
            const payment = await keymaster.payLightningInvoice(bolt11Input.trim());
            const status = await keymaster.checkLightningPayment(payment.paymentHash);
            setLightningPaymentResult(status);
            showSuccess('Payment sent successfully');
            setBolt11Input('');
            setDecodedInvoice(null);
        } catch (error) {
            if (decodedInvoice?.payment_hash) {
                try {
                    const status = await keymaster.checkLightningPayment(decodedInvoice.payment_hash);
                    if (status.paid) {
                        setLightningPaymentResult(status);
                        showSuccess('Invoice was already paid');
                        return;
                    }
                } catch { /* fall through to original error */ }
            }
            showError(error);
        }
    }

    async function togglePublishLightning() {
        setLoadingPublishToggle(true);
        try {
            if (isPublished) {
                await keymaster.unpublishLightning();
                setIsPublished(false);
                showSuccess('Lightning unpublished — your DID is no longer zappable');
            } else {
                await keymaster.publishLightning();
                setIsPublished(true);
                showSuccess('Lightning published — your DID is now zappable');
            }
        } catch (error) {
            showError(error);
        } finally {
            setLoadingPublishToggle(false);
        }
    }

    async function handleZap() {
        if (!zapDid.trim()) {
            showAlert('Enter a recipient');
            return;
        }
        const amount = parseInt(zapAmount, 10);
        if (!amount || amount <= 0) {
            showAlert('Enter a valid amount in satoshis');
            return;
        }
        setLoadingZap(true);
        setZapResult(null);
        try {
            const payment = await keymaster.zapLightning(
                zapDid.trim(),
                amount,
                zapMemo.trim() || undefined
            );
            const status = await checkLightningPaymentWithRetry(payment.paymentHash);
            setZapResult(status);
            if (status.paid) {
                showSuccess('Zap sent successfully');
            } else if (status.status === 'failed') {
                showError('Zap failed');
            } else {
                showAlert('Zap submitted, but settlement is still pending');
            }
            setZapDid('');
            setZapAmount('');
            setZapMemo('');
        } catch (error) {
            showError(error);
        } finally {
            setLoadingZap(false);
        }
    }

    async function checkForChallenge() {
        try {
            if (challengeDID) {
                setChallenge(challengeDID);
                setWidget(true);
            }
        } catch (error) {
            showError(error);
        }
    }

    async function refreshAll() {
        try {
            const currentId = await keymaster.getCurrentId();
            const registries = await keymaster.listRegistries();
            setRegistries(registries);

            if (currentId) {
                setCurrentId(currentId);
                setSelectedId(currentId);

                const idList = await keymaster.listIds();
                setIdList(idList);

                const docs = await keymaster.resolveDID(currentId);
                setCurrentDID(docs.didDocument.id);
                setManifest(docs.didDocumentData.manifest);
                setNostrKeys(docs.didDocumentData.nostr || null);
                setDocsString(JSON.stringify(docs, null, 4));

                const versions = docs.didDocumentMetadata.version ?? 1;
                setDocsVersion(versions);
                setDocsVersionMax(versions);

                await refreshNames();
                await refreshHeld();
                await refreshIssued();
                await refreshDmail();

                setTab('identity');
                setAssetsTab('schemas');
                setCredentialTab('held');
                setDmailTab('inbox');
            }
            else {
                setCurrentId('');
                setSelectedId('');
                setCurrentDID('');
                setNostrKeys(null);
                setAddressList({});
                setAddressInput('');
                setAddressDomain('');
                setSelectedAddress('');
                setAddressDocs('');
                setIdentityTab('details');
                setNsecString('');
                setTab('create');
            }

            setSaveId('');
            setNewName('');
            setMnemonicString('');
            setWalletString('');
            setSelectedName('');
            setSelectedHeld('');
            setSelectedIssued('');
            setDmailBody('');
            setDmailCc('');
            setDmailDID('');
            setSelectedImageName('');
            setSelectedFileName('');
            setSelectedVaultName('');
            setSelectedVault(null);
            setSelectedPollName("");
            setSelectedPollDesc("");
            setPollOptions([]);
            setPollResults(null);
            setPollController("");
        } catch (error) {
            showError(error);
        }
    }

    async function selectId(id) {
        try {
            setSelectedId(id);
            await keymaster.setCurrentId(id);
            await refreshAll();
        } catch (error) {
            showError(error);
        }
    }

    async function selectDocsVersion(version) {
        try {
            setDocsVersion(version);
            const docs = await keymaster.resolveDID(currentId, { versionSequence: version });
            setDocsString(JSON.stringify(docs, null, 4));
        } catch (error) {
            showError(error);
        }
    }

    // Properties helpers
    const propsNameEntries = useMemo(() => {
        const seen = new Set();
        const entries = [];
        for (const name of agentList || []) {
            if (!seen.has(name)) { seen.add(name); entries.push(name); }
        }
        for (const name of Object.keys(aliasList || {})) {
            if (!seen.has(name)) { seen.add(name); entries.push(name); }
        }
        return entries.sort((a, b) => a.localeCompare(b));
    }, [agentList, aliasList]);

    useEffect(() => {
        if (!propsSelectedName && currentId && propsNameEntries.includes(currentId)) {
            setPropsSelectedName(currentId);
        }
    }, [currentId, propsNameEntries, propsSelectedName]);

    useEffect(() => {
        setPropsEditingKey(null);
        setPropsEditValue('');
        setPropsDeleteOpen(false);
        setPropsDeleteKey('');
        setPropsNewKey('');
        setPropsNewValue('');

        if (propsSelectedName) {
            loadProps();
        } else {
            setPropsData({});
            setPropsIsOwned(false);
        }
        // eslint-disable-next-line
    }, [propsSelectedName]);

    async function refreshResolvedDocs() {
        try {
            if (currentId && propsSelectedName === currentId) {
                const docs = await keymaster.resolveDID(currentId);
                setCurrentDID(docs.didDocument.id);
                setDocsString(JSON.stringify(docs, null, 4));
                const versions = docs.didDocumentMetadata.version ?? 1;
                setDocsVersion(versions);
                setDocsVersionMax(versions);
            }

            if (selectedName && propsSelectedName === selectedName) {
                const docs = await keymaster.resolveDID(selectedName);
                setAliasDocs(JSON.stringify(docs, null, 4));
                const versions = docs.didDocumentMetadata.version ?? 1;
                setAliasDocsVersion(versions);
                setAliasDocsVersionMax(versions);
            }
        } catch (error) {
            // ignore — tabs will refresh on next visit
        }
    }

    async function loadProps() {
        if (!propsSelectedName) return;
        setPropsLoading(true);
        try {
            const doc = await keymaster.resolveDID(propsSelectedName);
            setPropsData(doc.didDocumentData || {});
            setPropsIsOwned(!!doc.didDocumentMetadata?.isOwned);
        } catch (error) {
            showError(error);
            setPropsData({});
            setPropsIsOwned(false);
        } finally {
            setPropsLoading(false);
        }
    }

    async function propsAdd() {
        if (!propsNewKey.trim()) return;
        try {
            let parsed;
            try { parsed = JSON.parse(propsNewValue); } catch { parsed = propsNewValue; }
            await keymaster.mergeData(propsSelectedName, { [propsNewKey.trim()]: parsed });
            setPropsNewKey('');
            setPropsNewValue('');
            showSuccess('Property added');
            await loadProps();
            await refreshResolvedDocs();
        } catch (error) {
            showError(error);
        }
    }

    async function propsSaveEdit(key) {
        try {
            let parsed;
            try { parsed = JSON.parse(propsEditValue); } catch { parsed = propsEditValue; }
            await keymaster.mergeData(propsSelectedName, { [key]: parsed });
            setPropsEditingKey(null);
            showSuccess('Property updated');
            await loadProps();
            await refreshResolvedDocs();
        } catch (error) {
            showError(error);
        }
    }

    async function propsConfirmDelete() {
        if (!propsDeleteKey) return;
        try {
            await keymaster.mergeData(propsSelectedName, { [propsDeleteKey]: null });
            showSuccess('Property removed');
            await loadProps();
            await refreshResolvedDocs();
        } catch (error) {
            showError(error);
        }
        setPropsDeleteOpen(false);
        setPropsDeleteKey('');
    }

    function propsStartEdit(key, value) {
        setPropsEditingKey(key);
        setPropsEditValue(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    }

    function propsFormatValue(value) {
        if (typeof value === 'string') return value;
        return JSON.stringify(value);
    }

    async function showCreate() {
        setSaveId(currentId);
        setCurrentId('');
        setTab('create');
        setShowCreateDialog(true);
    }

    async function cancelCreate() {
        setShowCreateDialog(false);
        setCurrentId(saveId);
        setTab(saveId ? 'identity' : 'create');
    }

    async function createId() {
        try {
            await keymaster.createId(newName, { registry });
            setShowCreateDialog(false);
            refreshAll();
        } catch (error) {
            showError(error);
        }
    }

    async function resolveId() {
        try {
            const docs = await keymaster.resolveDID(selectedId);
            setManifest(docs.didDocumentData.manifest);
            setNostrKeys(docs.didDocumentData.nostr || null);
            setDocsString(JSON.stringify(docs, null, 4));

            const versions = docs.didDocumentMetadata.version ?? 1;
            setDocsVersion(versions);
            setDocsVersionMax(versions);
        } catch (error) {
            showError(error);
        }
    }

    function openMigrate(id) {
        setMigrateTarget(id);
        setRegistry('');
        setShowMigrateDialog(true);
    }

    function closeMigrate() {
        setShowMigrateDialog(false);
        setMigrateTarget('');
        setRegistry('');
    }

    function openClone() {
        setCloneName('');
        setRegistry('');
        setShowCloneDialog(true);
    }

    function closeClone() {
        setShowCloneDialog(false);
        setCloneName('');
        setRegistry('');
    }

    async function migrateId() {
        try {
            const ok = await keymaster.changeRegistry(migrateTarget, registry);
            if (ok) {
                showSuccess(`${migrateTarget} migrated to ${registry}`);
                closeMigrate();
                if (migrateTarget === selectedId) {
                    resolveId();
                } else {
                    resolveAlias(migrateTarget);
                }
            }
        } catch (error) {
            showError(error);
        }
    }

    function showConfirm(message) {
        return new Promise((resolve) => {
            confirmResolve.current = resolve;
            setConfirmDialog({ open: true, message });
        });
    }

    function handleConfirmOk() {
        setConfirmDialog(d => ({ ...d, open: false }));
        confirmResolve.current?.(true);
    }

    function handleConfirmCancel() {
        setConfirmDialog(d => ({ ...d, open: false }));
        confirmResolve.current?.(false);
    }

    function showPrompt(message, defaultValue = '') {
        return new Promise((resolve) => {
            promptResolve.current = resolve;
            setPromptDialog({ open: true, message, value: defaultValue });
        });
    }

    function handlePromptOk() {
        setPromptDialog(d => {
            promptResolve.current?.(d.value || null);
            return { ...d, open: false };
        });
    }

    function handlePromptCancel() {
        setPromptDialog(d => ({ ...d, open: false }));
        promptResolve.current?.(null);
    }

    async function renameId() {
        try {
            const input = await showPrompt("Please enter new name:");

            if (input) {
                const name = input.trim();

                if (name.length > 0) {
                    await keymaster.renameId(selectedId, name);
                    refreshAll();
                }
            }
        } catch (error) {
            showError(error);
        }
    }

    async function removeId() {
        try {
            if (await showConfirm(`Are you sure you want to remove ${selectedId}?`)) {
                await keymaster.removeId(selectedId);
                refreshAll();
            }
        } catch (error) {
            showError(error);
        }
    }

    async function backupId() {
        try {
            const ok = await keymaster.backupId(selectedId);

            if (ok) {
                showSuccess(`${selectedId} backup succeeded`);
                resolveId();
            }
            else {
                showError(`${selectedId} backup failed`);
            }
        } catch (error) {
            showError(error);
        }
    }

    async function recoverId() {
        try {
            const did = await showPrompt("Please enter the DID:");
            if (did) {
                const response = await keymaster.recoverId(did);
                refreshAll();
                showAlert(response);
            }
        } catch (error) {
            showError(error);
        }
    }

    async function rotateKeys() {
        try {
            await keymaster.rotateKeys();
            refreshAll();
        } catch (error) {
            showError(error);
        }
    }

    async function addNostr() {
        try {
            const nostr = await keymaster.addNostr();
            setNostrKeys(nostr);
            resolveId();
            showSuccess('Nostr keys added');
        } catch (error) {
            showError(error);
        }
    }

    async function removeNostr() {
        try {
            if (await showConfirm('Are you sure you want to remove Nostr keys?')) {
                await keymaster.removeNostr();
                setNostrKeys(null);
                setNsecString('');
                resolveId();
                showSuccess('Nostr keys removed');
            }
        } catch (error) {
            showError(error);
        }
    }

    async function showNsec() {
        try {
            const nsec = await keymaster.exportNsec();
            setNsecString(nsec);
        } catch (error) {
            showError(error);
        }
    }

    function hideNsec() {
        setNsecString('');
    }

    function openChallengeDialog() {
        setChallengeCredentials([]);
        setChallengeSchemaSelection('');
        setChallengeIssuerSelection('');
        setShowChallengeDialog(true);
    }

    function closeChallengeDialog() {
        setShowChallengeDialog(false);
    }

    function addChallengeCredential() {
        if (challengeSchemaSelection) {
            setChallengeCredentials([...challengeCredentials, {
                schema: challengeSchemaSelection,
                issuer: challengeIssuerSelection || '',
            }]);
            setChallengeSchemaSelection('');
            setChallengeIssuerSelection('');
        }
    }

    function removeChallengeCredential(index) {
        setChallengeCredentials(challengeCredentials.filter((_, i) => i !== index));
    }

    async function newChallenge() {
        try {
            const spec = {};
            if (challengeCredentials.length > 0) {
                const credentials = [];
                for (const cred of challengeCredentials) {
                    const schemaDid = await keymaster.lookupDID(cred.schema);
                    const entry = { schema: schemaDid };
                    if (cred.issuer) {
                        const issuerDid = await keymaster.lookupDID(cred.issuer);
                        entry.issuers = [issuerDid];
                    }
                    credentials.push(entry);
                }
                spec.credentials = credentials;
            }
            const challenge = await keymaster.createChallenge(spec);
            closeChallengeDialog();
            setChallenge(challenge);
            resolveChallenge(challenge);
        } catch (error) {
            showError(error);
        }
    }

    async function resolveChallenge(did) {
        try {
            const asset = await keymaster.resolveAsset(did);
            setAuthDID(did);
            setAuthString(JSON.stringify(asset, null, 4));
        } catch (error) {
            showError(error);
        }
    }

    async function createResponse() {
        try {
            await clearResponse();
            const response = await keymaster.createResponse(challenge, { retries: 10 });
            setResponse(response);

            const asset = await keymaster.resolveAsset(challenge);
            const callback = asset.challenge.callback;

            setCallback(callback);

            if (callback) {
                setDisableSendResponse(false);
            }
            decryptResponse(response);
        } catch (error) {
            showError(error);
        }
    }

    async function clearChallenge() {
        setChallenge('');
    }

    async function decryptResponse(did) {
        try {
            const decrypted = await keymaster.decryptJSON(did);
            setAuthDID(did);
            setAuthString(JSON.stringify(decrypted, null, 4));
        } catch (error) {
            showError(error);
        }
    }

    async function verifyResponse() {
        try {
            const verify = await keymaster.verifyResponse(response);

            if (verify.match) {
                showSuccess("Response is VALID");
                setAccessGranted(true);
            }
            else {
                showError("Response is NOT VALID");
                setAccessGranted(false);
            }
        } catch (error) {
            showError(error);
        }
    }

    async function clearResponse() {
        setResponse('');
        setAccessGranted(false);
    }

    async function sendResponse() {
        try {
            setDisableSendResponse(true);
            axios.post(callback, { response });
        } catch (error) {
            showError(error);
        }
    }

    async function refreshNames() {
        const aliasList = await keymaster.listAliases({ includeIDs: false });
        const addressList = await keymaster.listAddresses();
        const names = Object.keys(aliasList);

        setAliasList(aliasList);
        setAddressList(addressList);
        setAlias('');
        setAliasDID('');
        setAliasDocs('');
        setAddressInput('');
        setAddressDomain('');
        setSelectedAddress('');
        setAddressDocs('');

        const docList = {};
        const agentList = await keymaster.listIds();
        const groupList = [];
        const schemaList = [];
        const imageList = [];
        const fileList = [];
        const vaultList = [];
        const pollList = [];

        for (const alias of names) {
            try {
                const doc = await keymaster.resolveDID(alias);
                const data = doc.didDocumentData;

                docList[alias] = doc;

                if (doc.didDocumentRegistration.type === 'agent') {
                    if (!agentList.includes(alias)) {
                        agentList.push(alias);
                    }
                    continue;
                }

                if (data.group) {
                    groupList.push(alias);
                    continue;
                }

                if (data.schema) {
                    schemaList.push(alias);
                    continue;
                }

                if (data.image) {
                    imageList.push(alias);
                    continue;
                }

                if (data.file) {
                    fileList.push(alias);
                    continue;
                }

                if (data.vault) {
                    const isPoll = await keymaster.testPoll(alias);
                    if (isPoll) {
                        pollList.push(alias);
                    } else {
                        vaultList.push(alias);
                    }
                    continue;
                }
            }
            catch {
                continue;
            }
        }

        setDocList(docList);
        setAgentList(agentList);

        if (!agentList.includes(credentialSubject)) {
            setCredentialSubject('');
            setCredentialString('');
        }

        setGroupList(groupList);

        if (!groupList.includes(selectedGroupName)) {
            setSelectedGroupName('');
            setSelectedGroup(null);
        }

        setSchemaList(schemaList);

        if (!schemaList.includes(selectedSchemaName)) {
            setSelectedSchemaName('');
            setSelectedSchema(null);
        }

        if (!schemaList.includes(credentialSchema)) {
            setCredentialSchema('');
            setCredentialString('');
        }

        setImageList(imageList);

        if (!imageList.includes(selectedImageName)) {
            setSelectedImageName('');
            setSelectedImage(null);
        }

        setFileList(fileList);

        setVaultList(vaultList);

        if (!vaultList.includes(selectedVaultName)) {
            setSelectedVaultName('');
            setSelectedVault(null);
        }

        setPollList(pollList);

    }

    function getDID(alias) {
        if (alias in docList) {
            return docList[alias].didDocument.id;
        }

        return '';
    }

    function getAliasIcon(alias) {
        const iconStyle = { verticalAlign: 'middle', marginRight: 4 };

        if (agentList && agentList.includes(alias)) {
            return <PermIdentity style={iconStyle} />;
        }

        if (vaultList && vaultList.includes(alias)) {
            return <Lock style={iconStyle} />;
        }

        if (groupList && groupList.includes(alias)) {
            return <Groups style={iconStyle} />;
        }

        if (schemaList && schemaList.includes(alias)) {
            return <Schema style={iconStyle} />;
        }

        if (imageList && imageList.includes(alias)) {
            return <Image style={iconStyle} />;
        }

        if (fileList && fileList.includes(alias)) {
            return <Article style={iconStyle} />;
        }

        if (pollList && pollList.includes(alias)) {
            return <Poll style={iconStyle} />;
        }

        return <Token style={iconStyle} />;
    }

    function getAliasKind(alias) {
        if (agentList && agentList.includes(alias)) return 'agent';
        if (vaultList && vaultList.includes(alias)) return 'vault';
        if (groupList && groupList.includes(alias)) return 'group';
        if (schemaList && schemaList.includes(alias)) return 'schema';
        if (imageList && imageList.includes(alias)) return 'image';
        if (fileList && fileList.includes(alias)) return 'file';
        if (pollList && pollList.includes(alias)) return 'poll';
        return 'unknown';
    }

    const filteredAliases = useMemo(() => {
        if (!aliasList) return [];
        return Object.entries(aliasList)
            .filter(([alias]) => !idList.includes(alias))
            .filter(([alias]) => {
                const passesSearch = !nameSearch || alias.toLowerCase().includes(nameSearch.toLowerCase());
                const passesType = nameTypeFilter === 'all' || getAliasKind(alias) === nameTypeFilter;
                return passesSearch && passesType;
            })
            .sort(([a], [b]) => a.localeCompare(b));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [aliasList, idList, nameSearch, nameTypeFilter, agentList, vaultList, groupList, schemaList, imageList, fileList, pollList]);

    const filteredAddresses = useMemo(() => {
        return Object.entries(addressList || {})
            .sort(([a], [b]) => a.localeCompare(b));
    }, [addressList]);

    async function addAlias() {
        try {
            await keymaster.addAlias(alias, aliasDID);
            refreshNames();
        } catch (error) {
            showError(error);
        }
    }

    function clearAliasFields() {
        setAlias('');
        setAliasDID('');
    }

    function clearAddressFields() {
        setAddressInput('');
        setAddressDomain('');
        setSelectedAddress('');
        setAddressDocs('');
    }

    async function resolveStoredAddress(domain) {
        setAddressBusy(true);
        try {
            const normalizedDomain = parseAddressDomain(domain);

            if (!normalizedDomain) {
                showAlert('Enter a domain');
                return;
            }

            const info = await keymaster.getAddress(normalizedDomain);
            setAddressDomain(normalizedDomain);

            if (info) {
                setSelectedAddress(info.address);
                setAddressInput(info.name);
                setAddressDocs(JSON.stringify(info, null, 4));
            }
            else {
                setSelectedAddress('');
                setAddressDocs(JSON.stringify(null, null, 4));
                showAlert(`No address stored for ${normalizedDomain}`);
            }
        } catch (error) {
            showError(error);
        } finally {
            setAddressBusy(false);
        }
    }

    async function selectAddress(address) {
        const normalizedAddress = address.trim().toLowerCase();
        setSelectedAddress(normalizedAddress);
        setAddressInput(parseAddressName(normalizedAddress));
        setAddressDomain(parseAddressDomain(normalizedAddress));
        await resolveStoredAddress(normalizedAddress);
    }

    async function checkAddressValue() {
        setAddressBusy(true);
        try {
            const normalizedAddress = composeAddress(addressInput, addressDomain);

            if (!normalizedAddress) {
                showAlert('Enter a name and domain');
                return;
            }

            const result = await keymaster.checkAddress(normalizedAddress);
            setAddressInput(parseAddressName(normalizedAddress));
            setAddressDomain(parseAddressDomain(normalizedAddress));
            setAddressDocs(JSON.stringify(result, null, 4));
        } catch (error) {
            showError(error);
        } finally {
            setAddressBusy(false);
        }
    }

    async function importAddressDomain() {
        setAddressBusy(true);
        try {
            const normalizedDomain = parseAddressDomain(addressDomain);

            if (!normalizedDomain) {
                showAlert('Enter a domain');
                return;
            }

            const imported = await keymaster.importAddress(normalizedDomain);
            await refreshNames();
            const importedAddresses = Object.keys(imported);
            setAddressDomain(normalizedDomain);
            setAddressDocs(JSON.stringify(imported, null, 4));
            if (importedAddresses.length > 0) {
                const importedAddress = importedAddresses[0];
                setSelectedAddress(importedAddress);
                setAddressInput(parseAddressName(importedAddress));
                showSuccess(`Imported ${importedAddresses.length} address(es) from ${normalizedDomain}`);
            }
            else {
                showAlert(`No addresses imported from ${normalizedDomain}`);
            }
        } catch (error) {
            showError(error);
        } finally {
            setAddressBusy(false);
        }
    }

    async function addAddressValue() {
        setAddressBusy(true);
        try {
            const normalizedAddress = composeAddress(addressInput, addressDomain);

            if (!normalizedAddress) {
                showAlert('Enter a name and domain');
                return;
            }

            await keymaster.addAddress(normalizedAddress);
            setAddressInput(parseAddressName(normalizedAddress));
            setAddressDomain(parseAddressDomain(normalizedAddress));
            await refreshNames();
            await resolveStoredAddress(normalizedAddress);
            showSuccess(`${normalizedAddress} added`);
        } catch (error) {
            showError(error);
        } finally {
            setAddressBusy(false);
        }
    }

    async function removeAddressValue(address = selectedAddress || composeAddress(addressInput, addressDomain)) {
        setAddressBusy(true);
        try {
            const normalizedAddress = address.trim().toLowerCase();

            if (!normalizedAddress) {
                showAlert('Select an address or enter a name and domain');
                return;
            }

            if (await showConfirm(`Are you sure you want to remove ${normalizedAddress}?`)) {
                await keymaster.removeAddress(normalizedAddress);
                if (selectedAddress === normalizedAddress) {
                    setSelectedAddress('');
                    setAddressDocs('');
                }
                setAddressInput('');
                setAddressDomain(parseAddressDomain(normalizedAddress));
                await refreshNames();
                showSuccess(`${normalizedAddress} removed`);
            }
        } catch (error) {
            showError(error);
        } finally {
            setAddressBusy(false);
        }
    }

    async function cloneAsset() {
        try {
            await keymaster.cloneAsset(aliasList[selectedName], { alias: cloneName, registry });
            showSuccess(`${selectedName} cloned as ${cloneName}`);
            closeClone();
            refreshNames();
        } catch (error) {
            const errorMessage = error.error || error.toString();

            if (errorMessage.includes('Invalid parameter: id')) {
                showError('Only assets can be cloned');
            }
            else {
                showError(error);
            }
        }
    }

    async function resolveAlias(name) {
        try {
            const trimmedName = name.trim();
            const docs = await keymaster.resolveDID(trimmedName);
            const did = docs.didDocument?.id;
            const data = docs.didDocumentData || {};
            const resolvedName = typeof data.name === 'string' ? data.name : '';
            if (!did) {
                showError(`Unable to resolve DID document for "${trimmedName}".`);
                return;
            }
            setSelectedName(trimmedName);
            if (alias.trim()) {
                setAliasDID(did);
            }
            else if (resolvedName) {
                setAlias(resolvedName);
            }
            setAliasIsOwned(!!docs.didDocumentMetadata?.isOwned);
            setAliasDocs(JSON.stringify(docs, null, 4));
            const versions = docs.didDocumentMetadata?.version ?? 1;
            setAliasDocsVersion(versions);
            setAliasDocsVersionMax(versions);
        } catch (error) {
            showError(error);
        }
    }

    async function removeAlias(alias) {
        try {
            if (await showConfirm(`Are you sure you want to remove ${alias}?`)) {
                await keymaster.removeAlias(alias);
                setSelectedName('');
                refreshNames();
            }
        } catch (error) {
            showError(error);
        }
    }

    async function changeAlias(oldName, did) {
        try {
            const newName = await showPrompt("Rename DID:");

            if (newName && newName !== oldName) {
                await keymaster.addAlias(newName, did);
                await keymaster.removeAlias(oldName);
                refreshNames();
            }
        } catch (error) {
            showError(error);
        }
    }

    async function revokeAlias(alias) {
        try {
            if (await showConfirm(`Are you sure you want to revoke ${alias}? This operation cannot be undone.`)) {
                await keymaster.revokeDID(alias);
                resolveAlias(alias);
                showAlert(`Revoked ${alias} can no longer be updated.`);
            }
        } catch (error) {
            showError(error);
        }
    }

    async function transferAlias(alias) {
        try {
            const docs = await keymaster.resolveDID(alias);

            if (docs.didDocumentRegistration.type === 'agent') {
                showAlert("Only asset DIDs may be transferred");
                return;
            }

            if (!docs.didDocumentMetadata.isOwned) {
                showAlert("Only assets you own may be transferred");
                return;
            }

            const newController = await showPrompt("Transfer asset to name or DID:");

            if (newController) {
                await keymaster.transferAsset(alias, newController);
                resolveAlias(alias);
                showSuccess(`Transferred ${alias} to ${newController}`);
            }
        } catch (error) {
            showError(error);
        }
    }

    async function selectAliasDocsVersion(version) {
        try {
            setAliasDocsVersion(version);
            const docs = await keymaster.resolveDID(selectedName, { versionSequence: version });
            setAliasDocs(JSON.stringify(docs, null, 4));
        } catch (error) {
            showError(error);
        }
    }

    async function createGroup() {
        try {
            if (Object.keys(aliasList).includes(groupName)) {
                alert(`${groupName} already in use`);
                return;
            }

            const alias = groupName;
            setGroupName('');

            await keymaster.createGroup(alias, { registry, alias });

            refreshNames();
            setSelectedGroupName(alias);
            refreshGroup(alias);
        } catch (error) {
            showError(error);
        }
    }

    async function refreshGroup(groupName) {
        try {
            const docs = await keymaster.resolveDID(groupName);

            setSelectedGroupName(groupName);
            setSelectedGroup(docs.didDocumentData.group);
            setSelectedGroupOwned(docs.didDocumentMetadata.isOwned);
            setGroupMember('');
            setGroupMemberDocs('');
        } catch (error) {
            showError(error);
        }
    }

    async function resolveGroupMember(did) {
        try {
            const docs = await keymaster.resolveDID(did);
            setGroupMemberDocs(JSON.stringify(docs, null, 4));
        } catch (error) {
            showError(error);
        }
    }

    async function addGroupMember(did) {
        try {
            await keymaster.addGroupMember(selectedGroupName, did);
            refreshGroup(selectedGroupName);
        } catch (error) {
            showError(error);
        }
    }

    async function removeGroupMember(did) {
        try {
            if (await showConfirm(`Remove member from ${selectedGroupName}?`)) {
                await keymaster.removeGroupMember(selectedGroupName, did);
                refreshGroup(selectedGroupName);
            }
        } catch (error) {
            showError(error);
        }
    }

    async function createSchema() {
        try {
            if (Object.keys(aliasList).includes(schemaName)) {
                alert(`${schemaName} already in use`);
                return;
            }

            const alias = schemaName;
            setSchemaName('');

            await keymaster.createSchema(null, { registry, alias });

            refreshNames();
            setSelectedSchemaName(alias);
            selectSchema(alias);
        } catch (error) {
            showError(error);
        }
    }

    async function selectSchema(schemaName) {
        try {
            const docs = await keymaster.resolveDID(schemaName);
            const schema = docs.didDocumentData.schema;

            setSelectedSchemaName(schemaName);
            setSelectedSchemaOwned(docs.didDocumentMetadata.isOwned);
            setSelectedSchema(schema);
            setSchemaString(JSON.stringify(schema, null, 4));
        } catch (error) {
            showError(error);
        }
    }

    async function saveSchema() {
        try {
            await keymaster.setSchema(selectedSchemaName, JSON.parse(schemaString));
            await selectSchema(selectedSchemaName);
        } catch (error) {
            showError(error);
        }
    }

    async function importSchemaPack() {
        try {
            if (!schemaPackDID) return;

            // Resolve the pack DID first to get its info
            const packDoc = await keymaster.resolveDID(schemaPackDID);
            const packData = packDoc.didDocumentData;

            if (!packData.group || !packData.group.members) {
                showAlert('Schema pack DID is not a group');
                return;
            }

            // Recursively collect all schema DIDs from the group
            const schemaDIDs = [];
            const visited = new Set();

            async function collectSchemas(did) {
                if (visited.has(did)) return;
                visited.add(did);

                let doc;
                try {
                    doc = await keymaster.resolveDID(did);
                } catch {
                    return;
                }

                const data = doc.didDocumentData;

                // Check if this is a group - recurse into members
                if (data.group && data.group.members) {
                    for (const memberDID of data.group.members) {
                        await collectSchemas(memberDID);
                    }
                    return;
                }

                // Check if this is a schema - collect it
                if (data.schema) {
                    schemaDIDs.push({ did: doc.didDocument.id, schema: data.schema, doc });
                }
            }

            // Collect schemas from all members
            for (const memberDID of packData.group.members) {
                await collectSchemas(memberDID);
            }

            if (schemaDIDs.length === 0) {
                showAlert('No schemas found in the pack');
                return;
            }

            // Import each schema with appropriate name
            const existingNames = Object.keys(aliasList);

            for (const { did, schema, doc } of schemaDIDs) {
                let name = null;

                // Priority 1: last $credentialType
                if (schema.$credentialType && Array.isArray(schema.$credentialType) && schema.$credentialType.length > 0) {
                    name = schema.$credentialType[schema.$credentialType.length - 1];
                }
                // Priority 2: schema title
                else if (schema.title) {
                    name = schema.title;
                }
                // Priority 3: DID document data name field
                else if (doc.didDocumentData?.name) {
                    name = doc.didDocumentData.name;
                }

                // Priority 4: Generic name
                if (!name) {
                    name = 'schema';
                }

                // Truncate name if too long (max 30 chars to leave room for suffix)
                if (name.length > 30) {
                    name = name.substring(0, 30);
                }

                // Ensure unique name
                let uniqueName = name;
                let suffix = 1;
                while (existingNames.includes(uniqueName)) {
                    uniqueName = `${name}-${suffix}`;
                    suffix++;
                }

                await keymaster.addAlias(uniqueName, did);
                existingNames.push(uniqueName);
            }

            // Also add the pack DID itself with the group's name or a fallback
            let basePackName = packData.group.name;
            if (!basePackName) {
                basePackName = 'schema-pack';
            }

            let packName = basePackName;
            let suffix = 1;
            while (existingNames.includes(packName)) {
                packName = `${basePackName}-${suffix}`;
                suffix++;
            }
            await keymaster.addAlias(packName, packDoc.didDocument.id);

            setSchemaPackDID('');
            refreshNames();
            showSuccess(`Imported ${schemaDIDs.length} schema(s)`);
        } catch (error) {
            showError(error);
        }
    }

    async function editCredential() {
        try {
            const credentialBound = await keymaster.bindCredential(credentialSubject, { schema: credentialSchema });
            setCredentialString(JSON.stringify(credentialBound, null, 4));
            setCredentialDID('');
        } catch (error) {
            showError(error);
        }
    }

    async function issueCredential() {
        try {
            const did = await keymaster.issueCredential(JSON.parse(credentialString), { registry });
            setCredentialDID(did);
            setCredentialSent(false);
            // Add did to issuedList
            setIssuedList(prevIssuedList => [...prevIssuedList, did]);
        } catch (error) {
            showError(error);
        }
    }

    async function sendCredential() {
        try {
            await keymaster.sendCredential(credentialDID);
            setCredentialSent(true);
            showSuccess("Credential sent");
        } catch (error) {
            showError(error);
        }
    }

    async function refreshHeld() {
        try {
            const heldList = await keymaster.listCredentials();
            setHeldList(heldList);
            setHeldString('');
        } catch (error) {
            showError(error);
        }
    }

    async function refreshIssued() {
        try {
            const issuedList = await keymaster.listIssued();
            setIssuedList(issuedList);
            setIssuedString('');
        } catch (error) {
            showError(error);
        }
    }

    async function acceptCredential() {
        try {
            const ok = await keymaster.acceptCredential(heldDID);
            if (ok) {
                refreshHeld();
                setHeldDID('');
            }
            else {
                showError("Credential not accepted");
            }
        } catch (error) {
            showError(error);
        }
    }

    async function removeCredential(did) {
        try {
            if (await showConfirm(`Are you sure you want to remove ${did}?`)) {
                await keymaster.removeCredential(did);
                refreshHeld();
            }
        } catch (error) {
            showError(error);
        }
    }

    async function resolveCredential(did) {
        try {
            const doc = await keymaster.resolveDID(did);
            setSelectedHeld(did);
            setHeldString(JSON.stringify(doc, null, 4));
        } catch (error) {
            showError(error);
        }
    }

    async function decryptCredential(did) {
        try {
            const doc = await keymaster.getCredential(did);
            setSelectedHeld(did);
            setHeldString(JSON.stringify(doc, null, 4));
        } catch (error) {
            showError(error);
        }
    }

    async function publishCredential(did) {
        try {
            await keymaster.publishCredential(did, { reveal: false });
            resolveId();
            decryptCredential(did);
        } catch (error) {
            showError(error);
        }
    }

    async function revealCredential(did) {
        try {
            await keymaster.publishCredential(did, { reveal: true });
            resolveId();
            decryptCredential(did);
        } catch (error) {
            showError(error);
        }
    }

    async function unpublishCredential(did) {
        try {
            await keymaster.unpublishCredential(did);
            resolveId();
            decryptCredential(did);
        } catch (error) {
            showError(error);
        }
    }

    function credentialRevealed(did) {
        if (!manifest) {
            return false;
        }

        if (!manifest[did]) {
            return false;
        }

        return manifest[did].credential !== null;
    }

    function credentialUnpublished(did) {
        if (!manifest) {
            return true;
        }

        return !manifest[did];
    }

    async function resolveIssued(did) {
        try {
            const doc = await keymaster.resolveDID(did);
            setSelectedIssued(did);
            setIssuedString(JSON.stringify(doc, null, 4));
        } catch (error) {
            showError(error);
        }
    }

    async function decryptIssued(did) {
        try {
            const doc = await keymaster.getCredential(did);
            setSelectedIssued(did);
            const issued = JSON.stringify(doc, null, 4);
            setIssuedStringOriginal(issued);
            setIssuedString(issued);
            setIssuedEdit(true);
        } catch (error) {
            showError(error);
        }
    }

    async function updateIssued(did) {
        try {
            const credential = JSON.parse(issuedString);
            await keymaster.updateCredential(did, credential);
            decryptIssued(did);
        } catch (error) {
            showError(error);
        }
    }

    async function revokeIssued(did) {
        try {
            if (await showConfirm(`Revoke credential?`)) {
                await keymaster.revokeCredential(did);

                // Remove did from issuedList
                const newIssuedList = issuedList.filter(item => item !== did);
                setIssuedList(newIssuedList);
            }
        } catch (error) {
            showError(error);
        }
    }

    async function sendIssued(did) {
        try {
            await keymaster.sendCredential(did);
            showSuccess("Credential sent");
        } catch (error) {
            showError(error);
        }
    }

    useEffect(() => {
        if (selectedDmailDID && dmailList[selectedDmailDID]) {
            setSelectedDmail(dmailList[selectedDmailDID]);
        } else {
            setSelectedDmail(null);
        }
    }, [selectedDmailDID, dmailList]);

    async function refreshDmail() {
        try {
            await keymaster.refreshNotices();
            await refreshInbox();
            await clearSendDmail();
            setSelectedDmailDID('');
        } catch (error) {
            showError(error);
        }
    }

    async function importDmail() {
        try {
            const did = await showPrompt("Dmail DID:");

            if (!did) {
                return;
            }

            const ok = await keymaster.importDmail(did);

            if (ok) {
                showSuccess("Dmail import successful");
                refreshDmail();
            } else {
                showError("Dmail import failed");
            }
        } catch (error) {
            showError(error);
        }
    }

    async function addDmailTo() {
        setDmailToList(prevToList => {
            if (!dmailTo) {
                return prevToList;
            }

            // Check if recipient already exists in the list
            if (prevToList.includes(dmailTo)) {
                return prevToList;
            }

            // Add recipient to the list
            return [...prevToList, dmailTo];
        });
        setDmailTo(''); // Clear the input field after adding
    }

    async function removeDmailTo(recipient) {
        setDmailToList(prevToList => {
            // Remove recipient from the list
            return prevToList.filter(item => item !== recipient);
        });
    }

    async function addDmailCc() {
        setDmailCcList(prevToList => {
            if (!dmailCc) {
                return prevToList;
            }

            // Check if recipient already exists in the list
            if (prevToList.includes(dmailCc)) {
                return prevToList;
            }

            // Add recipient to the list
            return [...prevToList, dmailCc];
        });
        setDmailCc(''); // Clear the input field after adding
    }

    async function removeDmailCc(recipient) {
        setDmailCcList(prevToList => {
            // Remove recipient from the list
            return prevToList.filter(item => item !== recipient);
        });
    }

    function getDmailInputOrError() {
        if (!dmailTo && dmailToList.length === 0) {
            showError("Please add at least one recipient to the 'To' field.");
            return null;
        }

        if (!dmailSubject) {
            showError("Please enter a subject for the Dmail.");
            return null;
        }

        if (!dmailBody) {
            showError("Please enter a body for the Dmail.");
            return null;
        }

        const toList = [dmailTo, ...dmailToList].filter(Boolean); // Ensure no empty strings
        const ccList = [dmailCc, ...dmailCcList].filter(Boolean);

        return {
            to: toList,
            cc: ccList,
            subject: dmailSubject,
            body: dmailBody,
            reference: dmailReference,
        };
    }

    async function createDmail() {
        const dmail = getDmailInputOrError();
        if (!dmail) return;

        let validUntil;

        if (registry === 'hyperswarm' && dmailEphemeral) {
            if (!dmailValidUntil) {
                showError("Please set a valid until date for ephemeral Dmail.");
                return;
            }

            const validUntilDate = new Date(dmailValidUntil + "T00:00:00Z");
            if (isNaN(validUntilDate.getTime())) {
                showError("Invalid date format for valid until.");
                return;
            }

            if (validUntilDate <= new Date()) {
                showError("Valid until date must be in the future.");
                return;
            }
            // Set validUntil to start of day of the next day (UTC-safe)
            validUntilDate.setUTCDate(validUntilDate.getUTCDate() + 1);
            validUntilDate.setUTCHours(0, 0, 0, 0);
            validUntil = validUntilDate.toISOString();
        }

        try {
            const did = await keymaster.createDmail(dmail, { registry, validUntil });
            setDmailDID(did);

            if (dmailForwarding) {
                const attachments = await keymaster.listDmailAttachments(dmailForwarding) || {};
                for (const name of Object.keys(attachments)) {
                    const buffer = await keymaster.getDmailAttachment(dmailForwarding, name);
                    await keymaster.addDmailAttachment(did, name, buffer);
                }

                setDmailAttachments(await keymaster.listDmailAttachments(did) || {});
            }
        } catch (error) {
            showError(error);
        }
    }

    async function updateDmail() {
        const dmail = getDmailInputOrError();
        if (!dmail) return;

        try {
            const ok = await keymaster.updateDmail(dmailDID, dmail);
            if (ok) {
                showSuccess("Dmail updated successfully");
            } else {
                showError("Dmail update failed");
            }
        } catch (error) {
            showError(error);
        }
    }

    async function refreshDmailAttachments() {
        try {
            const attachments = await keymaster.listDmailAttachments(dmailDID) || {};
            setDmailAttachments(attachments);
            dmailList[dmailDID].attachments = attachments;
        } catch (error) {
            showError(error);
        }
    }

    async function uploadDmailAttachment(event) {
        try {
            const fileInput = event.target; // Reference to the input element
            const file = fileInput.files[0];

            if (!file) return;

            // Reset the input value to allow selecting the same file again
            fileInput.value = "";

            // Read the file as a binary buffer
            const reader = new FileReader();

            reader.onload = async (e) => {
                try {
                    const arrayBuffer = e.target.result;
                    const buffer = Buffer.from(arrayBuffer);

                    const ok = await keymaster.addDmailAttachment(dmailDID, file.name, buffer);

                    if (ok) {
                        showSuccess(`Attachment uploaded successfully: ${file.name}`);
                        refreshDmailAttachments();
                    } else {
                        showError(`Error uploading file: ${file.name}`);
                    }
                } catch (error) {
                    // Catch errors from the Keymaster API or other logic
                    showError(`Error uploading file: ${error}`);
                }
            };

            reader.onerror = (error) => {
                showError(`Error uploading file: ${error}`);
            };

            reader.readAsArrayBuffer(file);
        } catch (error) {
            showError(`Error uploading file: ${error}`);
        }
    }

    async function removeDmailAttachment(name) {
        try {
            await keymaster.removeDmailAttachment(dmailDID, name);
            refreshDmailAttachments();
        } catch (error) {
            showError(error);
        }
    }

    async function downloadDmailAttachment(name) {
        try {
            const buffer = await keymaster.getDmailAttachment(selectedDmailDID, name);

            if (!buffer) {
                showError(`Attachment ${name} not found in dmail ${selectedDmailDID}`);
                return;
            }

            // Create a Blob from the buffer
            const blob = new Blob([buffer]);
            // Create a temporary link to trigger the download
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = name; // Use the item name as the filename
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(link.href);
        } catch (error) {
            showError(error);
        }
    }

    async function sendDmail() {
        try {
            const ok = await keymaster.sendDmail(dmailDID);

            if (ok) {
                showSuccess("Dmail sent successfully");
            } else {
                showError("Dmail send failed");
            }
        } catch (error) {
            showError(error);
        }
    }

    async function archiveDmail() {
        try {
            const tags = dmailList[selectedDmailDID]?.tags || [];
            await keymaster.fileDmail(selectedDmailDID, [...tags, DmailTags.ARCHIVED]);
            refreshDmail();
        } catch (error) {
            showError(error);
        }
    }

    async function unarchiveDmail() {
        try {
            const tags = dmailList[selectedDmailDID]?.tags || [];
            await keymaster.fileDmail(selectedDmailDID, tags.filter(tag => tag !== DmailTags.ARCHIVED));
            refreshDmail();
        } catch (error) {
            showError(error);
        }
    }

    async function deleteDmail() {
        try {
            const tags = dmailList[selectedDmailDID]?.tags || [];
            await keymaster.fileDmail(selectedDmailDID, [...tags, DmailTags.DELETED]);
            refreshDmail();
        } catch (error) {
            showError(error);
        }
    }

    async function undeleteDmail() {
        try {
            const tags = dmailList[selectedDmailDID]?.tags || [];
            await keymaster.fileDmail(selectedDmailDID, tags.filter(tag => tag !== DmailTags.DELETED));
            refreshDmail();
        } catch (error) {
            showError(error);
        }
    }

    async function revokeDmail() {
        try {
            if (await showConfirm(`Revoke Dmail?`)) {
                await keymaster.removeDmail(dmailDID);
                await keymaster.revokeDID(dmailDID);
                refreshDmail();
            }
        } catch (error) {
            showError(error);
        }
    }

    async function clearSendDmail() {
        setDmailDID('');
        setDmailTo('');
        setDmailToList([]);
        setDmailCc('');
        setDmailCcList([]);
        setDmailSubject('');
        setDmailBody('');
        setDmailAttachments({});
        setDmailForwarding('');
        setDmailEphemeral(false);
        setDmailValidUntil('');
        setDmailReference('');
    }

    async function forwardDmail() {
        if (!selectedDmail) return;

        clearSendDmail();

        setDmailForwarding(selectedDmailDID);
        setDmailSubject(`Fwd: ${selectedDmail.message.subject}`);
        setDmailBody(`On ${selectedDmail.date} ${selectedDmail.sender} wrote:\n\n${selectedDmail.message.body}`);
        setDmailTab('compose');
    }

    async function replyDmail() {
        if (!selectedDmail) return;

        clearSendDmail();

        setDmailSubject(`Re: ${selectedDmail.message.subject}`);
        setDmailBody(`On ${selectedDmail.date} ${selectedDmail.sender} wrote:\n\n${selectedDmail.message.body}`);
        setDmailTo(selectedDmail.sender);
        setDmailReference(selectedDmailDID);
        setDmailTab('compose');
    }

    async function replyAllDmail() {
        if (!selectedDmail) return;

        clearSendDmail();

        setDmailSubject(`Re: ${selectedDmail.message.subject}`);
        setDmailBody(`On ${selectedDmail.date} ${selectedDmail.sender} wrote:\n\n${selectedDmail.message.body}`);
        setDmailTo(selectedDmail.sender);
        setDmailToList(selectedDmail.to);
        setDmailCcList(selectedDmail.cc);
        setDmailReference(selectedDmailDID);
        setDmailTab('compose');
    }

    async function editDmail() {
        if (!selectedDmail) return;

        clearSendDmail();

        setDmailDID(selectedDmailDID);

        if (selectedDmail.to.length === 1) {
            setDmailTo(selectedDmail.to[0]);
        } else {
            setDmailToList(selectedDmail.to);
        }

        if (selectedDmail.cc.length === 1) {
            setDmailCc(selectedDmail.cc[0]);
        } else {
            setDmailCcList(selectedDmail.cc);
        }

        setDmailSubject(selectedDmail.message.subject);
        setDmailBody(selectedDmail.message.body);
        setDmailAttachments(selectedDmail.attachments || {});
        setDmailTab('compose');
    }

    function isDmailUnread(item) {
        return item.tags && item.tags.includes(DmailTags.UNREAD);
    }

    async function markDmailUnread() {
        try {
            const tags = dmailList[selectedDmailDID]?.tags || [];

            if (!tags.includes(DmailTags.UNREAD)) {
                const selectedDID = selectedDmailDID;
                await keymaster.fileDmail(selectedDmailDID, [...tags, DmailTags.UNREAD]);
                await refreshDmail();
                setSelectedDmailDID(selectedDID);
            }
        } catch (error) {
            showError(error);
        }
    }

    async function markDmailRead() {
        try {
            const tags = dmailList[selectedDmailDID]?.tags || [];

            if (tags.includes(DmailTags.UNREAD)) {
                const selectedDID = selectedDmailDID;
                await keymaster.fileDmail(selectedDmailDID, tags.filter(tag => tag !== DmailTags.UNREAD));
                await refreshDmail();
                setSelectedDmailDID(selectedDID);
            }
        } catch (error) {
            showError(error);
        }
    }

    function searchDmail() {
        const q = dmailSearchQuery.trim().toLowerCase();
        const res = {};

        if (q) {
            Object.entries(dmailList).forEach(([did, item]) => {
                const body = item.message.body.toLowerCase();
                const subj = item.message.subject.toLowerCase();
                const from = item.sender.toLowerCase();
                const tocc = [...item.to, ...(item.cc ?? [])].join(", ").toLowerCase();

                if (body.includes(q) || subj.includes(q) || from.includes(q) || tocc.includes(q)) {
                    res[did] = item;
                }
            });
        }

        setDmailSearchResults(res);
        setSelectedDmailDID('');
        setDmailTab('results');
    }

    async function clearDmailSearch() {
        setDmailSearchQuery('');
        setDmailSearchResults({});
    }

    async function addDmailContact(senderDID) {
        setAliasDID(senderDID);
        resolveAlias(senderDID);
        setTab('aliases');
    }

    async function showMnemonic() {
        try {
            const response = await keymaster.decryptMnemonic();
            setMnemonicString(response);
        } catch (error) {
            showError(error);
        }
    }

    async function hideMnemonic() {
        setMnemonicString('');
    }

    async function newWallet() {
        try {
            if (await showConfirm(`Overwrite wallet with new one?`)) {
                await keymaster.newWallet(null, true);
                refreshAll();
            }
        } catch (error) {
            showError(error);
        }
    }

    async function importWallet() {
        try {
            const mnenomic = await showPrompt("Overwrite wallet with mnemonic:");

            if (mnenomic) {
                await keymaster.newWallet(mnenomic, true);
                await keymaster.recoverWallet();
                refreshAll();
            }
        } catch (error) {
            showError(error);
        }
    }

    async function backupWallet() {
        try {
            await keymaster.backupWallet();
            showSuccess('Wallet backup successful')

        } catch (error) {
            showError(error);
        }
    }

    async function recoverWallet() {
        try {
            if (await showConfirm(`Overwrite wallet from backup?`)) {
                await keymaster.recoverWallet();
                refreshAll();
            }
        } catch (error) {
            showError(error);
        }
    }

    async function checkWallet() {
        setCheckingWallet(true);
        try {
            const { checked, invalid, deleted } = await keymaster.checkWallet();

            if (invalid === 0 && deleted === 0) {
                showError(`${checked} DIDs checked, no problems found`);
            }
            else if (await showConfirm(`${checked} DIDs checked\n${invalid} invalid DIDs found\n${deleted} deleted DIDs found\n\nFix wallet?`)) {
                const { idsRemoved, ownedRemoved, heldRemoved, aliasesRemoved } = await keymaster.fixWallet();
                showError(`${idsRemoved} IDs removed\n${ownedRemoved} owned DIDs removed\n${heldRemoved} held DIDs removed\n${aliasesRemoved} aliases removed`);
                refreshAll();
            }

        } catch (error) {
            showError(error);
        }
        setCheckingWallet(false);
    }

    async function showWallet() {
        try {
            const wallet = await keymaster.loadWallet();
            setWalletString(JSON.stringify(wallet, null, 4));
        } catch (error) {
            showError(error);
        }
    }

    async function hideWallet() {
        setWalletString('');
    }

    async function uploadWallet() {
        try {
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = 'application/json';

            fileInput.onchange = async (event) => {
                const file = event.target.files[0];
                if (!file) {
                    return;
                }

                const text = await file.text();
                let wallet;
                try {
                    wallet = JSON.parse(text);
                } catch {
                    showError("Invalid JSON file.");
                }

                if (!await showConfirm('Overwrite wallet with upload?')) {
                    return;
                }

                if (onWalletUpload) {
                    await onWalletUpload(wallet);
                    await refreshAll();
                    return;
                }

                const backupWallet = await keymaster.exportEncryptedWallet();

                try {
                    await keymaster.saveWallet(wallet, true);
                    await keymaster.loadWallet();
                    refreshAll();
                } catch (e) {
                    try {
                        await keymaster.saveWallet(backupWallet, true);
                    } catch { }
                    window.alert('Upload rejected: the server could not decrypt the wallet with its configured passphrase.');
                }
            };

            fileInput.click();
        }
        catch (error) {
            showError(error);
        }
    }

    async function downloadWallet() {
        try {
            const wallet = await keymaster.exportEncryptedWallet();
            const walletJSON = JSON.stringify(wallet, null, 4);
            const blob = new Blob([walletJSON], { type: 'application/json' });
            const url = URL.createObjectURL(blob);

            const link = document.createElement('a');
            link.href = url;
            link.download = 'archon-wallet.json';
            link.click();

            // The URL.revokeObjectURL() method releases an existing object URL which was previously created by calling URL.createObjectURL().
            URL.revokeObjectURL(url);
        } catch (error) {
            showError(error);
        }
    }

    async function changePassphrase() {
        try {
            const newPass = await showPrompt("Enter new passphrase:");
            if (!newPass) {
                return;
            }
            const confirmPassphrase = await showPrompt("Confirm new passphrase:");
            if (newPass !== confirmPassphrase) {
                showError("Passphrases do not match");
                return;
            }
            await keymaster.changePassphrase(newPass);
            showSuccess('Passphrase changed');
        } catch (error) {
            showError(error);
        }
    }

    async function uploadImage(event) {
        try {
            const fileInput = event.target; // Reference to the input element
            const file = fileInput.files[0];

            if (!file) return;

            // Reset the input value to allow selecting the same file again
            fileInput.value = "";

            // Read the file as a binary buffer
            const reader = new FileReader();

            reader.onload = async (e) => {
                try {
                    const arrayBuffer = e.target.result;
                    const buffer = Buffer.from(arrayBuffer);
                    const did = await keymaster.createImage(buffer, { registry });

                    const aliasList = await keymaster.listAliases();
                    // Names have a 32-character limit. Truncating to 26 characters and appending a number if needed.
                    let alias = file.name.slice(0, 26);
                    let count = 1;

                    while (alias in aliasList) {
                        alias = `${file.name.slice(0, 26)} (${count++})`;
                    }

                    await keymaster.addAlias(alias, did);
                    showSuccess(`Image uploaded successfully: ${alias}`);

                    refreshNames();
                    selectImage(alias);
                } catch (error) {
                    // Catch errors from the Keymaster API or other logic
                    showError(`Error processing image: ${error}`);
                }
            };

            reader.onerror = (error) => {
                showError(`Error reading file: ${error}`);
            };

            reader.readAsArrayBuffer(file);
        } catch (error) {
            showError(`Error uploading image: ${error}`);
        }
    }

    async function updateImage(event) {
        try {
            const fileInput = event.target; // Reference to the input element
            const file = fileInput.files[0];

            if (!file) return;

            // Reset the input value to allow selecting the same file again
            fileInput.value = "";

            // Read the file as a binary buffer
            const reader = new FileReader();

            reader.onload = async (e) => {
                try {
                    const arrayBuffer = e.target.result;
                    const buffer = Buffer.from(arrayBuffer);

                    await keymaster.updateImage(selectedImageName, buffer);

                    showSuccess(`Image updated successfully`);
                    selectImage(selectedImageName);
                } catch (error) {
                    showError(`Error processing image: ${error}`);
                }
            };

            reader.onerror = (error) => {
                showError(`Error reading file: ${error}`);
            };

            reader.readAsArrayBuffer(file);
        } catch (error) {
            showError(`Error uploading image: ${error}`);
        }
    }

    async function selectImage(imageName) {
        try {
            setSelectedImageURL('');

            const docs = await keymaster.resolveDID(imageName);
            const versions = docs.didDocumentMetadata.version ?? 1;
            const data = docs.didDocumentData;

            setSelectedImageName(imageName);
            setSelectedImageDocs(docs);
            setSelectedImage({ file: data.file, image: data.image });
            setSelectedImageOwned(docs.didDocumentMetadata.isOwned);
            setSelectedImageURL(`${serverUrl}/api/v1/ipfs/data/${data.file.cid}`);
            setImageVersion(versions);
            setImageVersionMax(versions);
        } catch (error) {
            showError(error);
        }
    }

    async function selectImageVersion(version) {
        try {
            setSelectedImageURL('');

            const docs = await keymaster.resolveDID(selectedImageName, { versionSequence: version });
            const data = docs.didDocumentData;

            setSelectedImageDocs(docs);
            setSelectedImage({ file: data.file, image: data.image });
            setSelectedImageURL(`${serverUrl}/api/v1/ipfs/data/${data.file.cid}`);
            setImageVersion(version);
        } catch (error) {
            showError(error);
        }
    }

    function streamFileToServer(file) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) {
                    setUploadProgress({ loaded: e.loaded, total: e.total });
                }
            };
            xhr.onload = () => {
                setUploadProgress(null);
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(xhr.responseText);
                } else {
                    reject(new Error(`Upload failed: ${xhr.responseText}`));
                }
            };
            xhr.onerror = () => {
                setUploadProgress(null);
                reject(new Error('Upload failed: network error'));
            };
            xhr.open('POST', `${serverUrl}/api/v1/ipfs/stream`);
            xhr.setRequestHeader('Content-Type', 'application/octet-stream');
            xhr.send(file);
        });
    }

    async function uploadFile(event) {
        try {
            const fileInput = event.target;
            const file = fileInput.files[0];

            if (!file) return;

            fileInput.value = "";

            const cid = await streamFileToServer(file);
            const fileAsset = { cid, filename: file.name, type: file.type || 'application/octet-stream', bytes: file.size };

            // Names have a 32-character limit. Truncating to 26 characters and appending a number if needed.
            const names = await keymaster.listAliases();
            let alias = file.name.slice(0, 26);
            let count = 1;

            while (alias in names) {
                alias = `${file.name.slice(0, 26)} (${count++})`;
            }

            const did = await keymaster.createAsset({ file: fileAsset }, { registry });
            await keymaster.addAlias(alias, did);
            showSuccess(`File uploaded successfully: ${alias}`);
            refreshNames();
        } catch (error) {
            showError(`Error uploading file: ${error}`);
        }
    }

    async function updateFile(event) {
        try {
            const fileInput = event.target;
            const file = fileInput.files[0];

            if (!file) return;

            fileInput.value = "";

            const cid = await streamFileToServer(file);
            const fileAsset = { cid, filename: file.name, type: file.type || 'application/octet-stream', bytes: file.size };

            const did = aliasList[selectedFileName];
            await keymaster.mergeData(did, { file: fileAsset });
            showSuccess(`File updated successfully`);
            selectFile(selectedFileName);
        } catch (error) {
            showError(`Error updating file: ${error}`);
        }
    }

    async function selectFile(fileName) {
        try {
            const docs = await keymaster.resolveDID(fileName);
            const versions = docs.didDocumentMetadata.version ?? 1;
            const file = docs.didDocumentData.file;

            setSelectedFileName(fileName);
            setSelectedFileDocs(docs);
            setSelectedFile(file);
            setSelectedFileOwned(docs.didDocumentMetadata.isOwned);
            setSelectedFileURL(`${serverUrl}/api/v1/ipfs/stream/${file.cid}?filename=${encodeURIComponent(file.filename || 'download.bin')}&type=${encodeURIComponent(file.type || 'application/octet-stream')}`)
            setFileVersion(versions);
            setFileVersionMax(versions);
        } catch (error) {
            showError(error);
        }
    }

    async function selectFileVersion(version) {
        try {
            const docs = await keymaster.resolveDID(selectedFileName, { versionSequence: version });
            const file = docs.didDocumentData.file;

            setSelectedFileDocs(docs);
            setSelectedFile(file);
            setSelectedFileURL(`${serverUrl}/api/v1/ipfs/stream/${file.cid}?filename=${encodeURIComponent(file.filename || 'download.bin')}&type=${encodeURIComponent(file.type || 'application/octet-stream')}`)
            setFileVersion(version);
        } catch (error) {
            showError(error);
        }
    }

    async function downloadFile() {
        const link = document.createElement('a');
        link.href = selectedFileURL;
        link.download = selectedFile.filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    async function createVault() {
        try {
            if (vaultName in aliasList) {
                alert(`${vaultName} already in use`);
                return;
            }

            const alias = vaultName;
            setVaultName('');

            await keymaster.createVault({ registry, alias });

            refreshNames();
            setSelectedVaultName(alias);
            refreshVault(alias);
        } catch (error) {
            showError(error);
        }
    }

    async function refreshVault(vaultName) {
        try {
            const docs = await keymaster.resolveDID(vaultName);

            setSelectedVaultName(vaultName);
            setSelectedVaultOwned(docs.didDocument.controller === currentDID);
            setVaultMember('');

            const vaultMembers = await keymaster.listVaultMembers(vaultName);
            const vaultItems = await keymaster.listVaultItems(vaultName);

            const members = Object.keys(vaultMembers);
            const items = Object.keys(vaultItems);

            setSelectedVault({ members, vaultMembers, items, vaultItems });
        } catch (error) {
            setSelectedVaultName('');
            setSelectedVaultOwned(false);
            setSelectedVault(null)
            showError(error);
        }
    }

    async function addVaultMember(did) {
        try {
            await keymaster.addVaultMember(selectedVaultName, did);
            refreshVault(selectedVaultName);
        } catch (error) {
            showError(error);
        }
    }

    async function removeVaultMember(did) {
        try {
            if (await showConfirm(`Remove member from ${selectedVaultName}?`)) {
                await keymaster.removeVaultMember(selectedVaultName, did);
                refreshVault(selectedVaultName);
            }
        } catch (error) {
            showError(error);
        }
    }

    async function uploadVaultItem(event) {
        try {
            const fileInput = event.target; // Reference to the input element
            const file = fileInput.files[0];

            if (!file) return;

            // Reset the input value to allow selecting the same file again
            fileInput.value = "";

            // Read the file as a binary buffer
            const reader = new FileReader();

            reader.onload = async (e) => {
                try {
                    const arrayBuffer = e.target.result;
                    const buffer = Buffer.from(arrayBuffer);

                    const ok = await keymaster.addVaultItem(selectedVaultName, file.name, buffer);

                    if (ok) {
                        showSuccess(`Item uploaded successfully: ${file.name}`);
                        refreshVault(selectedVaultName);
                    } else {
                        showError(`Error uploading file: ${file.name}`);
                    }
                } catch (error) {
                    // Catch errors from the Keymaster API or other logic
                    showError(`Error uploading file: ${error}`);
                }
            };

            reader.onerror = (error) => {
                showError(`Error uploading file: ${error}`);
            };

            reader.readAsArrayBuffer(file);
        } catch (error) {
            showError(`Error uploading file: ${error}`);
        }
    }

    async function addLoginVaultItem(service, username, password) {
        try {
            if (
                !service || !service.trim() ||
                !username || !username.trim() ||
                !password || !password.trim()
            ) {
                showError("Service, username, and password are required");
                return;
            }

            service = service.trim();
            username = username.trim();

            const name = `login: ${service}`;
            const login = {
                service,
                username,
                password
            };
            const buffer = Buffer.from(JSON.stringify({ login }), 'utf-8');
            const ok = await keymaster.addVaultItem(selectedVaultName, name, buffer);

            setEditLoginOpen(false);

            if (ok) {
                showSuccess(`Login added successfully: ${service}`);
                refreshVault(selectedVaultName);
            } else {
                showError(`Error adding login: ${service}`);
            }
        } catch (error) {
            showError(error);
        }
    }

    function isVaultItemFile(item) {
        if (item.type === 'application/json') {
            return false;
        }

        return true;
    }

    async function downloadVaultItem(name) {
        try {
            const buffer = await keymaster.getVaultItem(selectedVaultName, name);

            if (!buffer) {
                showError(`Item ${name} not found in vault ${selectedVaultName}`);
                return;
            }

            // Create a Blob from the buffer
            const blob = new Blob([buffer]);
            // Create a temporary link to trigger the download
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = name; // Use the item name as the filename
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(link.href);
        } catch (error) {
            showError(error);
        }
    }

    async function revealVaultItem(name) {
        try {
            const buffer = await keymaster.getVaultItem(selectedVaultName, name);

            if (!buffer) {
                showError(`Item ${name} not found in vault ${selectedVaultName}`);
                return;
            }

            const item = JSON.parse(buffer.toString('utf-8'));

            if (item.login) {
                setRevealLogin(item.login);
                setRevealLoginOpen(true);
                return;
            }

            if (item.dmail) {
                setRevealDmail(item.dmail);
                setRevealDmailOpen(true);
                return;
            }

            showError(`Unknown item type ${name}`);
        } catch (error) {
            showError(error);
        }
    }

    async function removeVaultItem(name) {
        try {
            if (await showConfirm(`Remove item from ${selectedVaultName}?`)) {
                await keymaster.removeVaultItem(selectedVaultName, name);
                refreshVault(selectedVaultName);
            }
        } catch (error) {
            showError(error);
        }
    }

    function getVaultItemIcon(name, item) {
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

        // Add more types as needed, e.g. images, pdf, etc.
        return <AttachFile style={iconStyle} />;
    }

    const resetForm = () => {
        setPollName("");
        setDescription("");
        setOptionsStr("yes, no, abstain");
        setDeadline("");
        setCreatedPollDid("");
        setPollNoticeSent(false);
        setVoterInput("");
        setVoters({});
        sessionStorage.removeItem('createdPollDid');
    };

    // Persist createdPollDid across navigation
    useEffect(() => {
        if (createdPollDid) {
            sessionStorage.setItem('createdPollDid', createdPollDid);
        }
    }, [createdPollDid]);

    useEffect(() => {
        const saved = sessionStorage.getItem('createdPollDid');
        if (saved && keymaster && !createdPollDid) {
            keymaster.getPoll(saved).then((config) => {
                if (config) {
                    setCreatedPollDid(saved);
                    setPollName(config.name || "");
                    setDescription(config.description || "");
                    setOptionsStr(config.options?.join(", ") || "");
                    setDeadline(config.deadline ? config.deadline.slice(0, 16) : "");
                    refreshVoters(saved);
                } else {
                    sessionStorage.removeItem('createdPollDid');
                }
            }).catch(() => {
                sessionStorage.removeItem('createdPollDid');
            });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [keymaster]);

    const arraysEqual = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

    const refreshInbox = useCallback(async () => {
        try {
            const msgs = await keymaster.listDmail();
            if (JSON.stringify(msgs) !== JSON.stringify(dmailList)) {
                setDmailList(msgs || {});
            }
        } catch (err) {
            showError(err);
        }
    }, [keymaster, dmailList]);

    const refreshPoll = useCallback(async () => {
        try {
            const walletAliases = await keymaster.listAliases();
            const names = Object.keys(walletAliases).sort((a, b) =>
                a.localeCompare(b)
            );

            const extraNames = {};
            const polls = [];

            for (const alias of names) {
                try {
                    const doc = await keymaster.resolveDID(alias);
                    if (doc?.didDocumentData?.vault) {
                        const isPoll = await keymaster.testPoll(alias);
                        if (isPoll) {
                            polls.push(alias);
                        }
                    }
                } catch { }
            }

            if (!arraysEqual(polls, pollList)) {
                for (const n of polls) {
                    if (!(n in aliasList)) {
                        extraNames[n] = walletAliases[n];
                    }
                }
                if (Object.keys(extraNames).length) {
                    setAliasList((prev) => ({ ...prev, ...extraNames }));
                }
                setPollList(polls);
            }
        } catch { }
    }, [keymaster, aliasList, pollList]);

    useEffect(() => {
        if (refreshIntervalSeconds === 0) {
            return undefined;
        }

        const interval = setInterval(async () => {
            try {
                await keymaster.refreshNotices();
                await refreshInbox();
                await refreshPoll();
            } catch { }
        }, refreshIntervalSeconds * 1000);

        return () => clearInterval(interval);

    }, [keymaster, refreshInbox, refreshPoll, refreshIntervalSeconds]);

    const saveSettings = () => {
        const trimmedUrl = settingsUrl.trim();
        const parsedInterval = Number(settingsRefreshIntervalSeconds);

        if (!Number.isFinite(parsedInterval) || parsedInterval < 0) {
            showError({ message: 'Refresh interval must be 0 or greater' });
            return;
        }

        const nextInterval = Math.floor(parsedInterval);
        localStorage.setItem(REFRESH_INTERVAL_STORAGE_KEY, String(nextInterval));
        setRefreshIntervalSeconds(nextInterval);
        setSettingsRefreshIntervalSeconds(nextInterval);

        if (trimmedUrl !== (serverUrl || '')) {
            onServerUrlChange && onServerUrlChange(trimmedUrl);
            return;
        }

        showSuccess(nextInterval === 0
            ? 'Settings saved. Auto-refresh disabled.'
            : `Settings saved. Auto-refresh every ${nextInterval} seconds.`);
    };

    const buildPoll = async () => {
        const template = await keymaster.pollTemplate();

        if (!pollName.trim()) {
            showError("Poll name is required");
            return null;
        }
        if (pollName in aliasList) {
            showError(`Name "${pollName}" is already in use`);
            return null;
        }
        if (!description.trim()) {
            showError("Description is required");
            return null;
        }
        if (!deadline) {
            showError("Deadline is required");
            return null;
        }
        const options = optionsStr
            .split(/[,\n]/)
            .map((o) => o.trim())
            .filter(Boolean);

        if (options.length < 2 || options.length > 10) {
            showError("Provide between 2 and 10 options");
            return null;
        }

        return {
            ...template,
            name: pollName.trim(),
            description: description.trim(),
            options,
            deadline: new Date(deadline).toISOString(),
        };
    };

    const handleCreatePoll = async () => {
        const poll = await buildPoll();
        if (!poll) {
            return;
        }

        try {
            const did = await keymaster.createPoll(poll, { registry });
            setCreatedPollDid(did);
            setPollNoticeSent(false);
            await keymaster.addAlias(pollName, did);
            await refreshNames();
            showSuccess(`Poll created: ${did}`);
        } catch (e) {
            showError(e);
        }
    };

    const refreshVoters = async (pollDid) => {
        try {
            const map = await keymaster.listPollVoters(pollDid);
            setVoters(map);
        } catch {
            setVoters({});
        }
    };

    const handleAddVoter = async () => {
        if (!createdPollDid || !voterInput.trim()) return;
        try {
            await keymaster.addPollVoter(createdPollDid, voterInput.trim());
            setVoterInput("");
            await refreshVoters(createdPollDid);
        } catch (e) {
            showError(e);
        }
    };

    const handleRemoveVoter = async (did) => {
        if (!createdPollDid) return;
        try {
            await keymaster.removePollVoter(createdPollDid, did);
            await refreshVoters(createdPollDid);
        } catch (e) {
            showError(e);
        }
    };

    const handleSendPoll = async () => {
        if (!createdPollDid) {
            return;
        }
        try {
            await keymaster.sendPoll(createdPollDid);
            showSuccess("Poll notice sent");
            setPollNoticeSent(true);
            sessionStorage.removeItem('createdPollDid');
        } catch (e) {
            showError(e);
        }
    };

    const handleSelectPoll = async (evt) => {
        const alias = evt.target.value;
        setSelectedPollName(alias);
        setSelectedPollDesc("");
        setSelectedOptionIdx(0);
        setSpoil(false);
        setHasVoted(false);
        setLastBallotDid("");
        setBallotSent(false);
        setPollController("");
        setPollResults(null);
        setPollPublished(false);

        try {
            const did = aliasList[alias] ?? "";
            if (!did) {
                return;
            }

            const poll = await keymaster.getPoll(did);
            setSelectedPollDesc(poll?.description ?? "");
            setPollOptions(poll?.options ?? []);
            setPollDeadline(poll?.deadline ? new Date(poll.deadline) : null);

            const didDoc = await keymaster.resolveDID(did);
            setPollController(didDoc?.didDocument?.controller ?? "");

            const view = await keymaster.viewPoll(did);
            setCanVote(view.isEligible);
            setHasVoted(view.hasVoted);
            if (view.results) {
                setPollResults(view.results);
                setPollPublished(true);
            }
        } catch (e) {
            showError(e);
            setPollOptions([]);
        }
    };

    const handleVote = async () => {
        if (!selectedPollDid) {
            return;
        }
        try {
            const voteVal = spoil ? 0 : selectedOptionIdx + 1;
            const ballotDid = await keymaster.votePoll(
                selectedPollDid,
                voteVal,
            );
            setLastBallotDid(ballotDid);
            setHasVoted(true);
            if (currentDID && currentDID === pollController) {
                setBallotSent(true);
                await keymaster.updatePoll(ballotDid);
                showSuccess("Poll updated");
            } else {
                setBallotSent(false);
                showSuccess("Ballot created");
            }
        } catch (e) {
            showError(e);
        }
    };

    const handleSendBallot = async () => {
        if (!lastBallotDid || !selectedPollDid) {
            return;
        }
        try {
            await keymaster.sendBallot(lastBallotDid, selectedPollDid);
            showSuccess("Ballot sent");
            setBallotSent(true);
        } catch (e) {
            showError(e);
        }
    };

    const handleTogglePublish = async () => {
        if (!selectedPollDid) {
            return;
        }
        try {
            if (pollPublished) {
                await keymaster.unpublishPoll(selectedPollDid);
                setPollPublished(false);
                setPollResults(null);
                showSuccess("Poll unpublished");
            } else {
                await keymaster.publishPoll(selectedPollDid);
                const view = await keymaster.viewPoll(selectedPollDid);
                if (view.results) setPollResults(view.results);
                setPollPublished(true);
                showSuccess("Poll published");
            }
        } catch (e) {
            showError(e);
        }
    };

    const handleViewResults = () => {
        if (!pollResults) {
            return;
        }
        setPollResultsOpen(true);
    };

    const handleViewPoll = async () => {
        if (!selectedPollDid) {
            return;
        }
        try {
            const view = await keymaster.viewPoll(selectedPollDid);
            if (view.results) {
                setPollResults(view.results);
                setPollResultsOpen(true);
            }
        } catch (e) {
            showError(e);
        }
    };

    async function confirmRemovePoll() {
        if (!removePollName) {
            return;
        }
        try {
            await keymaster.removeAlias(removePollName);
            await refreshNames();
            setSelectedPollName("");
            setSelectedPollDesc("");
            setPollOptions([]);
            setPollResults(null);
            setPollController("");
            showSuccess(`Removed '${removePollName}'`);
        } catch (err) {
            showError(err);
        }
        setRemovePollOpen(false);
        setRemovePollName("");
    }

    useEffect(() => {
        if (!keymaster || !currentDID || pollList.length === 0) {
            return;
        }

        (async () => {
            const map = {};

            for (const alias of pollList) {
                const did = aliasList[alias];
                try {
                    const poll = await keymaster.getPoll(did);
                    map[alias] = !!poll;
                } catch {
                    map[alias] = false;
                }
            }
            setEligiblePolls(map);
        })();
    }, [pollList, aliasList, keymaster, currentDID]);

    const openRenameModal = () => {
        setRenameOldPollName(selectedPollName);
        setRenamePollOpen(true);
    };

    const handleRenameSubmit = async (newName) => {
        setRenamePollOpen(false);
        if (!newName || newName === selectedPollName) {
            return;
        }
        try {
            await keymaster.addAlias(newName, selectedPollDid);
            await keymaster.removeAlias(selectedPollName);
            await refreshNames();
            setSelectedPollName(newName);
            setRenameOldPollName("");
            showSuccess("Poll renamed");
        } catch (e) {
            showError(e);
        }
    };

    function RegistrySelect() {
        return (
            <Select
                style={{ width: '300px' }}
                value={registry}
                fullWidth
                displayEmpty
                onChange={(event) => setRegistry(event.target.value)}
            >
                <MenuItem value="" disabled>
                    Select registry
                </MenuItem>
                {registries.map((registry, index) => (
                    <MenuItem value={registry} key={index}>
                        {registry}
                    </MenuItem>
                ))}
            </Select>
        );
    }

    function VersionsNavigator({ version, maxVersion, selectVersion }) {
        const versions = Array.from({ length: maxVersion }, (_, i) => i + 1);

        return (
            <Grid container direction="row" justifyContent="flex-start" alignItems="center" spacing={3}>
                <Grid item>
                    <Button variant="contained" color="primary" onClick={() => selectVersion(1)} disabled={version === 1}>
                        First
                    </Button>
                </Grid>
                <Grid item>
                    <Button variant="contained" color="primary" onClick={() => selectVersion(version - 1)} disabled={version === 1}>
                        Prev
                    </Button>
                </Grid>
                <Grid item>
                    <Select
                        style={{ width: '150px' }}
                        value={version}
                        fullWidth
                        onChange={(event) => selectVersion(event.target.value)}
                    >
                        {versions.map((version, index) => (
                            <MenuItem value={version} key={index}>
                                version {version}
                            </MenuItem>
                        ))}
                    </Select>
                </Grid>
                <Grid item>
                    <Button variant="contained" color="primary" onClick={() => selectVersion(version + 1)} disabled={version === maxVersion}>
                        Next
                    </Button>
                </Grid>
                <Grid item>
                    <Button variant="contained" color="primary" onClick={() => selectVersion(maxVersion)} disabled={version === maxVersion}>
                        Last
                    </Button>
                </Grid>
            </Grid>
        );
    }

    function LoginDialog({ open, onClose, onOK, login, readOnly }) {
        const [service, setService] = useState('');
        const [username, setUsername] = useState('');
        const [password, setPassword] = useState('');

        useEffect(() => {
            setService(login?.service || '');
            setUsername(login?.username || '');
            setPassword(login?.password || '');
        }, [login, open]);

        const handleSubmit = () => {
            if (onOK) {
                onOK(service, username, password);
            } else {
                onClose();
            }
        };

        const handleClose = () => {
            setService('');
            setUsername('');
            setPassword('');
            onClose();
        };

        return (
            <Dialog open={open} onClose={handleClose}>
                <DialogTitle>Login</DialogTitle>
                <DialogContent>
                    <TextField
                        autoFocus
                        margin="dense"
                        label="Service"
                        fullWidth
                        value={service}
                        onChange={e => setService(e.target.value)}
                        InputProps={{ readOnly }}
                    />
                    <TextField
                        margin="dense"
                        label="Username"
                        fullWidth
                        value={username}
                        onChange={e => setUsername(e.target.value)}
                        InputProps={{ readOnly }}
                    />
                    <TextField
                        margin="dense"
                        label="Password"
                        fullWidth
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        InputProps={{ readOnly }}
                    />
                </DialogContent>
                <DialogActions>
                    <Button onClick={handleClose} variant="contained" color="primary">Cancel</Button>
                    <Button onClick={handleSubmit} variant="contained" color="primary" disabled={!service || !username || !password}>
                        OK
                    </Button>
                </DialogActions>
            </Dialog>
        );
    }

    function DmailDialog({ open, onClose, onOK, dmail, readOnly }) {
        const [toList, setToList] = useState([]);
        const [ccList, setCcList] = useState([]);
        const [subject, setSubject] = useState('');
        const [body, setBody] = useState('');

        useEffect(() => {
            setToList(dmail?.to || []);
            setCcList(dmail?.cc || []);
            setSubject(dmail?.subject || '');
            setBody(dmail?.body || '');
        }, [dmail, open]);

        const handleSubmit = () => {
            if (onOK) {
                onOK();
            } else {
                onClose();
            }
        };

        const handleClose = () => {
            setToList([]);
            setCcList([]);
            setSubject('');
            setBody('')
            onClose();
        };

        return (
            <Dialog open={open} onClose={handleClose}>
                <DialogTitle>Dmail</DialogTitle>
                <DialogContent>
                    <TextField
                        autoFocus
                        margin="dense"
                        label="To"
                        fullWidth
                        value={toList.join(', ')}
                        onChange={e => setToList(e.target.value)}
                        InputProps={{ readOnly }}
                    />
                    <TextField
                        autoFocus
                        margin="dense"
                        label="cc"
                        fullWidth
                        value={ccList.join(', ')}
                        onChange={e => setCcList(e.target.value)}
                        InputProps={{ readOnly }}
                    />
                    <TextField
                        margin="dense"
                        label="Subject"
                        fullWidth
                        value={subject}
                        onChange={e => setSubject(e.target.value)}
                        InputProps={{ readOnly }}
                    />
                    <TextField
                        margin="dense"
                        label="Body"
                        fullWidth
                        multiline
                        minRows={10}
                        maxRows={30}
                        value={body}
                        onChange={e => setBody(e.target.value)}
                        InputProps={{ readOnly }}
                    />
                </DialogContent>
                <DialogActions>
                    <Button onClick={handleClose} variant="contained" color="primary">Cancel</Button>
                    <Button onClick={handleSubmit} variant="contained" color="primary" disabled={!subject || !body}>
                        OK
                    </Button>
                </DialogActions>
            </Dialog>
        );
    }

    const filteredDmailList = useMemo(() => {
        if (dmailTab === 'all') {
            return dmailList;
        }

        if (dmailTab === "results") {
            return dmailSearchResults;
        }

        let filtered = {};

        for (const [did, item] of Object.entries(dmailList)) {
            const has = (tag) => item.tags.includes(tag);
            const not = (tag) => !has(tag);

            if (dmailTab === 'inbox' && has(DmailTags.INBOX) && not(DmailTags.DELETED) && not(DmailTags.ARCHIVED)) {
                filtered[did] = item;
            } else if (dmailTab === 'outbox' && has(DmailTags.SENT) && not(DmailTags.DELETED) && not(DmailTags.ARCHIVED)) {
                filtered[did] = item;
            } else if (dmailTab === 'drafts' && has(DmailTags.DRAFT) && not(DmailTags.DELETED) && not(DmailTags.ARCHIVED)) {
                filtered[did] = item;
            } else if (dmailTab === 'archive' && has(DmailTags.ARCHIVED) && not(DmailTags.DELETED)) {
                filtered[did] = item;
            } else if (dmailTab === 'trash' && has(DmailTags.DELETED)) {
                filtered[did] = item;
            }
        }

        return filtered;
    }, [dmailList, dmailSearchResults, dmailTab]);

    const sortedDmailEntries = useMemo(() => {
        const entries = Object.entries(filteredDmailList);
        const column = dmailSortBy;
        const direction = dmailSortOrder;

        const compare = (a, b) => {
            const itemA = a[1];
            const itemB = b[1];
            let valA, valB;
            if (column === 'sender') {
                valA = itemA.sender?.toLowerCase() || '';
                valB = itemB.sender?.toLowerCase() || '';
            } else if (column === 'subject') {
                valA = itemA.message?.subject?.toLowerCase() || '';
                valB = itemB.message?.subject?.toLowerCase() || '';
            } else if (column === 'date') {
                valA = new Date(itemA.date);
                valB = new Date(itemB.date);
            }
            if (valA < valB) return direction === 'asc' ? -1 : 1;
            if (valA > valB) return direction === 'asc' ? 1 : -1;
            return 0;
        };

        return entries.sort(compare);
    }, [filteredDmailList, dmailSortBy, dmailSortOrder]);

    const boxRow = { mt: 1, mb: 1, display: "flex", alignItems: "center", gap: 1 };

    return (
        <div className="App">

            <Snackbar
                open={snackbar.open}
                autoHideDuration={5000}
                onClose={handleSnackbarClose}
                anchorOrigin={{ vertical: "top", horizontal: "center" }}
            >
                <Alert
                    onClose={handleSnackbarClose}
                    severity={snackbar.severity}
                    sx={{ width: "100%" }}
                >
                    {snackbar.message}
                </Alert>
            </Snackbar>

            <Dialog open={showMigrateDialog} onClose={closeMigrate}>
                <DialogTitle>Migrate {migrateTarget}</DialogTitle>
                <DialogContent>
                    <Box sx={{ mt: 1 }}>
                        <RegistrySelect />
                    </Box>
                </DialogContent>
                <DialogActions>
                    <Button onClick={closeMigrate}>Cancel</Button>
                    <Button variant="contained" onClick={migrateId} disabled={!registry}>
                        Migrate
                    </Button>
                </DialogActions>
            </Dialog>

            <Dialog open={showCreateDialog} onClose={cancelCreate}>
                <DialogTitle>Create ID</DialogTitle>
                <DialogContent>
                    <Box sx={{ mt: 1, display: 'flex', flexDirection: 'column', gap: 2, minWidth: '320px' }}>
                        <TextField
                            label="Name"
                            value={newName}
                            onChange={(e) => setNewName(e.target.value.trim())}
                            fullWidth
                            autoFocus
                            inputProps={{ maxLength: 30 }}
                        />
                        <RegistrySelect />
                    </Box>
                </DialogContent>
                <DialogActions>
                    <Button onClick={cancelCreate}>Cancel</Button>
                    <Button variant="contained" onClick={createId} disabled={!newName || !registry}>
                        Create
                    </Button>
                </DialogActions>
            </Dialog>

            <Dialog open={showCloneDialog} onClose={closeClone}>
                <DialogTitle>Clone {selectedName}</DialogTitle>
                <DialogContent>
                    <Box sx={{ mt: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <TextField
                            label="Clone name"
                            value={cloneName}
                            onChange={(e) => setCloneName(e.target.value)}
                            fullWidth
                            autoFocus
                        />
                        <RegistrySelect />
                    </Box>
                </DialogContent>
                <DialogActions>
                    <Button onClick={closeClone}>Cancel</Button>
                    <Button variant="contained" onClick={cloneAsset} disabled={!cloneName || !registry}>
                        Clone
                    </Button>
                </DialogActions>
            </Dialog>

            <Dialog open={showChallengeDialog} onClose={closeChallengeDialog}>
                <DialogTitle>New Challenge</DialogTitle>
                <DialogContent>
                    <Typography variant="body2" sx={{ mb: 2 }}>
                        Add credential requirements. Leave empty for an open challenge.
                    </Typography>
                    <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mb: 2 }}>
                        <Select
                            value={challengeSchemaSelection}
                            onChange={(e) => setChallengeSchemaSelection(e.target.value)}
                            displayEmpty
                            size="small"
                            sx={{ minWidth: 180 }}
                        >
                            <MenuItem value="" disabled>Schema</MenuItem>
                            {schemaList && schemaList.map((s) => (
                                <MenuItem key={s} value={s}>{s}</MenuItem>
                            ))}
                        </Select>
                        <Select
                            value={challengeIssuerSelection}
                            onChange={(e) => setChallengeIssuerSelection(e.target.value)}
                            displayEmpty
                            size="small"
                            sx={{ minWidth: 180 }}
                        >
                            <MenuItem value="">Any issuer</MenuItem>
                            {agentList && agentList.map((s) => (
                                <MenuItem key={s} value={s}>{s}</MenuItem>
                            ))}
                        </Select>
                        <Button variant="contained" size="small" onClick={addChallengeCredential} disabled={!challengeSchemaSelection}>
                            Add
                        </Button>
                    </Box>
                    {challengeCredentials.length > 0 &&
                        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                            {challengeCredentials.map((cred, i) => (
                                <Chip
                                    key={i}
                                    label={cred.issuer ? `${cred.schema} (${cred.issuer})` : cred.schema}
                                    onDelete={() => removeChallengeCredential(i)}
                                />
                            ))}
                        </Box>
                    }
                </DialogContent>
                <DialogActions>
                    <Button onClick={closeChallengeDialog}>Cancel</Button>
                    <Button variant="contained" onClick={newChallenge}>
                        Create
                    </Button>
                </DialogActions>
            </Dialog>

            <Dialog open={confirmDialog.open} onClose={handleConfirmCancel}>
                <DialogContent>
                    <Box sx={{ whiteSpace: 'pre-line' }}>{confirmDialog.message}</Box>
                </DialogContent>
                <DialogActions>
                    <Button onClick={handleConfirmCancel}>Cancel</Button>
                    <Button variant="contained" onClick={handleConfirmOk} autoFocus>OK</Button>
                </DialogActions>
            </Dialog>

            <Dialog open={promptDialog.open} onClose={handlePromptCancel}>
                <DialogContent>
                    <Box sx={{ mb: 1 }}>{promptDialog.message}</Box>
                    <TextField
                        value={promptDialog.value}
                        onChange={(e) => setPromptDialog(d => ({ ...d, value: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === 'Enter') handlePromptOk(); }}
                        fullWidth
                        autoFocus
                        margin="dense"
                    />
                </DialogContent>
                <DialogActions>
                    <Button onClick={handlePromptCancel}>Cancel</Button>
                    <Button variant="contained" onClick={handlePromptOk}>OK</Button>
                </DialogActions>
            </Dialog>

            <header className="App-header">

                <h1>{title}</h1>

                <Grid container direction="row" justifyContent="flex-start" alignItems="center" spacing={3}>
                    <Grid item>
                        <Typography style={{ fontSize: '1.5em' }}>
                            ID:
                        </Typography>
                    </Grid>
                    <Grid item>
                        <Typography style={{ fontSize: '1.5em', fontWeight: 'bold' }}>
                            {currentId}
                        </Typography>
                    </Grid>
                    <Grid item>
                        <Typography style={{ fontSize: '1em', fontFamily: 'Courier' }}>
                            {currentDID}
                        </Typography>
                    </Grid>
                </Grid>

                <Box>
                    <Tabs
                        value={tab}
                        onChange={(event, newTab) => setTab(newTab)}
                        indicatorColor="primary"
                        textColor="primary"
                        variant="scrollable"
                        scrollButtons="auto"
                    >
                        {currentId &&
                            <Tab key="identity" value="identity" label={'Identities'} icon={<PermIdentity />} />
                        }
                        {currentId && !widget &&
                            <Tab key="aliases" value="aliases" label={'Aliases'} icon={<List />} />
                        }
                        {currentId && !widget &&
                            <Tab key="properties" value="properties" label={'Properties'} icon={<Tune />} />
                        }
                        {currentId && !widget &&
                            <Tab key="assets" value="assets" label={'Assets'} icon={<Token />} />
                        }
                        {currentId && !widget &&
                            <Tab key="credentials" value="credentials" label={'Credentials'} icon={<Badge />} />
                        }
                        {currentId && !widget &&
                            <Tab key="dmail" value="dmail" label={'Dmail'} icon={<Email />} />
                        }
                        {currentId && !widget &&
                            <Tab key="polls" value="polls" label={'Polls'} icon={<Poll />} />
                        }
                        {currentId && !widget && hasLightning &&
                            <Tab key="lightning" value="lightning" label={'Lightning'} icon={<Bolt />} />
                        }
                        {currentId &&
                            <Tab key="auth" value="auth" label={'Auth'} icon={<Key />} />
                        }
                        {currentId && accessGranted &&
                            <Tab key="access" value="access" label={'Access'} />
                        }
                        {!currentId &&
                            <Tab key="create" value="create" label={'Create ID'} icon={<PermIdentity />} />
                        }
                        <Tab key="wallet" value="wallet" label={'Wallet'} icon={<AccountBalanceWallet />} />
                        <Tab key="settings" value="settings" label={'Settings'} icon={<Settings />} />
                    </Tabs>
                </Box>
                <Box style={{ width: '90vw' }}>
                    {tab === 'identity' &&
                        <Box>
                            <Grid container direction="row" justifyContent="flex-start" alignItems="center" spacing={3}>
                                <Grid item>
                                    <Select
                                        style={{ width: '300px' }}
                                        value={selectedId}
                                        fullWidth
                                        onChange={(event) => selectId(event.target.value)}
                                    >
                                        {idList.map((idname, index) => (
                                            <MenuItem value={idname} key={index}>
                                                {idname}
                                            </MenuItem>
                                        ))}
                                    </Select>
                                </Grid>
                            </Grid>
                            <Box sx={{ mt: 2, mb: 2 }}>
                                <Tabs
                                    value={identityTab}
                                    onChange={(event, newTab) => setIdentityTab(newTab)}
                                    indicatorColor="primary"
                                    textColor="primary"
                                    variant="scrollable"
                                    scrollButtons="auto"
                                >
                                    <Tab key="details" value="details" label={'Details'} icon={<PermIdentity />} />
                                    <Tab key="addresses" value="addresses" label={'Addresses'} icon={<Badge />} />
                                    <Tab key="nostr" value="nostr" label={'Nostr'} icon={<Login />} />
                                </Tabs>
                            </Box>
                            <p />
                            {identityTab === 'details' &&
                                <Box>
                                    <Grid container direction="row" justifyContent="flex-start" alignItems="center" spacing={3}>
                                        <Grid item>
                                            <Button variant="contained" color="primary" onClick={showCreate}>
                                                Create...
                                            </Button>
                                        </Grid>
                                        <Grid item>
                                            <Button variant="contained" color="primary" onClick={renameId}>
                                                Rename...
                                            </Button>
                                        </Grid>
                                        <Grid item>
                                            <Button variant="contained" color="primary" onClick={removeId}>
                                                Remove...
                                            </Button>
                                        </Grid>
                                        <Grid item>
                                            <Button variant="contained" color="primary" onClick={backupId}>
                                                Backup...
                                            </Button>
                                        </Grid>
                                        <Grid item>
                                            <Button variant="contained" color="primary" onClick={recoverId}>
                                                Recover...
                                            </Button>
                                        </Grid>
                                        <Grid item>
                                            <Button variant="contained" color="primary" onClick={rotateKeys}>
                                                Rotate keys
                                            </Button>
                                        </Grid>
                                        <Grid item>
                                            <Button variant="contained" color="primary" onClick={() => openMigrate(selectedId)}>
                                                Migrate...
                                            </Button>
                                        </Grid>
                                    </Grid>
                                    {!widget &&
                                        <Box>
                                            <VersionsNavigator
                                                version={docsVersion}
                                                maxVersion={docsVersionMax}
                                                selectVersion={selectDocsVersion}
                                            />
                                            <br />
                                            <textarea
                                                value={docsString}
                                                readOnly
                                                style={{ width: '800px', height: '600px', overflow: 'auto' }}
                                            />
                                        </Box>
                                    }
                                </Box>
                            }
                            {identityTab === 'addresses' &&
                                <Box sx={{ width: '800px', maxWidth: '100%' }}>
                                    <Grid container spacing={1} style={{ marginBottom: '8px' }}>
                                        <Grid item xs={12} md={5}>
                                            <TextField
                                                label="Name"
                                                size="small"
                                                fullWidth
                                                value={addressInput}
                                                onChange={(e) => setAddressInput(e.target.value)}
                                                placeholder="name"
                                            />
                                        </Grid>
                                        <Grid item xs={12} md={3}>
                                            <TextField
                                                label="Domain"
                                                size="small"
                                                fullWidth
                                                value={addressDomain}
                                                onChange={(e) => setAddressDomain(e.target.value)}
                                                placeholder="example.com"
                                            />
                                        </Grid>
                                        <Grid item xs={12} md={4}>
                                            <Grid container spacing={1}>
                                                <Grid item>
                                                    <Button variant="contained" color="primary" onClick={checkAddressValue} disabled={addressBusy || !addressInput.trim() || !addressDomain.trim()}>
                                                        Check
                                                    </Button>
                                                </Grid>
                                                <Grid item>
                                                    <Button variant="contained" color="primary" onClick={addAddressValue} disabled={addressBusy || !addressInput.trim() || !addressDomain.trim()}>
                                                        Add
                                                    </Button>
                                                </Grid>
                                                <Grid item>
                                                    <Button variant="contained" color="primary" onClick={() => resolveStoredAddress(addressDomain)} disabled={addressBusy || !addressDomain.trim()}>
                                                        Get
                                                    </Button>
                                                </Grid>
                                                <Grid item>
                                                    <Button variant="contained" color="primary" onClick={importAddressDomain} disabled={addressBusy || !addressDomain.trim()}>
                                                        Import
                                                    </Button>
                                                </Grid>
                                                <Grid item>
                                                    <Button variant="contained" color="primary" onClick={() => removeAddressValue()} disabled={addressBusy || (!selectedAddress && (!addressInput.trim() || !addressDomain.trim()))}>
                                                        Remove
                                                    </Button>
                                                </Grid>
                                                <Grid item>
                                                    <Button variant="contained" color="primary" onClick={clearAddressFields} disabled={addressBusy || (!addressInput && !addressDomain && !selectedAddress && !addressDocs)}>
                                                        Clear
                                                    </Button>
                                                </Grid>
                                            </Grid>
                                        </Grid>
                                    </Grid>
                                    <TableContainer component={Paper} style={{ maxHeight: '260px', overflow: 'auto', marginBottom: '8px' }}>
                                        <Table stickyHeader style={{ width: '100%', tableLayout: 'fixed' }}>
                                            <colgroup>
                                                <col />
                                                <col style={{ width: '220px' }} />
                                                <col style={{ width: '120px' }} />
                                            </colgroup>
                                            <TableHead>
                                                <TableRow>
                                                    <TableCell>Address</TableCell>
                                                    <TableCell>Added</TableCell>
                                                    <TableCell>Actions</TableCell>
                                                </TableRow>
                                            </TableHead>
                                            <TableBody>
                                                {filteredAddresses.map(([address, info]) => (
                                                    <TableRow key={address} selected={address === selectedAddress}>
                                                        <TableCell>
                                                            <Typography style={{ fontFamily: 'Courier' }}>
                                                                {address}
                                                            </Typography>
                                                        </TableCell>
                                                        <TableCell>
                                                            <Typography style={{ fontSize: '.9em', fontFamily: 'Courier' }}>
                                                                {formatAddedDate(info.added)}
                                                            </Typography>
                                                        </TableCell>
                                                        <TableCell>
                                                            <Button variant="contained" color="primary" onClick={() => selectAddress(address)}>
                                                                Select
                                                            </Button>
                                                        </TableCell>
                                                    </TableRow>
                                                ))}
                                            </TableBody>
                                        </Table>
                                    </TableContainer>
                                    <textarea
                                        value={addressDocs}
                                        readOnly
                                        style={{ width: '100%', height: '240px', overflow: 'auto' }}
                                    />
                                </Box>
                            }
                            {identityTab === 'nostr' &&
                                <Box sx={{ width: '800px', maxWidth: '100%' }}>
                                    <Grid container spacing={1} sx={{ mb: 2 }}>
                                        <Grid item>
                                            {nostrKeys ?
                                                <Button variant="contained" color="error" onClick={removeNostr}>
                                                    Remove Nostr
                                                </Button>
                                                :
                                                <Button variant="contained" color="primary" onClick={addNostr}>
                                                    Add Nostr
                                                </Button>
                                            }
                                        </Grid>
                                        {nostrKeys &&
                                            <Grid item>
                                                {nsecString ? (
                                                    <Button variant="contained" color="warning" onClick={hideNsec}>
                                                        Hide nsec
                                                    </Button>
                                                ) : (
                                                    <Button variant="contained" color="warning" onClick={showNsec}>
                                                        Show nsec
                                                    </Button>
                                                )}
                                            </Grid>
                                        }
                                    </Grid>
                                    {nostrKeys ?
                                        <Box>
                                            <Typography variant="body2" sx={{ fontFamily: 'monospace', wordBreak: 'break-all', mb: 1 }}>
                                                <strong>npub:</strong> {nostrKeys.npub}
                                            </Typography>
                                            <Typography variant="body2" sx={{ fontFamily: 'monospace', wordBreak: 'break-all', mb: 1 }}>
                                                <strong>pubkey:</strong> {nostrKeys.pubkey}
                                            </Typography>
                                            {nsecString &&
                                                <Typography variant="body2" color="error" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
                                                    <strong>nsec:</strong> {nsecString}
                                                </Typography>
                                            }
                                        </Box>
                                        :
                                        <Typography variant="body2" color="text.secondary">
                                            No Nostr keys are configured for this identity yet.
                                        </Typography>
                                    }
                                </Box>
                            }
                        </Box>
                    }
                    {tab === 'aliases' &&
                        <Box>
                            <TableContainer component={Paper} style={{ maxHeight: '400px', overflow: 'auto' }}>
                                <Table stickyHeader style={{ width: '1000px', tableLayout: 'fixed' }}>
                                    <colgroup>
                                        <col style={{ width: '200px' }} />
                                        <col />
                                        <col style={{ width: '160px' }} />
                                    </colgroup>
                                    <TableHead>
                                        <TableRow>
                                            <TableCell style={{ borderBottom: 'none' }}>
                                                <TextField
                                                    label="Alias"
                                                    size="small"
                                                    fullWidth
                                                    value={alias}
                                                    onChange={(e) => setAlias(e.target.value)}
                                                    inputProps={{ maxLength: 32 }}
                                                />
                                            </TableCell>
                                            <TableCell style={{ borderBottom: 'none' }}>
                                                <TextField
                                                    label="DID"
                                                    size="small"
                                                    fullWidth
                                                    value={aliasDID}
                                                    onChange={(e) => setAliasDID(e.target.value.trim())}
                                                    inputProps={{ maxLength: 80 }}
                                                />
                                            </TableCell>
                                            <TableCell style={{ borderBottom: 'none', whiteSpace: 'nowrap' }}>
                                                <Button
                                                    variant="contained"
                                                    color="primary"
                                                    onClick={() => resolveAlias(aliasDID || alias)}
                                                    disabled={!alias.trim() && !aliasDID.trim()}
                                                >
                                                    Resolve
                                                </Button>
                                                {' '}
                                                <Button variant="contained" color="primary" onClick={addAlias} disabled={!alias || !aliasDID}>
                                                    Add
                                                </Button>
                                                {' '}
                                                <Button variant="contained" color="primary" onClick={clearAliasFields} disabled={!alias && !aliasDID}>
                                                    Clear
                                                </Button>
                                            </TableCell>
                                        </TableRow>
                                        <TableRow>
                                            <TableCell style={{ borderBottom: 'none' }}>
                                                <TextField
                                                    label="Search"
                                                    size="small"
                                                    fullWidth
                                                    value={nameSearch}
                                                    onChange={(e) => setNameSearch(e.target.value)}
                                                    slotProps={{
                                                        input: {
                                                            endAdornment: nameSearch && (
                                                                <IconButton size="small" onClick={() => setNameSearch('')}>
                                                                    <Clear fontSize="small" />
                                                                </IconButton>
                                                            ),
                                                        },
                                                    }}
                                                />
                                            </TableCell>
                                            <TableCell style={{ borderBottom: 'none' }}>
                                                <Select
                                                    size="small"
                                                    value={nameTypeFilter}
                                                    onChange={(e) => setNameTypeFilter(e.target.value)}
                                                    style={{ width: '160px' }}
                                                >
                                                    <MenuItem value="all">Type: All</MenuItem>
                                                    <MenuItem value="agent">Agents</MenuItem>
                                                    <MenuItem value="file">Documents</MenuItem>
                                                    <MenuItem value="group">Groups</MenuItem>
                                                    <MenuItem value="image">Images</MenuItem>
                                                    <MenuItem value="poll">Polls</MenuItem>
                                                    <MenuItem value="schema">Schemas</MenuItem>
                                                    <MenuItem value="vault">Vaults</MenuItem>
                                                    <MenuItem value="unknown">Unknown</MenuItem>
                                                </Select>
                                            </TableCell>
                                            <TableCell style={{ borderBottom: 'none' }} />
                                        </TableRow>
                                    </TableHead>
                                    <TableBody>
                                        {filteredAliases.map(([alias, did], index) => (
                                            <TableRow key={index} selected={alias === selectedName}>
                                                <TableCell>
                                                    {getAliasIcon(alias)}
                                                    {alias}
                                                </TableCell>
                                                <TableCell>
                                                    <Typography style={{ fontSize: '.9em', fontFamily: 'Courier' }}>
                                                        {did}
                                                    </Typography>
                                                </TableCell>
                                                <TableCell>
                                                    <Button variant="contained" color="primary" onClick={() => resolveAlias(alias)}>
                                                        Resolve
                                                    </Button>
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </TableContainer>
                            <p>{selectedName}</p>
                            <Grid container spacing={1} style={{ marginBottom: '8px' }}>
                                <Grid item>
                                    <Button variant="contained" color="primary" onClick={() => changeAlias(selectedName, aliasList[selectedName])} disabled={!selectedName}>
                                        Rename...
                                    </Button>
                                </Grid>
                                <Grid item>
                                    <Button variant="contained" color="primary" onClick={() => removeAlias(selectedName)} disabled={!selectedName}>
                                        Remove...
                                    </Button>
                                </Grid>
                                <Grid item>
                                    <Button variant="contained" color="primary" onClick={() => revokeAlias(selectedName)} disabled={!selectedName || !aliasIsOwned}>
                                        Revoke...
                                    </Button>
                                </Grid>
                                <Grid item>
                                    <Button variant="contained" color="primary" onClick={() => transferAlias(selectedName)} disabled={!selectedName || !aliasIsOwned}>
                                        Transfer...
                                    </Button>
                                </Grid>
                                <Grid item>
                                    <Button variant="contained" color="primary" onClick={() => openMigrate(selectedName)} disabled={!selectedName || !aliasIsOwned}>
                                        Migrate...
                                    </Button>
                                </Grid>
                                <Grid item>
                                    <Button variant="contained" color="primary" onClick={openClone} disabled={!selectedName || !aliasIsOwned}>
                                        Clone...
                                    </Button>
                                </Grid>
                            </Grid>
                            <VersionsNavigator
                                version={aliasDocsVersion}
                                maxVersion={aliasDocsVersionMax}
                                selectVersion={selectAliasDocsVersion}
                            />
                            <br />
                            <textarea
                                value={aliasDocs}
                                readOnly
                                style={{ width: '800px', height: '600px', overflow: 'auto' }}
                            />
                        </Box>
                    }
                    {tab === 'assets' &&
                        <Box>
                            <Box>
                                <Tabs
                                    value={assetsTab}
                                    onChange={(event, newTab) => setAssetsTab(newTab)}
                                    indicatorColor="primary"
                                    textColor="primary"
                                    variant="scrollable"
                                    scrollButtons="auto"
                                >
                                    <Tab key="schemas" value="schemas" label={'Schemas'} icon={<Schema />} />
                                    <Tab key="groups" value="groups" label={'Groups'} icon={<Groups />} />
                                    <Tab key="images" value="images" label={'Images'} icon={<Image />} />
                                    <Tab key="files" value="files" label={'Files'} icon={<Article />} />
                                    <Tab key="vaults" value="vaults" label={'Vaults'} icon={<Lock />} />
                                </Tabs>
                            </Box>
                            {assetsTab === 'schemas' &&
                                <Box>
                                    <Grid container direction="row" justifyContent="flex-start" alignItems="center" spacing={3}>
                                        <Grid item>
                                            <TextField
                                                label="Schema Name"
                                                style={{ width: '300px' }}
                                                value={schemaName}
                                                onChange={(e) => setSchemaName(e.target.value.trim())}
                                                fullWidth
                                                margin="normal"
                                                inputProps={{ maxLength: 30 }}
                                            />
                                        </Grid>
                                        <Grid item>
                                            <Button variant="contained" color="primary" onClick={createSchema} disabled={!schemaName || !registry}>
                                                Create Schema
                                            </Button>
                                        </Grid>
                                        <Grid item>
                                            <RegistrySelect />
                                        </Grid>
                                    </Grid>
                                    <Grid container direction="row" justifyContent="flex-start" alignItems="center" spacing={3}>
                                        <Grid item>
                                            <TextField
                                                label="Schema Pack DID"
                                                style={{ width: '300px' }}
                                                value={schemaPackDID}
                                                onChange={(e) => setSchemaPackDID(e.target.value.trim())}
                                                fullWidth
                                                margin="normal"
                                                placeholder="did:mdip:..."
                                            />
                                        </Grid>
                                        <Grid item>
                                            <Button variant="contained" color="primary" onClick={importSchemaPack} disabled={!schemaPackDID}>
                                                Import Pack
                                            </Button>
                                        </Grid>
                                    </Grid>
                                    {schemaList &&
                                        <Grid container direction="row" justifyContent="flex-start" alignItems="center" spacing={3}>
                                            <Grid item>
                                                <Select
                                                    style={{ width: '300px' }}
                                                    value={selectedSchemaName}
                                                    fullWidth
                                                    displayEmpty
                                                    onChange={(event) => selectSchema(event.target.value)}
                                                >
                                                    <MenuItem value="" disabled>
                                                        Select schema
                                                    </MenuItem>
                                                    {schemaList.map((alias, index) => (
                                                        <MenuItem value={alias} key={index}>
                                                            {alias}
                                                        </MenuItem>
                                                    ))}
                                                </Select>
                                            </Grid>
                                            <Grid item>
                                                <Typography style={{ fontSize: '1em', fontFamily: 'Courier' }}>
                                                    {getDID(selectedSchemaName)}
                                                </Typography>
                                            </Grid>
                                        </Grid>
                                    }
                                    {selectedSchema &&
                                        <Box>
                                            <Grid container direction="column" spacing={1}>
                                                <Grid item>
                                                    <textarea
                                                        value={schemaString}
                                                        onChange={(e) => setSchemaString(e.target.value)}
                                                        style={{ width: '800px', height: '600px', overflow: 'auto' }}
                                                        readOnly={!selectedSchemaOwned}
                                                    />
                                                </Grid>
                                                <Grid container direction="row" spacing={1}>
                                                    <Grid item>
                                                        <Tooltip title={!selectedSchemaOwned ? "You must own the schema to save." : ""}>
                                                            <span>
                                                                <Button variant="contained" color="primary" onClick={saveSchema} disabled={!schemaString || !selectedSchemaOwned}>
                                                                    Save Schema
                                                                </Button>
                                                            </span>
                                                        </Tooltip>
                                                    </Grid>
                                                    <Grid item>
                                                        <Button variant="contained" color="primary" onClick={() => selectSchema(selectedSchemaName)} disabled={!schemaString || !selectedSchemaOwned}>
                                                            Revert Schema
                                                        </Button>
                                                    </Grid>
                                                </Grid>
                                            </Grid>
                                        </Box>
                                    }
                                </Box>
                            }
                            {assetsTab === 'groups' &&
                                <Box>
                                    <Grid container direction="row" justifyContent="flex-start" alignItems="center" spacing={3}>
                                        <Grid item>
                                            <TextField
                                                label="Group Name"
                                                style={{ width: '300px' }}
                                                value={groupName}
                                                onChange={(e) => setGroupName(e.target.value.trim())}
                                                fullWidth
                                                margin="normal"
                                                inputProps={{ maxLength: 30 }}
                                            />
                                        </Grid>
                                        <Grid item>
                                            <Button variant="contained" color="primary" onClick={createGroup} disabled={!groupName || !registry}>
                                                Create Group
                                            </Button>
                                        </Grid>
                                        <Grid item>
                                            <RegistrySelect />
                                        </Grid>
                                    </Grid>
                                    {groupList &&
                                        <Grid container direction="row" justifyContent="flex-start" alignItems="center" spacing={3}>
                                            <Grid item>
                                                <Select
                                                    style={{ width: '300px' }}
                                                    value={selectedGroupName}
                                                    fullWidth
                                                    displayEmpty
                                                    onChange={(event) => refreshGroup(event.target.value)}
                                                >
                                                    <MenuItem value="" disabled>
                                                        Select group
                                                    </MenuItem>
                                                    {groupList.map((alias, index) => (
                                                        <MenuItem value={alias} key={index}>
                                                            {alias}
                                                        </MenuItem>
                                                    ))}
                                                </Select>
                                            </Grid>
                                            <Grid item>
                                                <Typography style={{ fontSize: '1em', fontFamily: 'Courier' }}>
                                                    {getDID(selectedGroupName)}
                                                </Typography>
                                            </Grid>
                                        </Grid>
                                    }
                                    {selectedGroup &&
                                        <Box>
                                            <Table style={{ width: '800px' }}>
                                                <TableBody>
                                                    <TableRow>
                                                        <TableCell style={{ width: '100%' }}>
                                                            <TextField
                                                                label="Name or DID"
                                                                style={{ width: '500px' }}
                                                                value={groupMember}
                                                                onChange={(e) => setGroupMember(e.target.value.trim())}
                                                                fullWidth
                                                                margin="normal"
                                                                inputProps={{ maxLength: 80 }}
                                                            />
                                                        </TableCell>
                                                        <TableCell>
                                                            <Button variant="contained" color="primary" onClick={() => resolveGroupMember(groupMember)} disabled={!groupMember}>
                                                                Resolve
                                                            </Button>
                                                        </TableCell>
                                                        <TableCell>
                                                            <Tooltip title={!selectedGroupOwned ? "You must own the group to edit." : ""}>
                                                                <span>
                                                                    <Button variant="contained" color="primary" onClick={() => addGroupMember(groupMember)} disabled={!groupMember || !selectedGroupOwned}>
                                                                        Add
                                                                    </Button>
                                                                </span>
                                                            </Tooltip>
                                                        </TableCell>
                                                    </TableRow>
                                                    {selectedGroup.members.map((did, index) => (
                                                        <TableRow key={index}>
                                                            <TableCell>
                                                                <Typography style={{ fontSize: '.9em', fontFamily: 'Courier' }}>
                                                                    {did}
                                                                </Typography>
                                                            </TableCell>
                                                            <TableCell>
                                                                <Button variant="contained" color="primary" onClick={() => resolveGroupMember(did)}>
                                                                    Resolve
                                                                </Button>
                                                            </TableCell>
                                                            <TableCell>
                                                                <Tooltip title={!selectedGroupOwned ? "You must own the group to edit." : ""}>
                                                                    <span>
                                                                        <Button variant="contained" color="primary" onClick={() => removeGroupMember(did)} disabled={!selectedGroupOwned}>
                                                                            Remove
                                                                        </Button>
                                                                    </span>
                                                                </Tooltip>
                                                            </TableCell>
                                                        </TableRow>
                                                    ))}
                                                </TableBody>
                                            </Table>
                                            <textarea
                                                value={groupMemberDocs}
                                                readOnly
                                                style={{ width: '800px', height: '600px', overflow: 'auto' }}
                                            />
                                        </Box>
                                    }
                                </Box>
                            }
                            {assetsTab === 'images' &&
                                <Box>
                                    <Grid container direction="row" justifyContent="flex-start" alignItems="center" spacing={3}>
                                        <Grid item>
                                            <RegistrySelect />
                                        </Grid>
                                        <Grid item>
                                            <Button
                                                variant="contained"
                                                color="primary"
                                                onClick={() => document.getElementById('imageUpload').click()}
                                                disabled={!registry}
                                            >
                                                Upload Image...
                                            </Button>
                                            <input
                                                type="file"
                                                id="imageUpload"
                                                accept="image/*"
                                                style={{ display: 'none' }}
                                                onChange={uploadImage}
                                            />
                                        </Grid>
                                    </Grid>
                                    <p />
                                    {imageList &&
                                        <Box>
                                            <Grid container direction="row" justifyContent="flex-start" alignItems="center" spacing={3}>
                                                <Grid item>
                                                    <Select
                                                        style={{ width: '300px' }}
                                                        value={selectedImageName}
                                                        fullWidth
                                                        displayEmpty
                                                        onChange={(event) => selectImage(event.target.value)}
                                                    >
                                                        <MenuItem value="" disabled>
                                                            Select image
                                                        </MenuItem>
                                                        {imageList.map((alias, index) => (
                                                            <MenuItem value={alias} key={index}>
                                                                {alias}
                                                            </MenuItem>
                                                        ))}
                                                    </Select>
                                                </Grid>
                                                <Grid item>
                                                    <Tooltip title={!selectedImageOwned ? "You must own the image to update." : ""}>
                                                        <span>
                                                            <Button
                                                                variant="contained"
                                                                color="primary"
                                                                onClick={() => document.getElementById('imageUpdate').click()}
                                                                disabled={!selectedImageName || !selectedImageOwned}
                                                            >
                                                                Update image...
                                                            </Button>
                                                        </span>
                                                    </Tooltip>
                                                    <input
                                                        type="file"
                                                        id="imageUpdate"
                                                        accept="image/*"
                                                        style={{ display: 'none' }}
                                                        onChange={updateImage}
                                                    />
                                                </Grid>
                                            </Grid>
                                            <p />
                                            {selectedImage && selectedImageDocs &&
                                                <>
                                                    <VersionsNavigator
                                                        version={imageVersion}
                                                        maxVersion={imageVersionMax}
                                                        selectVersion={selectImageVersion}
                                                    />
                                                    <div className="container">
                                                    <div className="left-pane">
                                                        <img src={selectedImageURL} alt={selectedImageName} style={{ width: '100%', height: 'auto' }} />
                                                    </div>
                                                    <div className="right-pane">
                                                        <TableContainer>
                                                            <Table>
                                                                <TableBody>
                                                                    <TableRow>
                                                                        <TableCell>DID</TableCell>
                                                                        <TableCell>{selectedImageDocs.didDocument.id}</TableCell>
                                                                    </TableRow>
                                                                    <TableRow>
                                                                        <TableCell>CID</TableCell>
                                                                        <TableCell>{selectedImage.file.cid}</TableCell>
                                                                    </TableRow>
                                                                    <TableRow>
                                                                        <TableCell>Created</TableCell>
                                                                        <TableCell>{selectedImageDocs.didDocumentMetadata.created}</TableCell>
                                                                    </TableRow>
                                                                    <TableRow>
                                                                        <TableCell>Updated</TableCell>
                                                                        <TableCell>{selectedImageDocs.didDocumentMetadata.updated || selectedImageDocs.didDocumentMetadata.created}</TableCell>
                                                                    </TableRow>
                                                                    <TableRow>
                                                                        <TableCell>Version</TableCell>
                                                                        <TableCell>{selectedImageDocs.didDocumentMetadata.version} of {imageVersionMax}</TableCell>
                                                                    </TableRow>
                                                                    <TableRow>
                                                                        <TableCell>File size</TableCell>
                                                                        <TableCell>{selectedImage.file.bytes} bytes</TableCell>
                                                                    </TableRow>
                                                                    <TableRow>
                                                                        <TableCell>Image size</TableCell>
                                                                        <TableCell>{selectedImage.image.width} x {selectedImage.image.height} pixels</TableCell>
                                                                    </TableRow>
                                                                    <TableRow>
                                                                        <TableCell>Image type</TableCell>
                                                                        <TableCell>{selectedImage.file.type}</TableCell>
                                                                    </TableRow>
                                                                </TableBody>
                                                            </Table>
                                                        </TableContainer>
                                                    </div>
                                                    </div>
                                                </>
                                            }
                                        </Box>
                                    }
                                </Box>
                            }
                            {assetsTab === 'files' &&
                                <Box>
                                    <Grid container direction="row" justifyContent="flex-start" alignItems="center" spacing={3}>
                                        <Grid item>
                                            <RegistrySelect />
                                        </Grid>
                                        <Grid item>
                                            <Button
                                                variant="contained"
                                                color="primary"
                                                onClick={() => document.getElementById('fileUpload').click()}
                                                disabled={!registry}
                                            >
                                                Upload File...
                                            </Button>
                                            <input
                                                type="file"
                                                id="fileUpload"
                                                accept=".pdf,.doc,.docx,.txt,video/*"
                                                style={{ display: 'none' }}
                                                onChange={uploadFile}
                                            />
                                        </Grid>
                                    </Grid>
                                    {uploadProgress !== null && (
                                        <Box sx={{ mt: 1, width: 400 }}>
                                            <LinearProgress variant="determinate" value={Math.round((uploadProgress.loaded / uploadProgress.total) * 100)} />
                                            <Typography variant="caption">
                                                {formatBytes(uploadProgress.loaded)} / {formatBytes(uploadProgress.total)} ({((uploadProgress.loaded / uploadProgress.total) * 100).toFixed(1)}%)
                                            </Typography>
                                        </Box>
                                    )}
                                    <p />
                                    {fileList &&
                                        <Box>
                                            <Grid container direction="row" justifyContent="flex-start" alignItems="center" spacing={3}>
                                                <Grid item>
                                                    <Select
                                                        style={{ width: '300px' }}
                                                        value={selectedFileName}
                                                        fullWidth
                                                        displayEmpty
                                                        onChange={(event) => selectFile(event.target.value)}
                                                    >
                                                        <MenuItem value="" disabled>
                                                            Select file
                                                        </MenuItem>
                                                        {fileList.map((alias, index) => (
                                                            <MenuItem value={alias} key={index}>
                                                                {alias}
                                                            </MenuItem>
                                                        ))}
                                                    </Select>
                                                </Grid>
                                                <Grid item>
                                                    <Grid container direction="row" justifyContent="flex-start" alignItems="center" spacing={3}>
                                                        <Grid item>
                                                            <Tooltip title={!selectedFileOwned ? "You must own the file to update." : ""}>
                                                                <span>
                                                                    <Button
                                                                        variant="contained"
                                                                        color="primary"
                                                                        onClick={() => document.getElementById('fileUpdate').click()}
                                                                        disabled={!selectedFileName || !selectedFileOwned}
                                                                    >
                                                                        Update file...
                                                                    </Button>
                                                                </span>
                                                            </Tooltip>
                                                            <input
                                                                type="file"
                                                                id="fileUpdate"
                                                                accept=".pdf,.doc,.docx,.txt,video/*"
                                                                style={{ display: 'none' }}
                                                                onChange={updateFile}
                                                            />
                                                        </Grid>
                                                        <Grid item>
                                                            <Button
                                                                variant="contained"
                                                                color="primary"
                                                                onClick={() => downloadFile()}
                                                                disabled={!selectedFileName}
                                                            >
                                                                Download
                                                            </Button>
                                                        </Grid>
                                                    </Grid>
                                                </Grid>
                                            </Grid>
                                            <p />
                                            {selectedFile && selectedFileDocs &&
                                                <div className="container">
                                                    <VersionsNavigator
                                                        version={fileVersion}
                                                        maxVersion={fileVersionMax}
                                                        selectVersion={selectFileVersion}
                                                    />
                                                    <br />
                                                    <TableContainer>
                                                        <Table>
                                                            <TableBody>
                                                                <TableRow>
                                                                    <TableCell>DID</TableCell>
                                                                    <TableCell>{selectedFileDocs.didDocument.id}</TableCell>
                                                                </TableRow>
                                                                <TableRow>
                                                                    <TableCell>CID</TableCell>
                                                                    <TableCell>{selectedFile.cid}</TableCell>
                                                                </TableRow>
                                                                <TableRow>
                                                                    <TableCell>Created</TableCell>
                                                                    <TableCell>{selectedFileDocs.didDocumentMetadata.created}</TableCell>
                                                                </TableRow>
                                                                <TableRow>
                                                                    <TableCell>Updated</TableCell>
                                                                    <TableCell>{selectedFileDocs.didDocumentMetadata.updated || selectedFileDocs.didDocumentMetadata.created}</TableCell>
                                                                </TableRow>
                                                                <TableRow>
                                                                    <TableCell>Version</TableCell>
                                                                    <TableCell>{fileVersion} of {fileVersionMax}</TableCell>
                                                                </TableRow>
                                                                <TableRow>
                                                                    <TableCell>File name</TableCell>
                                                                    <TableCell>{selectedFile.filename}</TableCell>
                                                                </TableRow>
                                                                <TableRow>
                                                                    <TableCell>File size</TableCell>
                                                                    <TableCell>{selectedFile.bytes} bytes</TableCell>
                                                                </TableRow>
                                                                <TableRow>
                                                                    <TableCell>File type</TableCell>
                                                                    <TableCell>{selectedFile.type}</TableCell>
                                                                </TableRow>
                                                            </TableBody>
                                                        </Table>
                                                    </TableContainer>
                                                </div>
                                            }
                                        </Box>
                                    }
                                </Box>
                            }
                            {assetsTab === 'vaults' &&
                                <Box>
                                    <Grid container direction="row" justifyContent="flex-start" alignItems="center" spacing={3}>
                                        <Grid item>
                                            <TextField
                                                label="Vault Name"
                                                style={{ width: '300px' }}
                                                value={vaultName}
                                                onChange={(e) => setVaultName(e.target.value)}
                                                fullWidth
                                                margin="normal"
                                                inputProps={{ maxLength: 30 }}
                                            />
                                        </Grid>
                                        <Grid item>
                                            <Button variant="contained" color="primary" onClick={createVault} disabled={!vaultName || !registry}>
                                                Create Vault
                                            </Button>
                                        </Grid>
                                        <Grid item>
                                            <RegistrySelect />
                                        </Grid>
                                    </Grid>
                                    {vaultList &&
                                        <Grid container direction="row" justifyContent="flex-start" alignItems="center" spacing={3}>
                                            <Grid item>
                                                <Select
                                                    style={{ width: '300px' }}
                                                    value={selectedVaultName}
                                                    fullWidth
                                                    displayEmpty
                                                    onChange={(event) => refreshVault(event.target.value)}
                                                >
                                                    <MenuItem value="" disabled>
                                                        Select vault
                                                    </MenuItem>
                                                    {vaultList.map((alias, index) => (
                                                        <MenuItem value={alias} key={index}>
                                                            {alias}
                                                        </MenuItem>
                                                    ))}
                                                </Select>
                                            </Grid>
                                            <Grid item>
                                                <Typography style={{ fontSize: '1em', fontFamily: 'Courier' }}>
                                                    {getDID(selectedVaultName)}
                                                </Typography>
                                            </Grid>
                                        </Grid>
                                    }
                                    {selectedVault &&
                                        <FormControl component="fieldset" style={{ width: '100%' }}>
                                            <FormLabel component="legend">Vault Members</FormLabel>
                                            <Box sx={{ border: 1, borderColor: 'grey.400', borderRadius: 1, p: 2 }}>
                                                Vault Members are the DIDs that can access the vault.
                                                <Table style={{ width: '800px' }}>
                                                    <TableBody>
                                                        <TableRow>
                                                            <TableCell style={{ width: '100%' }}>
                                                                <Autocomplete
                                                                    freeSolo
                                                                    options={agentList || []} // array of options, e.g. DIDs or names
                                                                    value={vaultMember}
                                                                    onChange={(event, newValue) => setVaultMember(newValue)}
                                                                    onInputChange={(event, newInputValue) => setVaultMember(newInputValue)}
                                                                    renderInput={(params) => (
                                                                        <TextField
                                                                            {...params}
                                                                            label="Name or DID"
                                                                            style={{ width: '500px' }}
                                                                            margin="normal"
                                                                            inputProps={{ ...params.inputProps, maxLength: 80 }}
                                                                            fullWidth
                                                                        />
                                                                    )}
                                                                />
                                                            </TableCell>
                                                            <TableCell>
                                                                <Tooltip title={!selectedVaultOwned ? "You must own the vault to edit." : ""}>
                                                                    <span>
                                                                        <Button variant="contained" color="primary" onClick={() => addVaultMember(vaultMember)} disabled={!vaultMember || !selectedVaultOwned}>
                                                                            Add
                                                                        </Button>
                                                                    </span>
                                                                </Tooltip>
                                                            </TableCell>
                                                        </TableRow>
                                                        {selectedVault.members.map((did, index) => (
                                                            <TableRow key={index}>
                                                                <TableCell>
                                                                    <Typography style={{ fontSize: '.9em', fontFamily: 'Courier' }}>
                                                                        {did}
                                                                    </Typography>
                                                                </TableCell>
                                                                <TableCell>
                                                                    <Tooltip title={!selectedVaultOwned ? "You must own the vault to edit." : ""}>
                                                                        <span>
                                                                            <Button
                                                                                variant="contained"
                                                                                color="primary"
                                                                                onClick={() => removeVaultMember(did)}
                                                                                disabled={!selectedVaultOwned}>
                                                                                Remove
                                                                            </Button>
                                                                        </span>
                                                                    </Tooltip>
                                                                </TableCell>
                                                            </TableRow>
                                                        ))}
                                                    </TableBody>
                                                </Table>
                                            </Box>
                                            <FormLabel component="legend">Vault Items</FormLabel>
                                            <Box sx={{ border: 1, borderColor: 'grey.400', borderRadius: 1, p: 2 }}>
                                                Vault Items are data encrypted for members only.
                                                <Grid container direction="row" justifyContent="flex-start" alignItems="center" spacing={3}>
                                                    <Grid item>
                                                    </Grid>
                                                </Grid>
                                                <Table style={{ width: '800px' }}>
                                                    <TableBody>
                                                        <TableRow>
                                                            <TableCell>
                                                                Name
                                                            </TableCell>
                                                            <TableCell>
                                                                Size (bytes)
                                                            </TableCell>
                                                            <TableCell>
                                                                <Button
                                                                    variant="contained"
                                                                    color="primary"
                                                                    onClick={() => document.getElementById('vaultItemUpload').click()}
                                                                    disabled={!selectedVaultOwned}
                                                                >
                                                                    Upload...
                                                                </Button>
                                                                <input
                                                                    type="file"
                                                                    id="vaultItemUpload"
                                                                    style={{ display: 'none' }}
                                                                    onChange={uploadVaultItem}
                                                                />
                                                            </TableCell>
                                                            <TableCell>
                                                                <Button
                                                                    variant="contained"
                                                                    color="primary"
                                                                    onClick={() => setEditLoginOpen(true)}
                                                                    disabled={!selectedVaultOwned}
                                                                >
                                                                    Add login...
                                                                </Button>
                                                            </TableCell>
                                                        </TableRow>
                                                        {Object.entries(selectedVault.vaultItems).map(([name, item], index) => (
                                                            <TableRow key={index}>
                                                                <TableCell>
                                                                    {getVaultItemIcon(name, item)}
                                                                    {name}
                                                                </TableCell>
                                                                <TableCell>
                                                                    {item.bytes}
                                                                </TableCell>
                                                                <TableCell>
                                                                    {isVaultItemFile(item) ? (
                                                                        <Button
                                                                            variant="contained"
                                                                            color="primary"
                                                                            onClick={() => downloadVaultItem(name)}
                                                                        >
                                                                            Download
                                                                        </Button>
                                                                    ) : (
                                                                        <Button
                                                                            variant="contained"
                                                                            color="primary"
                                                                            onClick={() => revealVaultItem(name)}
                                                                        >
                                                                            Reveal
                                                                        </Button>
                                                                    )}
                                                                </TableCell>
                                                                <TableCell>
                                                                    <Tooltip title={!selectedVaultOwned ? "You must own the vault to edit." : ""}>
                                                                        <span>
                                                                            <Button
                                                                                variant="contained"
                                                                                color="primary"
                                                                                onClick={() => removeVaultItem(name)}
                                                                                disabled={!selectedVaultOwned}>
                                                                                Remove
                                                                            </Button>
                                                                        </span>
                                                                    </Tooltip>
                                                                </TableCell>
                                                            </TableRow>
                                                        ))}
                                                    </TableBody>
                                                </Table>
                                            </Box>
                                        </FormControl>
                                    }
                                </Box>
                            }
                        </Box>
                    }
                    {tab === 'polls' &&
                        <Box>
                            {pollResults && (
                                <PollResultsModal
                                    open={pollResultsOpen}
                                    onClose={() => setPollResultsOpen(false)}
                                    results={pollResults}
                                />
                            )}
                            <TextInputModal
                                isOpen={renamePollOpen}
                                title="Rename poll"
                                defaultValue={renameOldPollName}
                                onSubmit={handleRenameSubmit}
                                onClose={() => setRenamePollOpen(false)}
                            />
                            <WarningModal
                                title="Remove Poll"
                                warningText={`Are you sure you want to remove '${removePollName}'?`}
                                isOpen={removePollOpen}
                                onClose={() => setRemovePollOpen(false)}
                                onSubmit={confirmRemovePoll}
                            />

                            <Tabs
                                value={activeTab}
                                onChange={(_, v) => setActiveTab(v)}
                                indicatorColor="primary"
                                textColor="primary"
                                sx={{ mb: 2 }}
                            >
                                <Tab label="Create" value="create" icon={<AddCircleOutline />} />
                                <Tab label="View / Vote" value="view" icon={<BarChart />} />
                            </Tabs>

                            {activeTab === "create" && (
                                <Box sx={{ maxWidth: 550 }}>
                                    <TextField
                                        fullWidth
                                        label="Poll name"
                                        value={pollName}
                                        onChange={(e) => setPollName(e.target.value)}
                                        sx={{ mb: 2 }}
                                        disabled={!!createdPollDid}
                                        inputProps={{ maxLength: 32 }}
                                    />
                                    <TextField
                                        fullWidth
                                        label="Description"
                                        multiline
                                        value={description}
                                        onChange={(e) => setDescription(e.target.value)}
                                        sx={{ mb: 2 }}
                                        disabled={!!createdPollDid}
                                        inputProps={{ maxLength: 200 }}
                                    />
                                    <TextField
                                        fullWidth
                                        label="Options (comma or newline separated)"
                                        multiline
                                        minRows={3}
                                        value={optionsStr}
                                        onChange={(e) => setOptionsStr(e.target.value)}
                                        sx={{ mb: 2 }}
                                        disabled={!!createdPollDid}
                                        helperText="Between 2 and 10 options"
                                    />
                                    <TextField
                                        fullWidth
                                        type="datetime-local"
                                        label="Deadline"
                                        value={deadline}
                                        onChange={(e) => setDeadline(e.target.value)}
                                        sx={{ mb: 2 }}
                                        disabled={!!createdPollDid}
                                        InputLabelProps={{ shrink: true }}
                                    />

                                    <Box sx={{ mt: 2 }}>
                                        {!createdPollDid && (
                                        <>
                                        <Select
                                            value={registry}
                                            onChange={(e) => setRegistry(e.target.value)}
                                            sx={{ minWidth: 200, mb: 2 }}
                                        >
                                            {registries.map((r) => (
                                                <MenuItem key={r} value={r}>
                                                    {r}
                                                </MenuItem>
                                            ))}
                                        </Select>
                                        <Button
                                            variant="contained"
                                            onClick={handleCreatePoll}
                                            sx={{ mr: 1 }}
                                        >
                                            Create
                                        </Button>
                                        </>
                                        )}
                                        <Button
                                            variant="outlined"
                                            onClick={handleSendPoll}
                                            disabled={!createdPollDid || pollNoticeSent}
                                            sx={{ mr: 1 }}
                                        >
                                            Send
                                        </Button>
                                        <Button variant="text" onClick={resetForm}>
                                            Clear
                                        </Button>
                                    </Box>

                                    {createdPollDid && (
                                        <Box sx={{ mt: 2 }}>
                                            <Typography variant="body2" sx={{ mb: 1, fontWeight: 'bold' }}>
                                                Voters
                                            </Typography>
                                            <Box display="flex" sx={{ gap: 1, mb: 1 }}>
                                                <Autocomplete
                                                    freeSolo
                                                    options={agentList || []}
                                                    value={voterInput}
                                                    onChange={(_e, newVal) => setVoterInput(newVal || "")}
                                                    onInputChange={(_e, newInput) => setVoterInput(newInput)}
                                                    sx={{ flex: 1, minWidth: 0 }}
                                                    renderInput={(params) => (
                                                        <TextField
                                                            {...params}
                                                            fullWidth
                                                            size="small"
                                                            label="Name or DID"
                                                            onKeyDown={(e) => {
                                                                if (e.key === 'Enter') {
                                                                    e.preventDefault();
                                                                    handleAddVoter();
                                                                }
                                                            }}
                                                            inputProps={{
                                                                ...params.inputProps,
                                                                maxLength: 80,
                                                            }}
                                                        />
                                                    )}
                                                />
                                                <Button
                                                    variant="contained"
                                                    onClick={handleAddVoter}
                                                    disabled={!voterInput.trim()}
                                                    sx={{ minWidth: 'auto', px: 2 }}
                                                >
                                                    <PersonAdd />
                                                </Button>
                                            </Box>
                                            {Object.keys(voters).length > 0 && (
                                                <Box sx={{ mb: 1 }}>
                                                    {Object.keys(voters).map((did) => (
                                                        <Box
                                                            key={did}
                                                            display="flex"
                                                            alignItems="center"
                                                            sx={{ py: 0.5 }}
                                                        >
                                                            <Typography
                                                                variant="body2"
                                                                sx={{
                                                                    flex: 1,
                                                                    overflow: 'hidden',
                                                                    textOverflow: 'ellipsis',
                                                                    whiteSpace: 'nowrap',
                                                                }}
                                                            >
                                                                {did}
                                                            </Typography>
                                                            <IconButton
                                                                size="small"
                                                                onClick={() => handleRemoveVoter(did)}
                                                            >
                                                                <Clear fontSize="small" />
                                                            </IconButton>
                                                        </Box>
                                                    ))}
                                                </Box>
                                            )}
                                            <Typography variant="body2" sx={{ mt: 1 }}>{createdPollDid}</Typography>
                                        </Box>
                                    )}
                                </Box>
                            )}

                            {activeTab === "view" && (
                                <Box sx={{ maxWidth: 650 }}>
                                    {pollList.length > 0 ? (
                                        <Box sx={{ mt: 2 }}>
                                            <Box display="flex" flexDirection="row" sx={{ gap: 1 }}>
                                                <Select
                                                    value={selectedPollName}
                                                    onChange={handleSelectPoll}
                                                    displayEmpty
                                                    sx={{ minWidth: 220 }}
                                                >
                                                    <MenuItem value="">
                                                        Select poll
                                                    </MenuItem>
                                                    {pollList.map((alias) => (
                                                        <MenuItem key={alias} value={alias}>
                                                            {eligiblePolls[alias] ? (
                                                                <HowToVote fontSize="small" sx={{ mr: 1 }} />
                                                            ) : (
                                                                <Block fontSize="small" sx={{ mr: 1 }} />
                                                            )}
                                                            {alias}
                                                        </MenuItem>
                                                    ))}
                                                </Select>

                                                <Tooltip title="Rename Poll">
                                                    <span>
                                                        <IconButton
                                                            size="small"
                                                            sx={{ mt: 1, ml: 1, px: 0.5 }}
                                                            onClick={openRenameModal}
                                                            disabled={!selectedPollName}
                                                        >
                                                            <Edit fontSize="small" />
                                                        </IconButton>
                                                    </span>
                                                </Tooltip>

                                                <Tooltip title="Delete Poll">
                                                    <span>
                                                        <IconButton
                                                            size="small"
                                                            sx={{ mt: 1, ml: 1, px: 0.5 }}
                                                            disabled={!selectedPollName}
                                                            onClick={() => {
                                                                setRemovePollName(selectedPollName);
                                                                setRemovePollOpen(true);
                                                            }}
                                                        >
                                                            <Delete fontSize="small" />
                                                        </IconButton>
                                                    </span>
                                                </Tooltip>

                                                {currentDID && pollController && currentDID === pollController && (
                                                    <Box>
                                                        {pollExpired && (
                                                            <Button
                                                                variant="outlined"
                                                                sx={{ height: 56 }}
                                                                onClick={handleTogglePublish}
                                                            >
                                                                {pollPublished ? "Unpublish" : "Publish"}
                                                            </Button>
                                                        )}

                                                        <Button
                                                            variant="outlined"
                                                            sx={{ ml: 1, height: 56 }}
                                                            onClick={handleViewPoll}
                                                            disabled={!selectedPollDid}
                                                        >
                                                            View
                                                        </Button>
                                                    </Box>
                                                )}
                                            </Box>

                                            {selectedPollDid && (
                                                <Box>
                                                    <Box display="flex" flexDirection="row" sx={{ mt: 2, gap: 1 }}>
                                                        <Typography variant="h6">
                                                            Poll:
                                                        </Typography>
                                                        <Typography variant="body1" sx={{ mt: 0.75, fontFamily: 'Courier' }}>
                                                            {selectedPollDid}
                                                        </Typography>
                                                    </Box>
                                                    <Typography variant="h6" sx={{ mt: 2 }}>
                                                        Description
                                                    </Typography>
                                                    <Typography variant="body1" sx={{ mt: 2 }}>
                                                        {selectedPollDesc}
                                                    </Typography>

                                                    {!pollExpired ? (
                                                        <Box mt={2}>
                                                            <Typography variant="h6">
                                                                {hasVoted ? "Update your vote" : "Cast your vote"}
                                                            </Typography>

                                                            {pollDeadline && (
                                                                <Typography
                                                                    variant="body2"
                                                                    sx={{ mt: 1, color: pollExpired ? "error.main" : "text.secondary" }}
                                                                >
                                                                    Deadline: {pollDeadline.toLocaleString()}
                                                                </Typography>
                                                            )}

                                                            {!spoil && (
                                                                <RadioGroup
                                                                    value={String(selectedOptionIdx)}
                                                                    onChange={(_, v) => setSelectedOptionIdx(Number(v))}
                                                                >
                                                                    {pollOptions.map((opt, idx) => (
                                                                        <FormControlLabel
                                                                            key={idx}
                                                                            value={String(idx)}
                                                                            control={<Radio />}
                                                                            label={opt}
                                                                        />
                                                                    ))}
                                                                </RadioGroup>
                                                            )}

                                                            {canVote &&
                                                                <Box>
                                                                    <FormControlLabel
                                                                        control={
                                                                            <Checkbox checked={spoil} onChange={(_, v) => setSpoil(v)} />
                                                                        }
                                                                        label="Spoil ballot"
                                                                    />

                                                                    <Box sx={{ mt: 1 }}>
                                                                        <Button variant="contained" onClick={handleVote}>
                                                                            Vote
                                                                        </Button>
                                                                        {currentDID !== pollController && (
                                                                            <Button
                                                                                variant="outlined"
                                                                                sx={{ ml: 1 }}
                                                                                disabled={ballotSent}
                                                                                onClick={handleSendBallot}
                                                                            >
                                                                                Send Ballot
                                                                            </Button>
                                                                        )}
                                                                    </Box>
                                                                </Box>
                                                            }

                                                            {lastBallotDid && (
                                                                <Box sx={{ mt: 1 }}>
                                                                    <Typography variant="body2">
                                                                        Ballot: {lastBallotDid}
                                                                    </Typography>
                                                                </Box>
                                                            )}
                                                        </Box>
                                                    ) : (
                                                        <Box sx={{ mt: 2 }}>
                                                            <Typography variant="h6" sx={{ mt: 1, mb: 1 }}>
                                                                Poll complete
                                                            </Typography>
                                                            {pollPublished ? (
                                                                <Button
                                                                    variant="contained"
                                                                    onClick={handleViewResults}
                                                                >
                                                                    View Results
                                                                </Button>
                                                            ) : (
                                                                <Typography variant="body2">
                                                                    Results not published yet
                                                                </Typography>
                                                            )}
                                                        </Box>
                                                    )}
                                                </Box>
                                            )}
                                        </Box>
                                    ) : (
                                        <Box display="flex" width="100%" justifyContent="center" alignItems="center" mt={2}>
                                            <Typography variant="h6">No polls found</Typography>
                                        </Box>
                                    )}
                                </Box>
                            )}
                        </Box>
                    }
                    {tab === 'properties' &&
                        <Box sx={{ maxWidth: 700 }}>
                            <WarningModal
                                title="Remove Property"
                                warningText={`Are you sure you want to remove '${propsDeleteKey}'?`}
                                isOpen={propsDeleteOpen}
                                onClose={() => setPropsDeleteOpen(false)}
                                onSubmit={propsConfirmDelete}
                            />
                            <Box sx={{ mt: 1, mb: 2 }}>
                                <Select
                                    value={propsSelectedName}
                                    onChange={(e) => setPropsSelectedName(e.target.value)}
                                    displayEmpty
                                    size="small"
                                    fullWidth
                                >
                                    <MenuItem value="" disabled>Select a DID...</MenuItem>
                                    {propsNameEntries.map((name) => (
                                        <MenuItem key={name} value={name}>{name}</MenuItem>
                                    ))}
                                </Select>
                            </Box>
                            {propsSelectedName && (
                                <>
                                    {propsIsOwned && (
                                        <Box display="flex" sx={{ mb: 2, gap: 1 }}>
                                            <TextField
                                                label="Key"
                                                variant="outlined"
                                                value={propsNewKey}
                                                onChange={(e) => setPropsNewKey(e.target.value)}
                                                size="small"
                                                sx={{ flex: '0 0 150px' }}
                                            />
                                            <TextField
                                                label="Value"
                                                variant="outlined"
                                                value={propsNewValue}
                                                onChange={(e) => setPropsNewValue(e.target.value)}
                                                size="small"
                                                sx={{ flex: 1 }}
                                            />
                                            <Button
                                                variant="contained"
                                                onClick={propsAdd}
                                                disabled={!propsNewKey.trim()}
                                            >
                                                Add
                                            </Button>
                                        </Box>
                                    )}
                                    {propsLoading ? (
                                        <Typography color="text.secondary" sx={{ mt: 2 }}>Loading...</Typography>
                                    ) : Object.keys(propsData).length === 0 ? (
                                        <Typography color="text.secondary" sx={{ mt: 2 }}>No properties set</Typography>
                                    ) : (
                                        Object.entries(propsData).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => (
                                            <Box key={key} sx={{ display: 'flex', alignItems: 'flex-start', mb: 1, gap: 1 }}>
                                                <Typography sx={{ flex: '0 0 150px', fontWeight: 'bold', pt: propsEditingKey === key ? 1 : 0.5, wordBreak: 'break-all' }}>
                                                    {key}
                                                </Typography>
                                                {propsEditingKey === key ? (
                                                    <Box sx={{ flex: 1, display: 'flex', gap: 0.5, alignItems: 'flex-start' }}>
                                                        <TextField
                                                            value={propsEditValue}
                                                            onChange={(e) => setPropsEditValue(e.target.value)}
                                                            size="small"
                                                            fullWidth
                                                            multiline
                                                            maxRows={6}
                                                        />
                                                        <Tooltip title="Save">
                                                            <IconButton size="small" onClick={() => propsSaveEdit(key)} color="primary">
                                                                <LibraryAddCheck />
                                                            </IconButton>
                                                        </Tooltip>
                                                        <Tooltip title="Cancel">
                                                            <IconButton size="small" onClick={() => setPropsEditingKey(null)}>
                                                                <Clear />
                                                            </IconButton>
                                                        </Tooltip>
                                                    </Box>
                                                ) : (
                                                    <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
                                                        <Typography sx={{
                                                            flex: 1,
                                                            wordBreak: 'break-word',
                                                            fontFamily: typeof value !== 'string' ? 'monospace' : 'inherit',
                                                            fontSize: typeof value !== 'string' ? '0.85rem' : 'inherit',
                                                        }}>
                                                            {propsFormatValue(value)}
                                                        </Typography>
                                                        {propsIsOwned && (
                                                            <>
                                                                <Tooltip title="Edit">
                                                                    <IconButton size="small" onClick={() => propsStartEdit(key, value)}>
                                                                        <Edit />
                                                                    </IconButton>
                                                                </Tooltip>
                                                                <Tooltip title="Delete">
                                                                    <IconButton size="small" onClick={() => { setPropsDeleteKey(key); setPropsDeleteOpen(true); }}>
                                                                        <Delete />
                                                                    </IconButton>
                                                                </Tooltip>
                                                            </>
                                                        )}
                                                    </Box>
                                                )}
                                            </Box>
                                        ))
                                    )}
                                    <Box sx={{ mt: 2 }}>
                                        <Button variant="outlined" onClick={loadProps} size="small">
                                            Refresh
                                        </Button>
                                    </Box>
                                </>
                            )}
                        </Box>
                    }
                    {tab === 'credentials' &&
                        <Box>
                            <Box>
                                <Tabs
                                    value={credentialTab}
                                    onChange={(event, newTab) => setCredentialTab(newTab)}
                                    indicatorColor="primary"
                                    textColor="primary"
                                    variant="scrollable"
                                    scrollButtons="auto"
                                >
                                    <Tab key="held" value="held" label={'Held'} icon={<LibraryBooks />} />
                                    <Tab key="issue" value="issue" label={'Issue'} icon={<LibraryAdd />} />
                                    <Tab key="issued" value="issued" label={'Issued'} icon={<LibraryAddCheck />} />
                                </Tabs>
                            </Box>
                            {credentialTab === 'held' &&
                                <Box>
                                    <TableContainer component={Paper} style={{ maxHeight: '300px', overflow: 'auto' }}>
                                        <Table style={{ width: '800px' }}>
                                            <TableBody>
                                                <TableRow>
                                                    <TableCell style={{ width: '100%' }}>
                                                        <TextField
                                                            label="Credential DID"
                                                            style={{ width: '500px' }}
                                                            value={heldDID}
                                                            onChange={(e) => setHeldDID(e.target.value.trim())}
                                                            fullWidth
                                                            margin="normal"
                                                            inputProps={{ maxLength: 80 }}
                                                        />
                                                    </TableCell>
                                                    <TableCell>
                                                        <Button variant="contained" color="primary" onClick={() => resolveCredential(heldDID)} disabled={!heldDID}>
                                                            Resolve
                                                        </Button>
                                                    </TableCell>
                                                    <TableCell>
                                                        <Button variant="contained" color="primary" onClick={() => decryptCredential(heldDID)} disabled={!heldDID}>
                                                            Decrypt
                                                        </Button>
                                                    </TableCell>
                                                    <TableCell>
                                                        <Button variant="contained" color="primary" onClick={acceptCredential} disabled={!heldDID}>
                                                            Accept
                                                        </Button>
                                                    </TableCell>
                                                </TableRow>
                                                {heldList.map((did, index) => (
                                                    <TableRow key={index}>
                                                        <TableCell colSpan={6}>
                                                            <Typography style={{ fontSize: '1em', fontFamily: 'Courier' }}>
                                                                {did}
                                                            </Typography>
                                                            <Grid container direction="row" justifyContent="flex-start" alignItems="center" spacing={3}>
                                                                <Grid item>
                                                                    <Button variant="contained" color="primary" onClick={() => resolveCredential(did)}>
                                                                        Resolve
                                                                    </Button>
                                                                </Grid>
                                                                <Grid item>
                                                                    <Button variant="contained" color="primary" onClick={() => decryptCredential(did)}>
                                                                        Decrypt
                                                                    </Button>
                                                                </Grid>
                                                                <Grid item>
                                                                    <Button variant="contained" color="primary" onClick={() => removeCredential(did)} disabled={!credentialUnpublished(did)}>
                                                                        Remove
                                                                    </Button>
                                                                </Grid>
                                                                <Grid item>
                                                                    <Button variant="contained" color="primary" onClick={() => publishCredential(did)} disabled={!credentialUnpublished(did)}>
                                                                        Publish
                                                                    </Button>
                                                                </Grid>
                                                                <Grid item>
                                                                    <Button variant="contained" color="primary" onClick={() => revealCredential(did)} disabled={credentialRevealed(did)}>
                                                                        Reveal
                                                                    </Button>
                                                                </Grid>
                                                                <Grid item>
                                                                    <Button variant="contained" color="primary" onClick={() => unpublishCredential(did)} disabled={credentialUnpublished(did)}>
                                                                        Unpublish
                                                                    </Button>
                                                                </Grid>
                                                            </Grid>
                                                        </TableCell>
                                                    </TableRow>
                                                ))}
                                            </TableBody>
                                        </Table>
                                    </TableContainer>
                                    <p>{selectedHeld}</p>
                                    <textarea
                                        value={heldString}
                                        readOnly
                                        style={{ width: '800px', height: '600px', overflow: 'auto' }}
                                    />
                                </Box>
                            }
                            {credentialTab === 'issue' &&
                                <Box>
                                    <Grid container direction="row" justifyContent="flex-start" alignItems="center" spacing={3}>
                                        <Grid item>
                                            <Autocomplete
                                                freeSolo
                                                options={agentList || []}
                                                value={credentialSubject}
                                                onInputChange={(_e, value) => setCredentialSubject(value.trim())}
                                                style={{ width: '300px' }}
                                                renderInput={(params) => (
                                                    <TextField
                                                        {...params}
                                                        label="Subject (name, DID, or URI)"
                                                    />
                                                )}
                                            />
                                        </Grid>
                                        <Grid item>
                                            <Select
                                                style={{ width: '300px' }}
                                                value={credentialSchema}
                                                fullWidth
                                                displayEmpty
                                                onChange={(event) => setCredentialSchema(event.target.value)}
                                            >
                                                <MenuItem value="" disabled>
                                                    Select schema
                                                </MenuItem>
                                                {schemaList.map((alias, index) => (
                                                    <MenuItem value={alias} key={index}>
                                                        {alias}
                                                    </MenuItem>
                                                ))}
                                            </Select>
                                        </Grid>
                                        <Grid item>
                                            <Button variant="contained" color="primary" onClick={editCredential} disabled={!credentialSubject || !credentialSchema}>
                                                Edit Credential
                                            </Button>
                                        </Grid>
                                    </Grid>
                                    {credentialString &&
                                        <Box>
                                            <Grid container direction="column" spacing={1}>
                                                <Grid item>
                                                    <p>{`Editing ${credentialSchema} credential for ${credentialSubject}`}</p>
                                                </Grid>
                                                <Grid item>
                                                    <textarea
                                                        value={credentialString}
                                                        onChange={(e) => setCredentialString(e.target.value)}
                                                        style={{ width: '800px', height: '600px', overflow: 'auto' }}
                                                    />
                                                </Grid>
                                                <Grid container direction="row" justifyContent="flex-start" alignItems="center" spacing={3}>
                                                    <Grid item>
                                                        <Button variant="contained" color="primary" onClick={issueCredential} disabled={!credentialString || !registry}>
                                                            Issue Credential
                                                        </Button>
                                                    </Grid>
                                                    <Grid item>
                                                        <RegistrySelect />
                                                    </Grid>
                                                </Grid>
                                                {credentialDID &&
                                                    <>
                                                        <Grid item>
                                                            <Typography style={{ fontSize: '1em', fontFamily: 'Courier' }}>
                                                                {credentialDID}
                                                            </Typography>
                                                        </Grid>
                                                        <Grid item>
                                                            <Button variant="contained" color="primary" onClick={sendCredential} disabled={credentialSent}>
                                                                Send Credential
                                                            </Button>
                                                        </Grid>
                                                    </>
                                                }
                                            </Grid>
                                        </Box>
                                    }
                                </Box>
                            }
                            {credentialTab === 'issued' &&
                                <Box>
                                    <TableContainer component={Paper} style={{ maxHeight: '300px', overflow: 'auto' }}>
                                        <Table style={{ width: '800px' }}>
                                            <TableBody>
                                                {issuedList.map((did, index) => (
                                                    <TableRow key={index}>
                                                        <TableCell colSpan={6}>
                                                            <Typography style={{ fontSize: '1em', fontFamily: 'Courier' }}>
                                                                {did}
                                                            </Typography>
                                                            <Grid container direction="row" justifyContent="flex-start" alignItems="center" spacing={3}>
                                                                <Grid item>
                                                                    <Button variant="contained" color="primary" onClick={() => resolveIssued(did)}>
                                                                        Resolve
                                                                    </Button>
                                                                </Grid>
                                                                <Grid item>
                                                                    <Button variant="contained" color="primary" onClick={() => decryptIssued(did)}>
                                                                        Decrypt
                                                                    </Button>
                                                                </Grid>
                                                                <Grid item>
                                                                    <Button variant="contained" color="primary" onClick={() => updateIssued(did)} disabled={did !== selectedIssued || !issuedEdit || issuedString === issuedStringOriginal}>
                                                                        Update
                                                                    </Button>
                                                                </Grid>
                                                                <Grid item>
                                                                    <Button variant="contained" color="primary" onClick={() => revokeIssued(did)}>
                                                                        Revoke
                                                                    </Button>
                                                                </Grid>
                                                                <Grid item>
                                                                    <Button variant="contained" color="primary" onClick={() => sendIssued(did)}>
                                                                        Send
                                                                    </Button>
                                                                </Grid>
                                                            </Grid>
                                                        </TableCell>
                                                    </TableRow>
                                                ))}
                                            </TableBody>
                                        </Table>
                                    </TableContainer>
                                    <p>{selectedIssued}</p>
                                    {issuedEdit ? (
                                        <textarea
                                            value={issuedString}
                                            onChange={(e) => setIssuedString(e.target.value.trim())}
                                            style={{ width: '800px', height: '600px', overflow: 'auto' }}
                                        />

                                    ) : (
                                        <textarea
                                            value={issuedString}
                                            readOnly
                                            style={{ width: '800px', height: '600px', overflow: 'auto' }}
                                        />
                                    )}
                                </Box>
                            }
                        </Box>
                    }
                    {tab === 'dmail' &&
                        <Box>
                            <Box sx={boxRow}>
                                <Tooltip title="Refresh DMail">
                                    <IconButton onClick={refreshDmail}>
                                        <Refresh />
                                    </IconButton>
                                </Tooltip>

                                <Tooltip title="Import DMail">
                                    <IconButton onClick={importDmail}>
                                        <Download />
                                    </IconButton>
                                </Tooltip>

                                <TextField
                                    variant="outlined"
                                    size="small"
                                    placeholder="Search…"
                                    value={dmailSearchQuery}
                                    onChange={(e) => setDmailSearchQuery(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") {
                                            searchDmail();
                                        }
                                    }}
                                />

                                <Tooltip title="Search DMail">
                                    <IconButton onClick={searchDmail}>
                                        <Search />
                                    </IconButton>
                                </Tooltip>

                                <Tooltip title="Clear Search">
                                    <IconButton onClick={clearDmailSearch}>
                                        <Clear />
                                    </IconButton>
                                </Tooltip>
                            </Box>
                            <Box>
                                <Tabs
                                    value={dmailTab}
                                    onChange={(event, newTab) => {
                                        setDmailTab(newTab);
                                        setSelectedDmailDID('');
                                    }}
                                    indicatorColor="primary"
                                    textColor="primary"
                                    variant="scrollable"
                                    scrollButtons="auto"
                                >
                                    <Tab key="compose" value="compose" label={'Compose'} icon={<Create />} />
                                    <Tab key="inbox" value="inbox" label={'Inbox'} icon={<Inbox />} />
                                    <Tab key="outbox" value="outbox" label={'Outbox'} icon={<Outbox />} />
                                    <Tab key="drafts" value="drafts" label={'Drafts'} icon={<Drafts />} />
                                    <Tab key="archive" value="archive" label={'Archived'} icon={<Archive />} />
                                    <Tab key="trash" value="trash" label={'Trash'} icon={<Delete />} />
                                    <Tab key="all" value="all" label={'All Dmail'} icon={<AllInbox />} />
                                    <Tab key="results" value="results" label={'Results'} icon={<Search />} />
                                </Tabs>
                            </Box>
                            {dmailTab !== 'compose' &&
                                <Box>
                                    <Box>
                                        <TableContainer component={Paper} style={{ maxHeight: '300px', overflow: 'auto' }}>
                                            <Table size="small" sx={{ tableLayout: 'auto', width: 'auto' }}>
                                                <TableHead>
                                                    <TableRow>
                                                        <TableCell sx={{ fontWeight: 'bold', backgroundColor: '#f5f5f5' }}>
                                                            <TableSortLabel
                                                                active={dmailSortBy === 'sender'}
                                                                direction={dmailSortOrder}
                                                                onClick={() => {
                                                                    setDmailSortBy('sender');
                                                                    setDmailSortOrder(dmailSortOrder === 'asc' ? 'desc' : 'asc');
                                                                }}
                                                            >
                                                                Sender
                                                            </TableSortLabel>
                                                        </TableCell>
                                                        <TableCell sx={{ fontWeight: 'bold', backgroundColor: '#f5f5f5' }}>
                                                            <TableSortLabel
                                                                active={dmailSortBy === 'subject'}
                                                                direction={dmailSortOrder}
                                                                onClick={() => {
                                                                    setDmailSortBy('subject');
                                                                    setDmailSortOrder(dmailSortOrder === 'asc' ? 'desc' : 'asc');
                                                                }}
                                                            >
                                                                Subject
                                                            </TableSortLabel>
                                                        </TableCell>
                                                        <TableCell sx={{ fontWeight: 'bold', backgroundColor: '#f5f5f5' }}>
                                                            <TableSortLabel
                                                                active={dmailSortBy === 'date'}
                                                                direction={dmailSortOrder}
                                                                onClick={() => {
                                                                    setDmailSortBy('date');
                                                                    setDmailSortOrder(dmailSortOrder === 'asc' ? 'desc' : 'asc');
                                                                }}
                                                            >
                                                                Date
                                                            </TableSortLabel>
                                                        </TableCell>
                                                    </TableRow>
                                                </TableHead>
                                                <TableBody>
                                                    {sortedDmailEntries.map(([did, item], idx) => (
                                                        <TableRow
                                                            key={did}
                                                            hover
                                                            selected={selectedDmail && selectedDmail === item}
                                                            onClick={() => setSelectedDmailDID(did)}
                                                            style={{ cursor: 'pointer' }}
                                                        >
                                                            {isDmailUnread(item) ? (
                                                                <>
                                                                    <TableCell sx={{ fontWeight: 'bold', color: 'blue' }}>{item.sender}</TableCell>
                                                                    <TableCell sx={{ fontWeight: 'bold', color: 'blue' }}>{item.message.subject}</TableCell>
                                                                    <TableCell sx={{ fontWeight: 'bold', color: 'blue' }}>{item.date}</TableCell>
                                                                </>
                                                            ) : (
                                                                <>
                                                                    <TableCell>{item.sender}</TableCell>
                                                                    <TableCell>{item.message.subject}</TableCell>
                                                                    <TableCell>{item.date}</TableCell>
                                                                </>
                                                            )}
                                                        </TableRow>
                                                    ))}
                                                </TableBody>
                                            </Table>
                                        </TableContainer>
                                    </Box>
                                    <Box>
                                        <Grid container direction="row" justifyContent="flex-start" alignItems="center" spacing={3}>
                                            <Grid item>
                                                <Typography style={{ fontSize: '1.5em', fontWeight: 'bold' }}>
                                                    Dmail:
                                                </Typography>
                                            </Grid>
                                            <Grid item>
                                                <Typography style={{ fontSize: '1em', fontFamily: 'Courier' }}>
                                                    {selectedDmailDID || 'None selected'}
                                                </Typography>
                                            </Grid>
                                        </Grid>
                                        {selectedDmail && dmailTab === 'inbox' &&
                                            <Box sx={boxRow}>
                                                {isDmailUnread(selectedDmail) ? (
                                                    <Tooltip title="Mark as Read">
                                                        <IconButton onClick={markDmailRead}>
                                                            <MarkEmailRead />
                                                        </IconButton>
                                                    </Tooltip>
                                                ) : (
                                                    <Tooltip title="Mark as Unread">
                                                        <IconButton onClick={markDmailUnread}>
                                                            <MarkEmailUnread />
                                                        </IconButton>
                                                    </Tooltip>
                                                )}
                                                <Tooltip title="Archive">
                                                    <IconButton onClick={archiveDmail}>
                                                        <Archive />
                                                    </IconButton>
                                                </Tooltip>
                                                <Tooltip title="Move to Trash">
                                                    <IconButton onClick={deleteDmail}>
                                                        <Delete />
                                                    </IconButton>
                                                </Tooltip>
                                                <Tooltip title="Forward">
                                                    <IconButton onClick={forwardDmail}>
                                                        <Forward />
                                                    </IconButton>
                                                </Tooltip>
                                                <Tooltip title="Reply">
                                                    <IconButton onClick={replyDmail}>
                                                        <Reply />
                                                    </IconButton>
                                                </Tooltip>
                                                <Tooltip title="Reply All">
                                                    <IconButton onClick={replyAllDmail}>
                                                        <ReplyAll />
                                                    </IconButton>
                                                </Tooltip>
                                            </Box>
                                        }
                                        {selectedDmail && dmailTab === 'outbox' &&
                                            <Box sx={boxRow}>
                                                <Tooltip title="Archive">
                                                    <IconButton onClick={archiveDmail}>
                                                        <Archive />
                                                    </IconButton>
                                                </Tooltip>
                                                <Tooltip title="Move to Trash">
                                                    <IconButton onClick={deleteDmail}>
                                                        <Delete />
                                                    </IconButton>
                                                </Tooltip>
                                                <Tooltip title="Edit">
                                                    <IconButton onClick={editDmail}>
                                                        <Edit />
                                                    </IconButton>
                                                </Tooltip>
                                            </Box>
                                        }
                                        {selectedDmail && dmailTab === 'drafts' &&
                                            <Box sx={boxRow}>
                                                <Tooltip title="Archive">
                                                    <IconButton onClick={archiveDmail}>
                                                        <Archive />
                                                    </IconButton>
                                                </Tooltip>
                                                <Tooltip title="Move to Trash">
                                                    <IconButton onClick={deleteDmail}>
                                                        <Delete />
                                                    </IconButton>
                                                </Tooltip>
                                                <Tooltip title="Edit">
                                                    <IconButton onClick={editDmail}>
                                                        <Edit />
                                                    </IconButton>
                                                </Tooltip>
                                            </Box>
                                        }
                                        {selectedDmail && dmailTab === 'archive' &&
                                            <Box sx={boxRow}>
                                                <Tooltip title="Unarchive">
                                                    <IconButton onClick={unarchiveDmail}>
                                                        <Unarchive />
                                                    </IconButton>
                                                </Tooltip>
                                                <Tooltip title="Move to Trash">
                                                    <IconButton onClick={deleteDmail}>
                                                        <Delete />
                                                    </IconButton>
                                                </Tooltip>
                                            </Box>
                                        }
                                        {selectedDmail && dmailTab === 'trash' &&
                                            <Box sx={boxRow}>
                                                <Tooltip title="Restore from Trash">
                                                    <IconButton onClick={undeleteDmail}>
                                                        <RestoreFromTrash />
                                                    </IconButton>
                                                </Tooltip>
                                            </Box>
                                        }
                                        {selectedDmail &&
                                            <Paper style={{ padding: 16 }}>
                                                <TableContainer>
                                                    <Table size="small" sx={{ tableLayout: 'auto', width: 'auto' }}>
                                                        <TableBody>
                                                            <TableRow>
                                                                <TableCell><b>To</b></TableCell>
                                                                <TableCell>{selectedDmail.to.join(', ')}</TableCell>
                                                            </TableRow>
                                                            <TableRow>
                                                                <TableCell><b>Cc</b></TableCell>
                                                                <TableCell>{selectedDmail.cc.join(', ')}</TableCell>
                                                            </TableRow>
                                                            <TableRow>
                                                                <TableCell><b>From</b></TableCell>
                                                                <TableCell>
                                                                    {selectedDmail.sender}
                                                                    {selectedDmail.sender.startsWith('did:') && (
                                                                        <Tooltip title="Add Contact">
                                                                            <IconButton onClick={() => addDmailContact(selectedDmail.sender)}>
                                                                                <PersonAdd />
                                                                            </IconButton>
                                                                        </Tooltip>
                                                                    )}
                                                                </TableCell>
                                                            </TableRow>
                                                            <TableRow>
                                                                <TableCell><b>Date</b></TableCell>
                                                                <TableCell>{selectedDmail.date}</TableCell>
                                                            </TableRow>
                                                            <TableRow>
                                                                <TableCell><b>Subject</b></TableCell>
                                                                <TableCell>{selectedDmail.message?.subject}</TableCell>
                                                            </TableRow>
                                                            <TableRow>
                                                                <TableCell><b>Reference</b></TableCell>
                                                                {selectedDmail.message?.reference ? (
                                                                    <TableCell>
                                                                        <button
                                                                            type="button"
                                                                            style={{
                                                                                background: "none",
                                                                                border: "none",
                                                                                padding: 0,
                                                                                margin: 0,
                                                                                color: "#1976d2",
                                                                                textDecoration: "underline",
                                                                                cursor: "pointer",
                                                                                font: "inherit"
                                                                            }}
                                                                            onClick={e => {
                                                                                e.preventDefault();
                                                                                if (dmailList[selectedDmail.message.reference]) {
                                                                                    setSelectedDmailDID(selectedDmail.message.reference);
                                                                                } else {
                                                                                    showAlert('Original dmail not found');
                                                                                }
                                                                            }}
                                                                        >
                                                                            {selectedDmail.message.reference}
                                                                        </button>
                                                                    </TableCell>
                                                                ) : (
                                                                    <TableCell></TableCell>
                                                                )}
                                                            </TableRow>
                                                            <TableRow>
                                                                <TableCell><b>Tags</b></TableCell>
                                                                <TableCell>{selectedDmail.tags.join(', ')}</TableCell>
                                                            </TableRow>
                                                        </TableBody>
                                                    </Table>
                                                </TableContainer>
                                                <TextField
                                                    value={selectedDmail.message.body}
                                                    multiline
                                                    minRows={10}
                                                    maxRows={30}
                                                    fullWidth
                                                    InputProps={{ readOnly: true }}
                                                    variant="outlined"
                                                />
                                                {selectedDmail.attachments && Object.keys(selectedDmail.attachments).length > 0 &&
                                                    <TableContainer>
                                                        <Table size="small" sx={{ tableLayout: 'auto', width: 'auto' }}>
                                                            <TableBody>
                                                                <TableRow>
                                                                    <TableCell sx={{ fontWeight: 'bold', backgroundColor: '#f5f5f5' }}>
                                                                        Attachment
                                                                    </TableCell>
                                                                    <TableCell sx={{ fontWeight: 'bold', backgroundColor: '#f5f5f5' }}>
                                                                        Size (bytes)
                                                                    </TableCell>
                                                                </TableRow>
                                                                {Object.entries(selectedDmail.attachments).map(([name, item], index) => (
                                                                    <TableRow key={index}>
                                                                        <TableCell>
                                                                            <Tooltip title="Download">
                                                                                <IconButton onClick={() => downloadDmailAttachment(name)}>
                                                                                    <Download />
                                                                                </IconButton>
                                                                            </Tooltip>
                                                                            {getVaultItemIcon(name, item)}
                                                                            {name}
                                                                        </TableCell>
                                                                        <TableCell>
                                                                            {item.bytes}
                                                                        </TableCell>
                                                                    </TableRow>
                                                                ))}
                                                            </TableBody>
                                                        </Table>
                                                    </TableContainer>
                                                }
                                            </Paper>
                                        }
                                    </Box>
                                </Box>
                            }
                            {dmailTab === 'compose' &&
                                <Box>
                                    <Grid container direction="column" spacing={1}>
                                        <Grid container direction="row" spacing={1} alignItems={'center'}>
                                            <Grid item>
                                                <Typography variant="subtitle1">To:</Typography>
                                            </Grid>
                                            <Grid item>
                                                <Autocomplete
                                                    freeSolo
                                                    options={agentList || []} // array of options, e.g. DIDs or names
                                                    value={dmailTo}
                                                    onChange={(event, newValue) => setDmailTo(newValue)}
                                                    onInputChange={(event, newInputValue) => setDmailTo(newInputValue)}
                                                    renderInput={(params) => (
                                                        <TextField
                                                            {...params}
                                                            label="Name or DID"
                                                            style={{ width: '500px' }}
                                                            margin="normal"
                                                            inputProps={{ ...params.inputProps, maxLength: 80 }}
                                                            fullWidth
                                                        />
                                                    )}
                                                />
                                            </Grid>
                                            <Grid item>
                                                <Button variant="contained" color="primary" onClick={addDmailTo} disabled={!dmailTo}>
                                                    Add
                                                </Button>
                                            </Grid>
                                        </Grid>
                                        {dmailToList.map(recipient => (
                                            <Grid container direction="row" spacing={1}>
                                                <Grid item>
                                                    <Button onClick={() => removeDmailTo(recipient)}><Clear /></Button>
                                                </Grid>
                                                <Grid item>
                                                    <Typography variant="subtitle1">{recipient}</Typography>
                                                </Grid>
                                            </Grid>
                                        ))}
                                        <Grid container direction="row" spacing={1} alignItems={'center'}>
                                            <Grid item>
                                                <Typography variant="subtitle1">Cc:</Typography>
                                            </Grid>
                                            <Grid item>
                                                <Autocomplete
                                                    freeSolo
                                                    options={agentList || []} // array of options, e.g. DIDs or names
                                                    value={dmailCc}
                                                    onChange={(event, newValue) => setDmailCc(newValue)}
                                                    onInputChange={(event, newInputValue) => setDmailCc(newInputValue)}
                                                    renderInput={(params) => (
                                                        <TextField
                                                            {...params}
                                                            label="Name or DID"
                                                            style={{ width: '500px' }}
                                                            margin="normal"
                                                            inputProps={{ ...params.inputProps, maxLength: 80 }}
                                                            fullWidth
                                                        />
                                                    )}
                                                />
                                            </Grid>
                                            <Grid item>
                                                <Button variant="contained" color="primary" onClick={addDmailCc} disabled={!dmailCc}>
                                                    Add
                                                </Button>
                                            </Grid>
                                        </Grid>
                                        {dmailCcList.map(recipient => (
                                            <Grid container direction="row" spacing={1}>
                                                <Grid item>
                                                    <Button onClick={() => removeDmailCc(recipient)}><Clear /></Button>
                                                </Grid>
                                                <Grid item>
                                                    <Typography variant="subtitle1">{recipient}</Typography>
                                                </Grid>
                                            </Grid>
                                        ))}
                                        <Grid item>
                                            <TextField
                                                label="Subject"
                                                style={{ width: '800px' }}
                                                value={dmailSubject}
                                                onChange={e => setDmailSubject(e.target.value)}
                                                margin="normal"
                                                inputProps={{ maxLength: 120 }}
                                                fullWidth
                                            />
                                        </Grid>
                                        <Grid item>
                                            <TextField
                                                margin="normal"
                                                label="Body"
                                                style={{ width: '800px' }}
                                                multiline
                                                minRows={12}
                                                maxRows={12}
                                                value={dmailBody}
                                                onChange={e => setDmailBody(e.target.value)}
                                            />
                                        </Grid>
                                        {!dmailDID &&
                                            <Box>
                                                <Box sx={boxRow}>
                                                    <Button variant="contained" color="primary" onClick={createDmail} disabled={!registry}>
                                                        Create Dmail
                                                    </Button>
                                                    <RegistrySelect />
                                                    <FormControlLabel
                                                        control={
                                                            <Checkbox
                                                                checked={dmailEphemeral}
                                                                onChange={e => setDmailEphemeral(e.target.checked)}
                                                                color="primary"
                                                            />
                                                        }
                                                        label="ephemeral"
                                                        sx={{ ml: 2 }}
                                                        disabled={registry !== 'hyperswarm'}
                                                    />
                                                    <TextField
                                                        label="Valid Until"
                                                        type="date"
                                                        value={dmailValidUntil}
                                                        onChange={e => setDmailValidUntil(e.target.value)}
                                                        InputLabelProps={{ shrink: true }}
                                                        sx={{ ml: 2, minWidth: 180 }}
                                                        disabled={!dmailEphemeral || registry !== 'hyperswarm'}
                                                    />
                                                </Box>
                                                <Button variant="contained" color="primary" onClick={clearSendDmail}>
                                                    Clear Dmail
                                                </Button>
                                            </Box>
                                        }
                                        {dmailDID &&
                                            <Box>
                                                <Typography style={{ fontSize: '1em', fontFamily: 'Courier' }}>
                                                    {dmailDID}
                                                </Typography>
                                                <p></p>
                                                <Grid container direction="column" spacing={1}>
                                                    <Grid item>
                                                        Attachments:
                                                        <Button
                                                            variant="contained"
                                                            color="primary"
                                                            sx={{ ml: 2 }}
                                                            onClick={() => document.getElementById('attachmentUpload').click()}
                                                        >
                                                            Upload...
                                                        </Button>
                                                        <input
                                                            type="file"
                                                            id="attachmentUpload"
                                                            style={{ display: 'none' }}
                                                            onChange={uploadDmailAttachment}
                                                        />
                                                    </Grid>

                                                    {Object.entries(dmailAttachments).map(([name, item], index) => (
                                                        <Grid item>
                                                            <Button onClick={() => removeDmailAttachment(name)}><Clear /></Button>
                                                            {getVaultItemIcon(name, item)} {name}
                                                        </Grid>
                                                    ))}
                                                </Grid>
                                                <p></p>
                                                <Box sx={boxRow}>
                                                    <Button variant="contained" color="primary" onClick={updateDmail}>
                                                        Update Dmail
                                                    </Button>
                                                    <Button variant="contained" color="primary" onClick={sendDmail}>
                                                        Send Dmail
                                                    </Button>
                                                    <Button variant="contained" color="primary" onClick={revokeDmail}>
                                                        Revoke Dmail...
                                                    </Button>
                                                </Box>
                                                <Button variant="contained" color="primary" onClick={clearSendDmail}>
                                                    Clear Dmail
                                                </Button>
                                            </Box>
                                        }
                                    </Grid>
                                </Box>
                            }
                        </Box>
                    }
                    {tab === 'create' &&
                        <Grid>
                            <Grid container direction="row" justifyContent="flex-start" alignItems="center" spacing={3}>
                                <Grid item>
                                    <Button variant="contained" color="primary" onClick={() => setShowCreateDialog(true)}>
                                        Create ID...
                                    </Button>
                                </Grid>
                            </Grid>
                            <Grid container direction="row" justifyContent="flex-start" alignItems="center" spacing={3}>
                                <Grid item>
                                    <Button variant="contained" color="primary" onClick={cancelCreate} disabled={!saveId}>
                                        Cancel
                                    </Button>
                                </Grid>
                            </Grid>
                        </Grid>
                    }
                    {tab === 'auth' &&
                        <Box>
                            <Table style={{ width: '800px' }}>
                                <TableBody>
                                    <TableRow>
                                        <TableCell style={{ width: '20%' }}>Challenge</TableCell>
                                        <TableCell style={{ width: '80%' }}>
                                            <TextField
                                                label=""
                                                value={challenge}
                                                onChange={(e) => setChallenge(e.target.value.trim())}
                                                fullWidth
                                                margin="normal"
                                                inputProps={{ maxLength: 85, style: { fontFamily: 'Courier', fontSize: '0.8em' } }}
                                            />
                                            <br />
                                            <Grid container direction="row" justifyContent="flex-start" alignItems="center" spacing={3}>
                                                <Grid item>
                                                    <Button variant="contained" color="primary" onClick={openChallengeDialog}>
                                                        New...
                                                    </Button>
                                                </Grid>
                                                <Grid item>
                                                    <Button variant="contained" color="primary" onClick={() => resolveChallenge(challenge)} disabled={!challenge || challenge === authDID}>
                                                        Resolve
                                                    </Button>
                                                </Grid>
                                                <Grid item>
                                                    <Button variant="contained" color="primary" onClick={createResponse} disabled={!challenge}>
                                                        Respond
                                                    </Button>
                                                </Grid>
                                                <Grid item>
                                                    <Button variant="contained" color="primary" onClick={clearChallenge} disabled={!challenge}>
                                                        Clear
                                                    </Button>
                                                </Grid>
                                            </Grid>
                                        </TableCell>
                                    </TableRow>
                                    <TableRow>
                                        <TableCell style={{ width: '20%' }}>Response</TableCell>
                                        <TableCell style={{ width: '80%' }}>
                                            <TextField
                                                label=""
                                                value={response}
                                                onChange={(e) => setResponse(e.target.value.trim())}
                                                fullWidth
                                                margin="normal"
                                                inputProps={{ maxLength: 85, style: { fontFamily: 'Courier', fontSize: '0.8em' } }}
                                            />
                                            <br />
                                            <Grid container direction="row" justifyContent="flex-start" alignItems="center" spacing={3}>
                                                <Grid item>
                                                    <Button variant="contained" color="primary" onClick={() => decryptResponse(response)} disabled={!response || response === authDID}>
                                                        Decrypt
                                                    </Button>
                                                </Grid>
                                                <Grid item>
                                                    <Button variant="contained" color="primary" onClick={verifyResponse} disabled={!response}>
                                                        Verify
                                                    </Button>
                                                </Grid>
                                                <Grid item>
                                                    <Button variant="contained" color="primary" onClick={sendResponse} disabled={disableSendResponse}>
                                                        Send
                                                    </Button>
                                                </Grid>
                                                <Grid item>
                                                    <Button variant="contained" color="primary" onClick={clearResponse} disabled={!response}>
                                                        Clear
                                                    </Button>
                                                </Grid>
                                            </Grid>
                                        </TableCell>
                                    </TableRow>
                                </TableBody>
                            </Table>
                            <p>{authDID}</p>
                            <textarea
                                value={authString}
                                readOnly
                                style={{ width: '800px', height: '600px', overflow: 'auto' }}
                            />
                        </Box>
                    }
                    {tab === 'lightning' &&
                        <Box>
                            <p />
                            <Tabs
                                value={lightningTab}
                                onChange={(_, v) => {
                                    setLightningTab(v);
                                    if (v === 'wallet') fetchLightningBalance();
                                    if (v === 'payments') fetchLightningPayments();
                                }}
                                indicatorColor="primary"
                                textColor="primary"
                            >
                                <Tab label="Wallet" value="wallet" />
                                <Tab label="Payments" value="payments" />
                                <Tab label="Receive" value="receive" />
                                <Tab label="Send" value="send" />
                                <Tab label="Zap" value="zap" />
                            </Tabs>

                            {lightningTab === 'wallet' &&
                                <Box sx={{ mt: 2 }}>
                                    {lightningIsConfigured === false &&
                                        <Box>
                                            <Typography>No Lightning wallet configured for this identity.</Typography>
                                            <p />
                                            <Button variant="contained" color="primary" onClick={setupLightning}>
                                                Set Up Lightning
                                            </Button>
                                        </Box>
                                    }
                                    {lightningIsConfigured === true &&
                                        <Box>
                                            {lightningWalletError ?
                                                <Typography color="error">{lightningWalletError}</Typography>
                                            :
                                                <Typography variant="h6">
                                                    Balance: {(lightningBalance ?? 0).toLocaleString()} sats
                                                </Typography>
                                            }
                                            <p />
                                            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                                                <Button variant="outlined" onClick={fetchLightningBalance}>
                                                    Refresh
                                                </Button>
                                                <Button
                                                    variant="outlined"
                                                    color={isPublished ? 'warning' : 'success'}
                                                    onClick={togglePublishLightning}
                                                    disabled={loadingPublishToggle}
                                                >
                                                    {loadingPublishToggle
                                                        ? (isPublished ? 'Unpublishing...' : 'Publishing...')
                                                        : isPublished ? 'Unpublish Lightning' : 'Publish Lightning'}
                                                </Button>
                                                <Button variant="outlined" color="error" onClick={disconnectLightning}>
                                                    Disconnect Wallet
                                                </Button>
                                            </Box>
                                        </Box>
                                    }
                                </Box>
                            }

                            {lightningTab === 'payments' &&
                                <Box sx={{ mt: 2 }}>
                                    <Box sx={{ display: "flex", alignItems: "center", gap: 2, mb: 2, flexWrap: "wrap" }}>
                                        <Button variant="outlined" onClick={fetchLightningPayments} disabled={loadingPayments}>
                                            Refresh
                                        </Button>
                                        {['settled', 'pending', 'failed', 'expired'].map(s => (
                                            <FormControlLabel key={s} label={s} sx={{ mr: 0 }}
                                                control={<Checkbox size="small" checked={lightningStatusFilter[s]}
                                                    onChange={e => setLightningStatusFilter(f => ({ ...f, [s]: e.target.checked }))} />} />
                                        ))}
                                    </Box>
                                    {loadingPayments && <Typography>Loading...</Typography>}
                                    {!loadingPayments && lightningPayments.length === 0 &&
                                        <Typography>No payments found.</Typography>
                                    }
                                    {!loadingPayments && lightningPayments.length > 0 &&
                                        <TableContainer component={Paper}>
                                            <Table size="small" sx={{ tableLayout: "fixed" }}>
                                                <colgroup>
                                                    <col style={{ width: "190px" }} />
                                                    <col style={{ width: "120px" }} />
                                                    <col style={{ width: "60px" }} />
                                                    <col style={{ width: "80px" }} />
                                                    <col />
                                                </colgroup>
                                                <TableHead>
                                                    <TableRow>
                                                        <TableCell>Date</TableCell>
                                                        <TableCell align="right">Amount (sats)</TableCell>
                                                        <TableCell align="right">Fee</TableCell>
                                                        <TableCell>Status</TableCell>
                                                        <TableCell>Memo</TableCell>
                                                    </TableRow>
                                                </TableHead>
                                                <TableBody>
                                                    {lightningPayments.map((p, i) => {
                                                        const d = p.time ? new Date(p.time) : null;
                                                        const date = d ? `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}` : '—';
                                                        const displayStatus = p.status === 'success' ? 'settled'
                                                            : p.status === 'failed' ? 'failed'
                                                            : (p.expiry && new Date(p.expiry) < new Date()) ? 'expired'
                                                            : 'pending';
                                                        if (!lightningStatusFilter[displayStatus]) return null;
                                                        const statusColor = displayStatus === 'settled' ? 'inherit'
                                                            : displayStatus === 'failed' ? 'error.main'
                                                            : 'text.secondary';
                                                        return (
                                                        <TableRow key={i}>
                                                            <TableCell>{date}</TableCell>
                                                            <TableCell align="right">{p.amount}</TableCell>
                                                            <TableCell align="right">{p.fee > 0 ? p.fee : ''}</TableCell>
                                                            <TableCell><Box component="span" sx={{ color: statusColor }}>{displayStatus}</Box></TableCell>
                                                            <TableCell>{p.memo || '—'}</TableCell>
                                                        </TableRow>
                                                        );
                                                    })}
                                                </TableBody>
                                            </Table>
                                        </TableContainer>
                                    }
                                </Box>
                            }

                            {lightningTab === 'receive' &&
                                <Box sx={{ mt: 2, display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 500 }}>
                                    <TextField
                                        label="Amount (sats)"
                                        type="number"
                                        value={lightningReceiveAmount}
                                        onChange={(e) => setLightningReceiveAmount(e.target.value)}
                                        size="small"
                                    />
                                    <TextField
                                        label="Memo (optional)"
                                        value={lightningReceiveMemo}
                                        onChange={(e) => setLightningReceiveMemo(e.target.value)}
                                        size="small"
                                    />
                                    <Box>
                                        <Button variant="contained" color="primary" onClick={createLightningInvoice}>
                                            Create Invoice
                                        </Button>
                                    </Box>
                                    {lightningInvoice &&
                                        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                                            <TextField
                                                label="BOLT11 Invoice"
                                                value={lightningInvoice}
                                                multiline
                                                rows={3}
                                                InputProps={{ readOnly: true }}
                                                size="small"
                                                onClick={(e) => e.target.select()}
                                            />
                                            <Box>
                                                <Button variant="outlined" size="small" onClick={() => {
                                                    navigator.clipboard.writeText(lightningInvoice);
                                                    showSuccess('Invoice copied to clipboard');
                                                }}>
                                                    Copy
                                                </Button>
                                            </Box>
                                            <Box sx={{ mt: 1 }}>
                                                <QRCodeSVG value={lightningInvoice} size={200} />
                                            </Box>
                                        </Box>
                                    }
                                </Box>
                            }

                            {lightningTab === 'send' &&
                                <Box sx={{ mt: 2, display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 500 }}>
                                    <TextField
                                        label="BOLT11 Invoice"
                                        value={bolt11Input}
                                        onChange={(e) => {
                                            setBolt11Input(e.target.value);
                                            setDecodedInvoice(null);
                                            setLightningPaymentResult(null);
                                        }}
                                        multiline
                                        rows={3}
                                        size="small"
                                    />
                                    <Box sx={{ display: 'flex', gap: 1 }}>
                                        <Button variant="outlined" onClick={decodeLightningInvoice} disabled={!bolt11Input.trim()}>
                                            Decode
                                        </Button>
                                        {decodedInvoice &&
                                            <Button variant="contained" color="primary" onClick={payLightningInvoice}>
                                                Pay
                                            </Button>
                                        }
                                    </Box>
                                    {decodedInvoice &&
                                        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                                            {decodedInvoice.amount !== undefined &&
                                                <Typography variant="body2"><strong>Amount:</strong> {decodedInvoice.amount}</Typography>
                                            }
                                            {decodedInvoice.description &&
                                                <Typography variant="body2"><strong>Description:</strong> {decodedInvoice.description}</Typography>
                                            }
                                            {decodedInvoice.network &&
                                                <Typography variant="body2"><strong>Network:</strong> {decodedInvoice.network}</Typography>
                                            }
                                            {decodedInvoice.created &&
                                                <Typography variant="body2"><strong>Created:</strong> {decodedInvoice.created}</Typography>
                                            }
                                            {decodedInvoice.expires &&
                                                <Typography variant="body2"><strong>Expires:</strong> {decodedInvoice.expires}</Typography>
                                            }
                                        </Box>
                                    }
                                    {lightningPaymentResult &&
                                        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, mt: 1 }}>
                                            <Typography variant="body2"><strong>Payment Hash:</strong> {lightningPaymentResult.paymentHash}</Typography>
                                            {lightningPaymentResult.preimage &&
                                                <Typography variant="body2"><strong>Preimage (Proof):</strong> {lightningPaymentResult.preimage}</Typography>
                                            }
                                        </Box>
                                    }
                                </Box>
                            }

                            {lightningTab === 'zap' &&
                                <Box sx={{ mt: 2, display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 500 }}>
                                    <Autocomplete
                                        freeSolo
                                        options={agentList || []}
                                        value={zapDid}
                                        onChange={(event, newValue) => {
                                            setZapDid(newValue || '');
                                            setZapResult(null);
                                        }}
                                        onInputChange={(event, newInputValue) => {
                                            setZapDid(newInputValue);
                                            setZapResult(null);
                                        }}
                                        renderInput={(params) => (
                                            <TextField
                                                {...params}
                                                label="Recipient"
                                                size="small"
                                                placeholder="DID, alias, or Lightning Address"
                                            />
                                        )}
                                    />
                                    <TextField
                                        label="Amount (sats)"
                                        type="number"
                                        value={zapAmount}
                                        onChange={(e) => setZapAmount(e.target.value)}
                                        size="small"
                                    />
                                    <TextField
                                        label="Memo (optional)"
                                        value={zapMemo}
                                        onChange={(e) => setZapMemo(e.target.value)}
                                        size="small"
                                    />
                                    <Box>
                                        <Button
                                            variant="contained"
                                            color="primary"
                                            onClick={handleZap}
                                            disabled={loadingZap || !zapDid.trim() || !zapAmount.trim()}
                                        >
                                            {loadingZap ? 'Zapping...' : 'Zap'}
                                        </Button>
                                    </Box>
                                        {zapResult &&
                                            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, mt: 1 }}>
                                                <Typography variant="body2"><strong>Status:</strong> {zapResult.paid ? 'Settled' : zapResult.status === 'failed' ? 'Failed' : 'Pending'}</Typography>
                                                <Typography variant="body2"><strong>Payment Hash:</strong> {zapResult.paymentHash}</Typography>
                                                {zapResult.preimage &&
                                                    <Typography variant="body2"><strong>Preimage (Proof):</strong> {zapResult.preimage}</Typography>
                                            }
                                        </Box>
                                    }
                                </Box>
                            }
                        </Box>
                    }
                    {tab === 'wallet' &&
                        <Box>
                            <p />
                            <Grid container direction="row" justifyContent="flex-start" alignItems="center" spacing={3}>
                                <Grid item>
                                    <Button variant="contained" color="primary" onClick={newWallet}>
                                        New...
                                    </Button>
                                </Grid>
                                <Grid item>
                                    <Button variant="contained" color="primary" onClick={importWallet}>
                                        Import...
                                    </Button>
                                </Grid>
                                <Grid item>
                                    <Button variant="contained" color="primary" onClick={backupWallet}>
                                        Backup
                                    </Button>
                                </Grid>
                                <Grid item>
                                    <Button variant="contained" color="primary" onClick={recoverWallet}>
                                        Recover...
                                    </Button>
                                </Grid>
                                <Grid item>
                                    <Button variant="contained" color="primary" onClick={checkWallet} disabled={checkingWallet}>
                                        Check...
                                    </Button>
                                </Grid>
                            </Grid>
                            <p />
                            <Grid container direction="row" justifyContent="flex-start" alignItems="center" spacing={3}>
                                <Grid item>
                                    {mnemonicString ? (
                                        <Button variant="contained" color="primary" onClick={hideMnemonic}>
                                            Hide Mnemonic
                                        </Button>
                                    ) : (
                                        <Button variant="contained" color="primary" onClick={showMnemonic}>
                                            Show Mnemonic
                                        </Button>
                                    )}
                                </Grid>
                                <Grid item>
                                    {walletString ? (
                                        <Button variant="contained" color="primary" onClick={hideWallet}>
                                            Hide Wallet
                                        </Button>
                                    ) : (
                                        <Button variant="contained" color="primary" onClick={showWallet}>
                                            Show Wallet
                                        </Button>
                                    )}
                                </Grid>
                                <Grid item>
                                    <Button variant="contained" color="primary" onClick={downloadWallet}>
                                        Download
                                    </Button>
                                </Grid>
                                <Grid item>
                                    <Button variant="contained" color="primary" onClick={uploadWallet}>
                                        Upload...
                                    </Button>
                                </Grid>
                                <Grid item>
                                    <Button variant="contained" color="primary" onClick={changePassphrase}>
                                        Change Passphrase...
                                    </Button>
                                </Grid>
                            </Grid>
                            <p />
                            <Box>
                                <pre>{mnemonicString}</pre>
                            </Box>
                            <Box>
                                {walletString &&
                                    <textarea
                                        value={walletString}
                                        readonly
                                        style={{ width: '800px', height: '600px', overflow: 'auto' }}
                                    />
                                }
                            </Box>
                        </Box>
                    }
                    {tab === 'access' &&
                        <Box>
                            Special Access
                        </Box>
                    }
                    {tab === 'settings' &&
                        <Box sx={{ display: 'flex', flexDirection: 'column', maxWidth: '400px', mt: 1 }}>
                            <TextField
                                label="Server URL"
                                variant="outlined"
                                value={settingsUrl}
                                onChange={(e) => setSettingsUrl(e.target.value)}
                                sx={{ mb: 2 }}
                            />
                            <TextField
                                label="Auto-refresh interval (seconds)"
                                variant="outlined"
                                type="number"
                                value={settingsRefreshIntervalSeconds}
                                onChange={(e) => setSettingsRefreshIntervalSeconds(e.target.value)}
                                inputProps={{ min: 0, step: 1 }}
                                helperText="Set to 0 to disable automatic DMail and poll refresh."
                                sx={{ mb: 2 }}
                            />
                            <Button
                                variant="contained"
                                color="primary"
                                onClick={saveSettings}
                                startIcon={<Save />}
                                sx={{ alignSelf: 'start' }}
                            >
                                Save
                            </Button>
                            <Typography variant="caption" sx={{ mt: 3, opacity: 0.6 }}>
                                Client v{packageJson.version} | Server v{serverVersion || '...'}
                            </Typography>
                        </Box>
                    }
                    <LoginDialog
                        open={editLoginOpen}
                        onClose={() => setEditLoginOpen(false)}
                        onOK={addLoginVaultItem}
                    />
                    <LoginDialog
                        open={revealLoginOpen}
                        onClose={() => setRevealLoginOpen(false)}
                        login={revealLogin}
                        readOnly
                    />
                    <DmailDialog
                        open={revealDmailOpen}
                        onClose={() => setRevealDmailOpen(false)}
                        dmail={revealDmail}
                        readOnly
                    />
                </Box>
            </header>
        </div >
    );
}

export default KeymasterUI;
