function u16(v,o){return v.getUint16(o,true)}
function u32(v,o){return v.getUint32(o,true)}
async function inflateRaw(bytes){const ds=new DecompressionStream('deflate-raw'),stream=new Blob([bytes]).stream().pipeThrough(ds);return new Uint8Array(await new Response(stream).arrayBuffer())}
async function readZipFiles(buffer,wanted){
 const v=new DataView(buffer),b=new Uint8Array(buffer),dec=new TextDecoder(),files={};
 let eocd=-1;
 for(let i=b.length-22;i>=Math.max(0,b.length-65557);i--){if(u32(v,i)===0x06054b50){eocd=i;break}}
 if(eocd<0)throw Error('ZIP završetak nije pronađen');
 const count=u16(v,eocd+10),cdOff=u32(v,eocd+16);
 let p=cdOff;
 for(let n=0;n<count;n++){
  if(u32(v,p)!==0x02014b50)throw Error('Neispravan ZIP direktorij');
  const method=u16(v,p+10),comp=u32(v,p+20),nameLen=u16(v,p+28),extraLen=u16(v,p+30),commentLen=u16(v,p+32),localOff=u32(v,p+42),name=dec.decode(b.slice(p+46,p+46+nameLen));
  if(wanted(name)){
   const ln=u16(v,localOff+26),le=u16(v,localOff+28),start=localOff+30+ln+le,raw=b.slice(start,start+comp);
   let out;
   if(method===0)out=raw;
   else if(method===8)out=await inflateRaw(raw);
   else throw Error('Nepodržana ZIP kompresija '+method);
   files[name]=dec.decode(out);
  }
  p+=46+nameLen+extraLen+commentLen;
 }
 return files;
}