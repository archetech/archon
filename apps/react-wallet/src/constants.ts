import { Capacitor } from '@capacitor/core';

const platform = Capacitor.getPlatform();
const isAndroid = platform === 'android';
const HOST = isAndroid ? '10.0.2.2' : 'localhost';

const ENV_GATEKEEPER = (import.meta.env.VITE_GATEKEEPER_URL as string) || '';

export const DEFAULT_GATEKEEPER_URL = ENV_GATEKEEPER || `http://${HOST}:4224`;
export const GATEKEEPER_KEY = 'gatekeeperUrl';

const ENV_FILECOIN_WALLET = (import.meta.env.VITE_FILECOIN_WALLET_URL as string) || '';
export const DEFAULT_FILECOIN_WALLET_URL = ENV_FILECOIN_WALLET || `http://${HOST}:4242`;
export const FILECOIN_WALLET_KEY = 'filecoinWalletUrl';
