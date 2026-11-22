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
import { anchoredOn, grantIn, grantMember, grantRequestId, grantRequestOf } from "@didcid/keymaster/grant";
import type { GrantRequestRefusal } from "@didcid/keymaster/grant";
import PageHeader from "./layout/PageHeader";
import EmptyState from "./layout/EmptyState";

// Grants: the assets by which an identity lets a client of an app act in its
// name. A grant is any app's: the wallet shows what a request asks for and
// makes, changes and revokes the grant, and what the grant's actions mean is
// the app's to say. packages/keymaster/README.md, "Grants".

export type GrantsKeymaster = Pick<KeymasterInterface,
    "createAsset" | "listAssets" | "listRevocations" | "resolveDID" | "updateGrant"
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

type GrantData = {
    v?: number;
    client: string;
    request?: string;
    actions?: string[];
    expiresAt?: string;
    [other: string]: unknown;
};

type HeldGrant = {
    did: string;
    // The app the grant is for, and the member of the asset's data that holds it.
    app: string;
    member: string;
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
// that deletion is anchored. A client can act under the grant until it is
// effective.
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
//
// `actions` are those on offer, which are the ones the request or the grant
// lists: the wallet knows no app's actions, so it can leave one out and cannot
// add one. With none listed there is nothing to choose among.
type Scope = { actions: string[]; chosen: string[]; expiry: string; expiresAt?: string };

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

// What a scope editor starts from: the actions listed, all chosen.
function scopeOf(actions: string[] | undefined, expiresAt: string | undefined): Scope {
    const listed = actions ?? [];
    return { actions: listed, chosen: listed, expiry: toLocalInput(expiresAt), expiresAt };
}

function expiryOf(scope: Scope): string | undefined {
    return scope.expiry === toLocalInput(scope.expiresAt) ? scope.expiresAt : fromLocalInput(scope.expiry);
}

type Resolved = Awaited<ReturnType<GrantsKeymaster["resolveDID"]>>;

// The registries that are no chain. What is made on one is never anchored, and
// has nothing to wait for.
const NO_CHAIN = ["local", "hyperswarm", "pin"];

const hasChain = (registry: string) => !NO_CHAIN.includes(registry);

// Whether a resolved version has the standing its registry gives: anchored, on
// a chain, and accepted by the node, which resolving it shows, on a registry
// that is none.
function isAnchored(doc: Resolved, registry: string): boolean {
    return !hasChain(registry) || anchoredOn(doc as Parameters<typeof anchoredOn>[0], registry);
}

// Whether a grant's actions are ones this view can show and change: a list of
// names, or none. Keymaster takes an asset as a grant on its client alone, so
// the rest of what a grant holds may be anything.
function readable(grant: GrantData): boolean {
    const { actions } = grant as { actions?: unknown };

    return actions === undefined || (Array.isArray(actions) && actions.every(action => typeof action === "string"));
}

// The `actions` a scope stands for: none when none are listed, which a grant
// states by leaving `actions` out.
function actionsOf(scope: Scope): string[] | undefined {
    return scope.actions.length === 0 ? undefined : scope.actions.filter(action => scope.chosen.includes(action));
}

function ScopeEditor({ scope, onChange, disabled }: { scope: Scope; onChange: (scope: Scope) => void; disabled?: boolean }) {
    return (
        <Box>
            <Box sx={{ display: "flex", flexWrap: "wrap", columnGap: 1 }}>
                {scope.actions.map(action => (
                    <FormControlLabel
                        key={action}
                        label={<Typography variant="body2" sx={{ wordBreak: "break-all" }}>{action}</Typography>}
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

function describeScope(held: HeldGrant): string {
    if (!readable(held.grant)) {
        return "Actions in a form this wallet cannot read";
    }
    if (!held.grant.actions) {
        return `Whatever ${held.app} allows a client`;
    }

    return held.grant.actions.length > 0 ? held.grant.actions.join(", ") : "No actions";
}

function isExpired(grant: GrantData): boolean {
    return grant.expiresAt !== undefined && new Date(grant.expiresAt).getTime() <= Date.now();
}

const NOT_A_LINK = "This is not a grant link. A grant link is archon://grant?request= followed by the DID of a request.";
const NOT_FOUND = "This node cannot find the request this link names. A request may last only an hour: ask the client for a new link.";

const LINK_ERRORS: Record<GrantRequestRefusal, string> = {
    "deleted": "The request this link names was withdrawn.",
    "not-an-asset": "This link does not name a grant request.",
    "changed": "The request this link names was changed after it was made, so it does not say who is asking.",
    "not-a-request": "This link does not name a grant request.",
    "invalid": "This link does not name a valid grant request.",
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
    // What the last read of Keymaster's revocations left unknown: whether the
    // read failed, with what, and how many of its entries could not be read.
    const heldRead = useRef<{ error?: unknown; failed: boolean; unread: number }>({ failed: false, unread: 0 });
    const [link, setLink] = useState("");
    const linkRef = useRef(link);
    linkRef.current = link;
    const [request, setRequest] = useState<Record<string, any> | null>(null);
    const [linkError, setLinkError] = useState("");
    const [scope, setScope] = useState<Scope>(scopeOf(undefined, undefined));
    const [chosen, setRegistry] = useState("");
    const [busy, setBusy] = useState(false);
    const [editing, setEditing] = useState<{ grant: HeldGrant; scope: Scope } | null>(null);
    const [revoking, setRevoking] = useState<HeldGrant | null>(null);

    // Where the client that is asking says a grant can be, and of those, where
    // this node can create one. A grant on a registry the client did not list
    // is one it cannot use.
    const asked: string[] = request?.registries ?? [];
    const permitted = asked.filter(name => registries.includes(name));
    // The choice holds only while it is one of the registries on offer.
    const registry = permitted.find(name => name === chosen) ?? permitted[0] ?? "";

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

                const holds = grantIn(found.doc.didDocumentData);

                if (found.doc.didDocumentMetadata?.deactivated || !holds) {
                    continue;
                }

                const registry = found.doc.didDocumentRegistration?.registry ?? "";

                held.push({
                    did: found.did,
                    app: holds.app,
                    member: holds.member,
                    grant: holds.grant as GrantData,
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

        setUnresolved(failed + heldRead.current.unread);
        setUnlisted(heldRead.current.failed);
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
        catch (error) {
            // What is held is unknown, so neither is whether a client can
            // still act under a grant that is not listed.
            heldRead.current = { error, failed: true, unread: 0 };
            return;
        }

        let unread = 0;

        for (const { did, status } of reported) {
            if (tracked(sessionKey).some(revocation => revocation.grant.did === did)) {
                continue;
            }
            if (status === "unresolved") {
                unread += 1;
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
                const holds = grantIn(before.didDocumentData);

                if (!holds) {
                    continue;
                }

                const registry = before.didDocumentRegistration?.registry ?? "";
                const grant: HeldGrant = {
                    did,
                    app: holds.app,
                    member: holds.member,
                    grant: holds.grant as GrantData,
                    registry,
                    anchored: isAnchored(before, registry),
                    created: Number(before.didDocumentMetadata?.versionSequence ?? 1) <= 1,
                };

                track(sessionKey, did, revocation => revocation
                    ?? { grant, state: status === "displaced" ? "displaced" : "submitted" });
            }
            catch {
                // Read again at the next refresh, while Keymaster reports it.
                unread += 1;
            }
        }

        heldRead.current = { failed: false, unread };
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
            if (heldRead.current.failed && report) {
                notifyRef.current.error(heldRead.current.error);
            }
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

    // The request a link names is an asset its client created. Who is asking
    // is read from the request as the node resolves it.
    async function readLink() {
        const reading = link;
        const named = grantRequestId(reading);

        if (!named.startsWith("did:")) {
            setRequest(null);
            setLinkError(NOT_A_LINK);
            return;
        }

        setBusy(true);
        let read: ReturnType<typeof grantRequestOf> | undefined;

        try {
            read = grantRequestOf(await keymaster.resolveDID(named));
        }
        catch {
            read = undefined;
        }
        finally {
            setBusy(false);
        }
        if (linkRef.current !== reading) {
            return;
        }
        if (!read || "refused" in read) {
            setRequest(null);
            setLinkError(read ? LINK_ERRORS[read.refused] : NOT_FOUND);
            return;
        }

        const asking: Record<string, any> = { ...read.request, client: read.client, did: read.did, app: read.app };

        setLinkError("");
        setRequest(asking);
        setScope(scopeOf(asking.actions, asking.expiresAt));

        const listed: string[] = asking.registries;
        const choices = listed.filter(name => registries.includes(name));

        setRegistry(current => (choices.includes(current) ? current : choices[0] ?? ""));
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
        const grant: GrantData = {
            ...(request.v === undefined ? {} : { v: request.v }),
            client: request.client,
            request: request.did,
            ...(actions ? { actions } : {}),
            ...(expiresAt ? { expiresAt } : {}),
        };

        setBusy(true);
        try {
            // Keymaster creates a local identity's assets on `local` whatever
            // registry is asked for, so that is where its grant would be.
            const grantor = await keymaster.resolveDID(identity, { confirm: true });

            if (grantor.didDocumentRegistration?.registry === "local" && registry !== "local") {
                throw new Error(`A local identity's grant is created on local, and this one is to be on ${registry}`);
            }
            if (grantor.didDocument?.id === request.client) {
                throw new Error("This request is this identity's own. An identity cannot grant itself.");
            }

            await keymaster.createAsset({ [grantMember(request.app)]: grant }, { registry, controller: identity });
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

        setBusy(true);
        try {
            // The change is to the grant as the user saw it. If the grant has
            // changed since, saving would put back what that change took away.
            const latest = (await keymaster.resolveDID(held.did)).didDocumentData as Record<string, unknown> | undefined;

            if (JSON.stringify(latest?.[held.member]) !== JSON.stringify(held.grant)) {
                setEditing(null);
                await load();
                throw new Error("This grant has changed since it was shown. Review it and make the change again.");
            }

            // Keymaster changes these two members and keeps everything else the
            // asset holds. Actions are named only when there were some to
            // choose among, so a grant that lists none is left listing none.
            if (!await keymaster.updateGrant(held.did, { ...(actions ? { actions } : {}), expiresAt: expiresAt ?? null })) {
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
            // On a registry that is no chain, a deletion the node is known to
            // have accepted has nothing more to wait for.
            mark(uncertain || hasChain(held.registry) ? "submitted" : "effective", uncertain);
            return;
        }

        mark(undefined);
        if (!failed) {
            notifyRef.current.error(new Error("The node did not accept the revocation"));
        }
        await load().catch(() => undefined);
    }

    // A scope that lists actions and has none of them chosen allows nothing.
    const scopeEmpty = (edited: Scope) => edited.actions.length > 0 && edited.chosen.length === 0;

    return (
        <Box>
            <PageHeader
                title="Grants"
                description="Clients you have allowed to act in this identity's name."
            />

            <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
                <Typography variant="h6" component="h2" sx={{ mb: 1 }}>Grant a client</Typography>

                {request && permitted.length === 0 && (
                    <Alert severity="warning" sx={{ mb: 2 }}>
                        This client can use a grant only on {asked.join(", ")}, and this node supports
                        none of them.
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
                        <Button variant="contained" onClick={readLink} disabled={busy || !link.trim()}>
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
                        <Typography variant="body2" color="text.secondary">App</Typography>
                        <Typography variant="body1" sx={{ mb: 1 }}>{request.app}</Typography>
                        {request.name !== undefined && (
                            <>
                                <Typography variant="body2" color="text.secondary">It calls itself</Typography>
                                <Typography variant="body1" sx={{ mb: 1 }}>{request.name}</Typography>
                                <Alert severity="info" sx={{ mb: 2 }}>
                                    The name is the client's own claim. The grant is to the client DID above.
                                </Alert>
                            </>
                        )}

                        <Typography variant="body2" color="text.secondary">
                            {request.actions ? "It asks for" : `It lists no actions: the grant allows whatever ${request.app} allows a client`}
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
                            Another change to this grant took the revocation's place. The client can still act under it.
                        </Typography>
                    )}
                    {(state === "requested" || state === "submitted") && (
                        <Typography variant="body2">
                            The client can still act under this grant until the revocation is {hasChain(held.registry) ? `anchored on ${held.registry}` : "accepted"}.
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
                    description="This identity has not allowed any client to act for it."
                />
            )}

            {grants?.map(held => (
                <Paper key={held.did} variant="outlined" sx={{ p: 2, mb: 1 }} data-testid="grant">
                    <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", alignItems: "center", mb: 1 }}>
                        <Chip size="small" variant="outlined" label={held.app} />
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
                                ? `The client cannot act under this grant until it is anchored on ${held.registry}.`
                                : `What is shown takes effect once it is anchored on ${held.registry}. Until then the grant is as it was.`}
                        </Typography>
                    )}
                    <Typography variant="body2" color="text.secondary">Client</Typography>
                    <Typography variant="body2" sx={{ fontFamily: "monospace", wordBreak: "break-all", mb: 1 }}>
                        {held.grant.client}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">May</Typography>
                    <Typography variant="body2" sx={{ wordBreak: "break-all", mb: 1 }}>{describeScope(held)}</Typography>
                    <Typography variant="body2" color="text.secondary">Expires</Typography>
                    <Typography variant="body2" sx={{ mb: 1 }}>
                        {held.grant.expiresAt ? new Date(held.grant.expiresAt).toLocaleString() : "Never"}
                    </Typography>
                    <Box sx={{ display: "flex", gap: 1 }}>
                        <Button
                            size="small"
                            disabled={!readable(held.grant)}
                            onClick={() => setEditing({
                                grant: held,
                                scope: scopeOf(held.grant.actions, held.grant.expiresAt),
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
                    {editing && hasChain(editing.grant.registry) && (
                        <DialogContentText sx={{ mb: 1 }}>
                            A change takes effect once it is anchored on {editing.grant.registry}.
                        </DialogContentText>
                    )}
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
                        The client will no longer be able to act for this identity once the
                        revocation is {revoking && hasChain(revoking.registry) ? `anchored on ${revoking.registry}` : "accepted"}.
                        What it did under the grant stands. A revocation cannot be undone.
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
