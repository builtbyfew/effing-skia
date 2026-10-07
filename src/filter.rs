use std::num::ParseFloatError;

use cssparser::{Parser, Token};
use cssparser_color::{Color, hsl_to_rgb, hwb_to_rgb};
use nom::{
  Err,
  IResult,
  Parser as NomParser,
  branch::alt,
  // effing: function names and units are case-insensitive, as in CSS
  bytes::complete::tag_no_case as tag,
  error::{Error, ErrorKind},
};
use rgb::RGBA;
use thiserror::Error;

use crate::sk::{ImageFilter, degrees_to_radians};

#[derive(Error, Debug)]
pub enum ParseFilterError<'a> {
  #[error("{0}")]
  Nom(Err<Error<&'a str>>),
  #[error("{0}")]
  ParseFloatError(ParseFloatError),
  #[error("[`{0}`] is not valid unit")]
  UnitParseError(&'a str),
}

impl<'a> From<Err<Error<&'a str>>> for ParseFilterError<'a> {
  fn from(value: Err<Error<&'a str>>) -> Self {
    Self::Nom(value)
  }
}

impl From<ParseFloatError> for ParseFilterError<'_> {
  fn from(value: ParseFloatError) -> Self {
    Self::ParseFloatError(value)
  }
}

#[derive(Debug, PartialEq)]
pub enum CssFilter {
  Blur(f32),
  Brightness(f32),
  Contrast(f32),
  DropShadow(f32, f32, f32, RGBA<u8>),
  Grayscale(f32),
  HueRotate(f32),
  Invert(f32),
  Opacity(f32),
  Saturate(f32),
  Sepia(f32),
}

// effing: only CSS whitespace separates and pads filter functions, where
// `str::trim` also takes U+00A0 and the other Unicode spaces, which Chrome
// rejects.
const CSS_WHITESPACE: [char; 5] = [' ', '\t', '\n', '\r', '\x0C'];

pub(crate) trait CssTrim {
  fn css_trim(&self) -> &str;
}

impl CssTrim for str {
  fn css_trim(&self) -> &str {
    self.trim_matches(CSS_WHITESPACE)
  }
}

// effing: a CSS number at the start of `input`, and what follows it: an
// optional sign, digits with an optional fraction (`.5`, `4.5`, not `4.`), and
// an optional exponent (`4e1`, `1E-3`), which `4em` does not start. Upstream
// cut the number at the first letter, so `blur(4e1px)` was rejected, and read
// `inf` and `NaN` as numbers.
fn css_number(input: &str) -> Option<(f32, &str)> {
  let bytes = input.as_bytes();
  let digits_from = |mut at: usize| {
    while bytes.get(at).is_some_and(u8::is_ascii_digit) {
      at += 1;
    }
    at
  };
  let mut end = usize::from(matches!(bytes.first(), Some(b'+' | b'-')));
  let integer_end = digits_from(end);
  let mut has_digits = integer_end > end;
  end = integer_end;
  if bytes.get(end) == Some(&b'.') && bytes.get(end + 1).is_some_and(u8::is_ascii_digit) {
    end = digits_from(end + 1);
    has_digits = true;
  }
  if !has_digits {
    return None;
  }
  if matches!(bytes.get(end), Some(b'e' | b'E')) {
    let sign = usize::from(matches!(bytes.get(end + 1), Some(b'+' | b'-')));
    if bytes.get(end + 1 + sign).is_some_and(u8::is_ascii_digit) {
      end = digits_from(end + 1 + sign);
    }
  }
  Some((input[..end].parse().ok()?, &input[end..]))
}

fn pixel<'a>(input: &'a str) -> Result<f32, ParseFilterError<'a>> {
  // effing: the number as CSS reads it (`css_number`).
  let input = input.css_trim();
  let (size, unit) = css_number(input).ok_or(ParseFilterError::UnitParseError(input))?;
  let mut size_px = size;
  // effing: units are case-insensitive, as in CSS, and the table is shared
  // with `drop-shadow()`'s lengths.
  match unit.css_trim().to_ascii_lowercase().as_str() {
    "%" => {
      size_px = size * 16.0 / 100.0;
    }
    "" => {
      if size_px != 0f32 {
        return Err(ParseFilterError::UnitParseError("[No unit assigned]"));
      }
    }
    lowercase => match length_px(size, lowercase) {
      Some(px) => size_px = px,
      None => return Err(ParseFilterError::UnitParseError(unit)),
    },
  };

  Ok(size_px)
}

