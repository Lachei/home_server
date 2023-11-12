#pragma once

#include <string_view>
#include <crow.h>
#include <filesystem>
#include <fstream>
#include <random>

#include "AdminCredentials.hpp"
#include "util.hpp"

// this class manages the credentials and keeps all credentials in memory and on harddisk to be quicker
// at checking a credential
// The credentials itself are stored as name, salt, sha256 pair, the admin has special credentials which can
// be found in the AdminCredential.hpp file which are static

class Credentials {
public:
    Credentials(std::string_view credentials_file): 
        _credentials_file(credentials_file) {
        auto credentials_path = std::filesystem::path(credentials_file);
        if(credentials_path.extension().string() != ".json")
            throw std::runtime_error{"Credentials file has to be a json file. Got " + std::string(credentials_file)};

        // loading the json containing all known credentials
        auto credentials_parent_path = std::filesystem::path(credentials_file).parent_path();
        if(!std::filesystem::exists(credentials_parent_path))
            std::filesystem::create_directory(credentials_parent_path);
        std::ifstream credentials_json_file(credentials_file.data(), std::ios_base::binary);
        std::string credentials_json_string{std::istream_iterator<char>(credentials_json_file), std::istream_iterator<char>()};
        if (credentials_json_string.size())
            _credentials = crow::json::load(credentials_json_string);
    };

    // if user is not yet known generates a new entry in the map and a new salt
    std::string get_or_create_user_salt(const std::string& name) {
        if(name == admin_name) 
            return std::string(admin_salt);
        
        if(!_credentials.count(name)){
            // create new credential salt
            std::string new_salt(SALT_LENGTH, ' ');
            std::mt19937 rng(_r());
            for(auto i: i_range(SALT_LENGTH)){
                int n = _dist(rng);
                if(n < 10)
                    new_salt[i] = static_cast<char>('0' + n);
                else
                    new_salt[i] = static_cast<char>('a' + n - 10);
            }
            using op = std::pair<std::string const, crow::json::wvalue>;
            _credentials[name] = crow::json::wvalue({op{"name", name}, op{"salt", new_salt}, op{"sha256", ""}});
            CROW_LOG_INFO << "Added new user salt pair: " << name << ": " << new_salt; 
            std::ofstream credentials_json_file(_credentials_file.data(), std::ios_base::binary);
            credentials_json_file << _credentials.dump();
        }

        return crow::json::wvalue_reader{_credentials[name]["salt"]}.get(std::string());
    }

    std::string get_user_salt(const std::string& name) {
        if(name == admin_name) 
            return std::string(admin_salt);
    
        if(!_credentials.count(name))
            return {};

        return crow::json::wvalue_reader{_credentials[name]["salt"]}.get(std::string());
    }

    bool check_credential(const std::string& name, std::string_view sha256) const {
        if (!_credentials.count(name))
            return false;
        
        auto sha_user = crow::json::wvalue_reader{_credentials[name]["sha256"]}.get(std::string());
        return sha_user == sha256;
    }

private:
    std::string_view _credentials_file;
    crow::json::wvalue _credentials;

    std::random_device _r{};
    std::uniform_int_distribution<int> _dist{0, ('z' - 'a') + 10};
};