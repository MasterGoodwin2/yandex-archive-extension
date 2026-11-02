// Минимальная запись .xlsx без сторонних библиотек.
// .xlsx = zip из XML-файлов. Строки хранятся как inlineStr, числа — как числа.
// Использование: const bytes = await XlsxWriter.build([{name, rows, widths, styleAt, merges, links}]);
// styleAt(r, c) -> номер стиля (XlsxWriter.STYLE), описание стиля {fill, bold, italic, link, rotate, h, v, wrap, border} или undefined; merges — [[r1, c1, r2, c2], …] (с нуля, включительно);
// links — [[r, c, адрес], …]: гиперссылка ячейки (http(s) или относительный путь к файлу, например ../../Archive_Scans/x.jpg).
(function (root) {
  const enc = new TextEncoder();

  // ---------- CRC32 ----------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // ---------- deflate (raw) через CompressionStream, иначе без сжатия ----------
  async function deflateRaw(bytes) {
    if (typeof CompressionStream === 'undefined') return null;
    try {
      const cs = new CompressionStream('deflate-raw');
      const stream = new Blob([bytes]).stream().pipeThrough(cs);
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (e) {
      return null;
    }
  }

  // ---------- zip ----------
  async function makeZip(files) {
    // files: [{name, data(Uint8Array)}]
    const parts = [];
    const central = [];
    let offset = 0;
    const dosTime = 0;
    const dosDate = (1 << 5) | 1 | ((2024 - 1980) << 9); // 2024-01-01

    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const crc = crc32(f.data);
      let comp = await deflateRaw(f.data);
      let method = 8;
      if (!comp || comp.length >= f.data.length) {
        comp = f.data;
        method = 0;
      }
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);
      lh.setUint16(6, 0x0800, true); // UTF-8 имена
      lh.setUint16(8, method, true);
      lh.setUint16(10, dosTime, true);
      lh.setUint16(12, dosDate, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, comp.length, true);
      lh.setUint32(22, f.data.length, true);
      lh.setUint16(26, nameBytes.length, true);
      lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), nameBytes, comp);

      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true);
      ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, method, true);
      ch.setUint16(12, dosTime, true);
      ch.setUint16(14, dosDate, true);
      ch.setUint32(16, crc, true);
      ch.setUint32(20, comp.length, true);
      ch.setUint32(24, f.data.length, true);
      ch.setUint16(28, nameBytes.length, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), nameBytes);

      offset += 30 + nameBytes.length + comp.length;
    }
    let centralSize = 0;
    for (const c of central) centralSize += c.length;
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);

    const all = [...parts, ...central, new Uint8Array(end.buffer)];
    let total = 0;
    for (const p of all) total += p.length;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const p of all) {
      out.set(p, pos);
      pos += p.length;
    }
    return out;
  }

  // ---------- XML ----------
  function xmlEscape(s) {
    return String(s)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function colName(i) {
    let s = '';
    i += 1;
    while (i > 0) {
      const m = (i - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      i = Math.floor((i - 1) / 26);
    }
    return s;
  }

  function sheetXml(rows, widths, styleAt, merges, links, book) {
    const out = [];
    out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
    out.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">');
    out.push('<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>');
    if (widths && widths.length) {
      out.push('<cols>');
      widths.forEach((w, i) => out.push(`<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`));
      out.push('</cols>');
    }
    out.push('<sheetData>');
    rows.forEach((row, r) => {
      out.push(`<row r="${r + 1}">`);
      row.forEach((v, c) => {
        const raw = r > 0 && styleAt ? styleAt(r, c) : undefined;
        const st = raw === undefined || raw === null ? 0 : book.xf(raw);
        const ref = colName(c) + (r + 1);
        if (v === null || v === undefined || v === '') {
          if (st) out.push(`<c r="${ref}" s="${st}"/>`);     // пустая ячейка с заливкой (внутри объединения)
          return;
        }
        const sid = r === 0 ? book.xf(STYLE.HEAD) : st || (typeof v === 'string' && v.includes('\n') ? book.xf(STYLE.WRAP) : 0);
        const style = sid ? ` s="${sid}"` : '';
        if (typeof v === 'number' && Number.isFinite(v)) {
          out.push(`<c r="${ref}"${style}><v>${v}</v></c>`);
        } else {
          out.push(`<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`);
        }
      });
      out.push('</row>');
    });
    out.push('</sheetData>');
    const mg = (merges || []).filter((m) => m[2] > m[0] || m[3] > m[1]);
    if (mg.length) {
      out.push(`<mergeCells count="${mg.length}">`);
      mg.forEach(([r1, c1, r2, c2]) => out.push(`<mergeCell ref="${colName(c1)}${r1 + 1}:${colName(c2)}${r2 + 1}"/>`));
      out.push('</mergeCells>');
    }
    if (links && links.length) {
      out.push('<hyperlinks>');
      links.forEach(([r, c], i) => out.push(`<hyperlink ref="${colName(c)}${r + 1}" r:id="rIdL${i + 1}"/>`));
      out.push('</hyperlinks>');
    }
    out.push('</worksheet>');
    return out.join('');
  }

  // ---------- стили ----------
  // styleAt(r, c) возвращает номер готового стиля (STYLE.*) или описание:
  //   { fill: 'E2EFDA', bold, italic, link, rotate: 90, h: 'center', v: 'center'|'top', wrap, border }
  // Одинаковые описания — один стиль файла (cellXfs), цвета — любые.
  const STYLE = { NORMAL: 0, HEAD: 1, WRAP: 2, SETTLEMENT: 3, YARD: 4, YARD_CALC: 5, PERSON: 6, LINK: 7 };
  const PRESET = {
    0: {}, 1: { bold: true, v: 'center', wrap: true, fill: 'D9D9D9' }, 2: { v: 'top', wrap: true },
    3: { bold: true, fill: 'E2EFDA', border: true, h: 'center', v: 'center', rotate: 90, wrap: true },
    4: { bold: true, fill: 'FFF2CC', border: true, h: 'center', v: 'center' },
    5: { bold: true, italic: true, fill: 'FFF2CC', border: true, h: 'center', v: 'center' },
    6: { border: true, v: 'center', wrap: true }, 7: { link: true, border: true, v: 'center', wrap: true },
  };

  class StyleBook {
    constructor() {
      this.fonts = ['<font><sz val="11"/><name val="Calibri"/></font>'];
      this.fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
      this.xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
      this.byKey = new Map([['{}', 0]]);
      this.fontIx = new Map(); this.fillIx = new Map();
    }
    font(sp) {
      const k = `${!!sp.bold}${!!sp.italic}${!!sp.link}`;
      if (k === 'falsefalsefalse') return 0;
      if (!this.fontIx.has(k)) {
        this.fontIx.set(k, this.fonts.length);
        this.fonts.push(`<font>${sp.bold ? '<b/>' : ''}${sp.italic ? '<i/>' : ''}${sp.link ? '<u/>' : ''}<sz val="11"/>` +
          `${sp.link ? '<color rgb="FF0563C1"/>' : ''}<name val="Calibri"/></font>`);
      }
      return this.fontIx.get(k);
    }
    fill(rgb) {
      if (!rgb) return 0;
      const k = String(rgb).replace('#', '').toUpperCase().slice(-6);
      if (!this.fillIx.has(k)) {
        this.fillIx.set(k, this.fills.length);
        this.fills.push(`<fill><patternFill patternType="solid"><fgColor rgb="FF${k}"/><bgColor indexed="64"/></patternFill></fill>`);
      }
      return this.fillIx.get(k);
    }
    xf(st) {
      const sp = typeof st === 'number' ? (PRESET[st] || {}) : (st || {});
      const key = JSON.stringify(Object.keys(sp).sort().reduce((o, k) => { if (sp[k] !== undefined && sp[k] !== false) o[k] = sp[k]; return o; }, {}));
      if (this.byKey.has(key)) return this.byKey.get(key);
      const fo = this.font(sp), fi = this.fill(sp.fill), bo = sp.border ? 1 : 0;
      const al = [sp.h ? `horizontal="${sp.h}"` : '', sp.v ? `vertical="${sp.v}"` : '', sp.rotate ? `textRotation="${sp.rotate}"` : '',
        sp.wrap ? 'wrapText="1"' : ''].filter(Boolean).join(' ');
      const id = this.xfs.length;
      this.xfs.push(`<xf numFmtId="0" fontId="${fo}" fillId="${fi}" borderId="${bo}" xfId="0"` +
        `${fo ? ' applyFont="1"' : ''}${fi ? ' applyFill="1"' : ''}${bo ? ' applyBorder="1"' : ''}` +
        (al ? ` applyAlignment="1"><alignment ${al}/></xf>` : '/>'));
      this.byKey.set(key, id);
      return id;
    }
    xml() {
      const thin = '<left style="thin"><color rgb="FFBFBFBF"/></left><right style="thin"><color rgb="FFBFBFBF"/></right>' +
        '<top style="thin"><color rgb="FFBFBFBF"/></top><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/>';
      return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        `<fonts count="${this.fonts.length}">${this.fonts.join('')}</fonts>` +
        `<fills count="${this.fills.length}">${this.fills.join('')}</fills>` +
        `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border>${thin}</border></borders>` +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        `<cellXfs count="${this.xfs.length}">${this.xfs.join('')}</cellXfs>` +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
    }
  }

  async function build(sheets) {
    const files = [];
    const add = (name, text) => files.push({ name, data: enc.encode(text) });

    let ct =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>';
    sheets.forEach((s, i) => {
      ct += `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`;
    });
    ct += '</Types>';
    add('[Content_Types].xml', ct);

    add(
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>'
    );

    let wb =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>';
    sheets.forEach((s, i) => {
      wb += `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`;
    });
    wb += '</sheets></workbook>';
    add('xl/workbook.xml', wb);

    let rels =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
    sheets.forEach((s, i) => {
      rels += `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`;
    });
    rels += `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`;
    rels += '</Relationships>';
    add('xl/_rels/workbook.xml.rels', rels);

    const book = new StyleBook();
    book.xf(STYLE.HEAD); book.xf(STYLE.WRAP);
    sheets.forEach((s, i) => {
      add(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows, s.widths, s.styleAt, s.merges, s.links, book));
      if (s.links && s.links.length) {
        let lr = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
        s.links.forEach(([, , target], k) => {
          lr += `<Relationship Id="rIdL${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" ` +
            `Target="${xmlEscape(target)}" TargetMode="External"/>`;
        });
        add(`xl/worksheets/_rels/sheet${i + 1}.xml.rels`, lr + '</Relationships>');
      }
    });

    add('xl/styles.xml', book.xml());
    return makeZip(files);
  }

  const api = { build, STYLE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.XlsxWriter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
