#pragma once
#include <string>
#include <string_view>

namespace httplib {
struct Response;
}

namespace editor_util{
    bool is_extension_editor(const std::string &ext);
    // Fills res with the editor page (or viewer page if editor is false) for the file at data_base_folder + path
    void get_editor(httplib::Response &res, bool editor, std::string_view path, std::string_view data_base_folder, std::string_view username = {});
}
