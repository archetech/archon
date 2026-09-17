// Synthetic signing keys only. Run from the repository root after building packages.
import fs from 'node:fs';
import Cipher from '../../packages/cipher/dist/esm/cipher-node.js';
import Gatekeeper from '../../packages/gatekeeper/dist/esm/gatekeeper.js';
import Db from '../../packages/gatekeeper/dist/esm/db/json-memory.js';
import IPFS from '../../packages/ipfs/dist/esm/memory-client.js';
const cipher=new Cipher(), g=new Gatekeeper({db:new Db('rules'),ipfs:new IPFS(),registries:['local','hyperswarm','BTC:signet','ETH:sepolia']});
const t='2026-01-01T00:00:00.000Z';
const sign=(op,k,signer='#key-1')=>({...op,proof:{type:'EcdsaSecp256k1Signature2019',created:t,verificationMethod:signer,proofPurpose:'authentication',proofValue:Buffer.from(cipher.signHash(cipher.hashJSON(op),k.privateJwk),'hex').toString('base64url')}});
const keyA=cipher.generateJwk(new Uint8Array(32).fill(51)),keyB=cipher.generateJwk(new Uint8Array(32).fill(52));
const agentOp=k=>sign({type:'create',created:t,registration:{version:1,type:'agent',registry:'BTC:signet'},publicJwk:k.publicJwk},k);
const createA=agentOp(keyA),createB=agentOp(keyB);
const a=await g.createDID(createA),b=await g.createDID(createB);
const root=(await g.resolveDID(a)).didDocument;
const assetOp=data=>sign({type:'create',created:t,registration:{version:1,type:'asset',registry:'BTC:signet'},controller:a,data},keyA,`${a}#key-1`);
const createAsset=assetOp('first'),createChild=assetOp('second');
const asset=await g.createDID(createAsset),child=await g.createDID(createChild);
const assetDoc=(await g.resolveDID(asset)).didDocument,childDoc=(await g.resolveDID(child)).didDocument;
const update=async(did,previd,doc)=>sign({type:'update',did,previd:await g.generateCID(previd),doc},keyA,`${a}#key-1`);
const cases=[
    ['agent self controller',await update(a,createA,{didDocument:{...root,controller:a}}),true],
    ['agent external controller',await update(a,createA,{didDocument:{...root,controller:b}}),false],
    ['agent asset controller',await update(a,createA,{didDocument:{...root,controller:asset}}),false],
    ['agent changes type',await update(a,createA,{didDocumentRegistration:{...createA.registration,type:'asset'}}),false],
    ['asset changes type',await update(asset,createAsset,{didDocumentRegistration:{...createAsset.registration,type:'agent'}}),false],
    ['asset drops controller',await update(asset,createAsset,{didDocument:{id:asset}}),false],
    ['asset owns itself',await update(asset,createAsset,{didDocument:{...assetDoc,controller:asset}}),false],
    ['asset owns another asset',await update(child,createChild,{didDocument:{...childDoc,controller:asset}}),false],
    ['valid agent transfer',await update(asset,createAsset,{didDocument:{...assetDoc,controller:b}}),true],
    ['asset data update',await update(asset,createAsset,{didDocumentData:'changed'}),true],
    ['agent create external controller',sign({type:'create',created:t,registration:{version:1,type:'agent',registry:'BTC:signet'},publicJwk:keyA.publicJwk,controller:b},keyA),false],
    ['asset create asset controller',sign({type:'create',created:t,registration:{version:1,type:'asset',registry:'BTC:signet'},controller:asset,data:'nested'},keyA,`${asset}#key-1`),false],
];
const event=async(op,height)=>({did:op.did??await g.generateDID(op),opid:await g.generateCID(op),operation:op,registry:'BTC:signet',time:t,ordinal:[height,0],registration:{height,index:0,txid:`tx${height}`,batch:`batch${height}`}});
const metadata = await update(a,createA,{didDocumentRegistration:{version:1,type:'agent',registry:'BTC:signet'}});
cases.push(['agent external controller after metadata replacement',await update(a,metadata,{didDocument:{...root,controller:b}}),false,[await event(metadata,6)]]);
cases.push(['agent self controller after metadata replacement',await update(a,metadata,{didDocument:{...root,controller:a}}),true,[await event(metadata,6)]]);
const fixture={cycle:JSON.parse(fs.readFileSync('tests/gatekeeper/controller-rules-vectors.json','utf8')).cycle,base:await Promise.all([createA,createB,createAsset,createChild].map((op,i)=>event(op,i+1))),cases:await Promise.all(cases.map(async([name,operation,accepted,setup=[]])=>({name,accepted,setup,event:await event(operation,10)})))};
fs.writeFileSync('tests/gatekeeper/controller-rules-vectors.json',JSON.stringify(fixture,null,2)+'\n');
