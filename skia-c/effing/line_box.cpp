// The CSS line model effing's paragraphs share (line_box.hpp).
#include "line_box.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <string>

#include "include/core/SkFont.h"
#include "include/core/SkFontMetrics.h"
#include "include/core/SkFontTypes.h"

namespace effing {

namespace {

int16_t read_be_i16(const uint8_t* p) {
  return static_cast<int16_t>((p[0] << 8) | p[1]);
}

}  // namespace

std::vector<SkString> split_families(const char* font_family) {
  std::vector<SkString> families;
  const std::string list(font_family);
  size_t start = 0;
  while (start <= list.size()) {
    size_t end = list.find(',', start);
    if (end == std::string::npos) {
      end = list.size();
    }
    if (end > start) {
      families.emplace_back(list.data() + start, end - start);
    }
    start = end + 1;
  }
  return families;
}

bool hhea_metrics(const sk_sp<SkTypeface>& typeface,
                  float font_size,
                  float* ascent,
                  float* descent,
                  float* line_gap) {
  uint8_t buf[6];
  if (!typeface || typeface->getTableData(SkSetFourByteTag('h', 'h', 'e', 'a'),
                                          4, 6, buf) != 6) {
    return false;
  }
  const int upem = typeface->getUnitsPerEm();
  if (upem <= 0) {
    return false;
  }
  *ascent = read_be_i16(buf) / static_cast<float>(upem) * font_size;
  *descent = -read_be_i16(buf + 2) / static_cast<float>(upem) * font_size;
  *line_gap = std::max(
      read_be_i16(buf + 4) / static_cast<float>(upem) * font_size, 0.f);
  return true;
}

float to_layout_units(float px) {
  const float rounded = std::round(px * 64) / 64;
  return std::isfinite(rounded) ? rounded : px;
}

float round_metric(float px) {
  return std::floor(px + 0.5f);
}

float baseline_in_line_box(float line_height,
                           float content_ascent,
                           float content_descent) {
  // In LayoutUnits: line_height is a whole number of them (to_layout_units),
  // so the leading is too, and halving it truncates as Blink's integer
  // division does.
  const double leading = static_cast<double>(line_height) * 64 -
                         (content_ascent + content_descent) * 64.0;
  const double above = std::floor(std::trunc(leading / 2) / 64);
  return content_ascent + static_cast<float>(above);
}

float x_height(const sk_sp<SkTypeface>& typeface, float font_size) {
  SkFont font(typeface, font_size);
  font.setHinting(SkFontHinting::kNone);
  SkFontMetrics m;
  font.getMetrics(&m);
  if (m.fXHeight != 0) {
    return std::abs(m.fXHeight);
  }
  const SkGlyphID x = font.unicharToGlyph('x');
  return std::max(0.f, -font.getBounds(x, nullptr).fTop);
}

}  // namespace effing
