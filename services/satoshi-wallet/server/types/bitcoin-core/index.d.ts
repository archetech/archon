export interface BtcClientOptions {
    username?: string;
    password?: string;
    host?: string;
    wallet?: string;
}

export interface ScriptPubKey {
    asm: string;
    hex: string;
    reqSigs?: number;
    type: string;
    addresses?: string[];
    desc?: string;
}

export interface Vout {
    value: number;
    n: number;
    scriptPubKey: ScriptPubKey;
}

export interface WalletInfo {
    walletname: string;
    walletversion: number;
    balance: number;
    unconfirmed_balance: number;
    immature_balance: number;
    txcount: number;
    keypoolsize: number;
    paytxfee: number;
    private_keys_enabled: boolean;
    descriptors: boolean;
}

export interface EstimateSmartFeeResult {
    feerate?: number;
    blocks: number;
    errors?: string[];
}

export interface AddressInfo {
    address: string;
    scriptPubKey: string;
    ismine: boolean;
    iswatchonly: boolean;
    solvable: boolean;
    ischange: boolean;
    labels: string[];
    desc?: string;
    isscript?: boolean;
    iswitness?: boolean;
    witness_version?: number;
    witness_program?: string;
    pubkey?: string;
    hdkeypath?: string;
    hdmasterfingerprint?: string;
    parent_descs?: string[];
}

export interface UnspentOutput {
    txid: string;
    vout: number;
    address?: string;
    label?: string;
    scriptPubKey: string;
    amount: number;
    confirmations: number;
    spendable: boolean;
    solvable: boolean;
    desc?: string;
    safe: boolean;
}

export interface ImportDescriptorRequest {
    desc: string;
    timestamp: number | 'now';
    active?: boolean;
    range?: number | [number, number];
    next_index?: number;
    internal?: boolean;
    label?: string;
}

export interface ImportDescriptorResult {
    success: boolean;
    warnings?: string[];
    error?: {
        code: number;
        message: string;
    };
}

export interface DescriptorInfoResult {
    descriptor: string;
    checksum: string;
    isrange: boolean;
    issolvable: boolean;
    hasprivatekeys: boolean;
}

export interface Descriptor {
    desc: string;
    timestamp: number;
    active: boolean;
    internal?: boolean;
    range?: [number, number];
    next?: number;
}

export interface ListDescriptorsResult {
    wallet_name: string;
    descriptors: Descriptor[];
}

export interface PsbtInput {
    txid: string;
    vout: number;
    sequence?: number;
}

export type PsbtOutput = Record<string, number | string>;

export interface WalletCreateFundedPsbtOptions {
    changeAddress?: string;
    changePosition?: number;
    change_type?: 'legacy' | 'p2sh-segwit' | 'bech32' | 'bech32m';
    includeWatching?: boolean;
    lockUnspents?: boolean;
    fee_rate?: number | string;
    feeRate?: number | string;
    subtractFeeFromOutputs?: number[];
    replaceable?: boolean;
    conf_target?: number;
    estimate_mode?: 'UNSET' | 'ECONOMICAL' | 'CONSERVATIVE';
    add_inputs?: boolean;
}

export interface WalletCreateFundedPsbtResult {
    psbt: string;
    fee: number;
    changepos: number;
}

export interface ListTransactionsEntry {
    address?: string;
    category: 'send' | 'receive' | 'generate' | 'immature' | 'orphan';
    amount: number;
    label?: string;
    vout?: number;
    fee?: number;
    confirmations: number;
    blockhash?: string;
    blockheight?: number;
    blockindex?: number;
    blocktime?: number;
    txid: string;
    time: number;
    timereceived: number;
    abandoned?: boolean;
    parent_descs?: string[];
}

export interface CreateWalletResult {
    name: string;
    warning: string;
}

export default class BtcClient {
    constructor(options: BtcClientOptions);
    command(method: string, ...args: any[]): Promise<any>;
    getWalletInfo(): Promise<WalletInfo>;
    getNewAddress(label?: string, addressType?: string): Promise<string>;
    listUnspent(
        minconf?: number,
        maxconf?: number,
        addresses?: string[],
        include_unsafe?: boolean,
    ): Promise<UnspentOutput[]>;
    getAddressInfo(address: string): Promise<AddressInfo>;
    estimateSmartFee(
        confTarget: number,
        estimateMode?: string,
    ): Promise<EstimateSmartFeeResult>;
    getDescriptorInfo(descriptor: string): Promise<DescriptorInfoResult>;
    importDescriptors(requests: ImportDescriptorRequest[]): Promise<ImportDescriptorResult[]>;
    listDescriptors(isPrivate: boolean): Promise<ListDescriptorsResult>;
    walletCreateFundedPsbt(
        inputs: PsbtInput[],
        outputs: PsbtOutput[],
        locktime?: number,
        options?: WalletCreateFundedPsbtOptions,
        bip32derivs?: boolean,
    ): Promise<WalletCreateFundedPsbtResult>;
    sendRawTransaction(rawtx: string): Promise<string>;
    getBlockCount(): Promise<number>;
    getBlockchainInfo(): Promise<unknown>;
}
