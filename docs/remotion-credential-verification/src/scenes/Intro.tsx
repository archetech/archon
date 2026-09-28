import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { Actor, Backdrop, Caption, FadeUp, Headline, SceneLabel, useEnter } from '../components';
import { cast, color, font } from '../theme';

export const TITLE_FRAMES = 150;

export const Title: React.FC = () => {
    const frame = useCurrentFrame();
    const rule = interpolate(frame, [20, 60], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    return (
        <AbsoluteFill>
            <Backdrop tint={color.verifier} />
            <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 28 }}>
                <FadeUp delay={0}>
                    <div style={{ fontFamily: font.mono, fontSize: 26, color: color.ledger, letterSpacing: 6 }}>ARCHON · DID:CID</div>
                </FadeUp>
                <Headline delay={8} size={112}>Proving what you hold</Headline>
                <div style={{ width: 520 * rule, height: 3, background: `linear-gradient(90deg, ${color.issuer}, ${color.holder}, ${color.verifier})` }} />
                <FadeUp delay={24}>
                    <div style={{ fontFamily: font.sans, fontSize: 40, color: color.muted, fontWeight: 500 }}>
                        How Archon verifies a credential presentation
                    </div>
                </FadeUp>
            </AbsoluteFill>
        </AbsoluteFill>
    );
};

export const CAST_FRAMES = 300;

const roles = ['issuer', 'holder', 'verifier'] as const;
const duties = { issuer: 'issues credentials', holder: 'holds them', verifier: 'checks them' };

export const Cast: React.FC = () => {
    const frame = useCurrentFrame();
    const ledger = useEnter(120);
    return (
        <AbsoluteFill>
            <Backdrop />
            <SceneLabel index={1} title="The cast" />
            <div style={{ position: 'absolute', top: 230, left: 0, right: 0, display: 'flex', justifyContent: 'center', gap: 260 }}>
                {roles.map((role, index) => (
                    <div key={role} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 26 }}>
                        <Actor role={role} size={190} delay={10 + index * 18} />
                        <FadeUp delay={30 + index * 18}>
                            <div style={{ fontFamily: font.sans, fontSize: 30, color: color.muted }}>{duties[role]}</div>
                        </FadeUp>
                    </div>
                ))}
            </div>
            <div
                style={{
                    position: 'absolute', left: 240, right: 240, top: 720, height: 96, borderRadius: 16,
                    border: `2px solid ${color.ledger}`, background: `${color.ledger}14`, opacity: ledger,
                    transform: `translateY(${(1 - ledger) * 30}px)`, display: 'flex', alignItems: 'center', gap: 18, padding: '0 28px',
                    overflow: 'hidden',
                }}
            >
                <span style={{ fontFamily: font.sans, fontWeight: 700, fontSize: 26, color: color.ledger, whiteSpace: 'nowrap' }}>
                    Gatekeeper · shared DID ledger
                </span>
                {Array.from({ length: 12 }, (_, index) => {
                    const shift = ((frame * 1.2) + index * 90) % 1080;
                    return (
                        <div
                            key={index}
                            style={{
                                position: 'absolute', left: 420 + shift, width: 64, height: 44, borderRadius: 8,
                                border: `1px solid ${color.ledger}88`, background: `${color.ledger}22`,
                                opacity: interpolate(shift, [0, 80, 960, 1080], [0, 1, 1, 0]),
                            }}
                        />
                    );
                })}
            </div>
            <Caption
                lines={[
                    { from: 20, to: 150, text: <>Three parties. <Name role="issuer" /> issues credentials, <Name role="holder" /> holds them, and <Name role="verifier" /> needs proof.</> },
                    { from: 150, to: CAST_FRAMES, text: 'What they publish lives on a shared ledger of DIDs, and nobody takes anyone’s word for anything.' },
                ]}
            />
        </AbsoluteFill>
    );
};

export const Name: React.FC<{ role: keyof typeof cast }> = ({ role }) => (
    <span style={{ color: cast[role].color, fontWeight: 700 }}>{cast[role].name}</span>
);
