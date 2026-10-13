// Small ZIP writer using only Node built-ins. Archive only the explicit public
// package files; never recurse into a release directory that may hold user secrets.
import { readFileSync, writeFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import path from "node:path";

const table = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function packageArchive(directory, files, output) {
  const local = [],
    central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(`WebDairy/${file.name}`);
    const data = readFileSync(path.join(directory, file.name));
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(33, 12); // 1980-01-01; reproducible archive metadata.
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(0x314, 4); // Unix creator: preserve Mac executable bits.
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(33, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(((0o100000 | file.mode) * 65536) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    local.push(header, name, compressed);
    central.push(entry, name);
    offset += header.length + name.length + compressed.length;
  }
  const directoryData = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directoryData.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(output, Buffer.concat([...local, directoryData, end]));
}
