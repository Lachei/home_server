#include "editor_util.hpp"

#include <filesystem>
#include <fstream>
#include <mutex>
#include "httplib.h"
#include "nlohmann/json.hpp"
#include "robin_hood/robin_hood.h"
#include "git_util.hpp"
#include "page_util.hpp"

// maps the extension name to the storage file of the editor
static const robin_hood::unordered_map<std::string, std::string> extension_editors{
    {".md", "editors/md.html"},
    {".tbl", "editors/tbl.html"},
    {".gpx", "editors/gpx.html"},
    {".rech", "editors/invoice.html"},
    {".stl", "editors/mesh.html"},
};
// cached and already loaded editors
static robin_hood::unordered_map<std::string, std::string> extension_loaded_editors{};
static std::mutex extension_loaded_editors_mutex{};

namespace editor_util
{
    bool is_extension_editor(const std::string &ext)
    {
        return extension_editors.contains(ext);
    }

    void get_editor(httplib::Response &res, bool editor, std::string_view path, std::string_view data_base_folder, std::string_view username)
    {
        std::string ext = std::filesystem::path(path).extension().string();
        if (!extension_editors.contains(ext)) {
            res.set_content(nlohmann::json{{"error", "Unknown editor extension"}}.dump(), "application/json");
            return;
        }

        std::string editor_page;
        {
            std::scoped_lock lock(extension_loaded_editors_mutex);
            if (!extension_loaded_editors.contains(ext))
                extension_loaded_editors.emplace(ext, page_util::load_template(extension_editors.at(ext)));
            editor_page = extension_loaded_editors.at(ext);
        }

        std::string data_path = std::string(data_base_folder) + std::string(path);
        std::ifstream data(data_path, std::ios_base::binary);
        std::string d{std::istreambuf_iterator<char>{data}, std::istreambuf_iterator<char>{}};
        if (d.size() && d.back() == '\n')
            d.pop_back();

        nlohmann::json page_info{
            {"editor", editor},
            {"file_data", std::move(d)},
            {"file_revision", git_util::get_latest_commit_hash(data_path)},
            {"file_name", std::filesystem::path(data_path).filename().string()},
            {"file_path", std::string(path)},
            {"username", std::string(username)},
        };
        res.set_content(page_util::render_page(editor_page, page_info), "text/html");
    }
}
