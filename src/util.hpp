#pragma once
#include <ranges>
#include <optional>
#include <source_location>
#include <chrono>

#include "crow/crow.h"

#define EXTRACT_CREDENTIALS(req)                        \
    auto req_creds = extract_credentials_from_req(req); \
    if (!req_creds)                                     \
        return std::string("Credentials missing");      \
    auto [username, sha] = *req_creds;

#define EXTRACT_CHECK_CREDENTIALS(req, credentials)                \
    auto req_creds = extract_credentials_from_req(req);            \
    if (!req_creds)                                                \
        return std::string("Credentials missing");                 \
    auto [username, sha] = *req_creds;                             \
    if (!credentials.check_credential(std::string(username), sha)) \
        return std::string("Credential check failed. Relogging might fix the issue.");

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
    return static_cast<std::variant<typename Ts::value_type ...> **>(nullptr);
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
    std::string_view creds;
    auto cred = req.headers.find("credentials");
    if (cred == req.headers.end())
    {
        if (std::ranges::count(req.url_params.keys(), "credentials"))
        {
            creds = req.url_params.get("credentials");
        }
        else
            return {};
    }
    else
        creds = cred->second;

    return std::optional{extract_credentials(creds)};
}

inline std::string log_msg(std::string_view message, const std::source_location &loc = std::source_location::current())
{
    return std::string(loc.file_name()) + ": " + std::to_string(loc.line()) + "| " + std::string(message);
}

inline std::string to_date_string(const std::chrono::system_clock::time_point &t)
{
    return std::format("{:%Y-%m-%d %X}", std::chrono::current_zone()->to_local(t));
}