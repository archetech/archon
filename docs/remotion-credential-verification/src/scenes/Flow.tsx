import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { Actor, Arrow, Backdrop, Caption, CodeLine, DidChip, FadeUp, HashChip, LockIcon, Panel, SceneLabel, useEnter, useProgress } from '../components';
import { color, font } from '../theme';
import { Name } from './Intro';

export const DID = {
    alice: 'did:cid:bagaa…a1ce',
    carol: 'did:cid:bagaa…c4r0',
    victor: 'did:cid:bagaa…v1c7',
    vc: 'did:cid:bagaa…7qx4',
    vp: 'did:cid:bagaa…m2kd',
    challenge: 'did:cid:bagaa…ch9e',
    response: 'did:cid:bagaa…r35p',
};
export const HASH = 'a91c…04be';

export const ISSUANCE_FRAMES = 540;

export const Issuance: React.FC = () => {
    const toAsset = useProgress(175, 225);
    const lock = useProgress(150, 180);
    const idLine = useEnter(345);
    return (
        <AbsoluteFill>
            <Backdrop tint={color.issuer} />
            <SceneLabel index={2} title="Issuance" />
            <div style={{ position: 'absolute', left: 110, top: 350 }}>
                <Actor role="issuer" size={170} />
            </div>
            <div style={{ position: 'absolute', left: 420, top: 240 }}>
                <Panel title="Verifiable credential" accent={color.issuer} width={700} delay={14}>
                    <CodeLine k="type" v="EmailCredential" delay={30} />
                    <CodeLine k="issuer" v={DID.alice} delay={42} highlight={color.issuer} />
                    <CodeLine k="subject" v={DID.carol} delay={54} highlight={color.holder} />
                    <CodeLine k="email" v="carol@example.com" delay={66} />
                    <div style={{ height: idLine * 40.8, overflow: 'hidden' }}>
                        <CodeLine k="id" v={DID.vc} delay={345} highlight={color.ledger} />
                    </div>
                    <FadeUp delay={90}>
                        <div
                            style={{
                                marginTop: 18, display: 'inline-flex', alignItems: 'center', gap: 12, padding: '10px 18px', borderRadius: 10,
                                border: `2px dashed ${color.issuer}`, color: color.issuer, fontFamily: font.sans, fontWeight: 700, fontSize: 24,
                            }}
                        >
                            ✎ proof · signed with Alice’s key
                        </div>
                    </FadeUp>
                </Panel>
            </div>
            <div style={{ position: 'absolute', left: 1174, top: 440, opacity: lock, transform: `scale(${0.6 + lock * 0.4})` }}>
                <LockIcon size={72} stroke={color.holder} open={1 - lock} />
            </div>
            <Arrow from={[1130, 530]} to={[1290, 530]} progress={toAsset} stroke={color.muted} />
            <div style={{ position: 'absolute', left: 1300, top: 400, display: 'flex', flexDirection: 'column', gap: 22, alignItems: 'flex-start' }}>
                <FadeUp delay={215}>
                    <div style={{ fontFamily: font.sans, fontWeight: 700, fontSize: 26, color: color.text }}>Credential asset</div>
                </FadeUp>
                <DidChip label="VC" did={DID.vc} accent={color.issuer} delay={222} />
                <HashChip value={HASH} accent={color.ledger} delay={250} />
                <FadeUp delay={265}>
                    <div style={{ fontFamily: font.sans, fontSize: 24, color: color.muted, lineHeight: 1.5 }}>
                        encrypted to <Name role="holder" /><br />
                        hash of the exact plaintext
                    </div>
                </FadeUp>
            </div>
            <Caption
                lines={[
                    { from: 20, to: 165, text: <><Name role="issuer" /> writes a credential about <Name role="holder" /> and signs it with her own key.</> },
                    { from: 165, to: 335, text: 'It’s encrypted to Carol and stored as an asset DID, with a hash of the exact plaintext beside it.' },
                    { from: 335, to: ISSUANCE_FRAMES, text: 'Then Alice signs the asset’s own DID into the credential, so it names the one place it lives.' },
                ]}
            />
        </AbsoluteFill>
    );
};

export const CHALLENGE_FRAMES = 300;

