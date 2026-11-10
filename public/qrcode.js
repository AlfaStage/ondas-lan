/**
 * Gerador QR Code ISO/IEC 18004 compacto e 100% offline (SVG nativo).
 * Suporta modo Byte (UTF-8 / ASCII) nas versões 1 a 6 (Nível L) para URLs de rede local.
 */
(function (global) {
  // Tabelas de capacidade para Nível de Correção L (Low = 7% de recuperação)
  // [version]: { totalCodewords, ecCodewordsPerBlock, numBlocks, size }
  const VERSION_TABLE = [
    null,
    { total: 26, ec: 7, blocks: 1, size: 21, align: [] },
    { total: 44, ec: 10, blocks: 1, size: 25, align: [6, 18] },
    { total: 70, ec: 15, blocks: 1, size: 29, align: [6, 22] },
    { total: 100, ec: 20, blocks: 1, size: 33, align: [6, 26] },
    { total: 134, ec: 26, blocks: 1, size: 37, align: [6, 30] },
    { total: 172, ec: 18, blocks: 2, size: 41, align: [6, 34] }
  ];

  // GF(256) com polinômio primitivo 0x11D
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function initGalois() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) {
      EXP[i] = EXP[i - 255];
    }
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  function polyMul(p, q) {
    const out = new Uint8Array(p.length + q.length - 1);
    for (let i = 0; i < p.length; i++) {
      for (let j = 0; j < q.length; j++) {
        out[i + j] ^= gfMul(p[i], q[j]);
      }
    }
    return out;
  }

  function getGeneratorPoly(degree) {
    let g = new Uint8Array([1]);
    for (let i = 0; i < degree; i++) {
      g = polyMul(g, new Uint8Array([1, EXP[i]]));
    }
    return g;
  }

  function computeReedSolomon(data, ecLen) {
    const gen = getGeneratorPoly(ecLen);
    const msg = new Uint8Array(data.length + ecLen);
    msg.set(data, 0);

    for (let i = 0; i < data.length; i++) {
      const coef = msg[i];
      if (coef !== 0) {
        for (let j = 1; j < gen.length; j++) {
          msg[i + j] ^= gfMul(gen[j], coef);
        }
      }
    }
    return msg.slice(data.length);
  }

  function encodeData(text) {
    const utf8 = new TextEncoder().encode(text);
    let version = 1;
    while (version <= 6) {
      const info = VERSION_TABLE[version];
      const dataCap = info.total - info.ec * info.blocks;
      // 4 bits mode + 8 bits length + 8*N data <= dataCap * 8
      if (utf8.length + 2 <= dataCap) break;
      version++;
    }
    if (version > 6) version = 6;

    const info = VERSION_TABLE[version];
    const dataCap = info.total - info.ec * info.blocks;
    const bits = [];

    function pushBits(val, len) {
      for (let i = len - 1; i >= 0; i--) {
        bits.push((val >>> i) & 1);
      }
    }

    // Mode indicator: Byte mode = 0100
    pushBits(0b0100, 4);
    // Character count indicator (8 bits para versões 1..9)
    const slice = utf8.slice(0, dataCap - 2);
    pushBits(slice.length, 8);

    for (let i = 0; i < slice.length; i++) {
      pushBits(slice[i], 8);
    }

    // Terminator (até 4 zeros)
    const maxBits = dataCap * 8;
    const term = Math.min(4, maxBits - bits.length);
    pushBits(0, term);

    while (bits.length % 8 !== 0) {
      bits.push(0);
    }

    const codewords = new Uint8Array(dataCap);
    for (let i = 0; i < bits.length / 8; i++) {
      let b = 0;
      for (let j = 0; j < 8; j++) {
        b = (b << 1) | bits[i * 8 + j];
      }
      codewords[i] = b;
    }

    // Pad bytes 0xEC, 0x11
    let padIdx = bits.length / 8;
    let toggle = true;
    while (padIdx < dataCap) {
      codewords[padIdx++] = toggle ? 0xec : 0x11;
      toggle = !toggle;
    }

    // Divide em blocos se necessário e gera EC
    const blocksData = [];
    const blocksEc = [];
    const blockSize = dataCap / info.blocks;
    for (let b = 0; b < info.blocks; b++) {
      const block = codewords.slice(b * blockSize, (b + 1) * blockSize);
      blocksData.push(block);
      blocksEc.push(computeReedSolomon(block, info.ec));
    }

    const finalCodewords = [];
    for (let i = 0; i < blockSize; i++) {
      for (let b = 0; b < info.blocks; b++) {
        finalCodewords.push(blocksData[b][i]);
      }
    }
    for (let i = 0; i < info.ec; i++) {
      for (let b = 0; b < info.blocks; b++) {
        finalCodewords.push(blocksEc[b][i]);
      }
    }

    return { version, info, codewords: finalCodewords };
  }

  function buildMatrix(text) {
    const { info, codewords } = encodeData(text);
    const size = info.size;
    const modules = Array.from({ length: size }, () => new Int8Array(size));
    const isFunction = Array.from({ length: size }, () => new Uint8Array(size));

    function setFunctionModule(r, c, dark) {
      if (r < 0 || r >= size || c < 0 || c >= size) return;
      modules[r][c] = dark ? 1 : 0;
      isFunction[r][c] = 1;
    }

    // Finder patterns (7x7) + Separators
    function drawFinder(row, col) {
      for (let dr = -1; dr <= 7; dr++) {
        for (let dc = -1; dc <= 7; dc++) {
          const r = row + dr;
          const c = col + dc;
          if (r < 0 || r >= size || c < 0 || c >= size) continue;
          const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
          const isBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
          const isCenter = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
          setFunctionModule(r, c, inOuter && (isBorder || isCenter));
        }
      }
    }

    drawFinder(0, 0);
    drawFinder(0, size - 7);
    drawFinder(size - 7, 0);

    // Timing patterns
    for (let i = 8; i < size - 8; i++) {
      setFunctionModule(6, i, i % 2 === 0);
      setFunctionModule(i, 6, i % 2 === 0);
    }

    // Alignment patterns
    const align = info.align;
    for (let i = 0; i < align.length; i++) {
      for (let j = 0; j < align.length; j++) {
        const r = align[i];
        const c = align[j];
        if (
          (r === 6 && c === 6) ||
          (r === 6 && c === size - 7) ||
          (r === size - 7 && c === 6)
        ) {
          continue;
        }
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
            setFunctionModule(r + dr, c + dc, dark);
          }
        }
      }
    }

    // Dark module + Format reserved areas
    setFunctionModule(size - 8, 8, true);
    for (let i = 0; i < 9; i++) {
      if (!isFunction[8][i]) setFunctionModule(8, i, false);
      if (!isFunction[i][8]) setFunctionModule(i, 8, false);
    }
    for (let i = 0; i < 8; i++) {
      if (!isFunction[8][size - 1 - i]) setFunctionModule(8, size - 1 - i, false);
      if (!isFunction[size - 1 - i][8]) setFunctionModule(size - 1 - i, 8, false);
    }

    // Posiciona os bits de dados em zigue-zague
    let bitIdx = 0;
    const totalBits = codewords.length * 8;
    let upward = true;

    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        const r = upward ? size - 1 - vert : vert;
        for (let j = 0; j < 2; j++) {
          const c = right - j;
          if (!isFunction[r][c]) {
            let dark = false;
            if (bitIdx < totalBits) {
              const byte = codewords[bitIdx >>> 3];
              dark = ((byte >>> (7 - (bitIdx & 7))) & 1) === 1;
              bitIdx++;
            }
            // Aplica máscara 0: (r + c) % 2 === 0
            if ((r + c) % 2 === 0) dark = !dark;
            modules[r][c] = dark ? 1 : 0;
          }
        }
      }
      upward = !upward;
    }

    // Format information para Error Correction Level L (01) + Mask 0 (000)
    // Pré-calculado BCH(15,5) com máscara XOR 0x5412 => 0x77C4 (30660)
    const formatBits = 0x77c4;
    function getFormatBit(idx) {
      return ((formatBits >>> idx) & 1) === 1;
    }

    // Ao redor do canto superior esquerdo
    for (let i = 0; i <= 5; i++) setFunctionModule(8, i, getFormatBit(14 - i));
    setFunctionModule(8, 7, getFormatBit(8));
    setFunctionModule(8, 8, getFormatBit(7));
    setFunctionModule(7, 8, getFormatBit(6));
    for (let i = 0; i <= 5; i++) setFunctionModule(5 - i, 8, getFormatBit(5 - i));

    // Cantos inferior esquerdo e superior direito
    for (let i = 0; i <= 6; i++) setFunctionModule(size - 1 - i, 8, getFormatBit(14 - i));
    for (let i = 0; i <= 7; i++) setFunctionModule(8, size - 8 + i, getFormatBit(7 - i));

    return { size, modules };
  }

  function renderQrSvg(text, options = {}) {
    const { size, modules } = buildMatrix(text);
    const margin = options.margin ?? 2;
    const total = size + margin * 2;
    const fg = options.fg || '#0c0e12';
    const bg = options.bg || '#ffffff';

    let pathData = '';
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (modules[r][c]) {
          const x = c + margin;
          const y = r + margin;
          pathData += `M${x},${y}h1v1h-1z`;
        }
      }
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" width="100%" height="100%" role="img" aria-label="QR Code de conexão rápida">
      <rect width="${total}" height="${total}" fill="${bg}" rx="1.5"/>
      <path d="${pathData}" fill="${fg}"/>
    </svg>`;
  }

  global.OndasQR = { renderQrSvg };
})(window);
