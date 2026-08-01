// Environment-derived configuration, shared by index.ts and routes.ts.
// Extracted from index.ts so the route module can be imported without pulling in
// the server bootstrap (app creation, session setup, listen).
import dotenv from 'dotenv';

dotenv.config();

export const HOST_PORT = Number(process.env.ARCHON_HERALD_PORT) || 4230;
export const DRAWBRIDGE_PORT = Number(process.env.ARCHON_DRAWBRIDGE_PORT) || 4222;
export const DRAWBRIDGE_PUBLIC_HOST = process.env.ARCHON_DRAWBRIDGE_PUBLIC_HOST || `http://localhost:${DRAWBRIDGE_PORT}`;
export const GATEKEEPER_URL = process.env.ARCHON_GATEKEEPER_URL || 'http://localhost:4224';
export const WALLET_URL = process.env.ARCHON_HERALD_WALLET_URL || 'https://wallet.archon.technology';
export const HERALD_DATABASE_TYPE = process.env.ARCHON_HERALD_DB || 'json';
export const DATA_DIR = process.env.ARCHON_HERALD_DATA_DIR || '/app/server/data';
export const IPFS_API_URL = process.env.ARCHON_HERALD_IPFS_API_URL || 'http://localhost:5001/api/v0';
export const SERVICE_NAME = process.env.ARCHON_HERALD_NAME || 'name-service';
export const PUBLIC_URL = `${DRAWBRIDGE_PUBLIC_HOST.replace(/\/$/, '')}/names`;
export const SERVICE_DOMAIN = process.env.ARCHON_HERALD_DOMAIN || '';
export const SESSION_SECRET = process.env.ARCHON_HERALD_SESSION_SECRET;
export const IPNS_KEY_NAME = process.env.ARCHON_HERALD_IPNS_KEY_NAME || SERVICE_NAME;
export const DEFAULT_MEMBERSHIP_SCHEMA_DID = 'did:cid:bagaaieravnv5onsflewvrz6urhwfjixfnwq7bgc3ejhlrj2nekx75ddhdupq';
export const MEMBERSHIP_SCHEMA_DID = process.env.ARCHON_HERALD_MEMBERSHIP_SCHEMA_DID || DEFAULT_MEMBERSHIP_SCHEMA_DID;
export const TOR_PROXY = process.env.ARCHON_HERALD_TOR_PROXY || '';
export const ADMIN_API_KEY = process.env.ARCHON_ADMIN_API_KEY || process.env.ARCHON_HERALD_ADMIN_API_KEY || '';
export const SENDGRID_API_KEY = process.env.ARCHON_HERALD_SENDGRID_API_KEY || '';
export const SENDGRID_FROM_EMAIL = process.env.ARCHON_HERALD_SENDGRID_FROM_EMAIL || `dmail@${SERVICE_DOMAIN}`;
export const SENDGRID_PARSE_DOMAIN = process.env.ARCHON_HERALD_SENDGRID_PARSE_DOMAIN || `parse.${SERVICE_DOMAIN}`;
export const OWNER_DID = process.env.ARCHON_HERALD_OWNER_DID || '';
export const WEBHOOK_SECRET = process.env.ARCHON_HERALD_WEBHOOK_SECRET || '';
