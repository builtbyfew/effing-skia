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
  fontSize: number
  /** Defaults to 400. */
  fontWeight?: number
  fontStyle?: 'normal' | 'italic' | 'oblique'
  letterSpacing?: number
  /** Line box height in px, where 0 collapses the line boxes; omitted or null for `normal` (hhea ascent + descent). */
  lineHeight?: number | null
  /** `start` and `end` follow `direction`. Defaults to `left`. */
  textAlign?: 'left' | 'right' | 'center' | 'justify' | 'start' | 'end'
  direction?: 'ltr' | 'rtl'
  /** Break only at hard line breaks. */
  noWrap?: boolean
  /** 0 or omitted for unlimited. */
  maxLines?: number
  /** Appended where text is truncated by `maxLines` or `noWrap`, e.g. `…`. */
  ellipsis?: string
  /**
   * Count spaces and tabs before a hard break or the end of the text in the
   * line's `width` and alignment instead of hanging them, as CSS
   * `white-space: pre` and `pre-wrap` do. Spaces at a soft wrap still hang.
   */
  keepTrailingWhitespace?: boolean
}

/**
 * An inline box in a paragraph's text, e.g. for an image or an emoji drawn as
 * one: it takes `width` on its line, can break from the text on either side,
 * and draws nothing. It never grows its line box.
 */
export interface ParagraphPlaceholder {
  width: number
  height: number
  /**
   * How the box sits on its line, as CSS `vertical-align`: `baseline` puts its
   * own baseline (`baselineOffset` below its top) on the text's; `middle` puts
   * its middle half the font's x-height above the baseline; `top` and
   * `bottom` align it with the line box; `text-top` and `text-bottom` with
   * the font's ascent and descent. Defaults to `baseline`.
   */
  verticalAlign?: 'baseline' | 'middle' | 'top' | 'bottom' | 'text-top' | 'text-bottom'
  /** For `baseline`: from the box's top down to its own baseline. Defaults to `height`, its bottom edge, as for an image. */
  baselineOffset?: number
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
  /** The widest word, or for `noWrap` text the widest line: CSS min-content. */
  minIntrinsicWidth: number
  maxIntrinsicWidth: number
  didExceedMaxLines: boolean
  /** Every line box is exactly this tall. */
  lineHeight: number
  /** The primary font's hhea ascender and descender in px. */
  ascent: number
  descent: number
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
