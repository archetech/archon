import React from 'react';
import {
  AbsoluteFill,
  Sequence,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

type StepProps = {
  title: string;
  body: string;
  accent: string;
  delay: number;
};

type Node = {
  label: string;
  x: number;
  y: number;
  width?: number;
  tone: 'sender' | 'service' | 'external' | 'network';
};

type Edge = {
  from: string;
  to: string;
  label: string;
  progress: number;
};

const palette = {
  bg: '#08141f',
  bgGlow: '#10253a',
  card: 'rgba(9, 21, 35, 0.84)',
  cardBorder: 'rgba(151, 195, 255, 0.2)',
  text: '#eff6ff',
  muted: '#9bb1c8',
  sender: '#f59e0b',
  service: '#38bdf8',
  external: '#34d399',
  network: '#f472b6',
  line: 'rgba(155, 177, 200, 0.28)',
};

const phaseSteps: StepProps[] = [
  {
    title: '1. Resolve recipient',
    body: 'Keymaster decides whether the target is a Lightning Address or needs DID / alias lookup via Gatekeeper.',
    accent: palette.sender,
    delay: 0,
  },
  {
    title: '2. Fetch invoice',
    body: 'Drawbridge calls the recipient service, either through LNURL pay metadata or a DID #lightning endpoint.',
    accent: palette.service,
    delay: 8,
  },
  {
    title: '3. Pay invoice',
    body: 'LNbits receives the BOLT11 invoice and routes the payment across the Lightning Network to settle the zap.',
    accent: palette.network,
    delay: 16,
  },
];

const graphNodes: Node[] = [
  {label: 'User', x: 120, y: 160, width: 132, tone: 'sender'},
  {label: 'CLI', x: 280, y: 160, width: 132, tone: 'sender'},
  {label: 'Keymaster', x: 470, y: 160, width: 164, tone: 'sender'},
  {label: 'Drawbridge', x: 700, y: 160, width: 172, tone: 'service'},
  {label: 'Recipient Service', x: 950, y: 160, width: 214, tone: 'external'},
  {label: 'Gatekeeper', x: 470, y: 360, width: 170, tone: 'service'},
  {label: 'Sender LNbits', x: 700, y: 360, width: 188, tone: 'service'},
  {label: 'Recipient Node', x: 950, y: 360, width: 192, tone: 'external'},
  {label: 'Lightning Network', x: 950, y: 510, width: 224, tone: 'network'},
];

const lookupBranchEdges: Edge[] = [
  {from: 'User', to: 'CLI', label: 'lightning-zap', progress: 0.18},
  {from: 'CLI', to: 'Keymaster', label: 'zapLightning()', progress: 0.32},
  {from: 'Keymaster', to: 'Gatekeeper', label: 'lookup DID', progress: 0.52},
  {from: 'Keymaster', to: 'Drawbridge', label: 'zap request', progress: 0.78},
];

const lud16Edges: Edge[] = [
  {from: 'Drawbridge', to: 'Recipient Service', label: '.well-known', progress: 0.18},
  {from: 'Recipient Service', to: 'Drawbridge', label: 'callback + limits', progress: 0.36},
  {from: 'Drawbridge', to: 'Recipient Service', label: 'request invoice', progress: 0.56},
  {from: 'Recipient Service', to: 'Recipient Node', label: 'create invoice', progress: 0.74},
  {from: 'Recipient Node', to: 'Drawbridge', label: 'BOLT11', progress: 0.92},
];

const didEdges: Edge[] = [
  {from: 'Drawbridge', to: 'Gatekeeper', label: 'resolve DID', progress: 0.18},
  {from: 'Gatekeeper', to: 'Drawbridge', label: '#lightning endpoint', progress: 0.34},
  {from: 'Drawbridge', to: 'Recipient Service', label: 'request invoice', progress: 0.58},
  {from: 'Recipient Service', to: 'Recipient Node', label: 'create invoice', progress: 0.76},
  {from: 'Recipient Node', to: 'Drawbridge', label: 'paymentRequest', progress: 0.92},
];

const paymentEdges: Edge[] = [
  {from: 'Drawbridge', to: 'Sender LNbits', label: 'pay invoice', progress: 0.18},
  {from: 'Sender LNbits', to: 'Lightning Network', label: 'route payment', progress: 0.42},
  {from: 'Lightning Network', to: 'Recipient Node', label: 'deliver sats', progress: 0.62},
  {from: 'Recipient Node', to: 'Lightning Network', label: 'settled preimage', progress: 0.78},
  {from: 'Lightning Network', to: 'Sender LNbits', label: 'confirmed', progress: 0.88},
  {from: 'Sender LNbits', to: 'Drawbridge', label: 'payment_hash', progress: 0.96},
];

const toneColor = (tone: Node['tone']) => {
  switch (tone) {
    case 'sender':
      return palette.sender;
    case 'service':
      return palette.service;
    case 'external':
      return palette.external;
    case 'network':
      return palette.network;
  }
};

const containerStyle: React.CSSProperties = {
  padding: 56,
  fontFamily: '"IBM Plex Sans", "Avenir Next", "Segoe UI", sans-serif',
  color: palette.text,
};

const cardStyle: React.CSSProperties = {
  background: palette.card,
  border: `1px solid ${palette.cardBorder}`,
  borderRadius: 28,
  boxShadow: '0 24px 80px rgba(0, 0, 0, 0.35)',
  backdropFilter: 'blur(12px)',
};

const backgroundStyle: React.CSSProperties = {
  backgroundColor: palette.bg,
  backgroundImage: [
    'radial-gradient(circle at 18% 20%, rgba(245, 158, 11, 0.16), transparent 28%)',
    'radial-gradient(circle at 78% 16%, rgba(56, 189, 248, 0.18), transparent 26%)',
    'radial-gradient(circle at 80% 78%, rgba(244, 114, 182, 0.16), transparent 32%)',
    'linear-gradient(135deg, #08141f 0%, #0b1b2a 48%, #08141f 100%)',
  ].join(','),
};

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(value, max));

