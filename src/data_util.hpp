#pragma once
#include <span>
#include "nlohmann/json_fwd.hpp"

namespace data_util{
    void setup_data(std::string_view dir);
    nlohmann::json get_dir_infos(std::string_view base, std::string_view dir);
    nlohmann::json create_dir(std::string_view dir);
    nlohmann::json create_file(std::string_view file);
    nlohmann::json delete_file(std::string_view file);
    nlohmann::json write_file(std::string_view file, std::span<const std::byte> data);
    std::vector<std::byte> read_file(std::string_view file);
}