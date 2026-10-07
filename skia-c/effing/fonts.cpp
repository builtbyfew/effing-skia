#include "fonts.hpp"

#include "../skia_c.hpp"

#include "modules/skparagraph/include/TypefaceFontProvider.h"

extern "C" {

uint32_t effing_font_collection_register_system_font(
    skiac_font_collection* c_font_collection,
    const char* path) {
  auto typeface = c_font_collection->font_mgr->makeFromFile(path);
  if (!typeface) {
    return 0;
  }
  uint32_t typeface_id =
      c_font_collection->assets->registerTypefaceFromPathWithTracking(
          std::string(path), typeface, /*system=*/true);
  if (typeface_id) {
    c_font_collection->markCachesDirty();
  }
  return typeface_id;
}

}  // extern "C"

namespace effing {

void SystemFaces::add(const SkString& family, const SkTypeface& typeface) {
  faces_.emplace(std::string(family.c_str()), typeface.uniqueID());
}

sk_sp<SkFontStyleSet> SystemFaces::shadow(const char family[],
                                          sk_sp<SkFontStyleSet> faces) const {
  if (family == nullptr || faces == nullptr) {
    return faces;
  }
  std::string name(family);
  // Most families are all registered or all system; skip those with no system
  // face at all without looking at their faces.
  auto first = faces_.lower_bound({name, 0});
  if (first == faces_.end() || first->first != name) {
    return faces;
  }
  auto registered =
      sk_make_sp<skia::textlayout::TypefaceFontStyleSet>(SkString(family));
  bool has_system_face = false;
  for (int i = 0; i < faces->count(); i++) {
    sk_sp<SkTypeface> face = faces->createTypeface(i);
    if (face == nullptr) {
      continue;
    }
    if (faces_.count({name, face->uniqueID()}) > 0) {
      has_system_face = true;
    } else {
      registered->appendTypeface(std::move(face));
    }
  }
  if (!has_system_face || registered->count() == 0) {
    return faces;
  }
  return registered;
}

}  // namespace effing
