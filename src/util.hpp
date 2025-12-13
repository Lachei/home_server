#pragma once
#include <ranges>
#include <optional>
#include <source_location>
#include <chrono>
#include <filesystem>

#include "crow/crow.h"
#include "date.h"
#include "string_view_stream.hpp"
#include "Credentials.hpp"

struct crow_status: public std::runtime_error {
    using header_vec = std::vector<std::pair<std::string, std::string>>;
    crow_status(crow::status st, const header_vec &headers, const std::string &what = {}): 
        std::runtime_error(what), status{st}, headers{headers} {}

    crow::status status{crow::status::OK};
    header_vec headers{};
};

template <class... Ts>
struct overloaded : Ts...
{
    using Ts::operator()...;
};

template <typename T, typename... Ts>
constexpr std::size_t variant_index_impl(std::variant<Ts...> **)
{
    std::size_t i = 0;
    ((!std::is_same_v<T, Ts> && ++i) && ...);
    return i;
}
template <typename T, typename V>
constexpr std::size_t variant_index_v = variant_index_impl<T>(static_cast<V **>(nullptr));
template <typename... Ts>
constexpr auto variant_to_value_type(std::variant<Ts...> **)
{
    return static_cast<std::variant<typename Ts::value_type...> **>(nullptr);
}

inline auto i_range(auto &&end) { return std::ranges::iota_view(std::remove_reference_t<decltype(end)>{}, end); }

inline std::pair<std::string_view, std::string_view> extract_credentials(std::string_view cred)
{
    auto colon = cred.find(":");
    auto username = cred.substr(0, colon);
    auto sha = cred.substr(colon + 1, 64);
    return std::pair{username, sha};
}

bool valid_credential(const std::string &credential, const Credentials& credentials);
std::string cookie_extract_credential(const std::string &cookie);
bool valid_cookie_credential(const std::string &cookie, const Credentials& credentials);
std::string get_authorized_username(const crow::request &req, const Credentials &credentials);

#define DATE_FORMAT "%Y-%m-%d %T"
constexpr std::string_view date_dump_format = "{:" DATE_FORMAT "}";
constexpr std::string_view date_parse_format = DATE_FORMAT;
inline std::string to_date_string(const std::chrono::utc_clock::time_point &t)
{
    return std::format(date_dump_format.data(), t);
}

inline std::chrono::utc_clock::time_point from_date_string(std::string_view date_string)
{
    std::chrono::sys_time<std::chrono::nanoseconds> res;
    string_view_istream d(date_string);
    d >> date::parse(date_parse_format.data(), res);
    return std::chrono::time_point_cast<std::chrono::utc_clock::duration>(std::chrono::utc_clock::from_sys(res));
}

#define JSON_DATE_FORMAT "%Y-%m-%dT%TZ"
constexpr std::string_view json_date_dump_format = "{:" JSON_DATE_FORMAT "}";
constexpr std::string_view json_date_parse_format = JSON_DATE_FORMAT;
inline std::string to_json_date_string(const std::chrono::utc_clock::time_point &t)
{
    return std::format(json_date_dump_format.data(), std::chrono::utc_time<std::chrono::nanoseconds>(t));
}
inline std::chrono::utc_clock::time_point from_json_date_string(std::string_view date_string)
{
    std::chrono::sys_time<std::chrono::nanoseconds> res;
    string_view_istream d(date_string);
    d >> date::parse(json_date_parse_format.data(), res);
    return std::chrono::time_point_cast<std::chrono::utc_clock::duration>(std::chrono::utc_clock::from_sys(res));
}

inline std::string json_array_remove_whitespace(std::string_view arr)
{
    std::stringstream ret;
    for (auto c : arr)
        if (c != ' ' && c != '\t')
            ret << c;
    return ret.str();
}

inline std::string_view json_array_to_comma_list(std::string_view arr)
{
    if (!arr.size())
        return arr;
    if (arr.front() == '[')
        arr = arr.substr(1);
    if (arr.back() == ']')
        arr = arr.substr(0, arr.size() - 1);
    return arr;
}

namespace std::ranges
{
    template <typename T, typename E>
    inline bool contains(T range, E v)
    {
        return std::ranges::find(range, v) != range.end();
    }
}
