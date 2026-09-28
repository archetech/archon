import React from 'react';
import { AbsoluteFill, interpolate, Sequence, useCurrentFrame } from 'remotion';
import { Backdrop, Caption, CodeLine, DidChip, FadeUp, HashChip, Panel, SceneLabel, Verdict, useProgress } from '../components';
import { color, font } from '../theme';
import { DID, HASH } from './Flow';

const STEP = 240;

const checks: { title: string, detail: string, caption: string }[] = [
    { title: 'Still live', detail: 'credential and presentation not revoked', caption: 'Is it still live? A credential Alice has revoked no longer counts.' },
    { title: 'Hashes match', detail: 'the presentation is the credential’s current content', caption: 'Do the hashes match? If Alice has since updated the credential, an old copy is caught.' },
    { title: 'Signed by its issuer', detail: 'a valid proof by the issuer it names', caption: 'Was it signed by the issuer it names? Carol can sign anything, but not with Alice’s key.' },
    { title: 'Lives at its DID', detail: 'its signed id is the DID presented', caption: 'Does it live at the DID presented? A copy of a revoked credential still names its original home.' },
    { title: 'Meets a request', detail: 'the requested schema, from a named issuer', caption: 'Does it meet a request? The right schema, and when Victor named issuers, one of them.' },
];

const HOLD = 90;

export const CHECKS_FRAMES = STEP * checks.length + HOLD;

const Checklist: React.FC = () => {
    const frame = useCurrentFrame();
    const active = Math.min(checks.length - 1, Math.floor(frame / STEP));
    return (
        <div style={{ position: 'absolute', left: 110, top: 250, width: 620, display: 'flex', flexDirection: 'column', gap: 18 }}>
            {checks.map((check, index) => {
                const reached = frame >= index * STEP;
                const isActive = index === active;
                return (
                    <FadeUp key={check.title} delay={index * 6}>
                        <div
                            style={{
                                display: 'flex', alignItems: 'center', gap: 22, padding: '16px 22px', borderRadius: 14,
                                background: isActive ? `${color.verifier}1c` : 'transparent',
                                border: `2px solid ${isActive ? color.verifier : color.panelEdge}`,
                                opacity: reached ? 1 : 0.45,
                            }}
                        >
                            <div
                                style={{
                                    width: 46, height: 46, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    fontFamily: font.mono, fontWeight: 700, fontSize: 24,
                                    background: index < active || frame >= CHECKS_FRAMES - HOLD ? `${color.good}22` : color.backgroundLift,
                                    color: index < active || frame >= CHECKS_FRAMES - HOLD ? color.good : color.muted,
                                }}
                            >
                                {index < active || frame >= CHECKS_FRAMES - HOLD ? '✓' : index + 1}
                            </div>
                            <div>
                                <div style={{ fontFamily: font.sans, fontWeight: 700, fontSize: 30, color: color.text }}>{check.title}</div>
                                <div style={{ fontFamily: font.sans, fontSize: 21, color: color.muted, marginTop: 4 }}>{check.detail}</div>
                            </div>
                        </div>
                    </FadeUp>
                );
            })}
        </div>
    );
};

// The attempt each check stops, shown to the right of the checklist.
const Attempt: React.FC<{ label: string, children: React.ReactNode, verdict: string }> = ({ label, children, verdict }) => (
    <div style={{ position: 'absolute', left: 840, top: 250, width: 960 }}>
        <FadeUp delay={8}>
            <div style={{ fontFamily: font.sans, fontSize: 24, fontWeight: 700, color: color.bad, letterSpacing: 2, textTransform: 'uppercase', marginBottom: 22 }}>
                Attempt · {label}
            </div>
        </FadeUp>
        {children}
        <div style={{ marginTop: 34 }}>
            <Verdict ok={false} delay={150} text={verdict} />
        </div>
    </div>
);

