#pragma once

#include <string_view>

constexpr int SALT_LENGTH = 10;

constexpr std::string_view admin_name = "admin";
constexpr std::string_view admin_salt = "1111111111";
constexpr std::string_view admin_sha256 = "5204fcbf0a241a547875c993415eb9529f68582229f3cfb1cc0a69e5f6e882c6";