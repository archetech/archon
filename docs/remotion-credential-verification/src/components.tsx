import React from 'react';
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { cast, color, font, Role } from './theme';

// Eased 0 -> 1 from `delay` frames into the current sequence.
export function useEnter(delay = 0, damping = 18): number {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    return spring({ frame: frame - delay, fps, config: { damping, mass: 0.7 } });
}

// Linear-eased 0 -> 1 across [start, end] frames.
export function useProgress(start: number, end: number): number {
    const frame = useCurrentFrame();
    return interpolate(frame, [start, end], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
        easing: Easing.inOut(Easing.cubic),
    });
}

export const Backdrop: React.FC<{ tint?: string }> = ({ tint = color.ledger }) => (
    <AbsoluteFill style={{ background: color.background }}>
        <AbsoluteFill
            style={{
                backgroundImage: `linear-gradient(${color.grid} 1px, transparent 1px), linear-gradient(90deg, ${color.grid} 1px, transparent 1px)`,
                backgroundSize: '64px 64px',
            }}
        />
        <AbsoluteFill style={{ background: `radial-gradient(circle at 50% 38%, ${tint}22 0%, transparent 55%)` }} />
        <AbsoluteFill style={{ background: 'radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.55) 100%)' }} />
    </AbsoluteFill>
);

export const FadeUp: React.FC<{ delay?: number, distance?: number, style?: React.CSSProperties, children: React.ReactNode }> = ({
    delay = 0, distance = 24, style, children,
}) => {
    const enter = useEnter(delay);
    return (
        <div style={{ opacity: enter, transform: `translateY(${(1 - enter) * distance}px)`, ...style }}>
            {children}
        </div>
    );
};

export const SceneLabel: React.FC<{ index: number, title: string }> = ({ index, title }) => {
    const enter = useEnter(4);
    return (
        <div
            style={{
                position: 'absolute', top: 56, left: 72, display: 'flex', alignItems: 'center', gap: 18,
                opacity: enter, transform: `translateX(${(1 - enter) * -20}px)`,
            }}
        >
            <span style={{ fontFamily: font.mono, fontSize: 24, color: color.ledger, letterSpacing: 2 }}>
                {String(index).padStart(2, '0')}
            </span>
            <span style={{ width: 40, height: 2, background: color.panelEdge }} />
            <span style={{ fontFamily: font.sans, fontSize: 26, fontWeight: 600, color: color.muted, letterSpacing: 1 }}>
                {title}
            </span>
        </div>
    );
};

// Narration, since the video has no voice: one line at a time along the bottom.
export const Caption: React.FC<{ lines: { from: number, to: number, text: React.ReactNode }[] }> = ({ lines }) => {
    const frame = useCurrentFrame();
    const line = lines.find(item => frame >= item.from && frame < item.to);
    if (!line) {
        return null;
    }
    const opacity = interpolate(frame, [line.from, line.from + 10, line.to - 10, line.to], [0, 1, 1, 0], {
        extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
    });
    return (
        <div
            style={{
                position: 'absolute', bottom: 64, left: 0, right: 0, display: 'flex', justifyContent: 'center',
                opacity, transform: `translateY(${(1 - opacity) * 8}px)`,
            }}
        >
            <div
                style={{
                    maxWidth: 1560, padding: '18px 34px', borderRadius: 14, background: 'rgba(10, 15, 30, 0.82)',
                    border: `1px solid ${color.panelEdge}`, fontFamily: font.sans, fontSize: 34, lineHeight: 1.35,
                    color: color.text, textAlign: 'center', fontWeight: 500,
                    // Even line lengths rather than a lone word on the last line.
                    textWrap: 'balance',
                } as React.CSSProperties}
            >
                {line.text}
            </div>
        </div>
    );
};

