#pragma once
#include "crow/crow.h"
#include "string"

namespace editor_util{
    bool is_extension_editor(const std::string &ext);
    crow::response get_editor(bool editor, const crow::request & req, std::string_view path, std::string_view data_base_folder);
}