const Revoked: React.FC = () => {
    const strike = useProgress(80, 120);
    return (
        <Attempt label="present a revoked credential" verdict="Not counted">
            <DidChip label="VC" did={DID.vc} accent={color.issuer} delay={20} strike={strike} />
            <FadeUp delay={110}>
                <div style={{ marginTop: 18, fontFamily: font.sans, fontSize: 26, color: color.bad }}>revoked by Alice</div>
            </FadeUp>
        </Attempt>
    );
};

const StaleCopy: React.FC = () => (
    <Attempt label="present an outdated copy" verdict="Hashes differ">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
                <span style={{ width: 200, fontFamily: font.sans, fontSize: 24, color: color.muted }}>credential now</span>
                <HashChip value="5d02…e7a1" accent={color.issuer} delay={30} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
                <span style={{ width: 200, fontFamily: font.sans, fontSize: 24, color: color.muted }}>presentation</span>
                <HashChip value={HASH} accent={color.bad} delay={60} />
            </div>
        </div>
    </Attempt>
);

const Forged: React.FC = () => (
    <Attempt label="sign “from Alice” with Carol’s key" verdict="Wrong signer">
        <Panel title="Forged credential" accent={color.bad} width={700} delay={20}>
            <CodeLine k="issuer" v={DID.alice} delay={40} highlight={color.issuer} />
            <CodeLine k="proof" v={<>signed by <span style={{ color: color.holder }}>{DID.carol}</span></>} delay={70} highlight={color.bad} />
        </Panel>
    </Attempt>
);

const Copied: React.FC = () => (
    <Attempt label="copy a credential to a new DID" verdict="id ≠ presented DID">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, alignItems: 'flex-start' }}>
            <DidChip label="Presented" did="did:cid:bagaa…c0py" accent={color.holder} delay={20} />
            <Panel title="Credential inside" accent={color.bad} width={640} delay={50}>
                <CodeLine k="id" v={DID.vc} delay={70} highlight={color.bad} />
            </Panel>
        </div>
    </Attempt>
);

const WrongSchema: React.FC = () => (
    <Attempt label="answer with the wrong credential" verdict="Request not met">
        <div style={{ display: 'flex', gap: 30 }}>
            <Panel title="Requested" accent={color.verifier} width={420} delay={20}>
                <CodeLine k="schema" v="EmailCredential" delay={35} />
            </Panel>
            <Panel title="Presented" accent={color.bad} width={420} delay={50}>
                <CodeLine k="schema" v="LoyaltyCard" delay={65} highlight={color.bad} />
            </Panel>
        </div>
    </Attempt>
);

const attempts = [Revoked, StaleCopy, Forged, Copied, WrongSchema];

export const Checks: React.FC = () => {
    const frame = useCurrentFrame();
    const done = interpolate(frame, [CHECKS_FRAMES - HOLD, CHECKS_FRAMES - HOLD + 15], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    return (
        <AbsoluteFill>
            <Backdrop tint={color.verifier} />
            <SceneLabel index={5} title="Verification" />
            <FadeUp delay={0} style={{ position: 'absolute', left: 110, top: 140 }}>
                <div style={{ fontFamily: font.sans, fontWeight: 800, fontSize: 52, color: color.text }}>
                    Five checks before a credential counts
                </div>
            </FadeUp>
            <Checklist />
            {attempts.map((Scene, index) => (
                <Sequence key={index} from={index * STEP} durationInFrames={STEP}>
                    <Scene />
                </Sequence>
            ))}
            <div style={{ position: 'absolute', left: 860, top: 470, opacity: done }}>
                <Verdict ok delay={CHECKS_FRAMES - HOLD} size={110} text="All five pass: it counts" />
            </div>
            <Caption
                lines={[
                    ...checks.map((check, index) => ({ from: index * STEP + 10, to: (index + 1) * STEP, text: check.caption })),
                    { from: STEP * checks.length + 10, to: CHECKS_FRAMES, text: 'Only a credential that passes all five is counted.' },
                ]}
            />
        </AbsoluteFill>
    );
};
