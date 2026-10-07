// Effing's additions to @napi-rs/canvas. They live in this separate entry so
// the main entry stays a drop-in for upstream. See docs/effing.md.
import type { SKRSContext2D } from './index'

export interface GroupOptions {
  /** Group opacity, 0 to 1 (clamped). Defaults to 1. */
  opacity?: number
  /** A `globalCompositeOperation` value, e.g. `multiply`. Defaults to `source-over`. */
  blendMode?: string
  /** A CSS `filter` value applied to the whole group. */
  filter?: string
  /** A CSS `filter` value applied to the content behind the group, which the group starts from. */
  backdropFilter?: string
  /** `[x, y, width, height]` in the current coordinate space: a size hint that also clips the group's content. */
  bounds?: [number, number, number, number]
}

/**
 * Starts a compositing group on `ctx`: everything drawn until the matching
 * `endGroup(ctx)` is composited as one with the group's opacity, blend mode
 * and filter. Saves the context state like `save()`. Throws on invalid
 * options, and on an SVG canvas for a group that composites (anything but
 * opacity 1, `source-over` and no filters): Skia's SVG device has no layers.
 */
export function beginGroup(ctx: SKRSContext2D, options?: GroupOptions): void
/** Ends the innermost group on `ctx`, compositing it. Throws if the innermost save is not a group. */
export function endGroup(ctx: SKRSContext2D): void

export interface ParagraphStyle {
  /** CSS font-family list, e.g. `"Inter", sans-serif`. */
  fontFamily: string
  /** In px; a finite number > 0. */
  fontSize: number
  /** Defaults to 400. */
  fontWeight?: number
  fontStyle?: 'normal' | 'italic' | 'oblique'
  letterSpacing?: number
  /**
   * Line box height in px, rounded to 1/64px as Chrome lays it out, where 0
   * collapses the line boxes; omitted or null for `normal` (hhea ascent +
   * descent). The baseline sits Chrome's half-leading below each line's top:
   * `round(ascent) + floor((lineHeight - round(ascent) - round(descent)) / 2)`.
   */
  lineHeight?: number | null
  /** `start` and `end` follow `direction`. Defaults to `left`. */
  textAlign?: 'left' | 'right' | 'center' | 'justify' | 'start' | 'end'
  direction?: 'ltr' | 'rtl'
  /** Break only at hard line breaks. */
  noWrap?: boolean
  /** A whole number of lines; 0, Infinity or omitted for unlimited. */
  maxLines?: number
  /** Appended where text is truncated by `maxLines` or `noWrap`, e.g. `…`. */
  ellipsis?: string
  /**
   * Count spaces and tabs before a hard break or the end of the text in the
   * line's `width` and alignment instead of hanging them, and keep those that
   * start a line (at the start of the text or after a hard break) instead of
   * collapsing them away, as CSS `white-space: pre` and `pre-wrap` do. Spaces
   * at a soft wrap still hang.
   */
  keepTrailingWhitespace?: boolean
  /**
   * Where lines may break between letters, as CSS `word-break`: `normal`
   * (the default) between words; `break-all` between any two letters too;
   * `keep-all` never between two letters where one is CJK.
   */
  wordBreak?: 'normal' | 'break-all' | 'keep-all'
  /**
   * A word wider than the line, as CSS `overflow-wrap`: with `normal` (the
   * default) it sits on a line of its own and overflows it; with
   * `break-word` it starts a line of its own and is broken where that line is
   * full.
   */
  overflowWrap?: 'normal' | 'break-word'
}

/**
 * An inline box in a paragraph's text, e.g. for an image or an emoji drawn as
 * one: it takes `width` on its line and draws nothing. It never grows its
 * line box.
 */