export const ChallengeScene: React.FC = () => {
    const send = useProgress(150, 200);
    return (
        <AbsoluteFill>
            <Backdrop tint={color.verifier} />
            <SceneLabel index={3} title="Challenge" />
            <div style={{ position: 'absolute', left: 150, top: 350 }}>
                <Actor role="verifier" size={170} />
            </div>
            <div style={{ position: 'absolute', left: 480, top: 280 }}>
                <Panel title="Challenge" accent={color.verifier} width={640} delay={12}>
                    <FadeUp delay={26}>
                        <div style={{ fontFamily: font.sans, fontSize: 28, color: color.muted, marginBottom: 14 }}>Show me:</div>
                    </FadeUp>
                    <CodeLine k="schema" v="EmailCredential" delay={40} highlight={color.verifier} />
                    <CodeLine k="issuers" v={<>[<span style={{ color: color.issuer }}>Alice</span>]</>} delay={54} />
                    <div style={{ marginTop: 22 }}>
                        <DidChip label="Challenge" did={DID.challenge} accent={color.verifier} delay={90} />
                    </div>
                </Panel>
            </div>
            <Arrow from={[1150, 530]} to={[1480, 530]} progress={send} stroke={color.verifier} label="published" dashed />
            <div style={{ position: 'absolute', left: 1540, top: 350 }}>
                <Actor role="holder" size={170} delay={140} />
            </div>
            <Caption
                lines={[
                    { from: 15, to: 150, text: <><Name role="verifier" /> wants proof. He publishes a challenge: an email credential, issued by <Name role="issuer" />.</> },
                    { from: 150, to: CHALLENGE_FRAMES, text: 'Anyone can read a challenge. Carol decides whether to answer it.' },
                ]}
            />
        </AbsoluteFill>
    );
};

export const RESPONSE_FRAMES = 480;

export const ResponseScene: React.FC = () => {
    const frame = useCurrentFrame();
    const copy = useProgress(60, 110);
    const glow = interpolate(frame, [170, 200, 260, 300], [0, 1, 1, 0.3], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    const send = useProgress(400, 450);
    return (
        <AbsoluteFill>
            <Backdrop tint={color.holder} />
            <SceneLabel index={4} title="Response" />
            <div style={{ position: 'absolute', left: 110, top: 190 }}>
                <Actor role="holder" size={150} />
            </div>
            <div style={{ position: 'absolute', left: 380, top: 200, display: 'flex', flexDirection: 'column', gap: 16 }}>
                <DidChip label="VC" did={DID.vc} accent={color.issuer} delay={12} />
                <HashChip value={HASH} accent={color.ledger} delay={24} glow={glow} />
            </div>
            <Arrow from={[640, 330]} to={[640, 430]} progress={copy} stroke={color.holder} />
            <div style={{ position: 'absolute', left: 664, top: 345, width: 300, opacity: copy, fontFamily: font.sans, fontSize: 22, lineHeight: 1.35, color: color.holder, fontWeight: 600 }}>
                same plaintext, re-encrypted to Victor
            </div>
            <div style={{ position: 'absolute', left: 380, top: 450, display: 'flex', flexDirection: 'column', gap: 16 }}>
                <DidChip label="VP" did={DID.vp} accent={color.holder} delay={100} />
                <HashChip value={HASH} accent={color.ledger} delay={112} glow={glow} />
            </div>
            <FadeUp delay={185} style={{ position: 'absolute', left: 380, top: 640 }}>
                <div style={{ fontFamily: font.sans, fontSize: 28, fontWeight: 700, color: color.ledger }}>= same hash → same content</div>
            </FadeUp>
            <div style={{ position: 'absolute', left: 1080, top: 200 }}>
                <Panel title="Response · encrypted to Victor" accent={color.holder} width={620} delay={300}>
                    <CodeLine k="challenge" v={DID.challenge} delay={315} />
                    <CodeLine k="vc" v={DID.vc} delay={330} highlight={color.issuer} />
                    <CodeLine k="vp" v={DID.vp} delay={342} highlight={color.holder} />
                    <div style={{ marginTop: 18 }}>
                        <DidChip label="Response" did={DID.response} accent={color.holder} delay={360} />
                    </div>
                </Panel>
            </div>
            <Arrow from={[1390, 620]} to={[1390, 720]} progress={send} stroke={color.verifier} />
            <div style={{ position: 'absolute', left: 1430, top: 650, transform: 'scale(0.55)', transformOrigin: 'left top' }}>
                <Actor role="verifier" size={150} delay={400} />
            </div>
            <Caption
                lines={[
                    { from: 10, to: 165, text: <><Name role="holder" /> finds a matching credential and re-encrypts its exact plaintext for Victor: a presentation.</> },
                    { from: 165, to: 300, text: 'Same bytes, same hash. That hash is what ties the presentation to the credential.' },
                    { from: 300, to: RESPONSE_FRAMES, text: 'Her response pairs each credential DID with its presentation DID, encrypted so only Victor can read it.' },
                ]}
            />
        </AbsoluteFill>
    );
};
