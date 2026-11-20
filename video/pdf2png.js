// Renders each page of a PDF to PNG with PDFKit (built into macOS), for the demo video's preview:
//   osascript -l JavaScript pdf2png.js <file.pdf> <out-dir> [max-pages]
// Prints the PNG paths, one per line. JavaScript for Automation, so no compiler or install is needed.
ObjC.import('AppKit')
ObjC.import('PDFKit')

function run(argv) {
  const [file, outDir, max] = argv
  const MEDIA_BOX = 0 // kPDFDisplayBoxMediaBox; JXA does not bridge the constant as a number
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(file))
  if (!doc || doc.isNil()) throw new Error(`cannot open ${file}`)
  const pages = Math.min(doc.pageCount, Number(max) || 8)
  const width = 1400 // pixels; the preview shows pages at about 900 px wide
  const out = []
  for (let i = 0; i < pages; i++) {
    const page = doc.pageAtIndex(i)
    const box = page.boundsForBox(MEDIA_BOX)
    const scale = width / box.size.width
    const w = Math.round(box.size.width * scale)
    const h = Math.round(box.size.height * scale)
    const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
      null, w, h, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0)
    const gc = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep)
    $.NSGraphicsContext.saveGraphicsState
    $.NSGraphicsContext.setCurrentContext(gc)
    const ctx = gc.CGContext
    $.CGContextSetRGBFillColor(ctx, 1, 1, 1, 1)
    $.CGContextFillRect(ctx, $.CGRectMake(0, 0, w, h))
    $.CGContextScaleCTM(ctx, scale, scale)
    page.drawWithBoxToContext(MEDIA_BOX, ctx)
    $.NSGraphicsContext.restoreGraphicsState
    const png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $())
    const path = `${outDir}/page-${String(i + 1).padStart(2, '0')}.png`
    const err = Ref()
    if (!png.writeToFileOptionsError($(path), 0, err)) throw new Error(`cannot write ${path}: ${err[0].localizedDescription.js}`)
    out.push(path)
  }
  return out.join('\n')
}
