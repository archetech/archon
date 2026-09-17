// Synthetic signing key only. Run from the repository root after building packages.
import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import Cipher from '../../packages/cipher/dist/esm/cipher-node.js';
import {CID} from 'multiformats/cid';
import {create} from 'multiformats/hashes/digest';
const cipher=new Cipher();const key=cipher.generateJwk(new Uint8Array(32).fill(37));
const hash=bytes=>CID.createV1(0x0200,create(0x12,createHash('sha256').update(bytes).digest())).toString();
const canonical=op=>hash(cipher.canonicalizeJSON(op));
function sign(op,method){const proof={type:'DataIntegrityProof',cryptosuite:'archon-ecdsa-secp256k1-jcs-2026',created:'2026-09-17T12:00:00.000Z',verificationMethod:method,proofPurpose:'capabilityInvocation'};const msg=cipher.hashMessage(Buffer.from(cipher.hashJSON(proof)+cipher.hashJSON(op),'hex'));return {...op,proof:{...proof,proofValue:Buffer.from(cipher.signHash(msg,key.privateJwk),'hex').toString('base64url')}};}
const registration={version:1,type:'agent',registry:'hyperswarm',validUntil:'2099-12-31T00:00:00Z'};
const createOp={type:'create',created:'2026-09-17T11:00:00.000Z',registration,publicJwk:key.publicJwk};
const agent=sign(createOp,'#key-1'),did='did:cid:'+canonical(agent);
const specs=[
    ['omit_registration',undefined,true,registration],
    ['complete_replacement',{...registration,validUntil:'2098-01-01T12:34:56Z'},true],
    ['remove_expiry',{version:1,type:'agent',registry:'hyperswarm'},true],
    ['extension_member',{...registration,extension:{foo:'bar'}},true],
    ['registry_migration',{...registration,registry:'BTC:signet'},true],
    ['null_registration',null,false],
    ['array_registration',[],false],
    ['scalar_registration','hyperswarm',false],
    ['replace_registry_only',{registry:'hyperswarm'},false],
    ['missing_version',{type:'agent',registry:'hyperswarm'},false],
    ['missing_kind',{version:1,registry:'hyperswarm'},false],
    ['unsupported_version_and_invalid_expiry',{...registration,version:999,validUntil:'not-a-date'},false],
    ['claim_future_version',{...registration,version:2},false],
    ['string_version',{...registration,version:'1'},false],
    ['null_expiry',{...registration,validUntil:null},false],
    ['numeric_expiry',{...registration,validUntil:123},false],
    ['invalid_expiry',{...registration,validUntil:'2026-02-30T00:00:00Z'},false],
    ['empty_expiry',{...registration,validUntil:''},false],
    ['omit_registry',{version:1,type:'agent'},false],
    ['invalid_registry',{...registration,registry:'bad registry'},false],
    ['null_registry',{...registration,registry:null},false],
    ['change_prefix',{...registration,prefix:'did:example'},false],
    ['change_kind',{...registration,type:'asset'},false],
].map(([name,next,accepted])=>[name,next,accepted,accepted&&next!==undefined?next:registration]);
const cases=specs.map(([name,next,accepted,expectedRegistration])=>({name,accepted,expectedRegistration,operation:sign({type:'update',did,previd:canonical(agent),doc:{didDocumentData:{case:name},...(next===undefined?{}:{didDocumentRegistration:next})}},did+'#key-1')}));
for (const [name, next, accepted] of [
    ['preserve_prefix', 'did:cid', true], ['remove_prefix', undefined, false], ['replace_prefix', 'did:other', false],
]) {
    const registrationWithPrefix={...registration,prefix:'did:cid'};
    const genesis=sign({...createOp,registration:registrationWithPrefix},'#key-1');
    const target='did:cid:'+canonical(genesis);
    const replacement={...registration,...(next===undefined?{}:{prefix:next})};
    cases.push({name,agent:genesis,did:target,accepted,expectedRegistration:accepted?replacement:registrationWithPrefix,
        operation:sign({type:'update',did:target,previd:canonical(genesis),doc:{didDocumentRegistration:replacement}},target+'#key-1')});
}
const invalidGenesis=[null,123,'', '2026-02-30T00:00:00Z'].map(validUntil=>sign({...createOp,registration:{...registration,validUntil}},'#key-1'));
const unsupportedGenesis=sign({...createOp,registration:{...registration,version:2}},'#key-1');
writeFileSync('tests/gatekeeper/registration-transition-v1-vectors.json',JSON.stringify({agent,did,unsupportedGenesis,invalidGenesis,cases},null,2)+'\n');
