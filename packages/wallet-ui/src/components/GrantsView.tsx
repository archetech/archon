import { useCallback, useEffect, useRef, useState } from "react";
import {
    Alert,
    Box,
    Button,
    Checkbox,
    Chip,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogContentText,
    DialogTitle,
    FormControlLabel,
    MenuItem,
    Paper,
    TextField,
    Typography,
} from "@mui/material";
import { VerifiedUser } from "@mui/icons-material";
import type { KeymasterInterface } from "@didcid/clients/keymaster-types";
import { PERMITTED_REGISTRIES, decodeGrantLink, positionOn, validateGrant } from "@didcid/memeplex";
import PageHeader from "./layout/PageHeader";
import EmptyState from "./layout/EmptyState";

// Memeplex grants: the assets by which an identity lets a client publish in its
// name. docs/plans/memeplex-reference-1436.md, "Grant request flow" and "Wallet".

export type GrantsKeymaster = Pick<KeymasterInterface,
    "createAsset" | "listAssets" | "listRevocations" | "resolveDID" | "mergeData"
> & {
    revokeDID(id: string): Promise<boolean>;
};

type Props = {
    keymaster: GrantsKeymaster;
    // The identity whose grants are shown. Hosts key this component by it, and
    // every call names it, so a call under way when the identity changes still
    // acts for the identity it was started for.
    identity: string;
    // What this identity's revocations are shown from while the wallet is open.
    // Hosts pass the identity's DID, which a rename does not change.
    sessionKey?: string;
    // The registries this node can create on.
    registries: string[];
    notify: {
        error: (error: unknown) => void;
        success: (message: string) => void;
    };
    // How often, in milliseconds, the grants and revocations shown are read from
    // the node.
    pollMs?: number;
};

export const CORE_ACTIONS = ["memeplex:post", "memeplex:reply", "memeplex:rate", "memeplex:tag"];

const ACTION_NAMES: Record<string, string> = {
    "memeplex:post": "Post",
    "memeplex:reply": "Reply",
    "memeplex:rate": "Rate",
    "memeplex:tag": "Tag",
};

type GrantData = {
    v: 1;
    client: string;
    actions?: string[];
    nonce?: string;
    expiresAt?: string;
    [other: string]: unknown;
};

type HeldGrant = {
    did: string;
    // The grant as its latest version states it.
    grant: GrantData;
    registry: string;
    // Whether that version is anchored on the grant's registry. One that is not
    // has no effect yet.
    anchored: boolean;
    // Whether that version is the grant's creation.
    created: boolean;
};

// A revocation, from the wallet's side: `requested` once the user has asked,
// `submitted` once a node has accepted the signed deletion, `effective` once
// that deletion is anchored. A client can publish until it is effective.
//
// `displaced` is a revocation a node accepted and that then lost its place to
// another change to the grant, made elsewhere: the grant is live.
export type RevocationState = "requested" | "submitted" | "effective" | "displaced";

// `uncertain` marks a revocation the node was never seen to accept.
type Revocation = { grant: HeldGrant; state: RevocationState; uncertain?: boolean };

// The revocations shown while the wallet is open, by identity: those made in
// this session, from the moment the user asks, and those Keymaster reports as
// accepted and awaiting anchoring, which it keeps in the wallet.
const sessionRevocations = new Map<string, Revocation[]>();

const tracked = (key: string): Revocation[] => sessionRevocations.get(key) ?? [];

// Written here first and shown from here, so that a revocation started in a view
// the user has since left is where the next view finds it.
function track(key: string, did: string, change: (revocation?: Revocation) => Revocation | undefined): void {
    const others = tracked(key).filter(revocation => revocation.grant.did !== did);
    const next = change(tracked(key).find(revocation => revocation.grant.did === did));

    sessionRevocations.set(key, next ? [...others, next] : others);
}

// `expiresAt` is the instant the editor was opened with, kept so that an expiry
// the user leaves alone is written back exactly.
type Scope = { actions: string[]; chosen: string[]; expiry: string; expiresAt?: string };

function actionName(action: string): string {
    return ACTION_NAMES[action] ?? action;
}

// A datetime-local value for an instant, and back.
function toLocalInput(instant?: string): string {
    if (!instant) {
        return "";
    }
    const date = new Date(instant);
    if (Number.isNaN(date.getTime())) {
        return "";
    }
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
}

