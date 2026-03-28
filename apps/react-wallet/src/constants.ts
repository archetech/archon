import { Capacitor } from '@capacitor/core';

const platform = Capacitor.getPlatform();
const isAndroid = platform === 'android';
const browserHost = typeof window !== 'undefined' ? window.location.hostname : '';
const HOST = isAndroid ? '10.0.2.2' : (browserHost || 'localhost');

const ENV_GATEKEEPER = (import.meta.env.VITE_GATEKEEPER_URL as string) || '';
const isHostedDefault = ENV_GATEKEEPER === 'https://archon.technology';

export const DEFAULT_GATEKEEPER_URL =
    ENV_GATEKEEPER && !isHostedDefault ? ENV_GATEKEEPER : `http://${HOST}:4224`;
export const GATEKEEPER_KEY = 'gatekeeperUrl';
