// Word files without a separate service: pack a template as a minimal .docx, and find the Err markers XMerge
// writes into a merged report. Same output as the earlier Python engine (staging_render.build_docx and
// scan_output): one paragraph per line, "# " / "## " lines as bold headings, each line in a single run so
// Word and XPLAN never split a marker.
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib'

const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

function para(line: string): string {
  let text = line
  let size = 0
  if (text.startsWith('## ')) [text, size] = [text.slice(3), 28]
  else if (text.startsWith('# ')) [text, size] = [text.slice(2), 36]
  if (!text) return '<w:p/>'
  const rpr = size ? `<w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr>` : ''
  return `<w:p><w:r>${rpr}<w:t xml:space="preserve">${escape(text)}</w:t></w:r></w:p>`
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const CONTENT_TYPES = `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
  + '</Types>'
const RELS = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
  + '</Relationships>'

/** The template as a Word document XPLAN can merge. */
export function buildDocx(template: string): Buffer {
  const lines = template.replaceAll('\r\n', '\n').replace(/\n+$/, '').split('\n')
  const document = `${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${lines.map(para).join('')}<w:sectPr/></w:body></w:document>`
  return zip([['[Content_Types].xml', CONTENT_TYPES], ['_rels/.rels', RELS], ['word/document.xml', document]])
}

/** Lines of a merged Word report that hold an XMerge error marker ("Err: ..."), at most 50. */
export function errLines(file: Buffer, format: 'doc' | 'pdf'): { errors: string[]; note: string | null } {
  if (format === 'pdf') return { errors: [], note: 'A PDF is not checked for Err markers. Choose Word to check it.' }
  const xml = unzip(file, 'word/document.xml')
  if (xml === null) return { errors: [], note: 'The merged file is not a .docx, so it was not checked for Err markers.' }
  const lines = (xml.match(/<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g) ?? []).map((p) =>
    unescape([...p.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join('')))
  return { errors: lines.filter((l) => /\bErr\s*:/.test(l)).slice(0, 50), note: null }
}

function unescape(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
    return ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" } as Record<string, string>)[e.toLowerCase()]
  })
}

// ---- just enough ZIP: deflated entries, no zip64 (a template or a merged report is far below 4 GB)

function zip(entries: [string, string][]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, text] of entries) {
    const data = Buffer.from(text, 'utf8')
    const packed = deflateRawSync(data)
    const fname = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(8, 8) // deflate
    local.writeUInt16LE(0, 10) // time 00:00
    local.writeUInt16LE(0x21, 12) // date 1980-01-01
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(fname.length, 26)
    local.writeUInt16LE(0, 28)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // made by
    local.copy(central, 6, 4, 26) // version needed .. uncompressed size
    central.writeUInt16LE(fname.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, fname, packed)
    centrals.push(central, fname)
    offset += local.length + fname.length + packed.length
  }
  const dir = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, end])
}

/** One entry of a ZIP file as text, or null when the file is not a ZIP or has no such entry. */
function unzip(file: Buffer, wanted: string): string | null {
  let end = -1
  for (let i = file.length - 22; i >= Math.max(0, file.length - 22 - 0xffff); i--) {
    if (file.readUInt32LE(i) === 0x06054b50) { end = i; break }
  }
  if (end < 0) return null
  let p = file.readUInt32LE(end + 16)
  for (let n = file.readUInt16LE(end + 10); n > 0 && p + 46 <= file.length; n--) {
    if (file.readUInt32LE(p) !== 0x02014b50) return null
    const method = file.readUInt16LE(p + 10)
    const size = file.readUInt32LE(p + 20)
    const nameLen = file.readUInt16LE(p + 28)
    const skip = nameLen + file.readUInt16LE(p + 30) + file.readUInt16LE(p + 32)
    const name = file.toString('utf8', p + 46, p + 46 + nameLen)
    if (name === wanted) {
      const local = file.readUInt32LE(p + 42)
      const start = local + 30 + file.readUInt16LE(local + 26) + file.readUInt16LE(local + 28)
      const data = file.subarray(start, start + size)
      try {
        return (method === 8 ? inflateRawSync(data) : data).toString('utf8')
      } catch {
        return null
      }
    }
    p += 46 + skip
  }
  return null
}
