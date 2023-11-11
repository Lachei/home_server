#pragma once

#include <string_view>

constexpr int SALT_LENGTH = 10;

constexpr std::string_view admin_name = "admin";
constexpr std::string_view admin_salt = "1111111111";
constexpr std::string_view admin_sha256 = "xxx";