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
    "createAsset" | "listAssets" | "resolveDID" | "mergeData"
> & {
    revokeDID(id: string): Promise<boolean>;
};

type Props = {
    keymaster: GrantsKeymaster;
    // The identity whose grants are shown. Hosts key this component by it, and
    // every call names it, so a call under way when the identity changes still
    // acts for the identity it was started for.
    identity: string;
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
export type RevocationState = "requested" | "submitted" | "effective";

type Revocation = { grant: HeldGrant; state: RevocationState };

// Revocations made while the wallet is open, by identity. Keymaster does not
// list a revoked asset, so this is what lets the view warn about one when the
// user leaves the tab and comes back.
const sessionRevocations = new Map<string, Revocation[]>();

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
};

export default function GrantsView({ keymaster, identity, registries, notify: hostNotify, pollMs = 30000 }: Props) {
    const notifyRef = useRef(hostNotify);
    notifyRef.current = hostNotify;

    const [grants, setGrants] = useState<HeldGrant[] | null>(null);
    const [revocations, setRevocationState] = useState<Revocation[]>(() => sessionRevocations.get(identity) ?? []);
    const [unresolved, setUnresolved] = useState(0);
    const [link, setLink] = useState("");
    const [request, setRequest] = useState<Record<string, any> | null>(null);
    const [linkError, setLinkError] = useState("");
    const [scope, setScope] = useState<Scope>(scopeOf(undefined, undefined));
    const [registry, setRegistry] = useState("");
    const [busy, setBusy] = useState(false);
    const [editing, setEditing] = useState<{ grant: HeldGrant; scope: Scope } | null>(null);
    const [revoking, setRevoking] = useState<HeldGrant | null>(null);

    const permitted = PERMITTED_REGISTRIES.filter(name => registries.includes(name));

    const setRevocations = useCallback((change: (current: Revocation[]) => Revocation[]) => {
        setRevocationState(current => {
            const next = change(current);
            sessionRevocations.set(identity, next);
            return next;
        });
    }, [identity]);

    const load = useCallback(async () => {
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

        setUnresolved(failed);
        setGrants(held);
    }, [keymaster, identity]);

    // Whether each revocation the node has accepted is anchored. An anchor can be
    // withdrawn by a reorganization, so one seen as effective is read as well.
    const readRevocations = useCallback(async () => {
        const states = new Map<string, RevocationState>();

        for (const revocation of sessionRevocations.get(identity) ?? []) {
            if (revocation.state === "requested") {
                continue;
            }
            try {
                const doc = await keymaster.resolveDID(revocation.grant.did);
                const effective = doc.didDocumentMetadata?.deactivated === true && isAnchored(doc, revocation.grant.registry);
                states.set(revocation.grant.did, effective ? "effective" : "submitted");
            }
            catch {
                // Left as it is shown until the node answers.
            }
        }

        setRevocations(current => current.map(revocation => {
            const state = revocation.state === "requested" ? undefined : states.get(revocation.grant.did);
            return state && state !== revocation.state ? { ...revocation, state } : revocation;
        }));
    }, [keymaster, identity, setRevocations]);

    const refresh = useCallback(async () => {
        try {
            await load();
        }
        catch (error) {
            setGrants(current => current ?? []);
            notifyRef.current.error(error);
        }
        await readRevocations();
    }, [load, readRevocations]);

    useEffect(() => {
        refresh();
        const timer = setInterval(() => {
            load().catch(() => undefined);
            readRevocations();
        }, pollMs);

        return () => clearInterval(timer);
    }, [refresh, load, readRevocations, pollMs]);

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

    async function revoke() {
        if (!revoking) {
            return;
        }

        const held = revoking;
        const mark = (state: RevocationState) => setRevocations(current => [
            ...current.filter(revocation => revocation.grant.did !== held.did),
            { grant: held, state },
        ]);

        setRevoking(null);
        mark("requested");
        setGrants(current => current?.filter(grant => grant.did !== held.did) ?? current);

        try {
            if (!await keymaster.revokeDID(held.did)) {
                throw new Error("The node did not accept the revocation");
            }
            mark("submitted");
        }
        catch (error) {
            setRevocations(current => current.filter(revocation => revocation.grant.did !== held.did));
            notifyRef.current.error(error);
            await load().catch(() => undefined);
        }
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
                    severity={state === "effective" ? "success" : "warning"}
                    sx={{ mb: 1 }}
                    onClose={state === "effective"
                        ? () => setRevocations(current => current.filter(revocation => revocation.grant.did !== held.did))
                        : undefined}
                >
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>{REVOCATION_TEXT[state]}</Typography>
                    <Typography variant="body2" sx={{ fontFamily: "monospace", wordBreak: "break-all" }}>
                        {held.grant.client}
                    </Typography>
                    {state !== "effective" && (
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
                    action={<Button color="inherit" size="small" onClick={refresh}>Retry</Button>}
                >
                    {unresolved === 1 ? "One asset" : `${unresolved} assets`} of this identity could not be read,
                    so this list may be missing grants.
                </Alert>
            )}

            {grants === null && <CircularProgress size={24} aria-label="Loading grants" />}

            {grants !== null && grants.length === 0 && unresolved === 0 && (
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
                        {isExpired(held.grant)
                            ? <Chip size="small" color="default" label="Expired" />
                            : held.anchored
                                ? <Chip size="small" color="success" label="Active" />
                                : <Chip size="small" color="warning" label={held.created ? "Awaiting anchoring" : "Change awaiting anchoring"} />}
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
                    <Button variant="contained" color="error" onClick={revoke}>Revoke</Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}
