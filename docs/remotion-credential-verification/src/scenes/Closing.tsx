import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { Backdrop, Caption, FadeUp, Headline, SceneLabel, Verdict, useEnter, useProgress } from '../components';
import { color, font } from '../theme';
import { Name } from './Intro';

const bob = '#F59EB5';

export const PAIRING_FRAMES = 450;

const Card: React.FC<{ x: number, y: number, title: React.ReactNode, detail: React.ReactNode, accent: string, delay: number, state?: 'met' | 'unmet' }> = ({
    x, y, title, detail, accent, delay, state,
}) => {
    const enter = useEnter(delay);
    const edge = state === 'met' ? color.good : state === 'unmet' ? color.bad : accent;
    return (
        <div
            style={{
                position: 'absolute', left: x, top: y, width: 460, padding: '22px 26px', borderRadius: 16, background: color.panel,
                border: `2px solid ${edge}`, boxShadow: `0 0 ${state ? 26 : 0}px ${edge}55`,
                opacity: enter, transform: `translateY(${(1 - enter) * 20}px)`,
            }}
        >
            <div style={{ fontFamily: font.sans, fontWeight: 700, fontSize: 30, color: color.text }}>{title}</div>
            <div style={{ fontFamily: font.sans, fontSize: 24, color: color.muted, marginTop: 6 }}>{detail}</div>
        </div>
    );
};

// A link between a request card (left) and a credential card (right).
const Link: React.FC<{ fromY: number, toY: number, progress: number, stroke: string }> = ({ fromY, toY, progress, stroke }) => {
    const x1 = 640;
    const x2 = 1180;
    const path = `M ${x1} ${fromY} C ${x1 + 200} ${fromY}, ${x2 - 200} ${toY}, ${x2} ${toY}`;
    return (
        <svg style={{ position: 'absolute', inset: 0 }} width={1920} height={1080}>
            <path d={path} stroke={stroke} strokeWidth={5} fill="none" pathLength={1} strokeDasharray="1" strokeDashoffset={1 - progress} strokeLinecap="round" />
        </svg>
    );
};

