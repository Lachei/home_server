#pragma once
#include "crow/crow.h"
#include "string"

namespace editor_util{
    crow::response get_editor(bool editor, const crow::request & req, std::string_view path, std::string_view data_base_folder);
}