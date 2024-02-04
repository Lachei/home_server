#pragma once

#include <string_view>
#include <fstream>

constexpr int SALT_LENGTH = 10;

constexpr std::string_view admin_name = "admin";
constexpr std::string_view admin_credentials_file = "credentials/admin";
static std::string admin_salt{};
static std::string admin_sha256{};

inline void load_admin_credentials() {
    std::ifstream cred_file(admin_credentials_file.data());
    if (!cred_file) {
        std::cout << "[error] Can not open credentials file\n";
        exit(-1);
    }
    
    cred_file >> admin_salt >> admin_sha256;
}