#pragma once
#include <ranges>

inline auto i_range(auto&& end) {return std::ranges::iota_view(std::remove_reference_t<decltype(end)>{}, end);}