// effing: the length units `pixel` takes, for a lowercase unit. Font-relative
// ones are 16px, not the context's font.
fn length_px(size: f32, unit: &str) -> Option<f32> {
  Some(match unit {
    "em" | "rem" | "pc" => size * 16.0,
    "pt" => size * 4.0 / 3.0,
    "px" => size,
    "in" => size * 96.0,
    "cm" => size * 96.0 / 2.54,
    "mm" => size * 96.0 / 25.4,
    "q" => size * 96.0 / 25.4 / 4.0,
    _ => return None,
  })
}

#[inline(always)]
fn pixel_in_tuple(input: &str) -> IResult<&str, f32> {
  // effing: up to the `)` or the end, which closes it (`close_paren`).
  let end = input.find(')').unwrap_or(input.len());
  let size = pixel(&input[..end]).map_err(|_| Err::Error(Error::new(input, ErrorKind::MapRes)))?;
  Ok((&input[end..], size))
}

// effing: a function's `)`, or the end of the value, which closes what is
// still open, as in CSS: `blur(4px` is `blur(4px)`.
fn close_paren(input: &str) -> IResult<&str, ()> {
  let input = input.trim_start_matches(CSS_WHITESPACE);
  match input.strip_prefix(')') {
    Some(rest) => Ok((rest, ())),
    None if input.is_empty() => Ok((input, ())),
    None => Err(Err::Error(Error::new(input, ErrorKind::Char))),
  }
}

// effing: a negative amount or length is invalid, as in Chrome, which then
// keeps the previous `ctx.filter`; upstream clamped an amount and, for a
// length, built no filter, which took the whole list with it. A value that
// overflows f32 (`opacity(1e40)`, `blur(1e38in)`) is invalid too, where Chrome
// clamps it: it would reach Skia as infinity, which builds nothing.
fn reject_invalid(input: &str, value: f32) -> Result<(), Err<Error<&str>>> {
  if value.is_finite() && value >= 0.0 {
    Ok(())
  } else {
    Err(Err::Error(Error::new(input, ErrorKind::Verify)))
  }
}

fn number_percentage(input: &str) -> IResult<&str, f32> {
  // effing: the number as CSS reads it (`css_number`).
  let input = input.css_trim();
  let (num, input) = css_number(input).ok_or(Err::Error(Error::new(input, ErrorKind::Float)))?;
  if let Ok((input, _)) = tag::<&str, &str, Error<&str>>("%")(input.css_trim()) {
    Ok((input, num / 100.0f32))
  } else {
    Ok((input, num))
  }
}

fn hue_rotate_parser(input: &str) -> IResult<&str, CssFilter> {
  let (rotated_output, _) = tag("hue-rotate(")(input)?;
  // effing: no angle is 0, as in Chrome.
  if let Ok((rest, ())) = close_paren(rotated_output) {
    return Ok((rest.css_trim(), CssFilter::HueRotate(0.0)));
  }
  // effing: the number as CSS reads it (`css_number`).
  let rotated_output = rotated_output.css_trim();
  let (angle, rotated_output) =
    css_number(rotated_output).ok_or(Err::Error(Error::new(rotated_output, ErrorKind::Float)))?;
  if !angle.is_finite() {
    return Err(Err::Error(Error::new(rotated_output, ErrorKind::Verify))); // effing
  }
  let output = rotated_output.css_trim();
  let (output, filter) = if let Ok((output, _)) = tag::<&str, &str, Error<&str>>("deg")(output) {
    (output, CssFilter::HueRotate(angle))
  } else if let Ok((output, _)) = tag::<&str, &str, Error<&str>>("turn")(output) {
    (output, CssFilter::HueRotate(angle.fract() * 360.0))
  } else if let Ok((output, _)) = tag::<&str, &str, Error<&str>>("rad")(output) {
    (output, CssFilter::HueRotate(angle.to_degrees()))
  } else if let Ok((output, _)) = tag::<&str, &str, Error<&str>>("grad")(output) {
    (output, CssFilter::HueRotate(angle * 0.9))
  } else if angle == 0.0 {
    (output, CssFilter::HueRotate(0.0f32))
  } else {
    // effing: only a zero angle may go without a unit, as in Chrome; upstream
    // read `hue-rotate(90)` as `hue-rotate(0)`.
    return Err(Err::Error(Error::new(output, ErrorKind::Verify)));
  };
  let (finished_input, _) = close_paren(output)?; // effing
  Ok((finished_input.css_trim(), filter))
}

