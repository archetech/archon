import React, {useEffect, useState} from "react";
import {
    Autocomplete,
    Box,
    Button,
    IconButton,
    MenuItem,
    Select,
    SelectChangeEvent,
    TextField,
    Typography,
    RadioGroup,
    Radio,
    FormControlLabel,
    Checkbox,
    Tooltip,
    Tabs,
    Tab, FormControl,
} from "@mui/material";
import {
    AddCircleOutline,
    BarChart,
    Block,
    Close,
    Delete,
    Edit,
    HowToVote,
    PersonAdd,
} from "@mui/icons-material";
import { useWalletContext } from "../contexts/WalletProvider";
import { useVariablesContext } from "../contexts/VariablesProvider";
import { useUIContext } from "../contexts/UIContext";
import { useSnackbar } from "../contexts/SnackbarProvider";
import PollResultsModal from "../modals/PollResultsModal";
import {NoticeMessage, PollConfig, PollResults} from "@didcid/keymaster/types";
import TextInputModal from "../modals/TextInputModal";
import WarningModal from "../modals/WarningModal";
import CopyResolveDID from "./CopyResolveDID";
import DisplayDID from "./DisplayDID";
import { useThemeContext } from "../contexts/ContextProviders";

const PollsTab: React.FC = () => {
    const { keymaster } = useWalletContext();
    const {
        setError,
        setSuccess,
    } = useSnackbar();
    const {
        currentDID,
        currentId,
        registries,
        aliasList,
        agentList,
        pollList,
    } = useVariablesContext();
    const { refreshAliases } = useUIContext();
    const { isTabletUp } = useThemeContext();
    const [registry, setRegistry] = useState<string>("hyperswarm");
    const [pollName, setPollName] = useState<string>("");
    const [description, setDescription] = useState<string>("");
    const [optionsStr, setOptionsStr] = useState<string>("yes, no, abstain");

    const [deadline, setDeadline] = useState<string>("");
    const [createdPollDid, setCreatedPollDid] = useState<string>("");
    const [voterInput, setVoterInput] = useState<string>("");
    const [voters, setVoters] = useState<Record<string, any>>({});
    const [selectedPollName, setSelectedPollName] = useState<string>("");
    const [selectedPollDesc, setSelectedPollDesc] = useState<string>("");
    const [pollOptions, setPollOptions] = useState<string[]>([]);
    const [selectedOptionIdx, setSelectedOptionIdx] = useState<number>(0);
    const [spoil, setSpoil] = useState<boolean>(false);
    const [pollDeadline, setPollDeadline] = useState<Date | null>(null);
    const [pollPublished, setPollPublished] = useState<boolean>(false);
    const [pollController, setPollController] = useState<string>("");
    const [lastBallotDid, setLastBallotDid] = useState<string>("");
    const [hasVoted, setHasVoted] = useState<boolean>(false);
    const [pollResults, setPollResults] = useState<PollResults | null>(null);
    const [resultsOpen, setResultsOpen] = useState<boolean>(false);
    const [activeTab, setActiveTab] = useState<"create" | "view">("create");
    const [ballotSent, setBallotSent] = useState<boolean>(false);
    const [pollNoticeSent, setPollNoticeSent] = useState<boolean>(false);
    const [renameOpen, setRenameOpen] = useState<boolean>(false);
    const [renameOldName, setRenameOldName] = useState<string>("");
    const [removeOpen, setRemoveOpen]   = useState(false);
    const [removeName, setRemoveName]   = useState<string>("");
    const [canVote, setCanVote] = useState<boolean>(false);
    const [eligiblePolls, setEligiblePolls] = useState<Record<string, boolean>>({});

    const pollExpired = pollDeadline ? Date.now() > pollDeadline.getTime() : false;
    const selectedPollDid = selectedPollName ? aliasList[selectedPollName] ?? "" : "";

    useEffect(() => {
        if (!keymaster || !currentDID || pollList.length === 0) {
            return;
        }

        (async () => {
            const map: Record<string, boolean> = {};

            for (const name of pollList) {
                const did = aliasList[name];
                try {
                    const poll = await keymaster.getPoll(did);
                    map[name] = !!poll;
                } catch {
                    map[name] = false;
                }
            }
            setEligiblePolls(map);
        })();
    }, [pollList, aliasList, keymaster, currentDID]);

    function clearPollList() {
        setSelectedPollName("");
        setSelectedPollDesc("");
        setPollOptions([]);
        setPollResults(null);
        setPollController("");
    }

    useEffect(() => {
        clearPollList();
    }, [currentId]);

    // Persist createdPollDid across navigation
    useEffect(() => {
        if (createdPollDid) {
            sessionStorage.setItem('createdPollDid', createdPollDid);
        }
    }, [createdPollDid]);

    useEffect(() => {
        const saved = sessionStorage.getItem('createdPollDid');
        if (saved && keymaster && !createdPollDid) {
            // Verify the poll still exists before restoring
            keymaster.getPoll(saved).then((config) => {
                if (config) {
                    setCreatedPollDid(saved);
                    refreshVoters(saved);
                } else {
                    sessionStorage.removeItem('createdPollDid');
                }
            }).catch(() => {
                sessionStorage.removeItem('createdPollDid');
            });
        }
    }, [keymaster]);

    async function confirmRemovePoll() {
        if (!keymaster || !removeName) {
            return;
        }
        try {
            await keymaster.removeAlias(removeName);
            await refreshAliases();
            clearPollList();
            setSuccess(`Removed '${removeName}'`);
        } catch (err: any) {
            setError(err);
        }
        setRemoveOpen(false);
        setRemoveName("");
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

    const buildPoll = async (): Promise<PollConfig | null> => {
        if (!keymaster) {
            return null;
        }

        const template: PollConfig = await keymaster.pollTemplate();

        if (!pollName || !pollName.trim()) {
            setError("Poll name is required");
            return null;
        }
        if (pollName in aliasList) {
            setError(`Name "${pollName}" is already in use`);
            return null;
        }
        if (!description.trim()) {
            setError("Description is required");
            return null;
        }
        if (!deadline) {
            setError("Deadline is required");
            return null;
        }

        const options = optionsStr
            .split(/[,\n]/)
            .map((o) => o.trim())
            .filter((o) => o.length);

        if (options.length < 2 || options.length > 10) {
            setError("Provide between 2 and 10 options");
            return null;
        }

        return {
            ...template,
            name: pollName.trim(),
            description: description.trim(),
            options,
            deadline: new Date(deadline).toISOString(),
        } as PollConfig;
    };

    const handleCreatePoll = async () => {
        if (!keymaster) {
            return;
        }

        const poll = await buildPoll();
        if (!poll) {
            return;
        }

        try {
            const did = await keymaster.createPoll(poll, { registry });
            setCreatedPollDid(did);
            setPollNoticeSent(false);
            await keymaster.addAlias(pollName, did);
            await refreshAliases();
            setSuccess(`Poll created: ${did}`);
        } catch (error: any) {
            setError(error);
        }
    };

    const refreshVoters = async (pollDid: string) => {
        if (!keymaster) return;
        try {
            const map = await keymaster.listPollVoters(pollDid);
            setVoters(map);
        } catch {
            setVoters({});
        }
    };

    const handleAddVoter = async () => {
        if (!keymaster || !createdPollDid || !voterInput.trim()) return;
        try {
            await keymaster.addPollVoter(createdPollDid, voterInput.trim());
            setVoterInput("");
            await refreshVoters(createdPollDid);
        } catch (error: any) {
            setError(error);
        }
    };

    const handleRemoveVoter = async (did: string) => {
        if (!keymaster || !createdPollDid) return;
        try {
            await keymaster.removePollVoter(createdPollDid, did);
            await refreshVoters(createdPollDid);
        } catch (error: any) {
            setError(error);
        }
    };

    const handleSelectPoll = async (event: SelectChangeEvent) => {
        if (!keymaster) {
            return;
        }
        const name = event.target.value;
        setSelectedPollName(name);
        setSelectedPollDesc("");
        setSelectedOptionIdx(0);
        setSpoil(false);
        setHasVoted(false);
        setLastBallotDid("");
        setBallotSent(false);
        setPollController("");
        try {
            const did = aliasList[name] ?? "";
            if (did) {
                const poll = await keymaster.getPoll(did);
                setSelectedPollDesc(poll?.description ?? "");
                setPollOptions(poll?.options ?? []);
                setPollDeadline(poll?.deadline ? new Date(poll.deadline) : null);

                const didDoc = await keymaster.resolveDID(did);
                if (didDoc) {
                    setPollController(didDoc.didDocument?.controller ?? "");
                }

                const view = await keymaster.viewPoll(did);
                setCanVote(view.isEligible);
                setHasVoted(view.hasVoted);
                if (view.results) {
                    setPollResults(view.results);
                    setPollPublished(true);
                }
            }
        } catch (error: any) {
            setError(error);
            setPollOptions([]);
        }
    };

    const handleVote = async () => {
        if (!keymaster || !selectedPollDid) {
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
            if (currentDID && pollController && currentDID === pollController) {
                setBallotSent(true);
                await keymaster.updatePoll(ballotDid);
                setSuccess("Poll updated");
            } else {
                setBallotSent(false);
                setSuccess("Ballot created");
            }

        } catch (error: any) {
            setError(error);
        }
    };

    async function handleSendBallot() {
        if (!keymaster || !lastBallotDid || !selectedPollDid) {
            return;
        }
        try {
            await keymaster.sendBallot(lastBallotDid, selectedPollDid);
            setSuccess("Ballot sent");
            setBallotSent(true);
        } catch (error: any) {
            setError(error);
        }
    }

    const handleTogglePublish = async () => {
        if (!keymaster || !selectedPollDid) {
            return;
        }

        try {
            if (pollPublished) {
                await keymaster.unpublishPoll(selectedPollDid);
                setPollPublished(false);
                setPollResults(null);
                setSuccess("Poll unpublished");
            } else {
                await keymaster.publishPoll(selectedPollDid);
                const view = await keymaster.viewPoll(selectedPollDid);
                if (view.results) {
                    setPollResults(view.results);
                }
                setPollPublished(true);
                setSuccess("Poll published");
            }
        } catch (error: any) {
            setError(error);
        }
    };

    const handleViewPoll = async () => {
        if (!keymaster || !selectedPollDid) {
            return;
        }
        try {
            const view = await keymaster.viewPoll(selectedPollDid);
            if (view.results) {
                setPollResults(view.results);
                setResultsOpen(true);
            }
        } catch (error: any) {
            setError(error);
        }
    };

    async function handleSendPoll() {
        if (!keymaster || !createdPollDid) {
            return;
        }

        try {
            const membersMap = await keymaster.listPollVoters(createdPollDid);
            const members = Object.keys(membersMap);
            if (members.length === 0) {
                setError("No poll voters found");
                return;
            }
            const validUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
            const message: NoticeMessage = { to: members, dids: [createdPollDid] };
            const noticeDid = await keymaster.createNotice(message, {
                registry: "hyperswarm",
                validUntil,
            });

            if (noticeDid) {
                setSuccess("Poll notice sent");
                setPollNoticeSent(true);
                sessionStorage.removeItem('createdPollDid');
            } else {
                setError("Failed to send poll");
            }
        } catch (error: any) {
            setError(error);
        }
    }

    const openRenameModal = () => {
        setRenameOldName(selectedPollName);
        setRenameOpen(true);
    };

    const handleRenameSubmit = async (newName: string) => {
        setRenameOpen(false);
        if (!newName || newName === selectedPollName || !keymaster) {
            return;
        }

        try {
            await keymaster.addAlias(newName, selectedPollDid);
            await keymaster.removeAlias(selectedPollName);
            await refreshAliases();
            setSelectedPollName(newName);
            setRenameOldName("");
            setSuccess("Poll renamed");
        } catch (err: any) {
            setError(err);
        }
    }


    return (
        <Box>
            <WarningModal
                title="Remove Poll"
                warningText={`Are you sure you want to remove '${removeName}'?`}
                isOpen={removeOpen}
                onClose={() => setRemoveOpen(false)}
                onSubmit={confirmRemovePoll}
            />

            {pollResults && (
                <PollResultsModal
                    open={resultsOpen}
                    onClose={() => setResultsOpen(false)}
                    results={pollResults}
                />
            )}

            <TextInputModal
                isOpen={renameOpen}
                title="Rename Poll"
                description={`Rename '${renameOldName}' to:`}
                label="New Name"
                confirmText="Rename"
                defaultValue={renameOldName}
                onSubmit={handleRenameSubmit}
                onClose={() => setRenameOpen(false)}
            />

            <Box
                sx={{
                    position: "sticky",
                    top: 0,
                    zIndex: (t) => t.zIndex.appBar,
                    bgcolor: "background.paper",
                    mb: 1
                }}
            >
                <Tabs
                    value={activeTab}
                    onChange={(_, v) => setActiveTab(v)}
                    indicatorColor="primary"
                    textColor="primary"
                >
                    <Tab value="create" label="Create" icon={<AddCircleOutline />} />
                    <Tab value="view" label="View / Vote" icon={<BarChart />} />
                </Tabs>
            </Box>

            {activeTab === "create" && (
                <Box sx={{ width: isTabletUp ? '70%' : '100%' }}>
                    <TextField
                        fullWidth
                        label="Poll Name"
                        value={pollName}
                        onChange={(e) => setPollName(e.target.value)}
                        sx={{ mb: 2 }}
                        slotProps={{
                            htmlInput: {
                                maxLength: 32,
                            },
                        }}
                    />

                    <TextField
                        fullWidth
                        label="Description"
                        multiline
                        rows={3}
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        sx={{ mb: 2 }}
                        slotProps={{
                            htmlInput: {
                                maxLength: 200,
                            },
                        }}
                    />

                    <TextField
                        fullWidth
                        label="Options (comma‑separated)"
                        value={optionsStr}
                        onChange={(e) => setOptionsStr(e.target.value)}
                        sx={{ mb: 2 }}
                        helperText="Between 2 and 10 options"
                    />

                    <TextField
                        fullWidth
                        type="datetime-local"
                        label="Deadline"
                        slotProps={{ inputLabel: { shrink: true } }}
                        value={deadline}
                        onChange={(e) => setDeadline(e.target.value)}
                        sx={{ mb: 2 }}
                    />

                    <Box className="flex-box" sx={{ mb: 2 }}>
                        <FormControl fullWidth>
                            <Select
                                value={registry}
                                onChange={(e) => setRegistry(e.target.value)}
                                sx={{
                                    borderTopRightRadius: 0,
                                    borderBottomRightRadius: 0,
                                }}
                            >
                                {registries.map((r) => (
                                    <MenuItem key={r} value={r}>
                                        {r}
                                    </MenuItem>
                                ))}
                            </Select>
                        </FormControl>

                        <Button
                            variant="contained"
                            onClick={handleCreatePoll}
                            sx={{
                                borderTopLeftRadius: 0,
                                borderBottomLeftRadius: 0,
                            }}
                            size="large"
                            fullWidth
                            disabled={!pollName || !description || !optionsStr || !deadline}
                        >
                            Create
                        </Button>
                    </Box>

                    {createdPollDid && (
                        <Box sx={{ mb: 2 }}>
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
                                            slotProps={{
                                                htmlInput: {
                                                    ...params.inputProps,
                                                    maxLength: 80,
                                                },
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
                                                <Close fontSize="small" />
                                            </IconButton>
                                        </Box>
                                    ))}
                                </Box>
                            )}
                        </Box>
                    )}

                    <Box display="flex" flexDirection="row" sx={{ mb: 2, gap: 1, width: "100%" }}>
                        <Button
                            variant="contained"
                            color="secondary"
                            size="large"
                            onClick={handleSendPoll}
                            fullWidth
                            disabled={!createdPollDid || pollNoticeSent}
                        >
                            Send
                        </Button>

                        <Button
                            variant="outlined"
                            size="large"
                            onClick={resetForm}
                            fullWidth
                        >
                            Clear
                        </Button>
                    </Box>

                    {createdPollDid &&
                        <DisplayDID did={createdPollDid} />
                    }
                </Box>
            )}

            {activeTab === "view" && (
                <Box sx={{ width: isTabletUp ? '70%' : '100%' }}>
                    {pollList.length > 0 ? (
                        <Box>
                            <Box className="flex-box" sx={{ display: "flex", alignItems: "center", width: "100%", flexWrap: "nowrap" }}>
                                <FormControl sx={{ flex: 1, minWidth: 0 }}>
                                    <Select
                                        value={selectedPollName}
                                        onChange={handleSelectPoll}
                                        displayEmpty
                                        size="small"
                                    >
                                        <MenuItem value="" disabled>
                                            Select poll
                                        </MenuItem>
                                        {pollList.map((name: string) => (
                                            <MenuItem key={name} value={name}>
                                                {eligiblePolls[name] ? (
                                                    <HowToVote fontSize="small" sx={{ mr: 1 }} />
                                                ) : (
                                                    <Block fontSize="small" sx={{ mr: 1 }} />
                                                )}
                                                {name}
                                            </MenuItem>
                                        ))}
                                    </Select>
                                </FormControl>

                                <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexShrink: 0, whiteSpace: "nowrap" }}>
                                    <Tooltip title="Rename Poll">
                                        <span>
                                            <IconButton
                                                size="small"
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
                                                disabled={!selectedPollName}
                                                onClick={() => {
                                                    setRemoveName(selectedPollName);
                                                    setRemoveOpen(true);
                                                }}
                                            >
                                                <Delete fontSize="small" />
                                            </IconButton>
                                        </span>
                                    </Tooltip>

                                    <CopyResolveDID did={selectedPollDid} />
                                </Box>
                            </Box>

                            <Box className="flex-box" sx={{ mt: 1 }}>
                                {currentDID && pollController && currentDID === pollController && (
                                    <Box>
                                        {pollExpired && (
                                            <Button
                                                variant="outlined"
                                                size="large"
                                                onClick={handleTogglePublish}
                                            >
                                                {pollPublished ? "Unpublish" : "Publish"}
                                            </Button>
                                        )}

                                        <Button
                                            variant="outlined"
                                            size="large"
                                            sx={{ ml: 1 }}
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
                                    <Typography variant="h6" sx={{ mt: 2 }}>
                                        Description
                                    </Typography>
                                    <Typography variant="body1" sx={{ mt: 2 }}>
                                        {selectedPollDesc}
                                    </Typography>

                                    {!pollExpired ? (
                                        <Box mt={2}>
                                            {!hasVoted ? (
                                                <Typography variant="h6">Cast your vote</Typography>
                                            ) : (
                                                <Typography variant="h6">Update your vote</Typography>
                                            )}

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
                                                    value={selectedOptionIdx}
                                                    onChange={(_, val) => setSelectedOptionIdx(Number(val))}
                                                >
                                                    {pollOptions.map((opt, idx) => (
                                                        <FormControlLabel
                                                            key={idx}
                                                            value={idx}
                                                            control={<Radio />}
                                                            label={opt}
                                                        />
                                                    ))}
                                                </RadioGroup>
                                            )}

                                            {canVote &&
                                                <Box>
                                                    <FormControlLabel
                                                        control={<Checkbox checked={spoil} onChange={(_, v) => setSpoil(v)} />}
                                                        label="Spoil ballot"
                                                    />

                                                    <Button
                                                        variant="contained"
                                                        sx={{ height: 56 }}
                                                        onClick={handleVote}
                                                    >
                                                        Vote
                                                    </Button>

                                                    {currentDID !== pollController && (
                                                        <Button
                                                            variant="contained"
                                                            color="secondary"
                                                            sx={{ height: 56, ml: 1 }}
                                                            disabled={!lastBallotDid || ballotSent}
                                                            onClick={handleSendBallot}
                                                        >
                                                            Send Ballot
                                                        </Button>
                                                    )}

                                                    {lastBallotDid && (
                                                        <Box sx={{ mt: 1 }}>
                                                            <DisplayDID did={lastBallotDid} />
                                                        </Box>
                                                    )}
                                                </Box>
                                            }
                                        </Box>
                                    ) : (
                                        <Box mt={2}>
                                            <Typography variant="h6" sx={{ mt: 1, mb: 1 }}>
                                                Poll complete
                                            </Typography>
                                            {pollPublished ? (
                                                <Button
                                                    variant="outlined"
                                                    onClick={() => setResultsOpen(true)}
                                                    sx={{
                                                        height: 56
                                                    }}
                                                >
                                                    View Results
                                                </Button>
                                            ) : (
                                                <Typography variant="body1">
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
    );
};

export default PollsTab;
