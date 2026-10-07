#include "blur.hpp"

#include "include/core/SkBlendMode.h"
#include "include/core/SkColor.h"
#include "include/core/SkColorFilter.h"
#include "include/core/SkImageFilter.h"
#include "include/core/SkMatrix.h"
#include "include/core/SkSamplingOptions.h"
#include "include/effects/SkImageFilters.h"
#include "include/effects/SkRuntimeEffect.h"

#include <cmath>

namespace effing {

namespace {

// Skia's SkBlurEngine blurs 8888 layers with a Gaussian kernel below sigma 2
// (GaussianPass::kMaxSigma) and with three boxes from there, the boxes
// Chromium's blurs with at every sigma. From sigma 2.5 on, a window of 5 and
// up, Skia's blur is Chromium's.
constexpr float kBoxedSigma = 2.5f;

// The sigmas from about 1.86 to 2.39 have a window of 4. Skia boxes them from
// 2, but a layer can map sigma by a scale a rounding error under one, as the
// inverse of a rotation concatenated with the rotation does, and sigma 2 then
// takes the Gaussian. This one, in the middle, keeps the window either way.
constexpr float kWindow4Sigma = 2.125f;

// SkBlurEngine::BoxBlurWindow: the width of each of the three boxes.
int box_window(float sigma) {
  const int window = static_cast<int>(
      std::floor(sigma * 3 * std::sqrt(2 * SK_FloatPI) / 4 + 0.5f));
  return window < 1 ? 1 : window;
}

// One axis of SkBlurEngine's three-box pass for a window of 2 or 3, which no
// sigma Skia boxes has, in integers as ThreeBoxApproxPass computes it. The
// three boxes make one kernel: for a window of 3, [1 3 6 7 6 3 1] / 27; for 2,
// two boxes of 2 shifted apart and one of 3, [1 3 4 3 1] / 12. The pass rounds
// the sum through ScaledDividerU32, which for these divisors is
// floor((sum + 14) / 27) and floor((sum + 5) / 12), and stores 8 bits, as each
// of these filters does before the next reads it. A half more before the
// division keeps the floor of the float quotient off a rounding error. `v` is
// a pixel's premultiplied channels in 8-bit levels, which a colour filter
// before the blur may leave unrounded; `d` is a step along the axis.
constexpr char kBoxPass2SkSL[] =
    "uniform shader child;"
    "uniform float2 d;"
    "float4 v(float2 p) {"
    "  return floor(float4(child.eval(p)) * 255 + 0.5);"
    "}"
    "half4 main(float2 p) {"
    "  float4 sum = 4 * v(p) + 3 * (v(p - d) + v(p + d)) +"
    "               v(p - 2 * d) + v(p + 2 * d);"
    "  return half4(floor((sum + 5.5) / 12) / 255);"
    "}";
constexpr char kBoxPass3SkSL[] =
    "uniform shader child;"
    "uniform float2 d;"
    "float4 v(float2 p) {"
    "  return floor(float4(child.eval(p)) * 255 + 0.5);"
    "}"
    "half4 main(float2 p) {"
    "  float4 sum = 7 * v(p) + 6 * (v(p - d) + v(p + d)) +"
    "               3 * (v(p - 2 * d) + v(p + 2 * d)) +"
    "               v(p - 3 * d) + v(p + 3 * d);"
    "  return half4(floor((sum + 14.5) / 27) / 255);"
    "}";

const SkRuntimeEffect* make_effect(const char* sksl) {
  return SkRuntimeEffect::MakeForShader(SkString(sksl)).effect.release();
}

sk_sp<SkImageFilter> box_pass(int window,
                              SkV2 step,
                              sk_sp<SkImageFilter> input) {
  static const SkRuntimeEffect* effect2 = make_effect(kBoxPass2SkSL);
  static const SkRuntimeEffect* effect3 = make_effect(kBoxPass3SkSL);
  const SkRuntimeEffect* effect = window == 2 ? effect2 : effect3;
  if (effect == nullptr) {
    return nullptr;
  }
  SkRuntimeShaderBuilder builder(sk_ref_sp(effect));
  builder.uniform("d") = step;
  // The pass is transparent where its input is, so its output is bounded by
  // the input's, outset by the kernel.
  return SkImageFilters::RuntimeShader(builder, /*sampleRadius=*/window,
                                       "child", std::move(input),
                                       /*restrictOutputToInputBounds=*/true);
}

// How Chrome's canvas blurs along one axis, as SkImageFilters::Blur's sigma
// for that axis, or a window for box_pass when Skia has no sigma for it.
struct Axis {
  float sigma = 0;
  int box_window = 0;
};

Axis axis(float sigma) {
  if (sigma >= kBoxedSigma) {
    return {sigma};
  }
  switch (const int window = box_window(sigma)) {
    case 1:
      // Chromium skips the pass, as Skia does at sigma 0.
      return {0};
    case 2:
    case 3:
      return {0, window};
    case 4:
      return {kWindow4Sigma};
    default:
      return {sigma};
  }
}

sk_sp<SkImageFilter> canvas_blur(float sigma_x,
                                 float sigma_y,
                                 sk_sp<SkImageFilter> input) {
  if (!std::isfinite(sigma_x) || !std::isfinite(sigma_y) || sigma_x < 0 ||
      sigma_y < 0) {
    return SkImageFilters::Blur(sigma_x, sigma_y, std::move(input));
  }
  const Axis x = axis(sigma_x);
  const Axis y = axis(sigma_y);
  if (x.box_window == 0 && y.box_window == 0) {
    return SkImageFilters::Blur(x.sigma, y.sigma, std::move(input));
  }
  // SkBlurEngine blurs along x first and stores 8 bits before blurring along y.
  if (x.box_window != 0) {
    input = box_pass(x.box_window, {1, 0}, std::move(input));
  } else if (x.sigma > 0) {
    input = SkImageFilters::Blur(x.sigma, 0, std::move(input));
  }
  if (input == nullptr) {
    return nullptr;
  }
  if (y.box_window != 0) {
    return box_pass(y.box_window, {0, 1}, std::move(input));
  }
  if (y.sigma > 0) {
    return SkImageFilters::Blur(0, y.sigma, std::move(input));
  }
  return input;
}

sk_sp<SkImageFilter> take_filter(skiac_image_filter* c_image_filter) {
  return sk_ref_sp(reinterpret_cast<SkImageFilter*>(c_image_filter));
}

skiac_image_filter* release_filter(sk_sp<SkImageFilter> filter) {
  return reinterpret_cast<skiac_image_filter*>(filter.release());
}

}  // namespace

}  // namespace effing