const StepCard: React.FC<StepProps> = ({title, body, accent, delay}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const entrance = spring({
    frame: frame - delay,
    fps,
    config: {damping: 12, stiffness: 120},
  });

  return (
    <div
      style={{
        ...cardStyle,
        padding: '22px 24px 24px',
        opacity: entrance,
        transform: `translateY(${interpolate(entrance, [0, 1], [26, 0])}px)`,
      }}
    >
      <div
        style={{
          width: 56,
          height: 6,
          borderRadius: 999,
          backgroundColor: accent,
          marginBottom: 22,
        }}
      />
      <div style={{fontSize: 28, fontWeight: 700, marginBottom: 10}}>{title}</div>
      <div style={{fontSize: 20, lineHeight: 1.4, color: palette.muted}}>{body}</div>
    </div>
  );
};

const findNode = (label: string) => {
  const node = graphNodes.find((item) => item.label === label);
  if (!node) {
    throw new Error(`Unknown node ${label}`);
  }
  return node;
};

const AnimatedGraph: React.FC<{
  title: string;
  subtitle: string;
  edges: Edge[];
  branchLabel?: string;
  showLegend?: boolean;
}> = ({title, subtitle, edges, branchLabel, showLegend = true}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const t = clamp(frame / (fps * 24), 0, 1);
  const graphIntro = spring({
    frame,
    fps,
    config: {damping: 15, stiffness: 120},
  });

  return (
    <AbsoluteFill style={{...backgroundStyle, ...containerStyle}}>
      <div style={{display: 'flex', gap: 28, height: '100%'}}>
        <div
          style={{
            ...cardStyle,
            width: 390,
            padding: 30,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <div
              style={{
                fontSize: 18,
                textTransform: 'uppercase',
                letterSpacing: 2,
                color: palette.service,
                marginBottom: 16,
              }}
            >
              Lightning Zap Workflow
            </div>
            <div style={{fontSize: 52, lineHeight: 1.05, fontWeight: 700, marginBottom: 18}}>
              {title}
            </div>
            <div style={{fontSize: 23, lineHeight: 1.45, color: palette.muted}}>{subtitle}</div>
          </div>

          <div>
            {branchLabel ? (
              <div
                style={{
                  display: 'inline-flex',
                  padding: '12px 18px',
                  borderRadius: 999,
                  background: 'rgba(56, 189, 248, 0.12)',
                  border: `1px solid ${palette.cardBorder}`,
                  fontSize: 18,
                  color: palette.text,
                  marginBottom: 26,
                }}
              >
                {branchLabel}
              </div>
            ) : null}
            {showLegend ? (
              <div style={{display: 'grid', gap: 14}}>
                {[
                  ['Sender side', palette.sender],
                  ['Archon services', palette.service],
                  ['Recipient systems', palette.external],
                  ['Lightning settlement', palette.network],
                ].map(([label, color]) => (
                  <div key={label} style={{display: 'flex', alignItems: 'center', gap: 12}}>
                    <div
                      style={{
                        width: 14,
                        height: 14,
                        borderRadius: 999,
                        backgroundColor: color,
                      }}
                    />
                    <div style={{fontSize: 19, color: palette.muted}}>{label}</div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        <div
          style={{
            ...cardStyle,
            flex: 1,
            position: 'relative',
            padding: 28,
            overflow: 'hidden',
            opacity: graphIntro,
            transform: `scale(${interpolate(graphIntro, [0, 1], [0.97, 1])})`,
          }}
        >
          <svg width="100%" height="100%" viewBox="0 0 1180 620">
            {graphNodes.map((node) => (
              <g key={node.label} transform={`translate(${node.x}, ${node.y})`}>
                {(() => {
                  const nodeWidth = node.width ?? 156;
                  const labelOffset = -nodeWidth / 2 + 18;

                  return (
                    <>
                <rect
                  x={-nodeWidth / 2}
                  y={-34}
                  rx={24}
                  width={nodeWidth}
                  height={68}
                  fill="rgba(10, 23, 38, 0.92)"
                  stroke={toneColor(node.tone)}
                  strokeWidth={2}
                />
                <circle cx={labelOffset} cy={0} r={8} fill={toneColor(node.tone)} />
                <text
                  x={labelOffset + 18}
                  y={8}
                  fill={palette.text}
                  fontSize={20}
                  fontWeight={600}
                  fontFamily='"IBM Plex Sans", "Avenir Next", "Segoe UI", sans-serif'
                >
                  {node.label}
                </text>
                    </>
                  );
                })()}
              </g>
            ))}

            {edges.map((edge) => {
              const from = findNode(edge.from);
              const to = findNode(edge.to);
              const dx = to.x - from.x;
              const dy = to.y - from.y;
              const midX = from.x + dx / 2;
              const midY = from.y + dy / 2;
              const drawn = clamp((t - (edge.progress - 0.16)) / 0.22, 0, 1);
              const lineX = from.x + dx * drawn;
              const lineY = from.y + dy * drawn;
              const color = drawn >= 1 ? palette.text : toneColor(findNode(edge.to).tone);

              return (
                <g key={`${edge.from}-${edge.to}-${edge.label}`}>
                  <line
                    x1={from.x}
                    y1={from.y}
                    x2={to.x}
                    y2={to.y}
                    stroke={palette.line}
                    strokeWidth={3}
                    strokeDasharray="10 14"
                  />
                  <line
                    x1={from.x}
                    y1={from.y}
                    x2={lineX}
                    y2={lineY}
                    stroke={color}
                    strokeWidth={5}
                    strokeLinecap="round"
                  />
                  <circle cx={lineX} cy={lineY} r={drawn > 0 ? 7 : 0} fill={color} />
                  {(() => {
                    const labelWidth = Math.max(110, Math.min(168, edge.label.length * 8));

                    return (
                      <rect
                        x={midX - labelWidth / 2}
                        y={midY - 52}
                        rx={16}
                        width={labelWidth}
                        height={30}
                        fill="rgba(6, 12, 22, 0.92)"
                        opacity={drawn}
                      />
                    );
                  })()}
                  <text
                    x={midX}
                    y={midY - 32}
                    textAnchor="middle"
                    fill={palette.text}
                    fontSize={14}
                    fontFamily='"IBM Plex Sans", "Avenir Next", "Segoe UI", sans-serif'
                    opacity={drawn}
                  >
                    {edge.label}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      </div>
    </AbsoluteFill>
  );
};

const IntroScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const titleReveal = spring({
    frame,
    fps,
    config: {damping: 14, stiffness: 110},
  });

  return (
    <AbsoluteFill style={{...backgroundStyle, ...containerStyle}}>
      <div style={{display: 'grid', gridTemplateColumns: '1.05fr 0.95fr', gap: 28, height: '100%'}}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            opacity: titleReveal,
            transform: `translateY(${interpolate(titleReveal, [0, 1], [24, 0])}px)`,
          }}
        >
          <div
            style={{
              fontSize: 18,
              textTransform: 'uppercase',
              letterSpacing: 3,
              color: palette.sender,
              marginBottom: 18,
            }}
          >
            Archon + Lightning
          </div>
          <div style={{fontSize: 78, lineHeight: 0.92, fontWeight: 800, maxWidth: 620}}>
            How a lightning zap moves from alias to settled sats
          </div>
          <div
            style={{
              fontSize: 24,
              lineHeight: 1.45,
              color: palette.muted,
              marginTop: 22,
              maxWidth: 580,
            }}
          >
            A short visual walkthrough of recipient resolution, invoice generation, and payment
            settlement in the Archon lightning zap flow.
          </div>
        </div>

        <div
          style={{
            ...cardStyle,
            padding: 24,
            display: 'grid',
            gap: 14,
            alignContent: 'center',
          }}
        >
          {phaseSteps.map((step) => (
            <StepCard key={step.title} {...step} />
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
};

const DecisionScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const pulse = 0.86 + spring({frame: frame - 28, fps, config: {damping: 10, stiffness: 90}}) * 0.14;

  return (
    <AbsoluteFill style={{...backgroundStyle, ...containerStyle}}>
      <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 28, height: '100%'}}>
        <div
          style={{
            ...cardStyle,
            padding: 40,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
          }}
        >
          <div style={{fontSize: 54, lineHeight: 1.05, fontWeight: 700, marginBottom: 18}}>
            The branch point
          </div>
          <div style={{fontSize: 26, lineHeight: 1.5, color: palette.muted, marginBottom: 30}}>
            Keymaster first classifies the recipient string. That decision determines how Drawbridge
            fetches the invoice.
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 22,
            }}
          >
            {[
              {title: 'Contains @', body: 'Treat as LUD-16 address', color: palette.external},
              {title: 'Otherwise', body: 'Resolve alias / DID via Gatekeeper', color: palette.service},
            ].map((item) => (
              <div
                key={item.title}
                style={{
                  flex: 1,
                  borderRadius: 24,
                  padding: 26,
                  border: `1px solid ${palette.cardBorder}`,
                  background: 'rgba(12, 28, 44, 0.78)',
                }}
              >
                <div
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 999,
                    backgroundColor: item.color,
                    marginBottom: 18,
                  }}
                />
                <div style={{fontSize: 28, fontWeight: 700, marginBottom: 8}}>{item.title}</div>
                <div style={{fontSize: 22, color: palette.muted, lineHeight: 1.45}}>{item.body}</div>
              </div>
            ))}
          </div>
        </div>

        <div
          style={{
            ...cardStyle,
            padding: 40,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            style={{
              width: 600,
              height: 600,
              borderRadius: 320,
              border: `1px solid ${palette.cardBorder}`,
              background:
                'radial-gradient(circle, rgba(16, 37, 58, 0.92) 0%, rgba(8, 20, 31, 0.66) 62%, transparent 100%)',
              display: 'grid',
              placeItems: 'center',
              transform: `scale(${pulse})`,
            }}
          >
            <div style={{textAlign: 'center', maxWidth: 420}}>
              <div style={{fontSize: 30, color: palette.muted, marginBottom: 12}}>
                Recipient input
              </div>
              <div style={{fontSize: 68, fontWeight: 800, marginBottom: 20}}>user@domain</div>
              <div style={{fontSize: 30, color: palette.muted, marginBottom: 10}}>or</div>
              <div style={{fontSize: 56, fontWeight: 700}}>did:example:alice</div>
            </div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const LightningZapVideo: React.FC = () => {
  return (
    <AbsoluteFill>
      <Sequence durationInFrames={300}>
        <IntroScene />
      </Sequence>

      <Sequence from={300} durationInFrames={240}>
        <AnimatedGraph
          title="Resolve the recipient"
          subtitle="The CLI hands the request to Keymaster. If the recipient is not already a Lightning Address, Gatekeeper resolves the alias or DID before Drawbridge is called."
          edges={lookupBranchEdges}
          branchLabel="Phase 1"
        />
      </Sequence>

      <Sequence from={540} durationInFrames={240}>
        <DecisionScene />
      </Sequence>

      <Sequence from={780} durationInFrames={360}>
        <AnimatedGraph
          title="LUD-16 invoice path"
          subtitle="Drawbridge performs LNURL discovery, validates the callback, converts sats to millisats, and requests a BOLT11 invoice from the recipient service."
          edges={lud16Edges}
          branchLabel="Phase 2A: Lightning Address"
        />
      </Sequence>

      <Sequence from={1140} durationInFrames={360}>
        <AnimatedGraph
          title="DID-based invoice path"
          subtitle="For DID recipients, Drawbridge resolves the DID document, validates the #lightning endpoint, and asks that service to create the invoice."
          edges={didEdges}
          branchLabel="Phase 2B: DID / alias"
        />
      </Sequence>

      <Sequence from={1500} durationInFrames={300}>
        <AnimatedGraph
          title="Settle the zap"
          subtitle="Once Drawbridge has the BOLT11 invoice, LNbits routes the payment across the Lightning Network and returns the payment hash when settlement succeeds."
          edges={paymentEdges}
          branchLabel="Phase 3"
        />
      </Sequence>
    </AbsoluteFill>
  );
};
