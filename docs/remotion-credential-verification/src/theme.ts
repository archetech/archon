import { loadFont as loadInter } from '@remotion/google-fonts/Inter';
import { loadFont as loadMono } from '@remotion/google-fonts/JetBrainsMono';

const inter = loadInter('normal', { weights: ['400', '500', '600', '700', '800'], subsets: ['latin'] });
const mono = loadMono('normal', { weights: ['400', '500', '700'], subsets: ['latin'] });

export const FPS = 30;

export const font = {
    sans: inter.fontFamily,
    mono: mono.fontFamily,
};

export const color = {
    background: '#0A0F1E',
    backgroundLift: '#111830',
    panel: '#141C36',
    panelEdge: '#26325A',
    grid: 'rgba(120, 140, 200, 0.06)',
    text: '#E8ECF6',
    muted: '#8D98B3',
    faint: '#56607A',
    issuer: '#F5B544',
    holder: '#3DD6C4',
    verifier: '#A594FF',
    ledger: '#6F93D6',
    good: '#4ADE80',
    bad: '#F87171',
};

export type Role = 'issuer' | 'holder' | 'verifier';

export const cast: Record<Role, { name: string, role: string, color: string }> = {
    issuer: { name: 'Alice', role: 'Issuer', color: color.issuer },
    holder: { name: 'Carol', role: 'Holder', color: color.holder },
    verifier: { name: 'Victor', role: 'Verifier', color: color.verifier },
};
