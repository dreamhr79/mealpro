function u16(v:DataView,o:number){return v.getUint16(o,true)}
function u32(v:DataView,o:number){return v.getUint32(o,true)}

type ZipEntry={name:string;method:number;compressedSize:number;localOffset:number};

async function inflateRaw(bytes:Uint8Array){
  const ds=new DecompressionStream("deflate-raw");
  const stream=new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function range(url:string,start:number,end:number){
  const res=await fetch(url,{headers:{Range:`bytes=${start}-${end}`}});
  if(!(res.status===206||res.status===200))throw new Error(`Archive range failed: ${res.status}`);
  const bytes=new Uint8Array(await res.arrayBuffer());
  if(res.status===200&&start>0)throw new Error("Archive server does not support byte ranges");
  return bytes;
}

export async function listRemoteZip(url:string){
  const head=await fetch(url,{method:"HEAD"});
  if(!head.ok)throw new Error(`Archive HEAD failed: ${head.status}`);
  const size=Number(head.headers.get("content-length"));
  if(!(size>0))throw new Error("Archive size unavailable");
  const tailStart=Math.max(0,size-65557);
  const tail=await range(url,tailStart,size-1),v=new DataView(tail.buffer,tail.byteOffset,tail.byteLength);
  let eocd=-1;
  for(let i=tail.length-22;i>=0;i--){if(u32(v,i)===0x06054b50){eocd=i;break;}}
  if(eocd<0)throw new Error("ZIP end record not found");
  const count=u16(v,eocd+10),cdSize=u32(v,eocd+12),cdOff=u32(v,eocd+16);
  const cd=await range(url,cdOff,cdOff+cdSize-1),cv=new DataView(cd.buffer,cd.byteOffset,cd.byteLength),dec=new TextDecoder();
  const entries=new Map<string,ZipEntry>(); let p=0;
  for(let n=0;n<count;n++){
    if(u32(cv,p)!==0x02014b50)throw new Error("Invalid ZIP directory");
    const method=u16(cv,p+10),compressedSize=u32(cv,p+20),nameLen=u16(cv,p+28),extraLen=u16(cv,p+30),commentLen=u16(cv,p+32),localOffset=u32(cv,p+42);
    const name=dec.decode(cd.subarray(p+46,p+46+nameLen));
    entries.set(name,{name,method,compressedSize,localOffset});
    p+=46+nameLen+extraLen+commentLen;
  }
  return{size,entries};
}

export async function readRemoteZipText(url:string,entry:ZipEntry){
  const header=await range(url,entry.localOffset,entry.localOffset+29);
  const hv=new DataView(header.buffer,header.byteOffset,header.byteLength);
  if(u32(hv,0)!==0x04034b50)throw new Error("Invalid ZIP local header");
  const nameLen=u16(hv,26),extraLen=u16(hv,28),start=entry.localOffset+30+nameLen+extraLen;
  const raw=await range(url,start,start+entry.compressedSize-1);
  const out=entry.method===0?raw:entry.method===8?await inflateRaw(raw):(()=>{throw new Error("Unsupported ZIP compression "+entry.method)})();
  return new TextDecoder().decode(out);
}