export interface ParagraphPlaceholder {
  width: number
  height: number
  /**
   * How the box sits on its line, as CSS `vertical-align`: `baseline` puts its
   * own baseline (`baselineOffset` below its top) on the text's; `middle` puts
   * its middle half the font's x-height above the baseline; `top` and
   * `bottom` align it with the line box; `text-top` and `text-bottom` with
   * the font's ascent and descent, rounded to whole pixels as in Chrome.
   * Defaults to `baseline`.
   */
  verticalAlign?: 'baseline' | 'middle' | 'top' | 'bottom' | 'text-top' | 'text-bottom' | null
  /** For `baseline`: from the box's top down to its own baseline. Defaults to `height`, its bottom edge, as for an image. Null means the default. */
  baselineOffset?: number | null
  /**
   * How lines break around the box. `box` (the default), as Chrome breaks them
   * around an inline-block or an image: on either side of it, even before
   * the "!" after it. `emoji`, as Chrome breaks them around an emoji (UAX #14
   * class ID): between it and a letter, a space or another box, but not
   * between it and the punctuation next to it, so `Hi 🎉! ok` breaks as
   * `Hi | 🎉! | ok`. Pass `emoji` for an emoji drawn in the box. Null means
   * the default.
   */
  lineBreak?: 'box' | 'emoji' | null
}

/** A paragraph's text: a string, or strings and inline placeholders in order. */
export type ParagraphContent = string | ReadonlyArray<string | ParagraphPlaceholder>

/** Where layout put a placeholder, from the paragraph's top-left corner. */
export interface ParagraphPlaceholderBox {
  x: number
  y: number
  width: number
  height: number
  /** The index of its line in `lines`. */
  line: number
}

export interface ParagraphLine {
  /** Left edge of the line, alignment included. */
  left: number
  /** Advance width without trailing whitespace (unless `keepTrailingWhitespace` keeps it), letter spacing included. */
  width: number
  /** Baseline, from the top of the paragraph. */
  baseline: number
  /**
   * UTF-16 offsets of the line's text (JS string indices), trailing whitespace
   * excluded unless `keepTrailingWhitespace` keeps it. Each placeholder counts
   * as one unit, as if it were U+FFFC.
   */
  startIndex: number
  endIndex: number
  hardBreak: boolean
}

export interface ParagraphLayout {
  /** `lines.length * lineHeight`. */
  height: number
  longestLine: number
  /**
   * The widest word, or for `noWrap` text the widest line: CSS min-content.
   * Under `break-all` a word is as little as a letter.
   */
  minIntrinsicWidth: number
  /**
   * The widest line between hard breaks, trailing whitespace hanging and,
   * unless `noWrap`, leading spaces and tabs collapsed, unless
   * `keepTrailingWhitespace` keeps them: CSS max-content, whatever the width,
   * `maxLines` and `ellipsis`. Rounded up to 0.01px, so the text laid out at
   * it breaks only at hard breaks.
   */
  maxIntrinsicWidth: number
  didExceedMaxLines: boolean
  /** Every line box is exactly this tall: `lineHeight` in 1/64px. */
  lineHeight: number
  /** The primary font's hhea ascender and descender in px. */
  ascent: number
  descent: number
  /**
   * The primary font's hhea line gap in px at this size, clamped to ≥ 0 (a
   * negative gap is 0, as in Chrome). Not part of `lineHeight`; Chrome's
   * `line-height: normal` is `round(ascent) + round(descent) + round(lineGap)`.
   * Like `ascent` and `descent`, it is the primary font's whatever the text,
   * so an empty paragraph or one of placeholders only reports it too.
   */
  lineGap: number
  lines: ParagraphLine[]
  /** One per placeholder, in order; null for one cut off by `maxLines` or an ellipsis. */
  placeholders: Array<ParagraphPlaceholderBox | null>
}

/**
 * A single-style paragraph laid out natively. Line boxes follow the CSS
 * model (every line exactly `lineHeight` tall, baseline placed by
 * half-leading) and glyphs are painted unhinted and unsnapped, so the text
 * lands in the same place at any raster scale.
 */
export class Paragraph {
  constructor(text: ParagraphContent, style: ParagraphStyle)
  /** Lays the paragraph out in `width` px (non-finite or ≤ 0 for unbounded) and reports its lines. */
  layout(width: number): ParagraphLayout
}

/** Fills a laid-out paragraph's glyphs on `ctx` with its current fill style, the paragraph's top-left corner at (x, y). */
export function fillParagraph(ctx: SKRSContext2D, paragraph: Paragraph, x: number, y: number): void
/** Strokes a laid-out paragraph's glyph outlines on `ctx` with its current stroke style, the paragraph's top-left corner at (x, y). */
export function strokeParagraph(ctx: SKRSContext2D, paragraph: Paragraph, x: number, y: number): void