export const Actor: React.FC<{ role: Role, size?: number, delay?: number, dim?: boolean, caption?: string }> = ({
    role, size = 150, delay = 0, dim = false, caption,
}) => {
    const person = cast[role];
    const enter = useEnter(delay);
    return (
        <div
            style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14,
                opacity: enter * (dim ? 0.35 : 1), transform: `scale(${0.8 + enter * 0.2})`,
            }}
        >
            <div
                style={{
                    width: size, height: size, borderRadius: '50%', display: 'flex', alignItems: 'center',
                    justifyContent: 'center', background: `radial-gradient(circle at 35% 30%, ${person.color}55, ${person.color}18)`,
                    border: `3px solid ${person.color}`, boxShadow: `0 0 ${size / 3}px ${person.color}44`,
                    fontFamily: font.sans, fontWeight: 800, fontSize: size * 0.42, color: person.color,
                }}
            >
                {person.name[0]}
            </div>
            <div style={{ fontFamily: font.sans, fontWeight: 700, fontSize: size * 0.2, color: color.text }}>{person.name}</div>
            <div style={{ fontFamily: font.sans, fontWeight: 500, fontSize: size * 0.14, color: person.color, letterSpacing: 2, textTransform: 'uppercase' }}>
                {caption ?? person.role}
            </div>
        </div>
    );
};

export const Panel: React.FC<{
    title: string, accent: string, width: number, delay?: number, style?: React.CSSProperties, children: React.ReactNode,
}> = ({ title, accent, width, delay = 0, style, children }) => {
    const enter = useEnter(delay);
    return (
        <div
            style={{
                width, borderRadius: 18, background: color.panel, border: `1px solid ${color.panelEdge}`,
                boxShadow: '0 30px 60px rgba(0,0,0,0.35)', overflow: 'hidden',
                opacity: enter, transform: `translateY(${(1 - enter) * 30}px)`, ...style,
            }}
        >
            <div
                style={{
                    padding: '16px 24px', borderBottom: `1px solid ${color.panelEdge}`, display: 'flex', alignItems: 'center', gap: 12,
                    fontFamily: font.sans, fontWeight: 700, fontSize: 24, color: color.text,
                }}
            >
                <span style={{ width: 12, height: 12, borderRadius: 3, background: accent }} />
                {title}
            </div>
            <div style={{ padding: '20px 24px' }}>{children}</div>
        </div>
    );
};

// One JSON-ish line of a document, revealed at `delay`.
export const CodeLine: React.FC<{ k: string, v: React.ReactNode, delay?: number, highlight?: string }> = ({ k, v, delay = 0, highlight }) => {
    const enter = useEnter(delay, 22);
    return (
        <div
            style={{
                fontFamily: font.mono, fontSize: 24, lineHeight: 1.7, color: color.muted, opacity: enter,
                transform: `translateX(${(1 - enter) * 16}px)`, borderRadius: 6, padding: '0 8px', margin: '0 -8px',
                background: highlight ? `${highlight}1f` : 'transparent',
            }}
        >
            <span style={{ color: color.faint }}>{k}: </span>
            <span style={{ color: highlight ?? color.text }}>{v}</span>
        </div>
    );
};

export const DidChip: React.FC<{ label: string, did: string, accent: string, delay?: number, glow?: number, strike?: number }> = ({
    label, did, accent, delay = 0, glow = 0, strike = 0,
}) => {
    const enter = useEnter(delay);
    return (
        <div
            style={{
                position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 14, padding: '12px 20px',
                borderRadius: 999, background: `${accent}14`, border: `2px solid ${accent}`,
                boxShadow: `0 0 ${12 + glow * 30}px ${accent}${glow > 0 ? '88' : '33'}`,
                opacity: enter, transform: `scale(${0.85 + enter * 0.15})`,
            }}
        >
            <span style={{ fontFamily: font.sans, fontWeight: 700, fontSize: 22, color: accent, letterSpacing: 1, textTransform: 'uppercase' }}>{label}</span>
            <span style={{ fontFamily: font.mono, fontSize: 22, color: color.text }}>{did}</span>
            {strike > 0 && (
                <span
                    style={{
                        position: 'absolute', left: 12, top: '50%', height: 4, borderRadius: 2, background: color.bad,
                        width: `calc(${strike * 100}% - 24px)`,
                    }}
                />
            )}
        </div>
    );
};

