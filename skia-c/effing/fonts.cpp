#include "fonts.hpp"

#include "../skia_c.hpp"

#include <memory>
#include <tuple>

#include "include/core/SkData.h"
#include "include/core/SkFontArguments.h"
#include "include/core/SkStream.h"
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

bool has_face(const sk_sp<SkFontStyleSet>& faces, const SkTypeface& typeface) {
  if (faces == nullptr) {
    return false;
  }
  for (int i = 0; i < faces->count(); i++) {
    sk_sp<SkTypeface> face = faces->createTypeface(i);
    if (face != nullptr && face->uniqueID() == typeface.uniqueID()) {
      return true;
    }
  }
  return false;
}

void ShadowableFaces::add(const SkString& family, const SkTypeface& typeface) {
  faces_.emplace(std::string(family.c_str()), typeface.uniqueID());
}

void ShadowableFaces::remove(const SkString& family,
                             const SkTypeface& typeface) {
  faces_.erase({std::string(family.c_str()), typeface.uniqueID()});
}

sk_sp<SkFontStyleSet> ShadowableFaces::shadow(
    const char family[],
    sk_sp<SkFontStyleSet> faces) const {
  if (family == nullptr || faces == nullptr || faces->count() == 0) {
    return faces;
  }
  std::string name(family);
  // Most families have no shadowable face at all; skip them without looking
  // at their faces.
  auto first = faces_.lower_bound({name, 0});
  if (first == faces_.end() || first->first != name) {
    return faces;
  }
  auto registered =
      sk_make_sp<skia::textlayout::TypefaceFontStyleSet>(SkString(family));
  bool has_shadowable_face = false;
  for (int i = 0; i < faces->count(); i++) {
    sk_sp<SkTypeface> face = faces->createTypeface(i);
    if (face == nullptr) {
      continue;
    }
    if (faces_.count({name, face->uniqueID()}) > 0) {
      has_shadowable_face = true;
    } else {
      registered->appendTypeface(std::move(face));
    }
  }
  if (!has_shadowable_face || registered->count() == 0) {
    return faces;
  }
  return registered;
}

namespace {

// Each rank is 0 for the desired value itself, and grows in the order CSS
// Fonts 4 §5.2 checks the other values in when no face has it.

// font-stretch (SkFontStyle::Width, 1 to 9): at or below normal, narrower
// widths nearest first, then wider ones nearest first; above normal, wider
// ones first, then narrower ones.
int stretch_rank(int desired, int width) {
  if (width == desired) {
    return 0;
  }
  bool narrower = width < desired;
  if (desired <= SkFontStyle::kNormal_Width) {
    return narrower ? desired - width : 10 + width - desired;
  }
  return narrower ? 10 + desired - width : width - desired;
}

// font-style: italic and oblique check slanted faces, then upright ones;
// normal checks upright faces, then slanted ones. An italic face and an
// oblique one are the same slope, as in Chrome: Blink takes italic for
// oblique 14deg (kItalicSlopeValue), the angle `oblique` has without one,
// and ranks faces by their angle alone. CSS Fonts 4 would check italic faces
// before oblique ones for italic, and the other way round otherwise.
int style_rank(SkFontStyle::Slant desired, SkFontStyle::Slant slant) {
  bool slanted = slant != SkFontStyle::kUpright_Slant;
  return slanted == (desired != SkFontStyle::kUpright_Slant) ? 0 : 1;
}

// font-weight: from 400 to 500, heavier weights up to 500 nearest first,
// then lighter ones nearest first, then those above 500 nearest first (so
// 400 takes 500 before anything lighter, and 500 takes 400 first); below
// 400, lighter weights nearest first, then heavier ones; above 500, heavier
// weights nearest first, then lighter ones.
int weight_rank(int desired, int weight) {
  if (weight == desired) {
    return 0;
  }
  bool lighter = weight < desired;
  if (desired >= SkFontStyle::kNormal_Weight &&
      desired <= SkFontStyle::kMedium_Weight) {
    if (lighter) {
      return 1000 + desired - weight;
    }
    return weight <= SkFontStyle::kMedium_Weight ? weight - desired
                                                 : 2000 + weight - desired;
  }
  if (desired < SkFontStyle::kNormal_Weight) {
    return lighter ? desired - weight : 1000 + weight - desired;
  }
  return lighter ? 1000 + desired - weight : weight - desired;
}

class CssFontStyleSet final : public SkFontStyleSet {
 public:
  explicit CssFontStyleSet(sk_sp<SkFontStyleSet> faces)
      : faces_(std::move(faces)) {}

  int count() override { return faces_->count(); }

