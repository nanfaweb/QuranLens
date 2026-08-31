/**
 * QuranLens — Icon Generator
 * 
 * Converts SVG icons to PNG at 16, 32, 48, and 128px sizes.
 * 
 * Prerequisites:
 *   npm install canvas
 * 
 * Usage:
 *   node icons/generate_icons.js
 * 
 * This uses the 'canvas' npm package (node-canvas) to render SVGs to PNG.
 * The PNGs are saved alongside the SVGs in the icons/ directory.
 */

const fs = require('fs');
const path = require('path');

async function generateIcons() {
  let createCanvas, loadImage;
  
  try {
    const canvas = require('canvas');
    createCanvas = canvas.createCanvas;
    loadImage = canvas.loadImage;
  } catch (e) {
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║  The "canvas" package is not installed.             ║');
    console.log('║                                                     ║');
    console.log('║  To generate PNG icons, run:                        ║');
    console.log('║    npm install canvas                               ║');
    console.log('║    node icons/generate_icons.js                     ║');
    console.log('║                                                     ║');
    console.log('║  Alternatively, using fallback canvas generation... ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log();
    
    // Fallback: generate minimal valid PNGs programmatically
    // These are solid green circles — good enough for development
    generateFallbackPNGs();
    return;
  }

  const sizes = [16, 32, 48, 128];
  const iconsDir = __dirname;
  const logoPath = path.join(iconsDir, 'logo.svg');

  if (!fs.existsSync(logoPath)) {
    console.error(`  ✗ Logo SVG not found: ${logoPath}`);
    process.exit(1);
  }

  let logoContent = fs.readFileSync(logoPath, 'utf-8');
  if (!logoContent.includes('viewBox=')) {
    logoContent = logoContent.replace(
      /<svg([^>]*?)width="840" height="840"/,
      '<svg$1width="840" height="840" viewBox="0 0 840 840"'
    );
    fs.writeFileSync(logoPath, logoContent);
  }

  for (const size of sizes) {
    const svgPath = path.join(iconsDir, `icon-${size}.svg`);
    const pngPath = path.join(iconsDir, `icon-${size}.png`);

    const svgContent = logoContent.replace(
      /<svg([^>]*?)width="840" height="840"/,
      `<svg$1width="${size}" height="${size}"`
    );
    fs.writeFileSync(svgPath, svgContent);

    const svgBuffer = Buffer.from(svgContent);

    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');

    try {
      const img = await loadImage(svgBuffer);
      ctx.drawImage(img, 0, 0, size, size);

      const pngBuffer = canvas.toBuffer('image/png');
      fs.writeFileSync(pngPath, pngBuffer);
      console.log(`  ✓ Generated ${pngPath} (${size}×${size})`);
    } catch (err) {
      console.error(`  ✗ Failed to generate ${size}px icon:`, err.message);
      // Generate fallback for this size
      generateSingleFallbackPNG(size, pngPath);
    }
  }

  console.log('\n  Done! All PNG icons generated.');
}

/**
 * Fallback: generate minimal PNG icons without the canvas package.
 * Creates a valid PNG with a solid colored circle.
 */
function generateFallbackPNGs() {
  const sizes = [16, 32, 48, 128];
  const iconsDir = __dirname;

  for (const size of sizes) {
    const pngPath = path.join(iconsDir, `icon-${size}.png`);
    generateSingleFallbackPNG(size, pngPath);
  }

  console.log('\n  Fallback PNGs generated. For better quality, install "canvas" and re-run.');
}

/**
 * Generate a single minimal PNG. This creates a valid PNG file
 * with a green circle on transparent background using raw PNG encoding.
 */
function generateSingleFallbackPNG(size, outputPath) {
  // Create raw RGBA pixel data
  const pixels = Buffer.alloc(size * size * 4, 0); // transparent
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 1;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      if (dist <= r) {
        const idx = (y * size + x) * 4;
        pixels[idx] = 6;     // R (dark emerald)
        pixels[idx + 1] = 95; // G
        pixels[idx + 2] = 70;  // B
        pixels[idx + 3] = 255; // A
      }
    }
  }

  // Encode as PNG
  const png = encodePNG(size, size, pixels);
  fs.writeFileSync(outputPath, png);
  console.log(`  ✓ Fallback PNG: ${outputPath} (${size}×${size})`);
}

/**
 * Minimal PNG encoder — no dependencies.
 * Produces a valid PNG from raw RGBA pixel data.
 */
function encodePNG(width, height, pixels) {
  // CRC32 table
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crcTable[n] = c;
  }

  function crc32(buf, offset, length) {
    let crc = 0xFFFFFFFF;
    for (let i = offset; i < offset + length; i++) {
      crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function adler32(buf) {
    let a = 1, b = 0;
    for (let i = 0; i < buf.length; i++) {
      a = (a + buf[i]) % 65521;
      b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
  }

  // Build raw data (filter byte 0 + row pixels)
  const rawData = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    rawData[y * (1 + width * 4)] = 0; // filter: none
    pixels.copy(rawData, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }

  // Compress with raw deflate (store blocks, no compression — simple but larger)
  const deflated = deflateStore(rawData);

  // Build PNG chunks
  const chunks = [];

  // Signature
  chunks.push(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  chunks.push(makeChunk('IHDR', ihdr, crc32));

  // IDAT
  chunks.push(makeChunk('IDAT', deflated, crc32));

  // IEND
  chunks.push(makeChunk('IEND', Buffer.alloc(0), crc32));

  return Buffer.concat(chunks);
}

function makeChunk(type, data, crc32fn) {
  const typeBytes = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcData = Buffer.concat([typeBytes, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32fn(crcData, 0, crcData.length), 0);
  return Buffer.concat([lenBuf, typeBytes, data, crcBuf]);
}

function deflateStore(data) {
  // zlib header (CM=8, CINFO=7, FCHECK) + raw stored blocks + adler32
  const maxBlock = 65535;
  const numBlocks = Math.ceil(data.length / maxBlock) || 1;
  const blocks = [];

  // zlib header
  blocks.push(Buffer.from([0x78, 0x01]));

  for (let i = 0; i < numBlocks; i++) {
    const start = i * maxBlock;
    const end = Math.min(start + maxBlock, data.length);
    const block = data.slice(start, end);
    const isLast = (i === numBlocks - 1) ? 1 : 0;

    const header = Buffer.alloc(5);
    header[0] = isLast;
    header.writeUInt16LE(block.length, 1);
    header.writeUInt16LE(block.length ^ 0xFFFF, 3);
    blocks.push(header);
    blocks.push(block);
  }

  // Adler32 checksum
  const a32 = adler32(data);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(a32, 0);
  blocks.push(checksum);

  return Buffer.concat(blocks);

  function adler32(buf) {
    let a = 1, b = 0;
    for (let i = 0; i < buf.length; i++) {
      a = (a + buf[i]) % 65521;
      b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
  }
}

generateIcons().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
