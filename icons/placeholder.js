/**
 * Creates minimal valid PNG placeholder icons.
 * Run: node icons/placeholder.js
 * 
 * Or simply open icons/generate_icons.html in Chrome,
 * right-click each canvas, and "Save image as" the corresponding filename.
 */

const fs = require('fs');
const path = require('path');

// Minimal 1x1 blue PNG (will be stretched by Chrome)
// This is a valid PNG file with a single blue pixel
function createMinimalPNG() {
  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  
  // IHDR chunk (1x1, 8-bit RGB)
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(1, 0);  // width
  ihdrData.writeUInt32BE(1, 4);  // height
  ihdrData[8] = 8;               // bit depth
  ihdrData[9] = 2;               // color type (RGB)
  ihdrData[10] = 0;              // compression
  ihdrData[11] = 0;              // filter
  ihdrData[12] = 0;              // interlace
  
  const ihdr = createChunk('IHDR', ihdrData);
  
  // IDAT chunk (filtered scanline: filter_byte + R + G + B)
  const rawData = Buffer.from([0, 74, 108, 247]); // filter=none, R=74, G=108, B=247 (blue)
  const { deflateSync } = require('zlib');
  const compressed = deflateSync(rawData);
  const idat = createChunk('IDAT', compressed);
  
  // IEND chunk
  const iend = createChunk('IEND', Buffer.alloc(0));
  
  return Buffer.concat([signature, ihdr, idat, iend]);
}

function createChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  
  const typeBuffer = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuffer, data]);
  
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 1) {
        crc = (crc >>> 1) ^ 0xEDB88320;
      } else {
        crc = crc >>> 1;
      }
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

try {
  const png = createMinimalPNG();
  const dir = __dirname;
  
  fs.writeFileSync(path.join(dir, 'icon16.png'), png);
  fs.writeFileSync(path.join(dir, 'icon48.png'), png);
  fs.writeFileSync(path.join(dir, 'icon128.png'), png);
  
  console.log('✓ Created placeholder icons (icon16.png, icon48.png, icon128.png)');
  console.log('  These are 1x1 blue pixels — Chrome will scale them.');
  console.log('  For proper icons, open generate_icons.html in Chrome and save the canvases.');
} catch (e) {
  console.error('Failed to create icons:', e.message);
  console.log('Please open generate_icons.html in a browser to generate icons manually.');
}