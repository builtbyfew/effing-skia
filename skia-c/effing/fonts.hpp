// Effing's font precedence: a family registered with GlobalFonts shadows the
// system's family of the same name, as an @font-face family shadows a local
// one in a browser. See docs/effing.md.
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

// The faces of a font provider that join a family without shadowing it, by
// the family name they were added under: the system's fonts, and a font
// registered under an alias alone, under its own family name. Every other
// face is a registered one, which shadows them.
class ShadowableFaces {
 public:
  void add(const SkString& family, const SkTypeface& typeface);

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

}  // namespace effing

#endif  // EFFING_FONTS_HPP
