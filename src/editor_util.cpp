#include "editor_util.hpp"

#include <regex>
#include "nlohmann/json.hpp"

#define TRY_ADD_HEADER(c, h_name, req) if (req.headers.find(h_name) != req.headers.end()) {c[h_name] = req.headers.find(h_name)->second;}

namespace editor_util
{
    crow::response get_editor(bool editor, const crow::request &req, std::string_view path, std::string_view data_base_folder)
    {
        const crow::mustache::template_t *md_editor_page{};
        std::string ext = std::filesystem::path(path).extension();
        if (ext == ".md")
        {
            static const auto md_editor = crow::mustache::load("editors/md.html");
            md_editor_page = &md_editor;
        }
        else if (ext == ".tbl")
        {
            static const auto md_editor = crow::mustache::load("editors/tbl.html");
            md_editor_page = &md_editor;
        }
        else
            return crow::response{nlohmann::json{{"error", "Only md files allowed for edit_md route"}}.dump()};
        std::string data_path = std::string(data_base_folder) + path.data();
        std::ifstream data(data_path, std::ios_base::binary);
        std::string d;
        d.resize(std::filesystem::file_size(data_path));
        data.read(d.data(), d.size());
        d = std::regex_replace(d, std::regex("\\\\\""), "\\\\\"");
        d = std::regex_replace(d, std::regex("\\\'"), "\\\'");
        while (d.size() && d.back() == '\n')
            d.pop_back();
        crow::mustache::context crow_context{};
        std::cout << "found credentials " << (req.headers.find("credentials") != req.headers.end()) << std::endl;
        TRY_ADD_HEADER(crow_context, "credentials", req);
        crow_context["file_data"] = d;
        crow_context["file_name"] = std::filesystem::path(data_path).filename();
        crow_context["file_path"] = std::string(path);
        TRY_ADD_HEADER(crow_context, "site_url", req);
        crow_context["editor"] = editor;
        crow::response r(md_editor_page->render_string(crow_context));
        r.add_header("Content-Type", crow::mime_types.at("html"));
        return r;
    }
}