macro_rules! percentage_parser {
  ($filter_name:ident, $filter_rule:expr, $filter_value:ident) => {
    fn $filter_name(input: &str) -> IResult<&str, CssFilter> {
      let (input, _) = tag($filter_rule)(input)?;
      let (input, value) = number_percentage(input)?;
      reject_invalid(input, value)?; // effing
      let (input, _) = close_paren(input)?; // effing
      Ok((input.css_trim(), CssFilter::$filter_value(value)))
    }

    mod $filter_name {
      #[test]
      fn $filter_name() {
        use super::CssFilter;
        assert_eq!(
          super::$filter_name(concat!($filter_rule, "2)")),
          Ok(("", CssFilter::$filter_value(2.0f32)))
        );
        assert_eq!(
          super::$filter_name(concat!($filter_rule, "2%)")),
          Ok(("", CssFilter::$filter_value(0.02f32)))
        );
        assert_eq!(
          super::$filter_name(concat!($filter_rule, ".2)")),
          Ok(("", CssFilter::$filter_value(0.2f32)))
        );
        assert_eq!(
          super::$filter_name(concat!($filter_rule, " 2%)")),
          Ok(("", CssFilter::$filter_value(0.02f32)))
        );

        assert_eq!(
          super::$filter_name(concat!($filter_rule, " 2% )")),
          Ok(("", CssFilter::$filter_value(0.02f32)))
        );

        assert_eq!(
          super::$filter_name(concat!($filter_rule, " 2 % )")),
          Ok(("", CssFilter::$filter_value(0.02f32)))
        );

        assert_eq!(
          super::$filter_name(concat!($filter_rule, " 2 % )  ")),
          Ok(("", CssFilter::$filter_value(0.02f32)))
        );
      }
    }
  };
}

percentage_parser!(brightness_parser, "brightness(", Brightness);
percentage_parser!(contrast_parser, "contrast(", Contrast);
percentage_parser!(grayscale_parser, "grayscale(", Grayscale);
percentage_parser!(invert_parser, "invert(", Invert);
percentage_parser!(opacity_parser, "opacity(", Opacity);
percentage_parser!(saturate_parser, "saturate(", Saturate);
percentage_parser!(sepia_parser, "sepia(", Sepia);

fn blur_parser(input: &str) -> IResult<&str, CssFilter> {
  let (blurred_input, _) = tag("blur(")(input)?;

  let (blurred_input, pixel) = pixel_in_tuple(blurred_input)?;
  reject_invalid(blurred_input, pixel)?; // effing
  let (finished_input, _) = close_paren(blurred_input)?; // effing
  Ok((finished_input.css_trim(), CssFilter::Blur(pixel)))
}

// effing: `drop-shadow( [<color>]? && [<length>{2} <length [0,∞]>?] )`, read
// with cssparser between balanced parentheses: the colour before or after the
// lengths, any colour function inside, and anything else invalid, where
// upstream took the colour only after the lengths, cut it at the first `)`
// unless it was `rgb()`/`rgba()`, and drew black for what it could not read.
fn drop_shadow_parser(input: &str) -> IResult<&str, CssFilter> {
  let invalid = || Err::Error(Error::new(input, ErrorKind::Verify));
  let (args, _) = tag("drop-shadow(")(input)?;
  let mut depth = 1usize;
  let close = args
    .char_indices()
    .find(|&(_, ch)| {
      match ch {
        '(' => depth += 1,
        ')' => depth -= 1,
        _ => {}
      }
      depth == 0
    })
    .map(|(index, _)| index);
  // The end of the value closes what is still open.
  let (args, rest) = match close {
    Some(close) => (&args[..close], &args[close + 1..]),
    None => (args, ""),
  };

  let mut parser = Parser::new(args);
  let mut lengths: Vec<f32> = Vec::with_capacity(3);
  let mut color = None;
  // The lengths are one run, before or after the colour.
  let mut lengths_closed = false;
  while !parser.is_exhausted() {
    let length = parser.try_parse(|parser| match *parser.next().map_err(|_| ())? {
      Token::Dimension {
        value, ref unit, ..
      } => length_px(value, &unit.to_ascii_lowercase()).ok_or(()),
      Token::Number { value: 0.0, .. } => Ok(0.0),
      _ => Err(()),
    });
    match length {
      Ok(_) if lengths_closed => return Err(invalid()),
      Ok(length) => lengths.push(length),
      Err(()) if color.is_none() => {
        let parsed = Color::parse(&mut parser).map_err(|_| invalid())?;
        color = Some(css_color_to_rgba(parsed).ok_or_else(invalid)?);
        lengths_closed = !lengths.is_empty();
      }
      Err(()) => return Err(invalid()),
    }
  }
  let &[offset_x, offset_y, ref blur @ ..] = lengths.as_slice() else {
    return Err(invalid());
  };
  let blur_radius = match *blur {
    [] => 0.0,
    [blur] => blur,
    _ => return Err(invalid()),
  };
  // A negative offset is fine. One that overflows f32 (`1e38in`) is invalid,
  // where Chrome clamps it, as is a negative or overflowing blur.
  if !offset_x.is_finite() || !offset_y.is_finite() {
    return Err(invalid());
  }
  reject_invalid(input, blur_radius)?;
  // No colour is `currentcolor`, the canvas element's `color`, black unless
  // styled; this canvas has no element to style.
  let shadow_color = color.unwrap_or(RGBA::new(0, 0, 0, 255));
  Ok((
    rest.css_trim(),
    CssFilter::DropShadow(offset_x, offset_y, blur_radius, shadow_color),
  ))
}

