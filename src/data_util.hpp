#pragma once
#include <chrono>
#include <span>
#include "nlohmann/json_fwd.hpp"

/**
 * @brief namespace containing utility functions for data access and manipulation
 * All write actions require a user as it is required for meaningful git commits
 */
namespace data_util{
    void setup_data(std::string_view dir);
    nlohmann::json get_dir_infos(std::string_view base, std::string_view dir);
    nlohmann::json create_dir(std::string_view user, std::string_view dir);
    nlohmann::json update_file(std::string_view user, std::string_view file, std::span<const std::byte> data = {}, std::string_view base_version = {});
    nlohmann::json delete_files(std::string_view user, std::string_view base_dir, const nlohmann::json &files);
    nlohmann::json move_files(std::string_view user, std::string_view base_dir, const nlohmann::json &move_infos);
    std::string read_file(std::string_view file);
    std::string check_file_revision(std::string_view path, std::string_view revision);
    void try_add_shift_to_rech(std::string_view user, std::string_view data_folder, std::chrono::minutes shift_length, std::string_view comment);
}
