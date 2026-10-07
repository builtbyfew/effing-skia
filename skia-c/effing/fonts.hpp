// Effing's font precedence: a family registered with GlobalFonts shadows the
// system's family of the same name, as an @font-face family shadows a local
// one in a browser. And its font matching: a family's face for a style is the
// one CSS font matching picks. See docs/effing.md.
//
// skia_c.hpp includes this header for its font provider, so it doesn't
// include skia_c.hpp itself.
#ifndef EFFING_FONTS_HPP
#define EFFING_FONTS_HPP

#include <cstdint>
#include <set>
#include <string>
#include <utility>

#include "include/core/SkFontMgr.h"
#include "include/core/SkFontStyle.h"
#include "include/core/SkRefCnt.h"
#include "include/core/SkString.h"
#include "include/core/SkTypeface.h"

struct skiac_font_collection;

extern "C" {
// Registers the font file at `path` under its own family name as a system
// font, one that any face registered under that name shadows, as
// skiac_font_collection_register_from_path registers a font otherwise.
// Returns the font's id, or 0 when the file is no font. A font already
// registered from `path` stays as it is.
uint32_t effing_font_collection_register_system_font(
    skiac_font_collection* collection,
    const char* path);
}

namespace effing {

// Whether `faces` holds `typeface` itself.
bool has_face(const sk_sp<SkFontStyleSet>& faces, const SkTypeface& typeface);

// The faces of a font provider that join a family without shadowing it, by
// the family name they were added under: the system's fonts, and a font
// registered under an alias alone, under its own family name. Every other
// face is a registered one, which shadows them.
class ShadowableFaces {
 public:
  void add(const SkString& family, const SkTypeface& typeface);
  void remove(const SkString& family, const SkTypeface& typeface);

  // The provider's `faces` of `family`, without the shadowable ones when the
  // family has registered faces too: a family registered under a name
  // replaces the system's family of that name whole, as an @font-face family
  // replaces a local one. A style only the system has, such as the bold of a
  // family registered in regular alone, is then synthesized from the
  // registered faces, as a browser does, rather than taken from another font.
  sk_sp<SkFontStyleSet> shadow(const char family[],
                               sk_sp<SkFontStyleSet> faces) const;

 private:
  std::set<std::pair<std::string, SkTypefaceID>> faces_;
};

// The index of the face of `faces` that CSS font matching (CSS Fonts 4
// §5.2) picks for `desired`, or -1 for none: of the faces nearest in
// font-stretch, those nearest in font-style, and of those the one nearest in
// font-weight, each in the order CSS checks them, with italic and oblique
// faces the same slope, as in Chrome. The first of equally good faces wins,
// where Chrome takes the last @font-face rule.
//
// Skia's SkFontStyleSet::matchStyleCSS3 scores the three in one number with
// eight bits apart, where a weight scores up to 1000, so the weight spills
// into the style: for bold italic it takes a bold face over an italic one.
int match_css(SkFontStyleSet& faces, const SkFontStyle& desired);

// `faces`, whose matchStyle picks the face match_css does. Null stays null.
sk_sp<SkFontStyleSet> with_css_matching(sk_sp<SkFontStyleSet> faces);

// `fonts`, whose families match a style as with_css_matching's do. Everything
// else it passes to `fonts`. The font collection's system font manager is
// one; the font manager skiac_skottie_animation_make gives Skottie isn't, so
// Lottie text keeps Skia's matching.
sk_sp<SkFontMgr> with_css_matching(sk_sp<SkFontMgr> fonts);

}  // namespace effing

#endif  // EFFING_FONTS_HPP