// effing: the colours the rest of the context takes (`rgb()`, `hsl()`, hex,
// names, `transparent`), with `hwb()` and `currentcolor` (black, see above);
// `None` for `lab()`, `lch()`, `oklab()`, `oklch()` and `color()`.
fn css_color_to_rgba(color: Color) -> Option<RGBA<u8>> {
  let channel = |value: f32| (value.clamp(0.0, 1.0) * 255.0).round() as u8;
  let hue = |hue: Option<f32>| hue.unwrap_or(0.0).rem_euclid(360.0) / 360.0;
  let (r, g, b, a) = match color {
    Color::CurrentColor => (0.0, 0.0, 0.0, 1.0),
    Color::Rgba(rgba) => {
      return Some(RGBA::new(
        rgba.red,
        rgba.green,
        rgba.blue,
        channel(rgba.alpha),
      ));
    }
    Color::Hsl(hsl) => {
      let (r, g, b) = hsl_to_rgb(
        hue(hsl.hue),
        hsl.saturation.unwrap_or(0.0).clamp(0.0, 1.0),
        hsl.lightness.unwrap_or(0.0).clamp(0.0, 1.0),
      );
      (r, g, b, hsl.alpha.unwrap_or(1.0))
    }
    Color::Hwb(hwb) => {
      let (r, g, b) = hwb_to_rgb(
        hue(hwb.hue),
        hwb.whiteness.unwrap_or(0.0).clamp(0.0, 1.0),
        hwb.blackness.unwrap_or(0.0).clamp(0.0, 1.0),
      );
      (r, g, b, hwb.alpha.unwrap_or(1.0))
    }
    _ => return None,
  };
  Some(RGBA::new(channel(r), channel(g), channel(b), channel(a)))
}

pub fn css_filter(input: &str) -> IResult<&str, Vec<CssFilter>> {
  let mut filters = Vec::with_capacity(10);
  let mut input = input.css_trim(); // effing: CSS whitespace only
  while let Ok((output, filter)) = alt((
    blur_parser,
    brightness_parser,
    contrast_parser,
    drop_shadow_parser,
    grayscale_parser,
    hue_rotate_parser,
    invert_parser,
    opacity_parser,
    saturate_parser,
    sepia_parser,
  ))
  .parse(input)
  {
    input = output;
    filters.push(filter);
  }

  Ok((input, filters))
}

