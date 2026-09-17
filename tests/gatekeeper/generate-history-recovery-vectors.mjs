// Synthetic signing keys only. Run from the repository root after building packages.
import fs from 'node:fs';
import CipherNode from '../../packages/cipher/dist/esm/cipher-node.js';
import Gatekeeper from '../../packages/gatekeeper/dist/esm/gatekeeper.js';
import DbJsonMemory from '../../packages/gatekeeper/dist/esm/db/json-memory.js';
import MemoryClient from '../../packages/ipfs/dist/esm/memory-client.js';
const cipher = new CipherNode();
let seed = 41;
const testKey = () => cipher.generateJwk(new Uint8Array(32).fill(seed++));
const T = height => new Date(Date.UTC(2026,0,1) + height * 1000).toISOString();
function sign(op, key, signer = '#key-1') {
    return {...op, proof:{type:'EcdsaSecp256k1Signature2019',created:T(0),verificationMethod:signer,proofPurpose:'authentication',proofValue:Buffer.from(cipher.signHash(cipher.hashJSON(op),key.privateJwk),'hex').toString('base64url')}};
}
const previous=JSON.parse(fs.readFileSync('tests/gatekeeper/history-recovery-vectors.json','utf8'));
const vectors=[];
for(const registry of ['BTC:signet','ETH:sepolia']) {
    const g=new Gatekeeper({db:new DbJsonMemory('vectors'),ipfs:new MemoryClient(),registries:['local','hyperswarm','BTC:signet','ETH:sepolia']});
    const k1=testKey(), k2=testKey(), k3=testKey();
    const create=sign({type:'create',created:T(0),registration:{version:1,type:'agent',registry},publicJwk:k1.publicJwk},k1);
    const controller=await g.createDID(create);
    const assetOp=sign({type:'create',created:T(0),registration:{version:1,type:'asset',registry:'BTC:signet'},controller,data:'original'},k1,`${controller}#key-1`);
    const asset=await g.createDID(assetOp);
    const controllerDoc=(await g.resolveDID(controller)).didDocument;
    controllerDoc.verificationMethod[0].publicKeyJwk=k2.publicJwk;
    const rotationOp=sign({type:'update',did:controller,previd:await g.generateCID(create),doc:{didDocument:controllerDoc}},k1,`${controller}#key-1`);
    const event=async (op,chain,height)=>({did:op.did??await g.generateDID(op),opid:await g.generateCID(op),operation:op,registry:chain,time:T(height),ordinal:[height,0],registration:{height,index:0,txid:`tx${height}`,batch:`batch${height}`}});
    const assetCid=await g.generateCID(assetOp);
    const update=async(key,data,prev=assetCid)=>sign({type:'update',did:asset,previd:prev,doc:{didDocumentData:data}},key,`${controller}#key-1`);
    const old=await update(k1,'retired'), fresh=await update(k2,'new-key'), early=await update(k1,'before-rotation');
    const oldNext=await update(k1,'retired-successor',await g.generateCID(old));
    const freshNext=await update(k2,'new-key-successor',await g.generateCID(fresh));
    const migrationOp=sign({type:'update',did:controller,previd:await g.generateCID(create),doc:{didDocument:controllerDoc,didDocumentRegistration:{version:1,type:'agent',registry:'BTC:signet'}}},k1,`${controller}#key-1`);
    const nextDoc=structuredClone(controllerDoc);nextDoc.verificationMethod[0].publicKeyJwk=k3.publicJwk;
    const migrationRotation=sign({type:'update',did:controller,previd:await g.generateCID(migrationOp),doc:{didDocument:nextDoc}},k2,`${controller}#key-1`);
    const kb=testKey();
    const otherCreate=sign({type:'create',created:T(0),registration:{version:1,type:'agent',registry:'BTC:signet'},publicJwk:kb.publicJwk},kb);
    const other=await g.createDID(otherCreate);
    const childCreate=sign({type:'create',created:T(0),registration:{version:1,type:'asset',registry:'BTC:signet'},controller:other,data:'original'},kb,`${other}#key-1`);
    const child=await g.createDID(childCreate);
    const childDoc=(await g.resolveDID(child)).didDocument;
    childDoc.controller=asset;
    const transfer=sign({type:'update',did:child,previd:await g.generateCID(childCreate),doc:{didDocument:childDoc}},kb,`${other}#key-1`);
    const delegatedOp=sign({type:'update',did:child,previd:await g.generateCID(transfer),doc:{didDocumentData:'retired-delegate'}},k1,`${controller}#key-1`);
    const deletion=sign({type:'delete',did:asset,previd:assetCid},k1,`${controller}#key-1`);
    vectors.push({registry,controller,asset,child,delegation:[await event(otherCreate,'BTC:signet',90),await event(childCreate,'BTC:signet',120),await event(transfer,'BTC:signet',150)],delegated:await event(delegatedOp,'BTC:signet',300),deletion:await event(deletion,'BTC:signet',300),base:[await event(create,registry,100),await event(assetOp,'BTC:signet',110)],rotation:await event(rotationOp,registry,200),old:await event(old,'BTC:signet',300),oldNext:await event(oldNext,'BTC:signet',400),fresh:await event(fresh,'BTC:signet',300),freshNext:await event(freshNext,'BTC:signet',400),early:await event(early,'BTC:signet',150),migration:await event(migrationOp,registry,200),migrationRotation:await event(migrationRotation,'BTC:signet',250)});
}
vectors.forEach((v,i)=>{ if(previous[i].gc) v.gc=previous[i].gc; });
fs.writeFileSync('tests/gatekeeper/history-recovery-vectors.json',JSON.stringify(vectors,null,2)+'\n');
