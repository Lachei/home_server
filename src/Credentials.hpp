#pragma once

#include <string_view>
#include <filesystem>
#include <fstream>
#include <random>

#include "crow/crow.h"
#include "AdminCredentials.hpp"
#include "util.hpp"
#include "nlohmann/json.hpp"

// this class manages the credentials and keeps all credentials in memory and on harddisk to be quicker
// at checking a credential
// The credentials itself are stored as name, salt, sha256 pair, the admin has special credentials which can
// be found in the AdminCredential.hpp file which are static

class Credentials
{
public:
    Credentials(std::string_view credentials_file) : _credentials_file(credentials_file)
    {
        auto credentials_path = std::filesystem::path(credentials_file);
        if (credentials_path.extension().string() != ".json")
            throw std::runtime_error{"Credentials file has to be a json file. Got " + std::string(credentials_file)};

        // loading the json containing all known credentials
        auto credentials_parent_path = std::filesystem::path(credentials_file).parent_path();
        if (!std::filesystem::exists(credentials_parent_path))
            std::filesystem::create_directory(credentials_parent_path);
        std::ifstream credentials_json_file(credentials_file.data(), std::ios_base::binary);
        std::string credentials_json_string{std::istream_iterator<char>(credentials_json_file), std::istream_iterator<char>()};
        if (credentials_json_string.size())
            _credentials = nlohmann::json::parse(credentials_json_string);
    }

    ~Credentials()
    {
        safe_credentials();
    }

    bool contains(const std::string &user)
    {
        return _credentials.contains(user);
    }

    std::vector<std::string> get_user_list() const
    {
        std::vector<std::string> users(_credentials.size());
        int i{};
        for (const auto &[user, _] : _credentials.get<std::map<std::string, nlohmann::json>>())
            users[i++] = user;
        return users;
    }

    // if user is not yet known generates a new entry in the map and a new salt
    std::string get_or_create_user_salt(const std::string &name)
    {
        if (name == admin_name)
            return std::string(admin_salt);

        if (!_credentials.contains(name))
        {
            // create new credential salt
            std::string new_salt(SALT_LENGTH, ' ');
            std::mt19937 rng(_r());
            for (auto i : i_range(SALT_LENGTH))
            {
                int n = _dist(rng);
                if (n < 10)
                    new_salt[i] = static_cast<char>('0' + n);
                else
                    new_salt[i] = static_cast<char>('a' + n - 10);
            }
            using op = std::pair<std::string const, crow::json::wvalue>;
            _credentials[name] = nlohmann::json{{"salt", new_salt}, {"sha256", ""}};
            CROW_LOG_INFO << "Added new user salt pair: " << name << ": " << new_salt;
            safe_credentials();
        }

        return _credentials[name]["salt"].get<std::string>();
    }

    std::string get_user_salt(const std::string &name)
    {
        if (name == admin_name)
            return std::string(admin_salt);

        if (!_credentials.contains(name))
            return {};

        return _credentials[name]["salt"].get<std::string>();
    }

    bool check_credential(const std::string &name, std::string_view sha256) const
    {
        if (name == admin_name)
            return sha256 == admin_sha256;
        if (!_credentials.contains(name))
            return false;

        auto sha_user = _credentials[name]["sha256"].get<std::string>();
        return sha_user == sha256;
    }

    bool set_credential(const std::string &user, std::string_view sha256)
    {
        if (!_credentials.contains(user))
            return false;
        _credentials[user]["sha256"] = std::string(sha256);
        safe_credentials();
        return true;
    }

    bool delete_credential(const std::string &user)
    {
        if (!_credentials.contains(user))
            return false;
        auto alt = crow::json::wvalue::object();
        _credentials.erase(user);
        safe_credentials();
        return true;
    }

    void safe_credentials()
    {
        std::ofstream credentials_json_file(_credentials_file.data(), std::ios_base::binary);
        credentials_json_file << _credentials.dump();
    }

private:
    std::string_view _credentials_file;
    nlohmann::json _credentials;

    std::random_device _r{};
    std::uniform_int_distribution<int> _dist{0, ('z' - 'a') + 10};
};