/// Fold a parsed `<filter-value-list>` into one chained `SkImageFilter`, or
/// `None` when the list produces no filter at all.
///
/// `None` is the only representation of "no filter" this may return, and the
/// chain is threaded as an `Option` so that an empty list yields it by
/// construction. A null `ImageFilter` here would reach
/// `skiac_paint_set_image_filter` on the next draw and segfault.
pub(crate) fn css_filters_to_image_filter(filters: Vec<CssFilter>) -> Option<ImageFilter> {
  let mut chain: Option<ImageFilter> = None;
  for f in filters {
    // effing: a step that builds no filter is skipped, as an identity step,
    // rather than taking the whole list with it. The parsers keep out the
    // values Skia rejects (a negative sigma, a non-finite matrix, where
    // `SkImageFilters::ColorFilter` hands back its input, null at the start).
    let next = match f {
      CssFilter::Blur(blur) => ImageFilter::make_blur(blur, blur, chain.as_ref()),
      CssFilter::Brightness(brightness) => {
        let brightness = brightness.max(0.0);
        ImageFilter::make_image_filter(
          brightness,
          0.0,
          0.0,
          0.0,
          brightness,
          0.0,
          0.0,
          0.0,
          brightness,
          1.0,
          chain.as_ref(),
        )
      }
      CssFilter::Contrast(contrast) => {
        let amt = contrast.max(0.0);
        let mut ramp = [0u8; 256];
        ramp.iter_mut().take(256).enumerate().for_each(|(i, v)| {
          let orig = i as f32;
          *v = (127.0 + amt * (orig - 127.0)) as u8;
        });
        let ramp = Some(&ramp);
        ImageFilter::from_argb(None, ramp, ramp, ramp, chain.as_ref())
      }
      CssFilter::DropShadow(offset_x, offset_y, blur_radius, shadow_color) => {
        // effing: the blur length is the standard deviation (Filter Effects 1,
        // `drop-shadow()`), as in `blur()` and Chrome. `shadowBlur` halves it.
        let sigma = blur_radius;
        // effing: a transparent shadow draws nothing, so it is skipped; it used
        // to drop the whole list, as `drop-shadow(0 0 0)` did. An unblurred,
        // unshifted shadow still shows where the content is translucent.
        if shadow_color.a == 0 {
          continue;
        }
        ImageFilter::make_drop_shadow(
          offset_x,
          offset_y,
          sigma,
          sigma,
          ((shadow_color.a as u32) << 24)
            | ((shadow_color.r as u32) << 16)
            | ((shadow_color.g as u32) << 8)
            | shadow_color.b as u32,
          chain.as_ref(),
        )
      }
      CssFilter::Grayscale(amt) => {
        let amt = 1.0 - amt.clamp(0.0, 1.0);
        ImageFilter::make_image_filter(
          0.2126 + 0.7874 * amt,
          0.7152 - 0.7152 * amt,
          0.0722 - 0.0722 * amt,
          0.2126 - 0.2126 * amt,
          0.7152 + 0.2848 * amt,
          0.0722 - 0.0722 * amt,
          0.2126 - 0.2126 * amt,
          0.7152 - 0.7152 * amt,
          0.0722 + 0.9278 * amt,
          1.0,
          chain.as_ref(),
        )
      }
      CssFilter::HueRotate(angle) => {
        let cos = degrees_to_radians(angle).cos();
        let sin = degrees_to_radians(angle).sin();
        ImageFilter::make_image_filter(
          0.213 + cos * 0.787 - sin * 0.213,
          0.715 - cos * 0.715 - sin * 0.715,
          0.072 - cos * 0.072 + sin * 0.928,
          0.213 - cos * 0.213 + sin * 0.143,
          0.715 + cos * 0.285 + sin * 0.140,
          0.072 - cos * 0.072 - sin * 0.283,
          0.213 - cos * 0.213 - sin * 0.787,
          0.715 - cos * 0.715 + sin * 0.715,
          0.072 + cos * 0.928 + sin * 0.072,
          1.0,
          chain.as_ref(),
        )
      }
      CssFilter::Invert(amt) => {
        let amt = amt.clamp(0.0, 1.0);
        let mut ramp = [0u8; 256];
        ramp
          .iter_mut()
          .take(256)
          .enumerate()
          .map(|(i, v)| (i as f32, v))
          .for_each(|(i, val)| {
            let (orig, inv) = (i, 255.0 - i);
            *val = (orig * (1.0 - amt) + inv * amt) as u8;
          });
        let ramp = Some(&ramp);
        ImageFilter::from_argb(None, ramp, ramp, ramp, chain.as_ref())
      }
      CssFilter::Opacity(opacity) => {
        let opacity = opacity.clamp(0.0, 1.0);
        ImageFilter::make_image_filter(
          1.0,
          0.0,
          0.0,
          0.0,
          1.0,
          0.0,
          0.0,
          0.0,
          1.0,
          opacity,
          chain.as_ref(),
        )
      }
      CssFilter::Saturate(amt) => {
        let amt = amt.max(0.0);
        ImageFilter::make_image_filter(
          0.2126 + 0.7874 * amt,
          0.7152 - 0.7152 * amt,
          0.0722 - 0.0722 * amt,
          0.2126 - 0.2126 * amt,
          0.7152 + 0.2848 * amt,
          0.0722 - 0.0722 * amt,
          0.2126 - 0.2126 * amt,
          0.7152 - 0.7152 * amt,
          0.0722 + 0.9278 * amt,
          1.0,
          chain.as_ref(),
        )
      }
      CssFilter::Sepia(amt) => {
        let amt = 1.0 - amt.clamp(0.0, 1.0);
        ImageFilter::make_image_filter(
          0.393 + 0.607 * amt,
          0.769 - 0.769 * amt,
          0.189 - 0.189 * amt,
          0.349 - 0.349 * amt,
          0.686 + 0.314 * amt,
          0.168 - 0.168 * amt,
          0.272 - 0.272 * amt,
          0.534 - 0.534 * amt,
          0.131 + 0.869 * amt,
          1.0,
          chain.as_ref(),
        )
      }
    };
    if next.is_some() {
      chain = next; // effing: `Some(next?)`, see above
    }
  }
  chain
}

