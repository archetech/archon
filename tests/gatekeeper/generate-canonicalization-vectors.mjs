// Synthetic signing keys only. Run after building packages.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import canonicalize from 'canonicalize';
import {CID} from 'multiformats/cid';
import {create} from 'multiformats/hashes/digest';
import Cipher from '../../packages/cipher/dist/esm/cipher-node.js';
const cipher=new Cipher();
const sha=bytes=>createHash('sha256').update(bytes).digest();
const cid=value=>CID.createV1(0x200,create(0x12,sha(canonicalize(value)))).toString();
const inputs=[
    ['nested indexes','{"z":[{"2":"b","10":"a","1":"c"}],"a":true}'],
    ['index boundaries','{"4294967295":0,"4294967294":1,"01":2,"0":3,"-1":4,"a":5}'],
    ['unicode order','{"\\ue000":1,"\\ud800\\udc00":2,"\\r":3,"1":4,"\\u20ac":5,"\\ud83d\\ude00":6}'],
    ['numbers','{"n":[1.0,-0.0,1e-6,1e-7,1e20,1e21,333333333.33333329,4.50,2e-3,1e-27,5e-324,1.7976931348623157e308]}'],
    ['binary64 integers','{"n":[9007199254740993,18446744073709551615,-9223372036854775808]}'],
    ['escaping','{"s":"\\u0000\\b\\f\\n\\r\\t\\"\\\\/é😀"}'],
    ['order one','{"b":2,"a":1}'],['order two','{"a":1,"b":2}'],
];
const bytes=inputs.map(([name,input])=>({name,input,canonical:canonicalize(JSON.parse(input)),cid:cid(JSON.parse(input))}));
const signed=[];
for(const modern of [false,true]){
    const key=cipher.generateJwk(new Uint8Array(32).fill(modern?74:73));
    const time='2026-01-02T00:00:00Z';
    const sign=(op,method='#key-1')=>{
        const proof=modern?{type:'DataIntegrityProof',cryptosuite:'archon-ecdsa-secp256k1-jcs-2026',created:time,verificationMethod:method,proofPurpose:'assertionMethod'}:{type:'EcdsaSecp256k1Signature2019',created:time,verificationMethod:method,proofPurpose:'authentication'};
        const digest=modern?sha(Buffer.concat([sha(canonicalize(proof)),sha(canonicalize(op))])).toString('hex'):sha(canonicalize(op)).toString('hex');
        return {...op,proof:{...proof,proofValue:Buffer.from(cipher.signHash(digest,key.privateJwk),'hex').toString('base64url')}};
    };
    const agent=sign({type:'create',created:time,registration:{version:1,type:'agent',registry:'hyperswarm'},publicJwk:key.publicJwk});const controller='did:cid:'+cid(agent);
    const data=Object.fromEntries(bytes.map(v=>[v.name,JSON.parse(v.input)]));
    const asset=sign({type:'create',created:time,registration:{version:1,type:'asset',registry:'hyperswarm'},controller,data},controller+'#key-1');const did='did:cid:'+cid(asset);
    const update=sign({type:'update',did,previd:cid(asset),doc:{didDocumentData:{...data,state:'updated'}}},controller+'#key-1');
    const deletion=sign({type:'delete',did,previd:cid(update)},controller+'#key-1');
    signed.push({modern,controller,did,operations:[agent,asset,update,deletion],cids:[agent,asset,update,deletion].map(cid)});
}
fs.writeFileSync('tests/gatekeeper/canonicalization-vectors.json',JSON.stringify({bytes,signed},null,2)+'\n');
