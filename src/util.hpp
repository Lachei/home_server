#pragma once
#include <ranges>
#include <optional>
#include <source_location>

#include "crow/crow.h"

#define EXTRACT_CREDENTIALS(req) auto req_creds = extract_credentials_from_req(req);\
        if (!req_creds) return std::string("Credentials missing"); \
        auto [username, sha] = *req_creds;

#define EXTRACT_CHECK_CREDENTIALS(req, credentials) auto req_creds = extract_credentials_from_req(req);\
        if (!req_creds) return std::string("Credentials missing"); \
        auto [username, sha] = *req_creds; \
        if (!credentials.check_credential(std::string(username), sha)) return std::string("Credential check failed. Relogging might fix the issue.");

template<class... Ts>
struct overloaded : Ts... { using Ts::operator()...; };

inline auto i_range(auto&& end) {return std::ranges::iota_view(std::remove_reference_t<decltype(end)>{}, end);}

inline std::pair<std::string_view, std::string_view> extract_credentials(std::string_view cred) {
    auto colon = cred.find(":");
    auto username = cred.substr(0, colon);
    auto sha = cred.substr(colon + 1, 64);
    return std::pair{username, sha};
}

inline std::optional<std::pair<std::string_view, std::string_view>> extract_credentials_from_req(const crow::request& req) {
    std::string_view creds;
    auto cred = req.headers.find("credentials");
    if (cred == req.headers.end()){
        if (std::ranges::count(req.url_params.keys(), "credentials")){
            creds = req.url_params.get("credentials");
        } else return {};
    } else
        creds = cred->second;

    return std::optional{extract_credentials(creds)};
}

inline std::string log_msg(std::string_view message, const std::source_location& loc = std::source_location::current()){
    return loc.file_name() + ':' + std::to_string(loc.line()) + '|' + std::string(message);
}