import { deflateRawSync } from 'node:zlib';

export const publicationPathCases = [
  ...['SKILL.JSON','Skill.Json','skill.JSON'].map(p => ({paths:[p],code:'path_duplicate'})),
  ...['.git/config','sub/.git/config','sub/deep/.GiT/config','.GIT'].map(p => ({paths:[p],code:'path_reserved'})),
  {paths:['scripts/skill.json'],code:'file_would_be_removed'},
  {paths:['sub/FILE.txt','sub/file.txt'],code:'path_duplicate'},
  {paths:['skill.json/config'],code:'path_collision'},
  {paths:['Dir','dir/file.txt'],code:'path_collision'},
  {paths:['skill.json'],code:null},
  {paths:['nested/SKILL.JSON','.github/config','notes.git/config'],code:null}
];

// Minimal ordinary ZIP, no filesystem staging: exercise the same path cases as
// files uploads, including a realistic archive containing repository metadata.
export function publicationSource(files, format = 'files') {
  if (format === 'files') return {type:'files',files};
  const locals=[], centrals=[];
  let offset=0;
  for (const file of files) {
    const name=Buffer.from(file.path), bytes=Buffer.from(file.content), packed=deflateRawSync(bytes);
    let crc=0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit=0;bit<8;bit++) crc=crc&1?0xedb88320^(crc>>>1):crc>>>1;
    }
    crc=(crc^0xffffffff)>>>0;
    const local=Buffer.alloc(30),central=Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(8,8);
    local.writeUInt32LE(crc,14);local.writeUInt32LE(packed.length,18);local.writeUInt32LE(bytes.length,22);local.writeUInt16LE(name.length,26);
    central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(8,10);
    central.writeUInt32LE(crc,16);central.writeUInt32LE(packed.length,20);central.writeUInt32LE(bytes.length,24);central.writeUInt16LE(name.length,28);
    central.writeUInt32LE(offset,42);
    locals.push(local,name,packed);centrals.push(central,name);offset+=local.length+name.length+packed.length;
  }
  const directory=Buffer.concat(centrals),end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);
  end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return {type:'zip',archiveBase64:Buffer.concat([...locals,directory,end]).toString('base64')};
}