  void getStyle(int index, SkFontStyle* style, SkString* name) override {
    faces_->getStyle(index, style, name);
  }

  sk_sp<SkTypeface> createTypeface(int index) override {
    return faces_->createTypeface(index);
  }

  sk_sp<SkTypeface> matchStyle(const SkFontStyle& pattern) override {
    int index = match_css(*faces_, pattern);
    return index < 0 ? nullptr : faces_->createTypeface(index);
  }

 private:
  sk_sp<SkFontStyleSet> faces_;
};

class CssFontMgr final : public SkFontMgr {
 public:
  explicit CssFontMgr(sk_sp<SkFontMgr> fonts) : fonts_(std::move(fonts)) {}

 protected:
  int onCountFamilies() const override { return fonts_->countFamilies(); }

  void onGetFamilyName(int index, SkString* family) const override {
    fonts_->getFamilyName(index, family);
  }

  sk_sp<SkFontStyleSet> onCreateStyleSet(int index) const override {
    return with_css_matching(fonts_->createStyleSet(index));
  }

  sk_sp<SkFontStyleSet> onMatchFamily(const char family[]) const override {
    return with_css_matching(fonts_->matchFamily(family));
  }

  sk_sp<SkTypeface> onMatchFamilyStyle(
      const char family[],
      const SkFontStyle& style) const override {
    if (family == nullptr) {
      return fonts_->matchFamilyStyle(nullptr, style);
    }
    sk_sp<SkFontStyleSet> faces = this->onMatchFamily(family);
    return faces == nullptr ? nullptr : faces->matchStyle(style);
  }

  sk_sp<SkTypeface> onMatchFamilyStyleCharacter(
      const char family[],
      const SkFontStyle& style,
      const char* bcp47[],
      int bcp47_count,
      SkUnichar character) const override {
    return fonts_->matchFamilyStyleCharacter(family, style, bcp47, bcp47_count,
                                             character);
  }

  sk_sp<SkTypeface> onMakeFromData(sk_sp<SkData> data,
                                   int ttc_index) const override {
    return fonts_->makeFromData(std::move(data), ttc_index);
  }

  sk_sp<SkTypeface> onMakeFromStreamIndex(std::unique_ptr<SkStreamAsset> stream,
                                          int ttc_index) const override {
    return fonts_->makeFromStream(std::move(stream), ttc_index);
  }

  sk_sp<SkTypeface> onMakeFromStreamArgs(
      std::unique_ptr<SkStreamAsset> stream,
      const SkFontArguments& args) const override {
    return fonts_->makeFromStream(std::move(stream), args);
  }

  sk_sp<SkTypeface> onMakeFromFile(const char path[],
                                   int ttc_index) const override {
    return fonts_->makeFromFile(path, ttc_index);
  }

  // The family `fonts` falls back to, a style of it as CSS picks one.
  sk_sp<SkTypeface> onLegacyMakeTypeface(const char family[],
                                         SkFontStyle style) const override {
    sk_sp<SkTypeface> face = fonts_->legacyMakeTypeface(family, style);
    if (face == nullptr) {
      return nullptr;
    }
    SkString name;
    face->getFamilyName(&name);
    sk_sp<SkFontStyleSet> faces = this->onMatchFamily(name.c_str());
    if (faces != nullptr && has_face(faces, *face)) {
      if (sk_sp<SkTypeface> match = faces->matchStyle(style)) {
        return match;
      }
    }
    return face;
  }

 private:
  sk_sp<SkFontMgr> fonts_;
};

}  // namespace

int match_css(SkFontStyleSet& faces, const SkFontStyle& desired) {
  int best = -1;
  std::tuple<int, int, int> best_rank;
  for (int i = 0; i < faces.count(); i++) {
    SkFontStyle style;
    faces.getStyle(i, &style, nullptr);
    std::tuple<int, int, int> rank = {
        stretch_rank(desired.width(), style.width()),
        style_rank(desired.slant(), style.slant()),
        weight_rank(desired.weight(), style.weight())};
    if (best < 0 || rank < best_rank) {
      best = i;
      best_rank = rank;
    }
  }
  return best;
}

sk_sp<SkFontStyleSet> with_css_matching(sk_sp<SkFontStyleSet> faces) {
  if (faces == nullptr) {
    return nullptr;
  }
  return sk_make_sp<CssFontStyleSet>(std::move(faces));
}

sk_sp<SkFontMgr> with_css_matching(sk_sp<SkFontMgr> fonts) {
  if (fonts == nullptr) {
    return nullptr;
  }
  return sk_make_sp<CssFontMgr>(std::move(fonts));
}

}  // namespace effing
