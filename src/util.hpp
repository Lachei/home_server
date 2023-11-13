#pragma once
#include <ranges>

inline auto i_range(auto&& end) {return std::ranges::iota_view(std::remove_reference_t<decltype(end)>{}, end);}

inline std::pair<std::string_view, std::string_view> extract_credentials(std::string_view cred) {
    auto colon = cred.find(":");
    auto username = cred.substr(0, colon);
    auto sha = cred.substr(colon + 1, 64);
    return std::pair{username, sha};
}