export const HashChip: React.FC<{ value: string, accent: string, delay?: number, glow?: number }> = ({ value, accent, delay = 0, glow = 0 }) => {
    const enter = useEnter(delay);
    return (
        <div
            style={{
                display: 'inline-flex', alignItems: 'center', gap: 12, padding: '8px 16px', borderRadius: 10,
                border: `1px solid ${accent}88`, background: `${accent}${glow > 0 ? '30' : '12'}`,
                boxShadow: glow > 0 ? `0 0 ${glow * 28}px ${accent}` : 'none', opacity: enter,
            }}
        >
            <span style={{ fontFamily: font.sans, fontSize: 18, fontWeight: 700, color: accent, letterSpacing: 1 }}>SHA-256</span>
            <span style={{ fontFamily: font.mono, fontSize: 22, color: color.text }}>{value}</span>
        </div>
    );
};

// A straight arrow drawn from one point to another as `progress` goes 0 -> 1.
export const Arrow: React.FC<{
    from: [number, number], to: [number, number], progress: number, stroke: string, label?: string, dashed?: boolean,
}> = ({ from, to, progress, stroke, label, dashed = false }) => {
    const [x1, y1] = from;
    const [x2, y2] = to;
    const length = Math.hypot(x2 - x1, y2 - y1);
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const head = 16;
    const tipX = x1 + (x2 - x1) * progress;
    const tipY = y1 + (y2 - y1) * progress;
    return (
        <svg style={{ position: 'absolute', inset: 0, overflow: 'visible' }} width={1920} height={1080}>
            <line
                x1={x1} y1={y1} x2={tipX} y2={tipY} stroke={stroke} strokeWidth={4} strokeLinecap="round"
                strokeDasharray={dashed ? '10 12' : undefined} opacity={progress > 0 ? 1 : 0}
            />
            {progress > 0.98 && (
                <polygon
                    points={`${x2},${y2} ${x2 - head * Math.cos(angle - 0.45)},${y2 - head * Math.sin(angle - 0.45)} ${x2 - head * Math.cos(angle + 0.45)},${y2 - head * Math.sin(angle + 0.45)}`}
                    fill={stroke}
                />
            )}
            {label && length > 0 && (
                <text
                    x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 18} fill={stroke} fontFamily={font.sans} fontSize={22} fontWeight={600}
                    textAnchor="middle" opacity={Math.max(0, progress * 2 - 1)}
                >
                    {label}
                </text>
            )}
        </svg>
    );
};

export const Verdict: React.FC<{ ok: boolean, delay?: number, size?: number, text?: string }> = ({ ok, delay = 0, size = 64, text }) => {
    const enter = useEnter(delay, 12);
    const tone = ok ? color.good : color.bad;
    return (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 16, opacity: Math.min(1, enter * 1.5), transform: `scale(${enter})` }}>
            <div
                style={{
                    width: size, height: size, borderRadius: '50%', background: `${tone}22`, border: `3px solid ${tone}`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
            >
                <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" fill="none" stroke={tone} strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round">
                    {ok ? <polyline points="4,12.5 10,18 20,6" /> : <><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></>}
                </svg>
            </div>
            {text && <span style={{ fontFamily: font.sans, fontWeight: 700, fontSize: size * 0.45, color: tone }}>{text}</span>}
        </div>
    );
};

export const LockIcon: React.FC<{ size?: number, stroke?: string, open?: number }> = ({ size = 48, stroke = color.text, open = 0 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="11" width="16" height="10" rx="2" />
        <path d={`M8 11 V7 a4 4 0 0 1 8 0 V${11 - open * 3}`} />
    </svg>
);

// Headline text used for scene titles inside the frame.
export const Headline: React.FC<{ children: React.ReactNode, delay?: number, size?: number }> = ({ children, delay = 0, size = 64 }) => (
    <FadeUp delay={delay}>
        <div style={{ fontFamily: font.sans, fontWeight: 800, fontSize: size, color: color.text, letterSpacing: -1, lineHeight: 1.1 }}>
            {children}
        </div>
    </FadeUp>
);
