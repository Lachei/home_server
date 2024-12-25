#pragma once
#include <ranges>
#include <optional>
#include <source_location>
#include <chrono>
#include <filesystem>

#include "crow/crow.h"
#include "date.h"
#include "string_view_stream.hpp"

#define EXTRACT_CREDENTIALS_T(req, ret_type)            \
    auto req_creds = extract_credentials_from_req(req); \
    if (!req_creds)                                     \
        return ret_type{"Credentials missing"};         \
    auto [username, sha] = *req_creds;

#define EXTRACT_CREDENTIALS(req) EXTRACT_CREDENTIALS_T(req, std::string)

#define EXTRACT_CHECK_CREDENTIALS_T(req, credentials, ret_type)    \
    auto req_creds = extract_credentials_from_req(req);            \
    if (!req_creds)                                                \
        return ret_type("Credentials missing");                    \
    auto [username, sha] = *req_creds;                             \
    if (!credentials.check_credential(std::string(username), sha)) \
        return ret_type("Credential check failed. Relogging might fix the issue.");

#define EXTRACT_CHECK_CREDENTIALS(req, credentials) EXTRACT_CHECK_CREDENTIALS_T(req, credentials, std::string)

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

inline std::optional<std::pair<std::string_view, std::string_view>> extract_credentials_from_req(const crow::request &req)
{
    if (std::filesystem::path(req.url).filename().string() == "overview")
    {
        auto body_view = std::string_view(req.body);
        if (body_view.empty())
            return {};
        auto uname_start = body_view.find("uname=") + sizeof("uname");
        auto uname_end = body_view.find('&', uname_start);
        auto uname = body_view.substr(uname_start, uname_end - uname_start);
        auto pwd = body_view.substr(body_view.find("psw=", uname_end) + sizeof("psw"));
        return std::optional{std::pair{uname, pwd}};
    }
    else
    {
        // check for credentials header field
        auto cred = req.headers.find("credentials");
        if (cred != req.headers.end())
        {
            return std::optional{extract_credentials(cred->second)};
        }
        // check for Authorization field
        cred = req.headers.find("Authorization");
        if (cred != req.headers.end())
        {
            return std::optional{extract_credentials(cred->second)};
        }
        // check for authorization field in cookies
        cred = req.headers.find("Cookie");
        if (cred != req.headers.end())
        {
            size_t cred_offset = std::string_view(cred->second).find("credentials");
            if (cred_offset != std::string_view::npos) {
                cred_offset += 11; // add size of credentials
                for (; cred_offset < cred->second.size() && (cred->second[cred_offset] == ' ' || cred->second[cred_offset] == '='); ++cred_offset);
                return std::optional{extract_credentials(std::string_view(cred->second).substr(cred_offset))};
            }
        }
    }
    return {};
}

inline std::string log_msg(std::string_view message, const std::source_location &loc = std::source_location::current())
{
    return std::string(loc.file_name()) + ": " + std::to_string(loc.line()) + " | " + std::string(message);
}

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
