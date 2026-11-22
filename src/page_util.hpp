#pragma once
#include <fstream>
#include <string>
#include <string_view>

#include "log.hpp"
#include "nlohmann/json.hpp"

namespace page_util {
inline constexpr std::string_view templates_folder{"templates/"};

// Reads a file from the templates folder, returns an empty string if the file can not be read
inline std::string load_template(std::string_view name) {
    std::string path = std::string(templates_folder) + std::string(name);
    std::ifstream f(path, std::ios_base::binary);
    if (!f) {
        LOG_WARNING << "Could not load template file " << path;
        return {};
    }
    return std::string{std::istreambuf_iterator<char>{f}, std::istreambuf_iterator<char>{}};
}

// Json dump which is safe to embed into a <script> element: invalid utf8 is replaced and every '<' is written as
// < so the content can never close the script element (only possible inside json strings, so the json stays valid)
inline std::string script_safe_json(const nlohmann::json &j) {
    std::string dumped = j.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
    std::string ret;
    ret.reserve(dumped.size());
    for (char c: dumped) {
        if (c == '<')
            ret += "\\u003c";
        else
            ret += c;
    }
    return ret;
}

// Makes the page infos available to the page as the global `page_info` object by inserting a script right after
// the first <head> tag. The script runs before anything else of the page, so the page can use page_info everywhere.
// If page_info.editor is true the html element gets the class edit_mode which shows all elements with the class
// edit_only, otherwise all elements with the class view_only are shown.
inline std::string render_page(std::string_view html, const nlohmann::json &page_info) {
    const std::string script = "\n<script>var page_info = " + script_safe_json(page_info) + ";\n"
        "if (page_info.editor) document.documentElement.classList.add('edit_mode');</script>\n"
        "<style>html:not(.edit_mode) .edit_only {display: none !important;} html.edit_mode .view_only {display: none !important;}</style>\n";
    size_t head = html.find("<head>");
    size_t insert_pos = head == std::string_view::npos ? 0 : head + std::string_view{"<head>"}.size();
    std::string ret;
    ret.reserve(html.size() + script.size());
    ret.append(html.substr(0, insert_pos));
    ret.append(script);
    ret.append(html.substr(insert_pos));
    return ret;
}
}