#[test]
fn parse_empty() {
  assert_eq!(css_filter(""), Ok(("", vec![])));
}

#[test]
fn empty_filter_list_is_no_filter_not_a_null_one() {
  // Pins the `Option` chain: an empty list must produce `None`, not a
  // `Some(ImageFilter(null))` that the next draw would dereference.
  assert!(css_filters_to_image_filter(vec![]).is_none());
}

#[test]
fn leftover_input_is_the_all_or_nothing_gate() {
  // `css_filter` never returns `Err`; anything it cannot read comes back as
  // leftover input, which `Context::set_filter` uses as Blink's
  // `!stream.AtEnd()` gate. So every accepted value must leave nothing behind...
  for input in [
    "blur(3px)",
    "blur(3px) grayscale(50%)",
    "contrast(175%) brightness(103%)",
    "drop-shadow(16px 16px 10px black)",
    "hue-rotate(90deg)",
    "opacity(20%)",
    "saturate(200%)",
    "sepia(100%)",
    "invert(100%)",
    " blur(3px) ",
  ] {
    let (rest, filters) = css_filter(input).unwrap();
    assert_eq!(rest.trim(), "", "`{input}` should be consumed whole");
    assert!(!filters.is_empty(), "`{input}` should parse to a filter");
  }

  // ...and every rejected value must be visibly rejected, by leaving junk
  // behind or by parsing to nothing at all.
  for input in [
    "", "   ", "garbage", "inherit", "initial", "unset", "revert", "none",
  ] {
    let (rest, filters) = css_filter(input).unwrap();
    assert!(
      filters.is_empty(),
      "`{input}` should not parse to any filter"
    );
    assert_eq!(rest, input.trim_start(), "`{input}` should be left unread");
  }

  // Greedy parsing DOES read the valid prefix, so the leftover is the only
  // thing telling the setter to reject the assignment.
  assert_eq!(
    css_filter("blur(3px) notafilter(1)"),
    Ok(("notafilter(1)", vec![CssFilter::Blur(3.0)]))
  );
}

#[test]
fn parse_blur() {
  assert_eq!(
    css_filter("blur(20px)"),
    Ok(("", vec![CssFilter::Blur(20.0)]))
  );
  assert_eq!(css_filter("blur(0)"), Ok(("", vec![CssFilter::Blur(0.0)])));
  assert_eq!(
    css_filter("blur(1.5rem)"),
    Ok(("", vec![CssFilter::Blur(24.0)]))
  );
  assert_eq!(
    css_filter("blur(20 px)"),
    Ok(("", vec![CssFilter::Blur(20.0)]))
  );
  assert_eq!(
    css_filter("blur( 20 px )"),
    Ok(("", vec![CssFilter::Blur(20.0)]))
  );
}

#[test]
fn drop_shadow_parse() {
  assert_eq!(
    drop_shadow_parser("drop-shadow(2px 2px)"),
    Ok((
      "",
      CssFilter::DropShadow(2.0f32, 2.0f32, 0.0f32, RGBA::new(0, 0, 0, 255))
    ))
  );
  assert_eq!(
    drop_shadow_parser("drop-shadow(2px 2px 5px)"),
    Ok((
      "",
      CssFilter::DropShadow(2.0f32, 2.0f32, 5.0f32, RGBA::new(0, 0, 0, 255))
    ))
  );

  assert_eq!(
    drop_shadow_parser("drop-shadow(2px 2px 5px #2F14DF)"),
    Ok((
      "",
      CssFilter::DropShadow(2.0f32, 2.0f32, 5.0f32, RGBA::new(47, 20, 223, 255))
    ))
  );

  assert_eq!(
    drop_shadow_parser("drop-shadow(2px 2px 5px rgba(47, 20, 223, 255))"),
    Ok((
      "",
      CssFilter::DropShadow(2.0f32, 2.0f32, 5.0f32, RGBA::new(47, 20, 223, 255))
    ))
  );
}

