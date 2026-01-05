#include "editor_util.hpp"

#include <regex>
#include "nlohmann/json.hpp"
#include "robin_hood/robin_hood.h"
#include "git_util.hpp"

#define TRY_ADD_HEADER(c, h_name, req) if (req.headers.find(h_name) != req.headers.end()) {c[h_name] = req.headers.find(h_name)->second;}

// maps the extension name to the storage file of the editor
static robin_hood::unordered_map<std::string, std::string> extension_editors{
    {".md", "editors/md.html"},
    {".tbl", "editors/tbl.html"},
    {".gpx", "editors/gpx.html"},
    {".rech", "editors/invoice.html"},
    {".stl", "editors/mesh.html"},
};
static robin_hood::unordered_map<std::string, bool> extension_escape{
    {".md", false},
    {".tbl", true},
    {".gpx", true},
    {".rech", true},
    {".stl", true},
};
// cached and already loaded editors
static robin_hood::unordered_map<std::string, crow::mustache::template_t> extension_loaded_editors{};

namespace editor_util
{
    bool is_extension_editor(const std::string &ext)
    {
        return extension_editors.contains(ext);
    }

    crow::response get_editor(bool editor, const crow::request &req, std::string_view path, std::string_view data_base_folder, std::string_view username)
    {
        std::string ext = std::filesystem::path(path).extension().string();
        if (!extension_editors.contains(ext))
            return crow::response{nlohmann::json{{"error", "Unknown editor extension"}}.dump()};
        
        if (!extension_loaded_editors.contains(ext))
            extension_loaded_editors.emplace(ext, crow::mustache::load(extension_editors.at(ext)));

        std::string data_path = std::string(data_base_folder) + path.data();
        std::ifstream data(data_path, std::ios_base::binary);
        std::string d{std::istreambuf_iterator<char>{data}, std::istreambuf_iterator<char>{}};
        if (d.size() && d.back() == '\n')
            d.pop_back();
        crow::mustache::context crow_context{};
        std::cout << "found credentials " << (req.headers.find("credentials") != req.headers.end()) << std::endl;
        TRY_ADD_HEADER(crow_context, "credentials", req);
        crow_context["file_data"] = extension_escape[ext] ? crow::json::escape(d): d;
        crow_context["file_revision"] = git_util::get_latest_commit_hash(data_path);
        std::cout << git_util::get_latest_commit_hash(data_path) << ", " << data_path << std::endl;
        crow_context["file_name"] = std::filesystem::path(data_path).filename().string();
        crow_context["file_path"] = std::string(path);
        TRY_ADD_HEADER(crow_context, "site_url", req);
        crow_context["editor"] = editor;
        crow_context["username"] = std::string(username);
        crow::response r(extension_loaded_editors.at(ext).render_string(crow_context));
        r.add_header("Content-Type", crow::mime_types.at("html"));
        return r;
    }
}