extern "C" {

skiac_image_filter* effing_image_filter_make_canvas_blur(
    float sigma_x,
    float sigma_y,
    skiac_image_filter* c_image_filter) {
  return effing::release_filter(effing::canvas_blur(
      sigma_x, sigma_y, effing::take_filter(c_image_filter)));
}

skiac_image_filter* effing_image_filter_make_canvas_drop_shadow(
    float dx,
    float dy,
    float sigma_x,
    float sigma_y,
    uint32_t color,
    bool shadow_only,
    skiac_image_filter* c_image_filter) {
  // SkImageFilters::DropShadow's graph (SkDropShadowImageFilter.cpp), with
  // the canvas blur.
  sk_sp<SkImageFilter> input = effing::take_filter(c_image_filter);
  sk_sp<SkImageFilter> shadow = effing::canvas_blur(sigma_x, sigma_y, input);
  if (shadow == nullptr) {
    return nullptr;
  }
  shadow = SkImageFilters::ColorFilter(
      SkColorFilters::Blend(SkColor4f::FromColor(color), /*colorSpace=*/nullptr,
                            SkBlendMode::kSrcIn),
      std::move(shadow));
  shadow = SkImageFilters::MatrixTransform(
      SkMatrix::Translate(dx, dy), SkFilterMode::kLinear, std::move(shadow));
  if (!shadow_only) {
    shadow = SkImageFilters::Merge(std::move(shadow), std::move(input));
  }
  return effing::release_filter(std::move(shadow));
}
}
