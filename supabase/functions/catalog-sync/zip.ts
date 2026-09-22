function u16(v:DataView,o:number){return v.getUint16(o,true)}
function u32(v:DataView,o:number){return v.getUint32(o,true)}
async function inflateRaw(bytes:Uint8Array){
  const ds=new DecompressionStream("deflate-raw");
  const stream=new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
export async function readZipFiles(buffer:ArrayBuffer,wanted:(name:string)=>boolean){
  const v=new DataView(buffer),b=new Uint8Array(buffer),dec=new TextDecoder(),files:Record<string,string>={};
  let eocd=-1;
  for(let i=b.length-22;i>=Math.max(0,b.length-65557);i--){if(u32(v,i)===0x06054b50){eocd=i;break;}}
  if(eocd<0)throw new Error("ZIP end record not found");
  const count=u16(v,eocd+10),cdOff=u32(v,eocd+16);let p=cdOff;
  for(let n=0;n<count;n++){
    if(u32(v,p)!==0x02014b50)throw new Error("Invalid ZIP directory");
    const method=u16(v,p+10),comp=u32(v,p+20),nameLen=u16(v,p+28),extraLen=u16(v,p+30),commentLen=u16(v,p+32),localOff=u32(v,p+42);
    const name=dec.decode(b.slice(p+46,p+46+nameLen));
    if(wanted(name)){
      const ln=u16(v,localOff+26),le=u16(v,localOff+28),start=localOff+30+ln+le,raw=b.slice(start,start+comp);
      const out=method===0?raw:method===8?await inflateRaw(raw):(()=>{throw new Error("Unsupported ZIP compression "+method)})();
      files[name]=dec.decode(out);
    }
    p+=46+nameLen+extraLen+commentLen;
  }
  return files;
}
