#pragma once
#include <cstdint>
#include <string_view>
#include "nlohmann/json.hpp"

std::pair<int, std::string> run_command(std::string_view cmd);
nlohmann::json get_groups();
void add_group(std::string_view group);
void delete_group(std::string_view group);
