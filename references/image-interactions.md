# Image interaction integration v1.6.0

`assets/reader/image-interactions.js` runs before `reader.js` and provides
`window.createImageInteractions(options)`. It owns image views and the temporary
modal scroll lock. The reader owns paper data, figure selection, layout and
annotation storage; the image controller never accesses annotation storage.

```js
const images = createImageInteractions();
images.mountFigure(viewport, img, figureId);
images.fitFigure(); // Complete normal-figure contain fit, centered.
images.openZoom(asset); // Dedicated figure zoom button.
```

Required modal nodes: `#image-dialog` (`dialog`), `#image-scroll` (bounded image
viewport), `#zoom-image` (`img`), `#image-tools` (toolbar; legacy `.image-tools`
also works), `#zoom-in`, `#zoom-out`, and `#zoom-fit`. Normal figure nodes are the
dynamic `.figure-viewport` and its image passed to `mountFigure`. The current-zoom
input retains the compatible ID `#figure-initial-scale`; it no longer sets or
persists an initial preference. Optional controls are `#figure-zoom-in`,
`#figure-zoom-out`, `#figure-fit`, and `#figure-scale-output`.

## Direct image gestures

There is no `#figure-interact` checkbox or activation mode. On the visible actual
image, wheel zoom anchors to the pointer and primary-pointer dragging pans
immediately. Gestures beginning outside the image, including letterbox space,
controls, caption and article, remain normal reading scroll. The normal image
does not require a click to enable interaction; the dedicated zoom button opens
the modal. Do not restore the old image click handler or checkbox handlers.

The reader measures the normal viewport at the full available figure-column
width. It calculates height from the loaded source image ratio, then caps it to
the available viewport height. There is no fixed portrait, paper or `3 / 4`
ratio. The image contains its complete bounds at default/reset scale, without
cropping or stretching. The legend follows the image region with a small gap.
The viewport still uses `overflow:hidden`: after an intentional zoom, dragging
exposes the enlarged image. Do not stretch the image to fill the frame or add a
second scroll container around the modal image. `.is-interactive` describes
direct interaction presentation, not a toggle state.

Image wheel gestures prevent simultaneous reading scroll. Normal non-image
wheel gestures are left untouched. The open modal absorbs wheel over its toolbar
and empty edges to keep the underlying article fixed; those areas do not zoom
the image. Focused image viewports accept `+`, `-`, `0`, and arrow keys. Modal
shortcuts also work from its toolbar; Escape closes it.

## Contain fit and current zoom

Both views use relative zoom around a complete contain-fit base. Their available
areas differ, so their absolute source-pixel sizes need not be equal:

|View|Scale and reset contract|
|---|---|
|Normal figure|Base scale is the minimum of available width/source width and available height/source height, with no added image padding. It opens and switches at relative `1`; `#figure-fit`, labeled “适应”, `fitFigure()` and key `0` restore the complete image and center it. Relative `0.5–8` means 50%–800% of contain fit, not source-pixel scale.|
|Modal|Base scale contains the complete image within the viewport with an 8px inset on each edge. It opens at relative `1`; `#zoom-fit`, `fitZoom()` and key `0` restore this contain fit. Its `0.5–8` range is relative to that fitted base, so its absolute source-pixel scale can differ from 1.|

The normal percentage and number input show the current relative fit multiplier;
100% and `1` mean complete fit, not one source pixel per CSS pixel. Both views
preserve aspect ratio. Pan bounds retain
the complete image on smaller axes and fill the viewport on oversized axes;
pointer anchoring can therefore be constrained at a boundary.

Changing the number input changes only the current normal image and centers it
at that multiplier. It does not update paper settings, local preferences, future
figures or HTML defaults. A different selection, including a revisit, starts at
complete fit; rerendering the same current figure can preserve its view. An
explicit manual selection also calls `fitFigure()`. Language changes, column
resizing and viewport resizing retain the current relative scale and natural
image point at the center, subject to pan bounds and a recalculated fit base.
Image loading and temporarily hidden mobile viewports are handled through `load`
and `ResizeObserver`. Call `refresh()` after custom layout changes.

The reader uses `figureScaleSchema: 3` and a compatible `figureInitialScale: 1`
in its runtime data. It ignores legacy initial-scale values and does not read or
write old display-preference storage. Neither current zoom nor pan is persisted.

