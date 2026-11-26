import { describe, expect, it } from 'vitest';
import * as candidate from '../src/metadata.js';
const api = candidate as unknown as {
 validatePublicMetadata(value:unknown):Record<string,unknown>;
 canonicalJson(value:unknown):string;
 sha256(value:string|Uint8Array):Promise<string>;
};
const publicValue = {name:'SPAWN Archivist',symbol:'SPWN',description:'Fictional archivist',image:'https://assets.example.org/image.png',showName:true,createdOn:'https://spawn.example.org',website:'https://spawn.example.org/agents/public-01'};
describe('public metadata',()=>{
 it('returns a validated immutable public projection',()=>expect(api.validatePublicMetadata(publicValue)).toEqual(publicValue));
 it('accepts a public FQDN with a trailing dot',()=>expect(api.validatePublicMetadata({...publicValue,image:'https://assets.example.org./image.png'})).toEqual({...publicValue,image:'https://assets.example.org./image.png'}));
 for (const field of ['system_instructions','memory','owner_id','private_key','api_key','chat','wallet_balance']) {
  it(`rejects ${field} rather than silently publishing it`,()=>expect(()=>api.validatePublicMetadata({...publicValue,[field]:'private'})).toThrow(/FIELD/));
 }
 it.each(['http://assets.example.org/a','https://user:secret@assets.example.org/a','https://127.0.0.1/a','https://localhost/a','https://[::1]/a','https://10.0.0.1/a','https://localhost./a','https://sub.localhost./a','https://foo.local./a','https://foo.internal./a','https://foo.test./a','https://foo.invalid./a','https://127.0.0.1./a','https://10.0.0.1./a'])('rejects non-public HTTPS image %s',(image)=>expect(()=>api.validatePublicMetadata({...publicValue,image})).toThrow(/URL/));
 it('enforces UTF8 byte lengths instead of string code-unit lengths',()=>expect(()=>api.validatePublicMetadata({...publicValue,name:'🦄'.repeat(9)})).toThrow(/NAME/));
 it('rejects symbol over 13 bytes',()=>expect(()=>api.validatePublicMetadata({...publicValue,symbol:'S'.repeat(14)})).toThrow(/SYMBOL/));
 it('does not coerce showName',()=>expect(()=>api.validatePublicMetadata({...publicValue,showName:'true'})).toThrow(/METADATA/));
 it('requires bounded description',()=>expect(()=>api.validatePublicMetadata({...publicValue,description:'x'.repeat(2049)})).toThrow(/DESCRIPTION/));
 it('canonicalizes object ordering for intent hashes',()=>expect(api.canonicalJson({b:1,a:{d:3,c:2}})).toBe('{"a":{"c":2,"d":3},"b":1}'));
 it('hashes exact immutable bytes',async()=>expect(await api.sha256('abc')).toBe('sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'));
});