export const Pairing: React.FC = () => {
    const frame = useCurrentFrame();
    const greedy = useProgress(50, 90);
    const fade = interpolate(frame, [180, 200], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    const bobLink = useProgress(210, 250);
    const aliceLink = useProgress(245, 285);
    const secondUnmet = frame >= 100 && frame < 200;
    const settled = frame >= 285;
    return (
        <AbsoluteFill>
            <Backdrop tint={color.good} />
            <SceneLabel index={6} title="Pairing requests" />
            <FadeUp delay={0} style={{ position: 'absolute', left: 180, top: 150 }}>
                <div style={{ fontFamily: font.sans, fontSize: 26, color: color.muted, letterSpacing: 2, textTransform: 'uppercase' }}>Victor asks for</div>
            </FadeUp>
            <FadeUp delay={0} style={{ position: 'absolute', left: 1180, top: 150 }}>
                <div style={{ fontFamily: font.sans, fontSize: 26, color: color.muted, letterSpacing: 2, textTransform: 'uppercase' }}>Carol holds</div>
            </FadeUp>
            <Card x={180} y={230} title="Email credential" detail={<>from <Name role="issuer" /> or <span style={{ color: bob, fontWeight: 700 }}>Bob</span></>} accent={color.verifier} delay={10} state={settled ? 'met' : undefined} />
            <Card x={180} y={470} title="Email credential" detail={<>from <Name role="issuer" /> only</>} accent={color.verifier} delay={20} state={settled ? 'met' : secondUnmet ? 'unmet' : undefined} />
            <Card x={1180} y={230} title="Email credential" detail={<>issued by <Name role="issuer" /></>} accent={color.issuer} delay={30} />
            <Card x={1180} y={470} title="Email credential" detail={<>issued by <span style={{ color: bob, fontWeight: 700 }}>Bob</span></>} accent={bob} delay={40} />
            <div style={{ opacity: fade }}>
                <Link fromY={300} toY={300} progress={greedy} stroke={color.bad} />
            </div>
            <Link fromY={300} toY={540} progress={bobLink} stroke={color.good} />
            <Link fromY={540} toY={300} progress={aliceLink} stroke={color.good} />
            {secondUnmet && (
                <div style={{ position: 'absolute', left: 180, top: 640 }}>
                    <Verdict ok={false} delay={100} size={56} text="first fit: second request unmet" />
                </div>
            )}
            {settled && (
                <div style={{ position: 'absolute', left: 180, top: 640 }}>
                    <Verdict ok delay={285} size={56} text="best pairing: every request met" />
                </div>
            )}
            <Caption
                lines={[
                    { from: 10, to: 190, text: 'Take the first fit, and Alice’s credential gets spent on the request Bob’s could have met.' },
                    { from: 190, to: 330, text: 'Holder and verifier both find the best one-to-one pairing, so order never decides the outcome.' },
                    { from: 330, to: PAIRING_FRAMES, text: 'Every request met, each by a different credential: that’s a match.' },
                ]}
            />
        </AbsoluteFill>
    );
};

export const HISTORY_FRAMES = 600;

const LEFT = 200;
const RIGHT = 1720;
const at = (minute: number) => LEFT + (RIGHT - LEFT) * (minute / 50);

const Event: React.FC<{ minute: number, label: string, accent: string, delay: number, above?: boolean, dashed?: boolean, opacity?: number }> = ({
    minute, label, accent, delay, above = false, dashed = false, opacity = 1,
}) => {
    const enter = useEnter(delay);
    return (
        <div style={{ position: 'absolute', left: at(minute) - 120, top: above ? 350 : 560, width: 240, textAlign: 'center', opacity: enter * opacity }}>
            {!above && <div style={{ margin: '0 auto', width: 18, height: 18, borderRadius: '50%', background: dashed ? 'transparent' : accent, border: `3px ${dashed ? 'dashed' : 'solid'} ${accent}` }} />}
            <div style={{ fontFamily: font.sans, fontWeight: 600, fontSize: 22, color: accent, marginTop: 10, lineHeight: 1.3 }}>{label}</div>
            {above && <div style={{ margin: '10px auto 0', width: 18, height: 18, borderRadius: '50%', background: accent }} />}
        </div>
    );
};

export const History: React.FC = () => {
    const frame = useCurrentFrame();
    const line = useProgress(10, 50);
    const cursorMinute = interpolate(frame, [60, 110, 190, 250, 350, 400], [5, 15, 15, 45, 45, 30], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    const anchored = useProgress(330, 380);
    const revokedAt = 20 + anchored * 20;
    const passes = cursorMinute < revokedAt;
    const cursor = useEnter(55);
    return (
        <AbsoluteFill>
            <Backdrop tint={color.ledger} />
            <SceneLabel index={7} title="Verifying the past" />
            <FadeUp delay={0} style={{ position: 'absolute', left: 200, top: 150 }}>
                <div
                    style={{
                        display: 'inline-block', padding: '14px 22px', borderRadius: 12, background: color.panel, border: `1px solid ${color.panelEdge}`,
                        fontFamily: font.mono, fontSize: 28, color: color.text,
                    }}
                >
                    verifyResponse(response, {'{'} <span style={{ color: color.ledger }}>versionTime</span> {'}'})
                </div>
            </FadeUp>
            <div style={{ position: 'absolute', left: LEFT, top: 568, width: (RIGHT - LEFT) * line, height: 3, background: color.panelEdge }} />
            <Event minute={0} label="credential issued" accent={color.issuer} delay={20} />
            <Event minute={10} label="response created" accent={color.holder} delay={30} />
            <Event minute={20} label={anchored > 0.5 ? 'revocation signed' : 'revoked'} accent={color.bad} delay={40} dashed={anchored > 0.5} />
            <Event minute={40} label="anchored in a block" accent={color.ledger} delay={330} />
            <div
                style={{
                    position: 'absolute', left: at(revokedAt) - 2, top: 470, width: 4, height: 96,
                    background: `repeating-linear-gradient(${color.bad}, ${color.bad} 8px, transparent 8px, transparent 16px)`,
                    opacity: line,
                }}
            />
            <div style={{ position: 'absolute', left: at(revokedAt) + 14, top: 462, fontFamily: font.sans, fontSize: 22, fontWeight: 700, color: color.bad, opacity: line }}>
                revocation takes effect
            </div>
            <div style={{ position: 'absolute', left: at(cursorMinute) - 90, top: 380, width: 180, textAlign: 'center', opacity: cursor }}>
                <div style={{ fontFamily: font.mono, fontSize: 22, color: color.ledger, marginBottom: 8 }}>versionTime</div>
                <div style={{ margin: '0 auto', width: 4, height: 150, background: color.ledger, boxShadow: `0 0 18px ${color.ledger}` }} />
            </div>
            <div style={{ position: 'absolute', left: 200, top: 790, opacity: cursor }}>
                <Verdict key={passes ? 'pass' : 'fail'} ok={passes} size={64} text={passes ? 'verifies as of then' : 'revoked as of then'} />
            </div>
            <Caption
                lines={[
                    { from: 10, to: 175, text: 'Revocation isn’t the end of the story. Victor can ask: did this response verify at some moment in the past?' },
                    { from: 175, to: 330, text: 'With a versionTime, every DID is read as it stood then: before the revocation it passes, after it fails.' },
                    { from: 330, to: 480, text: 'Once the revocation is anchored on chain, it takes effect at that block’s time.' },
                    { from: 480, to: HISTORY_FRAMES, text: 'A chosen time sets the context for checking. On its own, it isn’t proof that something happened then.' },
                ]}
            />
        </AbsoluteFill>
    );
};

export const OUTRO_FRAMES = 270;

const points = [
    'signed by the issuer it names',
    'living at the DID presented',
    'current: hashes match, not revoked',
    'one credential for each request',
    'checkable as of any moment in its history',
];

export const Outro: React.FC = () => (
    <AbsoluteFill>
        <Backdrop tint={color.verifier} />
        <div style={{ position: 'absolute', right: 230, top: 330 }}>
            <Verdict ok delay={90} size={300} />
        </div>
        <div style={{ position: 'absolute', left: 200, top: 180 }}>
            <Headline size={80}>A verified credential is</Headline>
            <div style={{ marginTop: 40, display: 'flex', flexDirection: 'column', gap: 22 }}>
                {points.map((point, index) => (
                    <FadeUp key={point} delay={20 + index * 14}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
                            <Verdict ok delay={20 + index * 14} size={44} />
                            <span style={{ fontFamily: font.sans, fontSize: 40, color: color.text, fontWeight: 500 }}>{point}</span>
                        </div>
                    </FadeUp>
                ))}
            </div>
        </div>
        <FadeUp delay={110} style={{ position: 'absolute', left: 200, bottom: 110 }}>
            <div style={{ fontFamily: font.sans, fontSize: 26, color: color.muted }}>
                Archon Keymaster · TypeScript and Python, verified against each other · <span style={{ fontFamily: font.mono, color: color.ledger }}>docs/services/keymaster §9.3–9.4</span>
            </div>
        </FadeUp>
    </AbsoluteFill>
);