#[test]
fn composite_parse() {
  assert_eq!(
    css_filter("blur(1.5rem) brightness(2)"),
    Ok((
      "",
      vec![CssFilter::Blur(24.0), CssFilter::Brightness(2.0f32)]
    ))
  );

  assert_eq!(
    css_filter("brightness(2) blur(1.5rem)"),
    Ok((
      "",
      vec![CssFilter::Brightness(2.0f32), CssFilter::Blur(24.0)]
    ))
  );

  assert_eq!(
    css_filter("drop-shadow(2px 2px 5px rgba(47, 20, 223, 255)) brightness(2) blur(1.5rem)"),
    Ok((
      "",
      vec![
        CssFilter::DropShadow(2.0f32, 2.0f32, 5.0f32, RGBA::new(47, 20, 223, 255)),
        CssFilter::Brightness(2.0f32),
        CssFilter::Blur(24.0)
      ]
    ))
  );

  assert_eq!(
    css_filter("brightness(2) drop-shadow(2px 2px 5px rgba(47, 20, 223, 255)) blur(1.5rem)"),
    Ok((
      "",
      vec![
        CssFilter::Brightness(2.0f32),
        CssFilter::DropShadow(2.0f32, 2.0f32, 5.0f32, RGBA::new(47, 20, 223, 255)),
        CssFilter::Blur(24.0)
      ]
    ))
  );

  assert_eq!(
    css_filter("brightness(2) blur(1.5rem) drop-shadow(2px 2px 5px rgba(47, 20, 223, 255))"),
    Ok((
      "",
      vec![
        CssFilter::Brightness(2.0f32),
        CssFilter::Blur(24.0),
        CssFilter::DropShadow(2.0f32, 2.0f32, 5.0f32, RGBA::new(47, 20, 223, 255)),
      ]
    ))
  );
}

#[test]
fn hue_rotate_parse() {
  assert_eq!(
    hue_rotate_parser("hue-rotate(0)"),
    Ok(("", CssFilter::HueRotate(0.0f32)))
  );
  assert_eq!(
    hue_rotate_parser("hue-rotate(90deg)"),
    Ok(("", CssFilter::HueRotate(90.0f32)))
  );
  assert_eq!(
    hue_rotate_parser("hue-rotate(-0.25turn)"),
    Ok(("", CssFilter::HueRotate(-90.0f32)))
  );
  assert_eq!(
    hue_rotate_parser("hue-rotate(3.141592653rad)"),
    Ok(("", CssFilter::HueRotate(180.0f32)))
  );
}

#[test]
fn parse_number_or_percentage() {
  assert_eq!(number_percentage("2"), Ok(("", 2f32)));
  assert_eq!(number_percentage("1.11"), Ok(("", 1.11f32)));
  assert_eq!(number_percentage("20%"), Ok(("", 0.2f32)));
  assert_eq!(number_percentage("-20%"), Ok(("", -0.2f32)));
  assert_eq!(number_percentage("-0.1"), Ok(("", -0.1f32)));
}

#[test]
fn negative_and_non_finite_values_are_left_unread() {
  // effing: as in Chrome, which then keeps the previous filter.
  for input in [
    "blur(-1px)",
    "drop-shadow(0 0 -2px red)",
    "brightness(-1)",
    "contrast(-50%)",
    "grayscale(-1)",
    "invert(-1)",
    "opacity(-1)",
    "saturate(-1)",
    "sepia(-1)",
    "opacity(inf)",
    "opacity(NaN)",
    "hue-rotate(infdeg)",
    "blur(1e38in)",
    "drop-shadow(1e38in 0 red)",
    "drop-shadow(0 -1e38in red)",
    "hue-rotate(90)",
    "drop-shadow(4px red 4px)",
    "drop-shadow(4px 4px 2px nosuchcolor)",
    "drop-shadow(4px 4px 2px 1px)",
    "drop-shadow(4px 4px 2px red 1px)",
    "drop-shadow(4px 4px 2px red blue)",
    "drop-shadow(4px)",
    "drop-shadow(red)",
    "drop-shadow(4px 4px 2px lab(50% 40 59))",
  ] {
    let (rest, filters) = css_filter(input).unwrap();
    assert!(filters.is_empty(), "`{input}` should not parse to a filter");
    assert_eq!(rest, input, "`{input}` should be left unread");
  }
  // A negative offset or angle is fine.
  for input in ["drop-shadow(-2px -3px 1px red)", "hue-rotate(-90deg)"] {
    assert_eq!(css_filter(input).unwrap().0, "", "`{input}` should be read");
  }
}

