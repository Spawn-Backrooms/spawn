import type * as Api from "../../src/core/research-exchange.mjs";
export function conformanceCases(api:typeof Api, hash:Api.Hash):{name:string;run:()=>Promise<void>}[];