function fromLocalInput(value: string): string | undefined {
    if (!value) {
        return undefined;
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

// What a scope editor starts from: the actions on offer, all chosen.
function scopeOf(actions: string[] | undefined, expiresAt: string | undefined, offered = actions): Scope {
    const all = offered ?? CORE_ACTIONS;
    return { actions: all, chosen: actions ?? all, expiry: toLocalInput(expiresAt), expiresAt };
}

function expiryOf(scope: Scope): string | undefined {
    return scope.expiry === toLocalInput(scope.expiresAt) ? scope.expiresAt : fromLocalInput(scope.expiry);
}

type Resolved = Awaited<ReturnType<GrantsKeymaster["resolveDID"]>>;

// Whether a resolved version is anchored on a registry: confirmation alone is
// not that, since a creation is confirmed from the start.
function isAnchored(doc: Resolved, registry: string): boolean {
    return positionOn(doc as Parameters<typeof positionOn>[0], registry) !== undefined;
}

// The `actions` a scope stands for: none when it is every core kind, which a
// grant states by leaving `actions` out.
function actionsOf(scope: Scope): string[] | undefined {
    const everyCore = scope.chosen.length === CORE_ACTIONS.length
        && CORE_ACTIONS.every(action => scope.chosen.includes(action));
    return everyCore ? undefined : scope.actions.filter(action => scope.chosen.includes(action));
}

function ScopeEditor({ scope, onChange, disabled }: { scope: Scope; onChange: (scope: Scope) => void; disabled?: boolean }) {
    return (
        <Box>
            <Box sx={{ display: "flex", flexWrap: "wrap", columnGap: 1 }}>
                {scope.actions.map(action => (
                    <FormControlLabel
                        key={action}
                        label={<Typography variant="body2" sx={{ wordBreak: "break-all" }}>{actionName(action)}</Typography>}
                        control={
                            <Checkbox
                                size="small"
                                disabled={disabled}
                                checked={scope.chosen.includes(action)}
                                onChange={event => onChange({
                                    ...scope,
                                    chosen: event.target.checked
                                        ? [...scope.chosen, action]
                                        : scope.chosen.filter(chosen => chosen !== action),
                                })}
                            />
                        }
                    />
                ))}
            </Box>
            <TextField
                label="Expires"
                type="datetime-local"
                size="small"
                margin="dense"
                disabled={disabled}
                value={scope.expiry}
                onChange={event => onChange({ ...scope, expiry: event.target.value })}
                helperText="Leave empty for a grant that lasts until it is revoked."
                slotProps={{ inputLabel: { shrink: true } }}
            />
        </Box>
    );
}

function describeScope(grant: GrantData): string {
    return grant.actions ? grant.actions.map(actionName).join(", ") : "All core kinds";
}

function isExpired(grant: GrantData): boolean {
    return grant.expiresAt !== undefined && new Date(grant.expiresAt).getTime() <= Date.now();
}

const LINK_ERRORS: Record<string, string> = {
    "not-a-grant-link": "This is not a grant link. A grant link begins with archon://grant?request=",
    "too-long": "This grant link is longer than a wallet accepts.",
    "undecodable": "This grant link's request cannot be read.",
    "invalid-request": "This grant link does not carry a valid grant request.",
};

const REVOCATION_TEXT: Record<RevocationState, string> = {
    requested: "Revocation requested",
    submitted: "Revocation submitted",
    effective: "Revoked",
    displaced: "Revocation did not take effect",
};

export default function GrantsView({ keymaster, identity, sessionKey = identity, registries, notify: hostNotify, pollMs = 30000 }: Props) {
    const notifyRef = useRef(hostNotify);
    notifyRef.current = hostNotify;

    const [grants, setGrants] = useState<HeldGrant[] | null>(null);
    const [revocations, setRevocations] = useState<Revocation[]>(() => tracked(sessionKey));
    const [unresolved, setUnresolved] = useState(0);
    const [unlisted, setUnlisted] = useState(false);
    const reads = useRef(0);
    const [link, setLink] = useState("");
    const [request, setRequest] = useState<Record<string, any> | null>(null);
    const [linkError, setLinkError] = useState("");
    const [scope, setScope] = useState<Scope>(scopeOf(undefined, undefined));
    const [registry, setRegistry] = useState("");
    const [busy, setBusy] = useState(false);
    const [editing, setEditing] = useState<{ grant: HeldGrant; scope: Scope } | null>(null);
    const [revoking, setRevoking] = useState<HeldGrant | null>(null);

    const permitted = PERMITTED_REGISTRIES.filter(name => registries.includes(name));

    const showRevocations = useCallback(() => setRevocations(tracked(sessionKey)), [sessionKey]);

    const load = useCallback(async () => {
        const read = reads.current += 1;
        const held: HeldGrant[] = [];
        const owned = await keymaster.listAssets(identity);
        let failed = 0;

        for (let start = 0; start < owned.length; start += 8) {
            const docs = await Promise.all(owned.slice(start, start + 8).map(async did => {
                try {
                    return { did, doc: await keymaster.resolveDID(did) };
                }
                catch {
                    return null;
                }
            }));

            for (const found of docs) {
                if (!found) {
                    failed += 1;
                    continue;
                }

                const data = found.doc.didDocumentData as { memeplexGrant?: unknown } | undefined;

                if (found.doc.didDocumentMetadata?.deactivated || validateGrant(data?.memeplexGrant) !== "valid") {
                    continue;
                }

                const registry = found.doc.didDocumentRegistration?.registry ?? "";

                held.push({
                    did: found.did,
                    grant: data!.memeplexGrant as GrantData,
                    registry,
                    anchored: isAnchored(found.doc, registry),
                    created: Number(found.doc.didDocumentMetadata?.versionSequence ?? 1) <= 1,
                });
            }
        }

        // A later read has started: its answer is the one to show.
        if (read !== reads.current) {
            return;
        }

        // A grant being revoked is shown as a revocation, not as a card.
        const revoking = new Set(tracked(sessionKey).map(revocation => revocation.grant.did));

        setUnresolved(failed);
        setUnlisted(false);
        setGrants(held.filter(grant => !revoking.has(grant.did)));
    }, [keymaster, identity, sessionKey]);

    // Revocations Keymaster holds for the identity that this session has no
    // record of, such as one made before the wallet was last closed. Only those
    // of grants are shown: the grant is read from the version the deletion
    // followed, since a deleted asset has no data.
    const readHeld = useCallback(async () => {
        let reported: Awaited<ReturnType<GrantsKeymaster["listRevocations"]>>;

        try {
            reported = await keymaster.listRevocations(identity);
        }
        catch {
            return;
        }

        for (const { did, status } of reported) {
            if (status === "unresolved" || tracked(sessionKey).some(revocation => revocation.grant.did === did)) {
                continue;
            }
            try {
                const current = await keymaster.resolveDID(did);
                const sequence = Number(current.didDocumentMetadata?.versionSequence);

                if (status === "pending" && (!Number.isInteger(sequence) || sequence < 2)) {
                    continue;
                }

                const before = status === "displaced"
                    ? current
                    : await keymaster.resolveDID(did, { versionSequence: sequence - 1 });
                const data = before.didDocumentData as { memeplexGrant?: unknown } | undefined;

                if (validateGrant(data?.memeplexGrant) !== "valid") {
                    continue;
                }

                const registry = before.didDocumentRegistration?.registry ?? "";
                const grant: HeldGrant = {
                    did,
                    grant: data!.memeplexGrant as GrantData,
                    registry,
                    anchored: isAnchored(before, registry),
                    created: Number(before.didDocumentMetadata?.versionSequence ?? 1) <= 1,
                };

                track(sessionKey, did, revocation => revocation
                    ?? { grant, state: status === "displaced" ? "displaced" : "submitted" });
            }
            catch {
                // Read again at the next refresh, while Keymaster reports it.
            }
        }
    }, [keymaster, identity, sessionKey]);

    // Whether each revocation the node has accepted is anchored. An anchor can be
    // withdrawn by a reorganization, so one seen as effective is read as well.
    const readRevocations = useCallback(async () => {
        for (const { grant: held, state: shown } of tracked(sessionKey)) {
            if (shown === "requested") {
                continue;
            }
            try {
                const doc = await keymaster.resolveDID(held.did);
                const deleted = doc.didDocumentMetadata?.deactivated === true;
                const effective = deleted && isAnchored(doc, held.registry);

                // A live grant after a revocation the node was not seen to
                // accept was not revoked: Keymaster still lists it, and it goes
                // back among the cards. After one the node accepted, it is live
                // because another change took the deletion's place.
                track(sessionKey, held.did, revocation => {
                    if (!revocation || revocation.state === "requested") {
                        return revocation;
                    }
                    if (deleted) {
                        return { grant: revocation.grant, state: effective ? "effective" : "submitted" };
                    }
                    return revocation.uncertain ? undefined : { ...revocation, state: "displaced" };
                });
            }
            catch {
                // Left as it is shown until the node answers.
            }
        }

        showRevocations();
    }, [keymaster, sessionKey, showRevocations]);

    const refresh = useCallback(async (report: boolean) => {
        // Revocations first, so that the grants read after them include one
        // whose revocation the node turned out not to have accepted.
        await readHeld();
        await readRevocations();
        try {
            await load();
        }
        catch (error) {
            setUnlisted(true);
            setGrants(current => current ?? []);
            if (report) {
                notifyRef.current.error(error);
            }
        }
    }, [load, readHeld, readRevocations]);

    // Each read is started an interval after the one before it finished, so a
    // read slower than the interval is not overtaken by the next.
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let stopped = false;

        const read = async (report: boolean) => {
            await refresh(report);
            if (!stopped) {
                timer = setTimeout(() => read(false), pollMs);
            }
        };

        read(true);

        return () => {
            stopped = true;
            clearTimeout(timer);
        };
    }, [refresh, pollMs]);

    function readLink() {
        const decoded = decodeGrantLink(link.trim());

        if ("error" in decoded) {
            setRequest(null);
            setLinkError(LINK_ERRORS[decoded.error]);
            return;
        }

        setLinkError("");
        setRequest(decoded.request);
        setScope(scopeOf(decoded.request.actions, decoded.request.expiresAt));
        setRegistry(current => current || permitted[0] || "");
    }

    function discard() {
        setRequest(null);
        setLink("");
        setLinkError("");
    }

    async function create() {
        if (!request) {
            return;
        }

        const actions = actionsOf(scope);
        const expiresAt = expiryOf(scope);
        const memeplexGrant: GrantData = {
            v: 1,
            client: request.client,
            ...(actions ? { actions } : {}),
            nonce: request.nonce,
            ...(expiresAt ? { expiresAt } : {}),
        };

        setBusy(true);
        try {
            // Keymaster creates a local identity's assets on `local` whatever
            // registry is asked for, and a grant there, like a grant to oneself,
            // is void.
            const grantor = await keymaster.resolveDID(identity, { confirm: true });

            if (grantor.didDocumentRegistration?.registry === "local") {
                throw new Error("A local identity cannot make a grant: its assets cannot be created on a chain registry");
            }
            if (grantor.didDocument?.id === request.client) {
                throw new Error("This request names this identity as the client. An identity cannot grant itself.");
            }

            await keymaster.createAsset({ memeplexGrant }, { registry, controller: identity });
            discard();
            notifyRef.current.success("Grant created");
            await load();
        }
        catch (error) {
            notifyRef.current.error(error);
        }
        finally {
            setBusy(false);
        }
    }

    async function saveScope() {
        if (!editing) {
            return;
        }

        const { grant: held, scope: edited } = editing;
        const actions = actionsOf(edited);
        const expiresAt = expiryOf(edited);
        // Everything else the grant holds is kept: a change to anything but
        // `actions` and `expiresAt` would end the grant.
        const memeplexGrant: GrantData = { ...held.grant };

        delete memeplexGrant.actions;
        delete memeplexGrant.expiresAt;

        if (actions) {
            memeplexGrant.actions = actions;
        }
        if (expiresAt) {
            memeplexGrant.expiresAt = expiresAt;
        }

        setBusy(true);
        try {
            // The change is to the grant as the user saw it. If the grant has
            // changed since, saving would put back what that change took away.
            const latest = (await keymaster.resolveDID(held.did)).didDocumentData as { memeplexGrant?: unknown } | undefined;

            if (JSON.stringify(latest?.memeplexGrant) !== JSON.stringify(held.grant)) {
                setEditing(null);
                await load();
                throw new Error("This grant has changed since it was shown. Review it and make the change again.");
            }

            if (!await keymaster.mergeData(held.did, { memeplexGrant })) {
                throw new Error("The node did not accept the change");
            }
            setEditing(null);
            notifyRef.current.success("Grant changed");
            await load();
        }
        catch (error) {
            notifyRef.current.error(error);
        }
        finally {
            setBusy(false);
        }
    }

    async function revoke(held: HeldGrant) {
        const mark = (state?: RevocationState, uncertain = false) => {
            track(sessionKey, held.did, () => state && { grant: held, state, ...(uncertain ? { uncertain } : {}) });
            showRevocations();
        };

        setRevoking(null);
        mark("requested");
        setGrants(current => current?.filter(grant => grant.did !== held.did) ?? current);

        let accepted: boolean;
        let failed = false;
        let uncertain = false;

        try {
            accepted = await keymaster.revokeDID(held.did);
        }
        catch (error) {
            failed = true;
            notifyRef.current.error(error);
            // A failure does not say the node refused: it may have accepted
            // the deletion before the failure. What the node resolves says.
            try {
                accepted = (await keymaster.resolveDID(held.did)).didDocumentMetadata?.deactivated === true;
            }
            catch {
                accepted = true;
                uncertain = true;
            }
        }

        if (accepted) {
            mark("submitted", uncertain);
            return;
        }

        mark(undefined);
        if (!failed) {
            notifyRef.current.error(new Error("The node did not accept the revocation"));
        }
        await load().catch(() => undefined);
    }

    const scopeEmpty = (edited: Scope) => edited.chosen.length === 0;

    return (
        <Box>
            <PageHeader
                title="Grants"
                description="Clients you have allowed to publish in this identity's name."
            />

            <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
                <Typography variant="h6" component="h2" sx={{ mb: 1 }}>Grant a client</Typography>

                {permitted.length === 0 && (
                    <Alert severity="warning" sx={{ mb: 2 }}>
                        This node supports none of the registries a grant may be created on
                        ({PERMITTED_REGISTRIES.join(", ")}).
                    </Alert>
                )}

                {!request && (
                    <Box sx={{ display: "flex", gap: 1, alignItems: "flex-start", flexWrap: "wrap" }}>
                        <TextField
                            label="Grant link"
                            size="small"
                            value={link}
                            onChange={event => setLink(event.target.value)}
                            error={linkError !== ""}
                            helperText={linkError || "Paste the link the client shows."}
                            sx={{ flex: 1, minWidth: 240 }}
                        />
                        <Button variant="contained" onClick={readLink} disabled={!link.trim()}>
                            Review
                        </Button>
                    </Box>
                )}

                {request && (
                    <Box>
                        <Typography variant="body2" color="text.secondary">Client</Typography>
                        <Typography variant="body2" sx={{ fontFamily: "monospace", wordBreak: "break-all", mb: 1 }}>
                            {request.client}
                        </Typography>
                        <Typography variant="body2" color="text.secondary">It calls itself</Typography>
                        <Typography variant="body1" sx={{ mb: 1 }}>{request.name}</Typography>
                        <Alert severity="info" sx={{ mb: 2 }}>
                            The name is the client's own claim. The grant is to the client DID above.
                        </Alert>

                        <Typography variant="body2" color="text.secondary">
                            {request.actions ? "It asks to" : "It asks for every core kind"}
                        </Typography>
                        <ScopeEditor scope={scope} onChange={setScope} disabled={busy} />

                        <TextField
                            select
                            label="Registry"
                            size="small"
                            margin="dense"
                            value={registry}
                            disabled={busy}
                            onChange={event => setRegistry(event.target.value)}
                            sx={{ minWidth: 200, display: "block" }}
                        >
                            {permitted.map(name => <MenuItem key={name} value={name}>{name}</MenuItem>)}
                        </TextField>

                        <Box sx={{ display: "flex", gap: 1, mt: 2 }}>
                            <Button
                                variant="contained"
                                onClick={create}
                                disabled={busy || !registry || scopeEmpty(scope)}
                            >
                                Create Grant
                            </Button>
                            <Button onClick={discard} disabled={busy}>Cancel</Button>
                        </Box>
                    </Box>
                )}
            </Paper>

            {revocations.map(({ grant: held, state }) => (
                <Alert
                    key={held.did}
                    severity={state === "effective" ? "success" : state === "displaced" ? "error" : "warning"}
                    sx={{ mb: 1 }}
                    action={state === "displaced"
                        ? <Button color="inherit" size="small" onClick={() => revoke(held)}>Revoke Again</Button>
                        : undefined}
                    onClose={state === "effective"
                        ? () => { track(sessionKey, held.did, () => undefined); showRevocations(); }
                        : undefined}
                >
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>{REVOCATION_TEXT[state]}</Typography>
                    <Typography variant="body2" sx={{ fontFamily: "monospace", wordBreak: "break-all" }}>
                        {held.grant.client}
                    </Typography>
                    {state === "displaced" && (
                        <Typography variant="body2">
                            Another change to this grant took the revocation's place. The client can still publish.
                        </Typography>
                    )}
                    {(state === "requested" || state === "submitted") && (
                        <Typography variant="body2">
                            The client can still publish until the revocation is anchored on {held.registry}.
                        </Typography>
                    )}
                </Alert>
            ))}

            {unresolved > 0 && (
                <Alert
                    severity="warning"
                    sx={{ mb: 1 }}
                    action={<Button color="inherit" size="small" onClick={() => refresh(true)}>Retry</Button>}
                >
                    {unresolved === 1 ? "One asset" : `${unresolved} assets`} of this identity could not be read,
                    so this list may be missing grants.
                </Alert>
            )}

            {unlisted && (
                <Alert
                    severity="warning"
                    sx={{ mb: 1 }}
                    action={<Button color="inherit" size="small" onClick={() => refresh(true)}>Retry</Button>}
                >
                    This identity's grants could not be read, so what is shown may be out of date or incomplete.
                </Alert>
            )}

            {grants === null && <CircularProgress size={24} aria-label="Loading grants" />}

            {grants !== null && grants.length === 0 && unresolved === 0 && !unlisted && (
                <EmptyState
                    icon={<VerifiedUser />}
                    title="No grants"
                    description="This identity has not allowed any client to publish for it."
                />
            )}

            {grants?.map(held => (
                <Paper key={held.did} variant="outlined" sx={{ p: 2, mb: 1 }} data-testid="grant">
                    <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", alignItems: "center", mb: 1 }}>
                        <Chip size="small" label={held.registry} />
                        {!held.anchored
                            ? <Chip size="small" color="warning" label={held.created ? "Awaiting anchoring" : "Change awaiting anchoring"} />
                            : isExpired(held.grant)
                                ? <Chip size="small" color="default" label="Expired" />
                                : <Chip size="small" color="success" label="Active" />}
                    </Box>
                    {!held.anchored && (
                        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                            {held.created
                                ? `The client cannot publish until this grant is anchored on ${held.registry}.`
                                : `What is shown takes effect once it is anchored on ${held.registry}. Until then the grant is as it was.`}
                        </Typography>
                    )}
                    <Typography variant="body2" color="text.secondary">Client</Typography>
                    <Typography variant="body2" sx={{ fontFamily: "monospace", wordBreak: "break-all", mb: 1 }}>
                        {held.grant.client}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">May</Typography>
                    <Typography variant="body2" sx={{ wordBreak: "break-all", mb: 1 }}>{describeScope(held.grant)}</Typography>
                    <Typography variant="body2" color="text.secondary">Expires</Typography>
                    <Typography variant="body2" sx={{ mb: 1 }}>
                        {held.grant.expiresAt ? new Date(held.grant.expiresAt).toLocaleString() : "Never"}
                    </Typography>
                    <Box sx={{ display: "flex", gap: 1 }}>
                        <Button
                            size="small"
                            onClick={() => setEditing({
                                grant: held,
                                scope: scopeOf(
                                    held.grant.actions,
                                    held.grant.expiresAt,
                                    [...CORE_ACTIONS, ...(held.grant.actions ?? []).filter(action => !CORE_ACTIONS.includes(action))],
                                ),
                            })}
                        >
                            Change
                        </Button>
                        <Button size="small" color="error" onClick={() => setRevoking(held)}>Revoke</Button>
                    </Box>
                </Paper>
            ))}

            <Dialog open={editing !== null} onClose={() => !busy && setEditing(null)}>
                <DialogTitle>Change grant</DialogTitle>
                <DialogContent>
                    <DialogContentText sx={{ mb: 1 }}>
                        A change takes effect once it is anchored on {editing?.grant.registry}.
                    </DialogContentText>
                    {editing && (
                        <ScopeEditor
                            scope={editing.scope}
                            disabled={busy}
                            onChange={edited => setEditing({ grant: editing.grant, scope: edited })}
                        />
                    )}
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setEditing(null)} disabled={busy}>Cancel</Button>
                    <Button
                        variant="contained"
                        onClick={saveScope}
                        disabled={busy || !editing || scopeEmpty(editing.scope)}
                    >
                        Save
                    </Button>
                </DialogActions>
            </Dialog>

            <Dialog open={revoking !== null} onClose={() => setRevoking(null)}>
                <DialogTitle>Revoke grant?</DialogTitle>
                <DialogContent>
                    <DialogContentText>
                        The client will no longer be able to publish for this identity once the
                        revocation is anchored on {revoking?.registry}. What it has published stays
                        attributed. A revocation cannot be undone.
                    </DialogContentText>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setRevoking(null)}>Cancel</Button>
                    <Button variant="contained" color="error" onClick={() => revoking && revoke(revoking)}>Revoke</Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}