#[test]
fn transparent_drop_shadow_is_skipped_not_the_whole_list() {
  // effing: it used to return `None` for the whole list.
  let transparent = || CssFilter::DropShadow(0.0, 0.0, 0.0, RGBA::new(255, 0, 0, 0));
  assert!(css_filters_to_image_filter(vec![transparent()]).is_none());
  let filter = css_filters_to_image_filter(vec![transparent(), CssFilter::Blur(2.0)]).unwrap();
  assert!(filter.needs_device_space_layer());
  let unshifted = CssFilter::DropShadow(0.0, 0.0, 0.0, RGBA::new(255, 0, 0, 255));
  assert!(css_filters_to_image_filter(vec![unshifted, CssFilter::Grayscale(1.0)]).is_some());
}

#[test]
fn drop_shadow_colour_before_or_after_any_colour_function() {
  // effing: as in Chrome.
  let green = RGBA::new(0, 128, 0, 255);
  for input in [
    "drop-shadow(4px 4px 2px rgb(0, 128, 0))",
    "drop-shadow(rgb(0, 128, 0) 4px 4px 2px)",
    "drop-shadow(4px 4px 2px hsl(120, 100%, 25%))",
    "drop-shadow(hsl(120deg 100% 25%) 4px 4px 2px)",
    "drop-shadow(4px 4px 2px hwb(120 0% 50%))",
    "DROP-SHADOW(4PX 4px 2Px #008000)",
  ] {
    assert_eq!(
      css_filter(input),
      Ok(("", vec![CssFilter::DropShadow(4.0, 4.0, 2.0, green)])),
      "`{input}`"
    );
  }
  assert_eq!(
    css_filter("drop-shadow(hsla(0, 0%, 0%, 0) 1px 2px) blur(1px)"),
    Ok((
      "",
      vec![
        CssFilter::DropShadow(1.0, 2.0, 0.0, RGBA::new(0, 0, 0, 0)),
        CssFilter::Blur(1.0)
      ]
    ))
  );
  assert_eq!(
    css_filter("hue-rotate(0) HUE-ROTATE(90DEG)"),
    Ok((
      "",
      vec![CssFilter::HueRotate(0.0), CssFilter::HueRotate(90.0)]
    ))
  );
}

#[test]
fn css_numbers_with_exponents_and_without_trailing_dots() {
  // effing: as CSS reads them.
  assert_eq!(css_number("4e1px"), Some((40.0, "px")));
  assert_eq!(css_number("1E-1%"), Some((0.1, "%")));
  assert_eq!(css_number("4em"), Some((4.0, "em")));
  assert_eq!(css_number("-.5px"), Some((-0.5, "px")));
  assert_eq!(css_number("+2"), Some((2.0, "")));
  assert_eq!(css_number("4.px"), Some((4.0, ".px")));
  assert_eq!(css_number("."), None);
  assert_eq!(css_number("inf"), None);
  assert_eq!(css_number("NaN"), None);
  assert_eq!(
    css_filter("blur(4e1px)"),
    Ok(("", vec![CssFilter::Blur(40.0)]))
  );
  assert_eq!(
    css_filter("hue-rotate()"),
    Ok(("", vec![CssFilter::HueRotate(0.0)]))
  );
  assert_eq!(css_filter("blur(4px"), Ok(("", vec![CssFilter::Blur(4.0)])));
  for input in ["blur(4.px)", "opacity(1.)"] {
    assert_eq!(
      css_filter(input).unwrap().0,
      input,
      "`{input}` should be left unread"
    );
  }
}

#[test]
fn only_css_whitespace_separates_filters() {
  // effing: U+00A0 and the other Unicode spaces are not CSS whitespace.
  assert_eq!(
    css_filter("\x0Cblur(1px)\r\n\tgrayscale(1)\n"),
    Ok(("", vec![CssFilter::Blur(1.0), CssFilter::Grayscale(1.0)]))
  );
  assert_eq!(
    css_filter("blur(1px)\u{a0}grayscale(1)"),
    Ok(("\u{a0}grayscale(1)", vec![CssFilter::Blur(1.0)]))
  );
  assert_eq!("\u{a0}none\u{2003}".css_trim(), "\u{a0}none\u{2003}");
}