Browser evidence may read `data-image-scale` (relative scale),
`data-image-pixel-scale` (source-pixel scale), and `data-image-scale-basis`
(`contain-fit`) on a viewport/image, plus
`data-image-pan-x/y` on the viewport. The normal scale output displays the
relative contain-fit percentage. These attributes never modify source image bytes or
paper text. A snapshot includes `relative`, `pixelScale`, `scaleBasis`,
`centerX`, and `centerY`.

## Modal lifecycle

Clicking the modal image or toolbar retains the dialog. Clicking fresh blank
stage space, an edge or backdrop closes it. A pointer-capture gesture's generated
click is consumed so a drag cannot accidentally close the dialog. A fresh
pointer gesture clears this guard. Opening records `window.scrollX/Y` and focus;
closing restores both and the exact inline properties used for temporary scroll
lock, without scrolling a previously focused control into view.

Public image-controller methods: `mountFigure`, `openZoom`, `fitFigure`, `fitZoom`, `zoomBy`,
`closeZoom`, `refresh`, and `destroy`.

## Three columns and canonical content

`column-layout.js` exposes `MicroPaperColumns.create({root,reader,settings,onResize})`.
Load its CSS after the base stylesheet and initialize once. It creates missing
`#sidebar-splitter` and `#figure-splitter` nodes at the correct boundaries; an
existing node with the same ID is reused. `settings` accepts `sidebarWidth`
(number or null) and `articleFraction` (0–1); it does not read storage.
`onResize` should remeasure the toolbar/figure viewport and refresh image views.
After a view switch, call `columns.refresh()`; the module also observes hidden
state. Methods are `refresh`, `reset`, `destroy`, `getState`, and `getSettings`.
Destroy removes listeners, observers, pending frames and drag state and restores
the supplied DOM's previous attributes/variables. See [display settings](reader-settings.md).

Canonical captions remain unique in the right green legend area, with the same
font family, size and line height as the corresponding language's body text.
Moving their display does not change stable IDs, text, source links, selection,
notes, search or figure-reference navigation. A generated section title is
omitted only when the section's first visible source heading matches both
section titles after whitespace normalization. The canonical heading remains.
Article-info styles apply only to mapped metadata fields, not body or legend
text. Canonical title blocks appear above the label/value rows. Metadata uses a
narrow label and wide value column on desktop and mobile; authors and
affiliations wrap in full without folding or truncation. Empty structured values
do not create empty rows. Unknown source prose, source buttons, canonical IDs,
formatting and note coordinates remain intact.

## Complete original PDF

`original-pdf.js` runs before `reader.js` and exposes
`MicroPaperOriginalPdf.create({paper,frame,fallback,loading,downloadLink})` with
`ensure`, `showPage`, `showFallback`, and `destroy`. “原pdf” uses the embedded
complete `paper.sourcePdf` through an offline Blob URL and a native PDF iframe;
the download link retains the original PDF bytes. It no longer uses a one-page
image selector or source-page image zoom controls.

`ensure()` initializes lazily. `showPage(pageId)` uses a fresh Blob URL for each
valid native page request while reusing the already decoded PDF Blob. The reader
calls it before switching into the source view, so a first noninitial page
request goes directly to that target instead of first opening page one. On load,
old URLs are released; page-number evidence must still come from the native
viewer's real page counter. An outer `#page` fragment, dataset value or load event
alone does not prove a page jump.

A disabled native PDF viewer, PDF-data/Blob error,
iframe error, or explicit `showFallback()` opens all `paper.pages` as ordered,
continuous raster page images with page numbers. A requested valid page remains
the target through fallback. Unknown page IDs are ignored before initialization.
`destroy()` removes listeners, cancels pending fallback scrolling and revokes the
Blob URLs and releases the decoded Blob reference; later fallback calls do not
reopen the view. The fallback is a raster
representation, not native PDF searchable text or vector rendering. There is no
timeout detector for silent native-viewer failure; an iframe load event alone
does not prove PDF pages were rendered.

DOM-stub unit tests verify controller logic, and the actual-template packaging
test verifies script/data wiring. Neither proves browser PDF rendering or real
image interaction. Actual offline wheel/pointer actions, source-byte hash
comparisons, complete native PDF and fallback checks, actual source-button jumps
verified against the native PDF counter, and individually inspected
screenshots remain necessary. The reading page has no visible QA status or report
dialog; full diagnostic data remains embedded and in the independent QA report.
See [QA gates and evidence boundaries](qa.md).
